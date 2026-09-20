import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

process.env.JWT_SECRET =
  process.env.JWT_SECRET ?? "action-approval-test-jwt-secret-value";

const { requireActionApproval, summarise, APPROVAL_HEADER, APPROVAL_TTL_MS } =
  await import("../middleware/action-approval.js");
const { digestAction } = await import("../utils/action-digest.js");

interface Row {
  id: string;
  organisationId: string;
  userId: string;
  sessionFamilyId: string;
  requestDigest: string;
  summary: string;
  method: string;
  routePattern: string;
  resourceId: string | null;
  expiresAt: Date;
  approvedAt: Date | null;
  consumedAt: Date | null;
}

/**
 * A standing-in approval store.
 *
 * Small enough to read, and it models the two rules the database enforces:
 * a conditional consume that only one caller can win, and at most one live row
 * per session and digest.
 */
function store(initial: Row[] = []) {
  const rows = [...initial];
  let next = initial.length + 1;

  const matches = (row: Row, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, value]) => {
      const actual = (row as unknown as Record<string, unknown>)[key];
      if (value && typeof value === "object" && !(value instanceof Date)) {
        const clause = value as Record<string, unknown>;
        if ("not" in clause) return actual !== clause["not"];
        if ("gt" in clause) return (actual as Date) > (clause["gt"] as Date);
      }
      return actual === value;
    });

  return {
    rows,
    client: {
      authActionApproval: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          rows.find((row) => matches(row, where)) ?? null,
        updateMany: async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Partial<Row>;
        }) => {
          const hits = rows.filter((row) => matches(row, where));
          for (const row of hits) Object.assign(row, data);
          return { count: hits.length };
        },
        create: async ({ data }: { data: Partial<Row> }) => {
          if (
            rows.some(
              (row) =>
                row.sessionFamilyId === data.sessionFamilyId &&
                row.requestDigest === data.requestDigest &&
                row.consumedAt === null,
            )
          ) {
            throw new Error("unique constraint");
          }
          const row: Row = {
            ...(data as Row),
            id: `apr-${next++}`,
            // A row is always created unapproved and unspent, whatever the
            // caller passed: only the password route may approve one.
            approvedAt: null,
            consumedAt: null,
          };
          rows.push(row);
          return row;
        },
      },
    },
  };
}

async function buildApp(options: {
  rows?: Row[];
  clientKind?: "WEB" | "MCP_CONNECTOR";
  familyId?: string;
  /** Record delegates the summary lookup may consult, e.g. `boardMember`. */
  lookups?: Record<string, unknown>;
}) {
  const backing = store(options.rows ?? []);
  const app = Fastify({ logger: false });
  app.decorate("prisma", { ...backing.client, ...(options.lookups ?? {}) } as never);

  app.addHook("onRequest", async (request) => {
    request.user = {
      userId: "usr-1",
      organisationId: "org-1",
      role: "OWNER",
      email: "owner@example.org",
    } as never;
    request.authSession = {
      id: "sess-1",
      familyId: options.familyId ?? "fam-1",
      clientKind: options.clientKind ?? "MCP_CONNECTOR",
      accessLevel: "ADMIN",
      dataScope: "FULL",
    };
  });

  app.delete(
    "/api/v1/board-members/:id",
    { preHandler: [requireActionApproval()] },
    async () => ({ deleted: true }),
  );

  await app.ready();
  return { app, rows: backing.rows };
}

const PATH = "/api/v1/board-members/clx-1";

function digestFor(path = PATH, familyId = "fam-1"): string {
  return digestAction({
    sessionId: familyId,
    method: "DELETE",
    path,
    body: undefined,
  });
}

function approvedRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "apr-live",
    organisationId: "org-1",
    userId: "usr-1",
    sessionFamilyId: "fam-1",
    requestDigest: digestFor(),
    summary: "Permanently delete: board members (DELETE)",
    method: "DELETE",
    routePattern: "/api/v1/board-members/:id",
    resourceId: "clx-1",
    expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
    approvedAt: new Date(),
    consumedAt: null,
    ...overrides,
  };
}

test("the refusal names the record when the charity has one by that identifier", async () => {
  const { app } = await buildApp({
    lookups: { boardMember: { findFirst: async () => ({ name: "Aoife Chairperson", role: "Chair" }) } },
  });
  try {
    const response = await app.inject({ method: "DELETE", url: PATH });
    assert.equal(response.statusCode, 428);
    assert.match(response.json().summary, /Aoife Chairperson/);
    assert.equal(response.json().resourceId, "clx-1");
  } finally {
    await app.close();
  }
});

test("without an approval the request is refused with something to run", async () => {
  const { app, rows } = await buildApp({});
  try {
    const response = await app.inject({ method: "DELETE", url: PATH });

    assert.equal(response.statusCode, 428);
    const body = response.json();
    assert.equal(body.code, "APPROVAL_REQUIRED");
    assert.ok(body.approvalId, "the caller needs an identifier to quote");
    assert.match(body.command, /charitypilot-mcp approve /);
    assert.match(body.summary, /delete/i);
    assert.ok(Date.parse(body.expiresAt) > Date.now());

    assert.equal(rows.length, 1, "exactly one approval is minted");
    assert.equal(rows[0]!.approvedAt, null, "only the password route may approve");
  } finally {
    await app.close();
  }
});

