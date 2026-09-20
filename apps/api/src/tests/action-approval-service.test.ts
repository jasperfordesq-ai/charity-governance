import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";

const { listPendingApprovals, grantApproval } = await import(
  "../services/action-approval.service.js"
);

const PASSWORD = "the-real-password";
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

const NOW = new Date("2026-09-20T12:00:00.000Z");

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "apr-1",
    userId: "usr-1",
    organisationId: "org-1",
    summary: 'Permanently delete risk "Flood damage"',
    method: "DELETE",
    routePattern: "/api/v1/governance-registers/risks/:id",
    resourceId: "risk-1",
    createdAt: new Date("2026-09-20T11:59:00.000Z"),
    expiresAt: new Date("2026-09-20T12:04:00.000Z"),
    approvedAt: null,
    consumedAt: null,
    ...overrides,
  };
}

/** Enough Prisma to answer the two queries, honouring every where clause. */
function prismaWith(rows: Record<string, unknown>[], passwordHash = PASSWORD_HASH) {
  const matches = (candidate: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => {
      const actual = candidate[key];
      if (value && typeof value === "object" && !(value instanceof Date)) {
        const clause = value as Record<string, unknown>;
        if ("gt" in clause) return (actual as Date) > (clause["gt"] as Date);
        if ("not" in clause) return actual !== clause["not"];
      }
      return actual === value;
    });

  return {
    calls: [] as Record<string, unknown>[],
    user: { findUnique: async () => (passwordHash ? { passwordHash } : null) },
    authActionApproval: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((candidate) => matches(candidate, where)),
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((candidate) => matches(candidate, where)) ?? null,
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const hits = rows.filter((candidate) => matches(candidate, where));
        for (const hit of hits) Object.assign(hit, data);
        return { count: hits.length };
      },
    },
  } as never;
}

const CALLER = { userId: "usr-1", organisationId: "org-1" };

test("the pending list shows this person's own unspent approvals", async () => {
  const prisma = prismaWith([row()]);

  const pending = await listPendingApprovals(prisma, CALLER, NOW);

  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.approvalId, "apr-1");
  assert.match(pending[0]!.summary, /Flood damage/);
  assert.equal(pending[0]!.resourceId, "risk-1");
  assert.equal(pending[0]!.expiresAt, "2026-09-20T12:04:00.000Z");
});

test("an approval that is granted, spent, expired or somebody else's is not pending", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["already granted", { approvedAt: new Date() }],
    ["already spent", { approvedAt: new Date(), consumedAt: new Date() }],
    ["expired", { expiresAt: new Date("2026-09-20T11:00:00.000Z") }],
    ["another person's", { userId: "usr-2" }],
    ["another charity's", { organisationId: "org-2" }],
  ];

  for (const [name, overrides] of cases) {
    const pending = await listPendingApprovals(prismaWith([row(overrides)]), CALLER, NOW);
    assert.deepEqual(pending, [], `${name} must not be offered for granting`);
  }
});

test("the right password grants the approval and reports what it was", async () => {
  const rows = [row()];
  const prisma = prismaWith(rows);

  const granted = await grantApproval(
    prisma,
    { ...CALLER, approvalId: "apr-1", password: PASSWORD },
    NOW,
  );

  assert.ok(granted);
  assert.match(granted.summary!, /Flood damage/);
  assert.equal(rows[0]!["approvedAt"], NOW, "the row is what records the grant");
});

test("a wrong password grants nothing and says nothing about why", async () => {
  const rows = [row()];

  const granted = await grantApproval(
    prismaWith(rows),
    { ...CALLER, approvalId: "apr-1", password: "not-the-password" },
    NOW,
  );

  assert.equal(granted, null);
  assert.equal(rows[0]!["approvedAt"], null, "a wrong password must approve nothing");
});

test("the right password grants nothing when the approval is not the caller's", async () => {
  // The refusal is identical to a wrong password: a caller must not learn that
  // an identifier exists by being told it belongs to somebody else.
  for (const overrides of [{ userId: "usr-2" }, { organisationId: "org-2" }]) {
    const rows = [row(overrides)];
    const granted = await grantApproval(
      prismaWith(rows),
      { ...CALLER, approvalId: "apr-1", password: PASSWORD },
      NOW,
    );
    assert.equal(granted, null);
    assert.equal(rows[0]!["approvedAt"], null);
  }
});

test("an expired or already-spent approval cannot be granted", async () => {
  for (const overrides of [
    { expiresAt: new Date("2026-09-20T11:00:00.000Z") },
    { approvedAt: new Date("2026-09-20T11:58:00.000Z"), consumedAt: new Date() },
  ]) {
    const granted = await grantApproval(
      prismaWith([row(overrides)]),
      { ...CALLER, approvalId: "apr-1", password: PASSWORD },
      NOW,
    );
    assert.equal(granted, null);
  }
});

test("an account that does not exist still costs a password comparison", async () => {
  const granted = await grantApproval(
    prismaWith([row()], ""),
    { ...CALLER, approvalId: "apr-1", password: PASSWORD },
    NOW,
  );

  assert.equal(granted, null, 'a missing account must not answer "yes" or answer faster');
});
