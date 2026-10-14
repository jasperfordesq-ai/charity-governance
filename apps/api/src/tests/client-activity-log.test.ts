import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

process.env.JWT_SECRET =
  process.env.JWT_SECRET ?? "client-activity-log-test-jwt-secret-value";

const { clientActivityLogPlugin, ACTIVITY_REASON_HEADER, ACTIVITY_REASON_ENCODING_HEADER } = await import(
  "../plugins/client-activity-log.js"
);

type Row = Record<string, unknown>;

interface Posture {
  clientKind: "WEB" | "MCP_CONNECTOR";
  accessLevel: "READ" | "WRITE" | "ADMIN";
}

/**
 * Builds an app with the hook installed and one route per method under test.
 *
 * The session is decorated by a hook standing in for authGuard, because what
 * is being tested is what the activity hook does with a session, not how a
 * session comes to exist.
 */
async function buildApp(options: {
  posture?: Posture | null;
  rows: Row[];
  createFails?: boolean;
  status?: number;
}) {
  const app = Fastify({ logger: false });
  app.decorate("prisma", {
    clientActivityEvent: {
      create: async ({ data }: { data: Row }) => {
        if (options.createFails) throw new Error("database is on fire");
        options.rows.push(data);
        return data;
      },
    },
  } as never);

  await app.register(clientActivityLogPlugin);

  app.addHook("onRequest", async (request) => {
    if (options.posture === null) return;
    request.user = {
      userId: "usr-1",
      organisationId: "org-1",
      role: "OWNER",
      email: "owner@example.org",
    } as never;
    request.authSession = {
      id: "sess-1",
      familyId: "fam-1",
      clientKind: options.posture?.clientKind ?? "MCP_CONNECTOR",
      accessLevel: options.posture?.accessLevel ?? "WRITE",
      dataScope: "WITHHELD",
    };
  });

  const handler = async (_request: unknown, reply: { status: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply.status(options.status ?? 200).send({ ok: true });

  app.get("/board-members/:id", handler as never);
  app.post("/board-members", handler as never);
  app.patch("/board-members/:id", handler as never);
  app.delete("/board-members/:id", handler as never);

  await app.ready();
  return app;
}

/**
 * The hook runs in onResponse, after the reply is sent, so inject() can return
 * before the row is written. Yielding once lets the hook's promise settle.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("an unsafe request from a connector session is recorded once", async () => {
  const rows: Row[] = [];
  const app = await buildApp({ rows, status: 201 });
  try {
    await app.inject({ method: "POST", url: "/board-members", payload: {} });
    await settle();

    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row["method"], "POST");
    assert.equal(row["statusCode"], 201);
    assert.equal(row["sessionId"], "sess-1");
    assert.equal(row["userId"], "usr-1");
    assert.equal(row["organisationId"], "org-1");
    assert.equal(row["clientKind"], "MCP_CONNECTOR");
    assert.equal(row["accessLevel"], "WRITE");
  } finally {
    await app.close();
  }
});

test("the route pattern is recorded, not the identifier-bearing path", async () => {
  const rows: Row[] = [];
  const app = await buildApp({ rows });
  try {
    await app.inject({ method: "PATCH", url: "/board-members/clx-123", payload: {} });
    await settle();

    assert.equal(
      rows[0]!["routePattern"],
      "/board-members/:id",
      "a path here would make the column a second, unindexed copy of the data",
    );
    assert.equal(rows[0]!["resourceId"], "clx-123", "the identifier has its own column");
  } finally {
    await app.close();
  }
});

test("a read writes nothing, so the writes are not buried in noise", async () => {
  const rows: Row[] = [];
  const app = await buildApp({ rows });
  try {
    await app.inject({ method: "GET", url: "/board-members/clx-123" });
    await settle();

    assert.deepEqual(rows, []);
  } finally {
    await app.close();
  }
});

test("a web session writes nothing: the browser session is already a human", async () => {
  const rows: Row[] = [];
  const app = await buildApp({
    rows,
    posture: { clientKind: "WEB", accessLevel: "ADMIN" },
  });
  try {
    await app.inject({ method: "POST", url: "/board-members", payload: {} });
    await settle();

    assert.deepEqual(rows, []);
  } finally {
    await app.close();
  }
});

test("an unauthenticated request writes nothing rather than a row with no actor", async () => {
  const rows: Row[] = [];
  const app = await buildApp({ rows, posture: null });
  try {
    await app.inject({ method: "POST", url: "/board-members", payload: {} });
    await settle();

    assert.deepEqual(rows, []);
  } finally {
    await app.close();
  }
});

test("a refused attempt is recorded, because it is the row most worth reading", async () => {
  const rows: Row[] = [];
  const app = await buildApp({ rows, status: 403 });
  try {
    await app.inject({ method: "DELETE", url: "/board-members/clx-9", payload: {} });
    await settle();

    assert.equal(rows.length, 1);
    assert.equal(rows[0]!["statusCode"], 403);
    assert.equal(rows[0]!["method"], "DELETE");
  } finally {
    await app.close();
  }
});

test("the reason the client gave is kept, stripped of control characters and capped", async () => {
  const rows: Row[] = [];
  const app = await buildApp({ rows });
  try {
    await app.inject({
      method: "POST",
      url: "/board-members",
      headers: {
        [ACTIVITY_REASON_HEADER]: `Correcting the AGM date\u001b[2K\u0007 at the owner's request${"!".repeat(600)}`,
      },
      payload: {},
    });
    await settle();

    const reason = String(rows[0]!["reason"]);
    assert.ok(reason.startsWith("Correcting the AGM date"));
    assert.ok(
      !/[\u0000-\u001f\u007f]/.test(reason),
      "a record that can move a terminal cursor is a record that can lie about what it says",
    );
    assert.equal(reason.length, 500, "capped, so the column is a note and not a store");
  } finally {
    await app.close();
  }
});

// The incident of 2026-10-14: a reason with an em dash could not be sent as a
// header at all. The connector now percent-encodes such a reason and says so;
// the audit row must hold the text as written, never its encoding.
const UNICODE_REASONS = [
  "Code of Conduct — Trustee Declaration, signed and filed",
  "Dearbhú ón gcathaoirleach: síníodh an cód iompair",
  "Both declarations signed 🎉 and uploaded as evidence",
];

for (const written of UNICODE_REASONS) {
  test(`a percent-encoded reason is stored as written: ${written}`, async () => {
    const rows: Row[] = [];
    const app = await buildApp({ rows });
    try {
      await app.inject({
        method: "POST",
        url: "/board-members",
        headers: {
          [ACTIVITY_REASON_HEADER]: encodeURIComponent(written),
          [ACTIVITY_REASON_ENCODING_HEADER]: "percent",
        },
        payload: {},
      });
      await settle();
      assert.equal(rows[0]!["reason"], written);
    } finally {
      await app.close();
    }
  });
}

test("the connector's own encoder and this decoder agree, end to end", async () => {
  // Through the connector's build, as search-route.test.ts does: the two
  // packages compile apart, and this is the one place their halves meet.
  const built = new URL("../../../../mcp/dist/client.js", import.meta.url).href;
  let reasonHeaders: (reason: string) => Record<string, string>;
  try {
    ({ reasonHeaders } = (await import(built)) as { reasonHeaders: typeof reasonHeaders });
  } catch {
    assert.fail("The connector is not built, so this could not be checked. Run `npm run build` in mcp/.");
  }
  for (const written of [...UNICODE_REASONS, "Plain ASCII reason, 100% unchanged"]) {
    const rows: Row[] = [];
    const app = await buildApp({ rows });
    try {
      await app.inject({ method: "POST", url: "/board-members", headers: reasonHeaders(written), payload: {} });
      await settle();
      assert.equal(rows[0]!["reason"], written);
    } finally {
      await app.close();
    }
  }
});

test("an encoded control character is stripped exactly like a literal one", async () => {
  const rows: Row[] = [];
  const app = await buildApp({ rows });
  try {
    await app.inject({
      method: "POST",
      url: "/board-members",
      headers: {
        [ACTIVITY_REASON_HEADER]: encodeURIComponent("Signed —\u001b[2K declaration"),
        [ACTIVITY_REASON_ENCODING_HEADER]: "percent",
      },
      payload: {},
    });
    await settle();
    const reason = String(rows[0]!["reason"]);
    assert.ok(!/[\u0000-\u001f\u007f]/.test(reason), reason);
    assert.ok(reason.startsWith("Signed —"));
  } finally {
    await app.close();
  }
});

test("without the encoding marker a percent sign is just text, and malformed encoding is kept", async () => {
  for (const [headers, expected] of [
    [{ [ACTIVITY_REASON_HEADER]: "Raised to 100%20 of target" }, "Raised to 100%20 of target"],
    [{ [ACTIVITY_REASON_HEADER]: "broken %E2%80 text", [ACTIVITY_REASON_ENCODING_HEADER]: "percent" }, "broken %E2%80 text"],
  ] as const) {
    const rows: Row[] = [];
    const app = await buildApp({ rows });
    try {
      await app.inject({ method: "POST", url: "/board-members", headers, payload: {} });
      await settle();
      assert.equal(rows[0]!["reason"], expected);
    } finally {
      await app.close();
    }
  }
});

test("a decoded reason is capped at 500 code points without splitting an emoji", async () => {
  const rows: Row[] = [];
  const app = await buildApp({ rows });
  try {
    await app.inject({
      method: "POST",
      url: "/board-members",
      headers: {
        [ACTIVITY_REASON_HEADER]: encodeURIComponent("a".repeat(499) + "🎉🎉"),
        [ACTIVITY_REASON_ENCODING_HEADER]: "percent",
      },
      payload: {},
    });
    await settle();
    const reason = String(rows[0]!["reason"]);
    assert.equal(Array.from(reason).length, 500);
    assert.ok(reason.endsWith("🎉"));
  } finally {
    await app.close();
  }
});

test("no reason header means no reason, not an empty string", async () => {
  const rows: Row[] = [];
  const app = await buildApp({ rows });
  try {
    await app.inject({ method: "POST", url: "/board-members", payload: {} });
    await settle();

    assert.equal(rows[0]!["reason"], null);
  } finally {
    await app.close();
  }
});

test("a failure to record never turns a completed write into an error", async () => {
  const rows: Row[] = [];
  const app = await buildApp({ rows, createFails: true, status: 201 });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/board-members",
      payload: {},
    });
    await settle();

    assert.equal(
      response.statusCode,
      201,
      "the response was already sent; failing here would leave the client and the database disagreeing",
    );
  } finally {
    await app.close();
  }
});

test("a request matching no route still records what was attempted", async () => {
  const rows: Row[] = [];
  const app = await buildApp({ rows });
  try {
    await app.inject({ method: "POST", url: "/does-not-exist?secret=x", payload: {} });
    await settle();

    assert.equal(rows.length, 1, "an agent probing for routes must still be visible");
    assert.equal(rows[0]!["routePattern"], "(unmatched) /does-not-exist");
    assert.equal(rows[0]!["statusCode"], 404);
  } finally {
    await app.close();
  }
});
