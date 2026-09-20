import assert from "node:assert/strict";
import test from "node:test";

const { describeAction } = await import("../services/action-summary.js");

function prismaWith(delegates: Record<string, unknown>) {
  return delegates as never;
}

test("deleting a board member names the trustee, scoped to the charity", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const prisma = prismaWith({
    boardMember: {
      findFirst: async (args: { where: Record<string, unknown> }) => {
        seen.push(args.where);
        return { name: "Aoife Chairperson", role: "Chair" };
      },
    },
  });

  const described = await describeAction(prisma, "org-1", "DELETE", "/api/v1/board-members/:id", { id: "bm-1" });

  assert.equal(described.summary, 'Permanently delete board member "Aoife Chairperson" (Chair)');
  assert.equal(described.resourceId, "bm-1");
  assert.deepEqual(seen[0], { id: "bm-1", organisationId: "org-1" }, "the lookup must be tenant-scoped");
});

test("a conflict record is described by its dates and status, never by the trustee named in it", async () => {
  const prisma = prismaWith({
    conflictRecord: {
      findFirst: async () => ({
        dateDeclared: new Date("2026-01-04T00:00:00.000Z"),
        status: "MANAGED",
        trusteeName: "Should Not Appear",
      }),
    },
  });

  const described = await describeAction(prisma, "org-1", "DELETE", "/api/v1/governance-registers/conflicts/:id", { id: "c-1" });

  assert.match(described.summary, /conflict of interest declared 2026-01-04 \(MANAGED\)/);
  assert.ok(!described.summary.includes("Should Not Appear"));
});

test("a record that cannot be found falls back to the route and the identifier", async () => {
  const prisma = prismaWith({ riskRecord: { findFirst: async () => null } });

  const described = await describeAction(prisma, "org-1", "DELETE", "/api/v1/governance-registers/risks/:id", { id: "r-9" });

  assert.equal(described.summary, "Permanently delete: governance registers risks (DELETE): record r-9");
  assert.equal(described.resourceId, "r-9");
});

test("a route with no lookup, or a lookup that throws, still yields a summary", async () => {
  const throwing = prismaWith({ document: { findFirst: async () => { throw new Error("db down"); } } });
  const described = await describeAction(throwing, "org-1", "DELETE", "/api/v1/documents/:id", { id: "d-1" });
  assert.match(described.summary, /^Permanently delete: documents \(DELETE\): record d-1$/);

  const unknown = await describeAction(prismaWith({}), "org-1", "POST", "/api/v1/team/members/:id/suspend", { id: "u-1" });
  assert.equal(unknown.summary, "Carry out: team members suspend (POST): record u-1");
});

test("unlinking names both the document and the standard", async () => {
  const prisma = prismaWith({
    document: { findFirst: async () => ({ name: "Safeguarding Policy" }) },
    governanceStandard: { findFirst: async () => ({ code: "3.2" }) },
  });
  const described = await describeAction(prisma, "org-1", "DELETE", "/api/v1/documents/:id/standards/:standardId", { id: "d-1", standardId: "s-1" });
  assert.equal(described.summary, 'Remove document "Safeguarding Policy" as evidence for standard 3.2');
});

test("voiding names the minute by reference and title", async () => {
  const prisma = prismaWith({
    governingAct: { findFirst: async () => ({ reference: "BM-2026-03", title: "March board meeting" }) },
  });
  const described = await describeAction(prisma, "org-1", "POST", "/api/v1/governing-acts/:id/void", { id: "g-1" });
  assert.equal(described.summary, 'Void minute-book entry BM-2026-03 "March board meeting"');
});

test("erasing a Confluence page names the page and the document it belonged to, scoped to the charity", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const prisma = prismaWith({
    documentPublication: {
      findFirst: async (args: { where: Record<string, unknown> }) => {
        seen.push(args.where);
        return { pageTitle: "Board minutes 2026-08", documentId: "doc-9" };
      },
    },
  });

  // The route's own param is `publicationId`, not `id` — this is exactly the
  // lookup that was missing before this fix, and why an operator previously
  // saw a bare "Carry out: ..." prompt with no page named in it.
  const described = await describeAction(
    prisma,
    "org-1",
    "POST",
    "/api/v1/integrations/confluence/publications/:publicationId/erase",
    { publicationId: "pub-1" },
  );

  assert.equal(
    described.summary,
    'Permanently erase the Confluence page "Board minutes 2026-08" for deleted document doc-9',
  );
  assert.deepEqual(seen[0], { id: "pub-1", organisationId: "org-1", provider: "confluence" });
});