test("asking twice reuses the one approval instead of stacking them up", async () => {
  const { app, rows } = await buildApp({});
  try {
    const first = await app.inject({ method: "DELETE", url: PATH });
    const second = await app.inject({ method: "DELETE", url: PATH });

    assert.equal(
      second.json().approvalId,
      first.json().approvalId,
      "otherwise an agent could collect approvals and spend them one by one",
    );
    assert.equal(rows.length, 1);
  } finally {
    await app.close();
  }
});

test("an approved approval lets exactly that request through", async () => {
  const { app, rows } = await buildApp({ rows: [approvedRow()] });
  try {
    const response = await app.inject({
      method: "DELETE",
      url: PATH,
      headers: { [APPROVAL_HEADER]: "apr-live" },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().deleted, true);
    assert.ok(rows[0]!.consumedAt, "the approval is spent by the request that used it");
  } finally {
    await app.close();
  }
});

test("an approval is single-use", async () => {
  const { app } = await buildApp({ rows: [approvedRow()] });
  try {
    assert.equal(
      (
        await app.inject({
          method: "DELETE",
          url: PATH,
          headers: { [APPROVAL_HEADER]: "apr-live" },
        })
      ).statusCode,
      200,
    );

    const again = await app.inject({
      method: "DELETE",
      url: PATH,
      headers: { [APPROVAL_HEADER]: "apr-live" },
    });
    assert.equal(again.statusCode, 428, "a spent approval buys nothing");
  } finally {
    await app.close();
  }
});

test("an approval for one record cannot delete another", async () => {
  const { app } = await buildApp({ rows: [approvedRow()] });
  try {
    const response = await app.inject({
      method: "DELETE",
      url: "/api/v1/board-members/clx-2",
      headers: { [APPROVAL_HEADER]: "apr-live" },
    });

    assert.equal(
      response.statusCode,
      428,
      "this is the difference between approving an action and elevating a session",
    );
  } finally {
    await app.close();
  }
});

test("an approval nobody granted is refused", async () => {
  const { app } = await buildApp({ rows: [approvedRow({ approvedAt: null })] });
  try {
    const response = await app.inject({
      method: "DELETE",
      url: PATH,
      headers: { [APPROVAL_HEADER]: "apr-live" },
    });
    assert.equal(response.statusCode, 428);
  } finally {
    await app.close();
  }
});

test("an expired approval is refused", async () => {
  const { app } = await buildApp({
    rows: [approvedRow({ expiresAt: new Date(Date.now() - 1000) })],
  });
  try {
    const response = await app.inject({
      method: "DELETE",
      url: PATH,
      headers: { [APPROVAL_HEADER]: "apr-live" },
    });
    assert.equal(response.statusCode, 428);
  } finally {
    await app.close();
  }
});

test("another session's approval is refused", async () => {
  const { app } = await buildApp({
    rows: [approvedRow({ sessionFamilyId: "fam-other" })],
  });
  try {
    const response = await app.inject({
      method: "DELETE",
      url: PATH,
      headers: { [APPROVAL_HEADER]: "apr-live" },
    });
    assert.equal(
      response.statusCode,
      428,
      "a second agent must not spend the first one's approval",
    );
  } finally {
    await app.close();
  }
});

test("every refusal looks the same, so the approval space cannot be mapped", async () => {
  const cases: Array<[string, Row]> = [
    ["not approved", approvedRow({ approvedAt: null })],
    ["expired", approvedRow({ expiresAt: new Date(Date.now() - 1) })],
    ["another session family", approvedRow({ sessionFamilyId: "fam-other" })],
    ["already used", approvedRow({ consumedAt: new Date() })],
  ];

  const bodies: string[] = [];
  for (const [, row] of cases) {
    const { app } = await buildApp({ rows: [row] });
    try {
      const response = await app.inject({
        method: "DELETE",
        url: PATH,
        headers: { [APPROVAL_HEADER]: "apr-live" },
      });
      bodies.push(response.json().code);
    } finally {
      await app.close();
    }
  }

  assert.deepEqual(new Set(bodies), new Set(["APPROVAL_REQUIRED"]));
});

test("a web session never meets any of this", async () => {
  const { app, rows } = await buildApp({ clientKind: "WEB" });
  try {
    const response = await app.inject({ method: "DELETE", url: PATH });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      rows,
      [],
      "a person looking at the screen they are changing should not be trained to type their password at prompts",
    );
  } finally {
    await app.close();
  }
});

test("the summary describes the route, not anything the caller sent", () => {
  assert.equal(
    summarise("DELETE", "/api/v1/board-members/:id"),
    "Permanently delete: board members (DELETE)",
  );
  assert.match(summarise("PATCH", "/api/v1/team/members/:id/role"), /^Change: /);
  assert.match(
    summarise("POST", "/api/v1/governing-acts/:id/void"),
    /governing acts void/,
  );
});
