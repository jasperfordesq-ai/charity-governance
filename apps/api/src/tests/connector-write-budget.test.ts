import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

const {
  connectorWriteBudgetPlugin,
  createWriteBudget,
  CONNECTOR_WRITE_MAX_PER_MINUTE,
} = await import("../plugins/connector-write-budget.js");

interface Posture {
  clientKind: "WEB" | "MCP_CONNECTOR";
  sessionId?: string;
}

async function buildApp(options: {
  posture?: Posture;
  max?: number;
  clock?: () => number;
}) {
  const app = Fastify({ logger: false });
  await app.register(connectorWriteBudgetPlugin, {
    budget: createWriteBudget(options.max ?? 3, options.clock ?? Date.now),
  });

  app.addHook("onRequest", async (request) => {
    // The session id may be varied per request, so the hook's own keying is
    // exercised rather than only the budget object underneath it.
    const fromHeader = request.headers["x-test-session"];
    request.authSession = {
      id:
        (typeof fromHeader === "string" ? fromHeader : undefined)
        ?? options.posture?.sessionId
        ?? "sess-1",
      familyId: "fam-1",
      clientKind: options.posture?.clientKind ?? "MCP_CONNECTOR",
      accessLevel: "WRITE",
      dataScope: "WITHHELD",
    };
  });

  const handler = async () => ({ ok: true });
  app.get("/thing", handler);
  app.post("/thing", handler);

  await app.ready();
  return app;
}

async function post(app: Awaited<ReturnType<typeof buildApp>>) {
  return app.inject({ method: "POST", url: "/thing", payload: {} });
}

test("a connector session may write up to its budget and no further", async () => {
  const app = await buildApp({ max: 3 });
  try {
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await post(app)).statusCode, 200, `write ${i + 1} must be allowed`);
    }

    const refused = await post(app);
    assert.equal(refused.statusCode, 429);
    assert.equal(refused.json().code, "CONNECTOR_WRITE_LIMIT");
    assert.ok(
      Number(refused.headers["retry-after"]) >= 1,
      "a client obeying retry-after must not come back too early",
    );
  } finally {
    await app.close();
  }
});

test("reads are not counted, so a refused write cannot be caused by reading", async () => {
  const app = await buildApp({ max: 3 });
  try {
    for (let i = 0; i < 20; i += 1) {
      assert.equal((await app.inject({ method: "GET", url: "/thing" })).statusCode, 200);
    }
    assert.equal((await post(app)).statusCode, 200);
  } finally {
    await app.close();
  }
});

test("a web session is untouched: the shared limiter is the browser's business", async () => {
  const app = await buildApp({ max: 3, posture: { clientKind: "WEB" } });
  try {
    for (let i = 0; i < 10; i += 1) {
      assert.equal((await post(app)).statusCode, 200, `web write ${i + 1}`);
    }
  } finally {
    await app.close();
  }
});

test("one session cannot spend another's budget", () => {
  const budget = createWriteBudget(2);

  assert.equal(budget.take("a").allowed, true);
  assert.equal(budget.take("a").allowed, true);
  assert.equal(budget.take("a").allowed, false);

  assert.equal(
    budget.take("b").allowed,
    true,
    "a second connector session starts with its own budget",
  );
});

test("the window slides, so a refusal is temporary rather than permanent", () => {
  let now = 1_000_000;
  const budget = createWriteBudget(2, () => now);

  assert.equal(budget.take("a").allowed, true);
  assert.equal(budget.take("a").allowed, true);
  assert.equal(budget.take("a").allowed, false);

  now += 61_000;
  assert.equal(
    budget.take("a").allowed,
    true,
    "a minute later the earlier writes are outside the window",
  );
});

test("a refused attempt does not extend the refusal", () => {
  let now = 1_000_000;
  const budget = createWriteBudget(1, () => now);

  assert.equal(budget.take("a").allowed, true);
  now += 30_000;
  assert.equal(budget.take("a").allowed, false);
  now += 31_000;
  assert.equal(
    budget.take("a").allowed,
    true,
    "counting the refusals would let a retry loop keep itself locked out forever",
  );
});

test("spent sessions are swept, so rotation does not grow the map forever", () => {
  let now = 1_000_000;
  const budget = createWriteBudget(5, () => now);

  for (let i = 0; i < 50; i += 1) budget.take(`sess-${i}`);
  assert.equal(budget.size, 50);

  now += 61_000;
  budget.sweep();
  assert.equal(budget.size, 0, "sessions rotate every fifteen minutes; the map must not");
});

test("the shipped budget is well under the shared address limit", () => {
  assert.ok(
    CONNECTOR_WRITE_MAX_PER_MINUTE < 100,
    "the point is that a write loop cannot exhaust the bucket the owner's browser shares",
  );
});

test("the hook itself keys by session, not by client kind alone", async () => {
  const app = await buildApp({ max: 2 });
  try {
    const write = (session: string) =>
      app.inject({
        method: "POST",
        url: "/thing",
        headers: { "x-test-session": session },
        payload: {},
      });

    assert.equal((await write("sess-a")).statusCode, 200);
    assert.equal((await write("sess-a")).statusCode, 200);
    assert.equal((await write("sess-a")).statusCode, 429);

    assert.equal(
      (await write("sess-b")).statusCode,
      200,
      "a second connector session must not inherit the first one's spent budget",
    );
  } finally {
    await app.close();
  }
});
