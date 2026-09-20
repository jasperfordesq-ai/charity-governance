import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

const {
  connectorIdempotencyPlugin,
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_IN_FLIGHT_GRACE_MS,
  IDEMPOTENCY_MAX_BODY_BYTES,
} = await import("../plugins/connector-idempotency.js");

const KEY = "3f1c9a77-2b5d-4e18-9c30-0a7f6b1e2d44";

interface Row {
  id: string;
  organisationId: string;
  userId: string;
  key: string;
  requestDigest: string;
  method: string;
  routePattern: string;
  completedAt: Date | null;
  statusCode: number | null;
  responseBody: string | null;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * A standing-in table with the one property the real one has that matters:
 * the unique index on (userId, key). Everything this plugin does about
 * duplicates hangs off that insert failing, so a double that let two inserts
 * through would test nothing.
 */
function table(options: { beforeInsert?: () => Promise<void> } = {}) {
  const rows = new Map<string, Row>();
  let nextId = 1;
  const at = (userId: string, key: string) => JSON.stringify([userId, key]);

  return {
    rows,
    delegate: {
      create: async ({ data }: { data: Omit<Row, "id" | "createdAt" | "completedAt" | "statusCode" | "responseBody"> & { createdAt?: Date } }) => {
        // A hook for the simultaneity test: both requests get inside create
        // before either has inserted, which is the only way to exercise the
        // unique index rather than the claim that precedes the handler.
        if (options.beforeInsert) await options.beforeInsert();
        const index = at(data.userId, data.key);
        if (rows.has(index)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const row: Row = {
          id: `row-${nextId++}`,
          createdAt: data.createdAt ?? new Date(),
          completedAt: null,
          statusCode: null,
          responseBody: null,
          ...data,
        };
        rows.set(index, row);
        return { id: row.id };
      },
      findUnique: async ({ where }: { where: { userId_key: { userId: string; key: string } } }) =>
        rows.get(at(where.userId_key.userId, where.userId_key.key)) ?? null,
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        let count = 0;
        for (const [index, row] of [...rows]) {
          if (typeof where.id === "string" && row.id !== where.id) continue;
          if (typeof where.userId === "string" && row.userId !== where.userId) continue;
          if (where.completedAt === null && row.completedAt !== null) continue;
          const expires = where.expiresAt as { lt?: Date } | undefined;
          if (expires?.lt && !(row.expiresAt < expires.lt)) continue;
          rows.delete(index);
          count += 1;
        }
        return { count };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        for (const row of rows.values()) {
          if (row.id === where.id) {
            Object.assign(row, data);
            return row;
          }
        }
        throw Object.assign(new Error("Record to update not found"), { code: "P2025" });
      },
    },
  };
}

async function buildApp(options: {
  clientKind?: "WEB" | "MCP_CONNECTOR";
  handler?: () => Promise<unknown>;
  store?: ReturnType<typeof table>;
} = {}) {
  const store = options.store ?? table();
  const app = Fastify({ logger: false });

  app.decorate("prisma", { connectorIdempotencyRecord: store.delegate } as never);
  app.addHook("onRequest", async (request) => {
    request.authSession = {
      id: "sess-1",
      familyId: "fam-1",
      clientKind: options.clientKind ?? "MCP_CONNECTOR",
      accessLevel: "WRITE",
      dataScope: "WITHHELD",
    };
    request.user = {
      userId: "user-1",
      organisationId: "org-1",
      role: "ADMIN",
      sessionId: "sess-1",
    };
  });

  await app.register(connectorIdempotencyPlugin);

  let created = 0;
  app.post("/things", async (_request, reply) => {
    created += 1;
    return reply.status(201).send({ data: { id: `thing-${created}`, created } });
  });
  app.post("/custom", options.handler ?? (async () => ({ ok: true })));
  app.patch("/things/:id", async () => ({ data: { changed: true } }));

  await app.ready();
  return { app, store, createdCount: () => created };
}

function post(
  app: Awaited<ReturnType<typeof buildApp>>["app"],
  payload: unknown,
  key?: string,
  url = "/things",
) {
  return app.inject({
    method: "POST",
    url,
    payload: payload as never,
    headers: key === undefined ? {} : { [IDEMPOTENCY_HEADER]: key },
  });
}

test("a create with no key behaves exactly as it always did", async () => {
  const { app, store, createdCount } = await buildApp();
  try {
    assert.equal((await post(app, { name: "One" })).statusCode, 201);
    assert.equal((await post(app, { name: "One" })).statusCode, 201);
    assert.equal(createdCount(), 2, "without a key, a repeat is a second create");
    assert.equal(store.rows.size, 0, "and nothing is remembered");
  } finally {
    await app.close();
  }
});

test("a retried create with the same key is answered, not carried out again", async () => {
  const { app, createdCount } = await buildApp();
  try {
    const first = await post(app, { name: "One" }, KEY);
    const second = await post(app, { name: "One" }, KEY);

    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    assert.equal(second.body, first.body, "the retry must be given the first answer");
    assert.equal(second.headers["idempotent-replay"], "true");
    assert.equal(createdCount(), 1, "the handler must have run once");
  } finally {
    await app.close();
  }
});

test("the same key sent with a different body is refused rather than answered", async () => {
  const { app, createdCount } = await buildApp();
  try {
    assert.equal((await post(app, { name: "One" }, KEY)).statusCode, 201);
    const second = await post(app, { name: "Something else" }, KEY);

    assert.equal(second.statusCode, 422);
    assert.equal(second.json().code, "IDEMPOTENCY_KEY_REUSED");
    assert.equal(createdCount(), 1, "the second request must not have run");
  } finally {
    await app.close();
  }
});

test("two identical creates racing on one key make one record", async () => {
  // The second request arrives while the first is still in its handler, which
  // is the case a lookup-then-insert would get wrong and the unique index
  // gets right.
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ran = 0;

  const { app } = await buildApp({
    handler: async () => {
      ran += 1;
      await held;
      return { ok: true };
    },
  });

  try {
    const first = post(app, { name: "One" }, KEY, "/custom");
    // Give the first request time to claim the key before the second starts.
    await new Promise((resolve) => setImmediate(resolve));
    const second = await post(app, { name: "One" }, KEY, "/custom");

    assert.equal(second.statusCode, 409);
    assert.equal(second.json().code, "IDEMPOTENCY_KEY_IN_FLIGHT");
    assert.equal(second.headers["retry-after"], "2");

    release();
    assert.equal((await first).statusCode, 200);
    assert.equal(ran, 1, "only one of the two may reach the handler");
  } finally {
    release();
    await app.close();
  }
});

test("a claim whose attempt never answered is taken over rather than refused forever", async () => {
  const store = table();
  const { app, createdCount } = await buildApp({ store });
  try {
    await post(app, { name: "One" }, KEY);

    // The shape a killed process leaves behind: claimed, never completed.
    const row = [...store.rows.values()][0]!;
    row.completedAt = null;
    row.statusCode = null;
    row.responseBody = null;
    row.createdAt = new Date(Date.now() - IDEMPOTENCY_IN_FLIGHT_GRACE_MS - 1000);

    const retry = await post(app, { name: "One" }, KEY);

    assert.equal(retry.statusCode, 201);
    assert.equal(retry.headers["idempotent-replay"], undefined, 'nothing was there to replay');
    assert.equal(createdCount(), 2, "the abandoned attempt must be allowed to run again");
  } finally {
    await app.close();
  }
});

test("a claim that is merely slow is not taken over", async () => {
  const store = table();
  const { app, createdCount } = await buildApp({ store });
  try {
    await post(app, { name: "One" }, KEY);
    const row = [...store.rows.values()][0]!;
    row.completedAt = null;
    row.statusCode = null;
    row.responseBody = null;
    row.createdAt = new Date(Date.now() - 1000);

    const retry = await post(app, { name: "One" }, KEY);

    assert.equal(retry.statusCode, 409);
    assert.equal(createdCount(), 1);
  } finally {
    await app.close();
  }
});

test("a server error releases the key, so the retry genuinely runs", async () => {
  const store = table();
  const { app } = await buildApp({
    store,
    handler: async () => {
      throw new Error("the database fell over");
    },
  });
  try {
    const failed = await post(app, { name: "One" }, KEY, "/custom");

    assert.equal(failed.statusCode, 500);
    assert.equal(store.rows.size, 0, "a 500 must not be remembered for a day");
  } finally {
    await app.close();
  }
});

test("a refusal the client caused is remembered, because sending it again will not help", async () => {
  const store = table();
  const { app } = await buildApp({
    store,
    handler: async (...args: unknown[]) => {
      const reply = (args as [unknown, { status: (code: number) => { send: (body: unknown) => unknown } }])[1];
      return reply.status(422).send({ code: "SOMETHING_INVALID" });
    },
  });
  try {
    const first = await post(app, { name: "One" }, KEY, "/custom");
    const second = await post(app, { name: "One" }, KEY, "/custom");

    assert.equal(first.statusCode, 422);
    assert.equal(second.statusCode, 422);
    assert.equal(second.headers["idempotent-replay"], "true");
  } finally {
    await app.close();
  }
});

test("a response too large to keep replays as an answer that says so", async () => {
  const store = table();
  const { app } = await buildApp({
    store,
    handler: async () => ({ padding: "x".repeat(IDEMPOTENCY_MAX_BODY_BYTES + 1) }),
  });
  try {
    assert.equal((await post(app, { name: "One" }, KEY, "/custom")).statusCode, 200);
    const replayed = await post(app, { name: "One" }, KEY, "/custom");

    assert.equal(replayed.statusCode, 200);
    assert.equal(replayed.json().code, "IDEMPOTENT_REPLAY_WITHOUT_BODY");
  } finally {
    await app.close();
  }
});

test("an unusable key is refused before anything is created", async () => {
  const { app, createdCount } = await buildApp();
  try {
    for (const key of ["short", "has a space", "bell-character-and-long-enough"]) {
      const response = await post(app, { name: "One" }, key);
      assert.equal(response.statusCode, 400, `"${key}" must be refused`);
      assert.equal(response.json().code, "IDEMPOTENCY_KEY_INVALID");
    }
    assert.equal(createdCount(), 0);
  } finally {
    await app.close();
  }
});

test("a browser session is not given idempotency, because a person sees the response", async () => {
  const { app, store, createdCount } = await buildApp({ clientKind: "WEB" });
  try {
    assert.equal((await post(app, { name: "One" }, KEY)).statusCode, 201);
    assert.equal((await post(app, { name: "One" }, KEY)).statusCode, 201);
    assert.equal(createdCount(), 2);
    assert.equal(store.rows.size, 0);
  } finally {
    await app.close();
  }
});

test("an update is left alone, because expectedUpdatedAt already guards it", async () => {
  const { app, store } = await buildApp();
  try {
    const response = await app.inject({
      method: "PATCH",
      url: "/things/thing-1",
      payload: { name: "Renamed" },
      headers: { [IDEMPOTENCY_HEADER]: KEY },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(store.rows.size, 0, "only creates claim a key");
  } finally {
    await app.close();
  }
});

test("the claim is filed under the user and the key, and names the matched route", async () => {
  // The pair is what the unique index is on, so a key belongs to whoever sent
  // it and cannot be collided with by a colleague who happened to pick the
  // same one. The route is recorded as the pattern, not the requested path,
  // so the table stays readable.
  const store = table();
  const { app } = await buildApp({ store });
  try {
    await post(app, { name: "One" }, KEY);
    const row = [...store.rows.values()][0]!;

    assert.equal(row.userId, "user-1");
    assert.equal(row.organisationId, "org-1");
    assert.equal(row.key, KEY);
    assert.equal(row.method, "POST");
    assert.equal(row.routePattern, "/things");
    assert.ok(row.expiresAt > new Date(), "a claim must expire");
  } finally {
    await app.close();
  }
});

test("two creates inside the claim at the same instant still make one record", async () => {
  // Both requests reach the insert before either has finished it. Nothing
  // earlier can separate them: the unique index is what decides, and the
  // loser must be told the key is taken rather than carrying on.
  let waiting = 0;
  let openTheGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    openTheGate = resolve;
  });

  const store = table({
    beforeInsert: async () => {
      waiting += 1;
      if (waiting >= 2) openTheGate();
      await gate;
    },
  });

  const { app, createdCount } = await buildApp({ store });
  try {
    const [first, second] = await Promise.all([
      post(app, { name: "One" }, KEY),
      post(app, { name: "One" }, KEY),
    ]);

    // Which of the two wins is a race, and so is whether the loser reads the
    // winner's row before or after it completes, so the loser is legitimately
    // either refused as in-flight or answered with the winner's response. What
    // is not negotiable is that exactly one of them is a create.
    const answers = [first, second];
    const creates = answers.filter(
      (answer) => answer.statusCode === 201 && answer.headers["idempotent-replay"] === undefined,
    );

    assert.equal(creates.length, 1, "exactly one of the two may be a create");
    const loser = answers.find((answer) => answer !== creates[0]);
    assert.ok(
      loser?.statusCode === 409 || loser?.headers["idempotent-replay"] === "true",
      `the loser must be refused or replayed, was ${loser?.statusCode}`,
    );
    assert.equal(createdCount(), 1, "the handler must have run exactly once");
    assert.equal(store.rows.size, 1, "and exactly one claim must survive");
  } finally {
    openTheGate();
    await app.close();
  }
});
