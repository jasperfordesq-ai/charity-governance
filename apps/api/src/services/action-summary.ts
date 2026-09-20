import type { PrismaClient } from "@prisma/client";
import { summarise } from "../middleware/action-approval.js";

/**
 * Names the record a destructive action is about, in words a person can check
 * against what the agent told them.
 *
 * Every lookup is scoped to the charity, and every field it reads is one the
 * connector's personal-data gate classifies safe, because this text is
 * returned in the refusal the agent sees as well as in the terminal. A
 * trustee's name is on the public register and may appear; the trustee named
 * in a conflict record is not, so a conflict is described by its dates and
 * status alone.
 *
 * A lookup that finds nothing, or throws, falls back to the route and the
 * identifier. The summary must never be the reason an approval cannot be
 * minted.
 */
type Params = Record<string, string | undefined>;
type Lookup = (
  prisma: PrismaClient,
  organisationId: string,
  params: Params,
) => Promise<string | null>;

const NAME_MAX = 120;

function day(value: Date | null | undefined): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : "an unknown date";
}

function quoted(value: string | null | undefined): string {
  const text = (value ?? "").replace(/[\r\n"]/g, " ").trim().slice(0, NAME_MAX);
  return `"${text || "(unnamed)"}"`;
}

function idOf(params: Params, key = "id"): string {
  return params[key] ?? "";
}

const LOOKUPS: Record<string, Lookup> = {
  "DELETE /api/v1/board-members/:id": async (prisma, organisationId, params) => {
    const row = await prisma.boardMember.findFirst({
      where: { id: idOf(params), organisationId },
      select: { name: true, role: true },
    });
    return row ? `Permanently delete board member ${quoted(row.name)} (${row.role})` : null;
  },
  "DELETE /api/v1/governance-registers/conflicts/:id": async (prisma, organisationId, params) => {
    const row = await prisma.conflictRecord.findFirst({
      where: { id: idOf(params), organisationId },
      select: { dateDeclared: true, status: true },
    });
    return row
      ? `Permanently delete the conflict of interest declared ${day(row.dateDeclared)} (${row.status})`
      : null;
  },
  "DELETE /api/v1/governance-registers/risks/:id": async (prisma, organisationId, params) => {
    const row = await prisma.riskRecord.findFirst({
      where: { id: idOf(params), organisationId },
      select: { title: true },
    });
    return row ? `Permanently delete risk ${quoted(row.title)}` : null;
  },
  "DELETE /api/v1/governance-registers/complaints/:id": async (prisma, organisationId, params) => {
    const row = await prisma.complaintRecord.findFirst({
      where: { id: idOf(params), organisationId },
      select: { receivedDate: true, status: true },
    });
    return row
      ? `Permanently delete the complaint received ${day(row.receivedDate)} (${row.status})`
      : null;
  },
  "DELETE /api/v1/governance-registers/fundraising/:id": async (prisma, organisationId, params) => {
    const row = await prisma.fundraisingRecord.findFirst({
      where: { id: idOf(params), organisationId },
      select: { name: true },
    });
    return row ? `Permanently delete fundraising activity ${quoted(row.name)}` : null;
  },
  "DELETE /api/v1/deadlines/:id": async (prisma, organisationId, params) => {
    const row = await prisma.deadline.findFirst({
      where: { id: idOf(params), organisationId },
      select: { title: true, dueDate: true },
    });
    return row ? `Permanently delete deadline ${quoted(row.title)} due ${day(row.dueDate)}` : null;
  },
  "DELETE /api/v1/documents/:id": async (prisma, organisationId, params) => {
    const row = await prisma.document.findFirst({
      where: { id: idOf(params), organisationId },
      select: { name: true, category: true },
    });
    return row
      ? `Permanently delete document ${quoted(row.name)} (${row.category}) and its stored file`
      : null;
  },
  "DELETE /api/v1/documents/:id/standards/:standardId": async (prisma, organisationId, params) => {
    const [document, standard] = await Promise.all([
      prisma.document.findFirst({
        where: { id: idOf(params), organisationId },
        select: { name: true },
      }),
      // Reference data describing the Governance Code itself, identical for
      // every charity, so it carries no organisationId to scope on.
      prisma.governanceStandard.findFirst({
        where: { id: idOf(params, "standardId") },
        select: { code: true },
      }),
    ]);
    if (!document) return null;
    return `Remove document ${quoted(document.name)} as evidence for standard ${standard?.code ?? idOf(params, "standardId")}`;
  },
  "POST /api/v1/governing-acts/:id/void": async (prisma, organisationId, params) => {
    const row = await prisma.governingAct.findFirst({
      where: { id: idOf(params), organisationId },
      select: { reference: true, title: true },
    });
    return row ? `Void minute-book entry ${row.reference} ${quoted(row.title)}` : null;
  },
  // Keyed by `publicationId`, not `id` — the erase route's own param name —
  // which is also why `resourceId` below is null for this route: it is
  // derived from `params["id"]` alone. The document is already gone by the
  // time a publication can be erased (that is what RETIRED means), so
  // `documentId` — a bare id, not a name — is the only remaining reference
  // to it; `pageTitle` is what actually makes the prompt useful.
  "POST /api/v1/integrations/confluence/publications/:publicationId/erase": async (
    prisma,
    organisationId,
    params,
  ) => {
    const row = await prisma.documentPublication.findFirst({
      where: { id: idOf(params, "publicationId"), organisationId, provider: "confluence" },
      select: { pageTitle: true, documentId: true },
    });
    return row
      ? `Permanently erase the Confluence page ${quoted(row.pageTitle)} for deleted document ${row.documentId}`
      : null;
  },
};

export interface ActionDescription {
  summary: string;
  resourceId: string | null;
}

export async function describeAction(
  prisma: PrismaClient,
  organisationId: string,
  method: string,
  routePattern: string,
  params: Params,
): Promise<ActionDescription> {
  const id = params["id"];
  const resourceId = typeof id === "string" && id.length > 0 ? id.slice(0, 200) : null;

  const lookup = LOOKUPS[`${method.toUpperCase()} ${routePattern}`];
  let named: string | null = null;
  if (lookup) {
    try {
      named = await lookup(prisma, organisationId, params);
    } catch {
      named = null;
    }
  }

  const generic = summarise(method, routePattern);
  return {
    summary: named ?? (resourceId ? `${generic}: record ${resourceId}` : generic),
    resourceId,
  };
}
