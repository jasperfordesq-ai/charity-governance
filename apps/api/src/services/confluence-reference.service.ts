/**
 * Citing a page the charity already has, as evidence for one of their
 * documents.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * THE REFERENCE MODEL. CHARITYPILOT NEVER WRITES TO A CITED PAGE.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * This is the direction the DPO signed off on 2026-09-18: Confluence
 * authoritative for the documents deliberately managed there, and CharityPilot
 * holding references to pages and versions rather than duplicate copies. It is
 * the opposite of `document-publication.service.ts`, which creates and
 * maintains pages of its own.
 *
 * **There is no update path and no erasure path in this module, and there must
 * not be one.** A cited page is the charity's own content, written by their
 * people, in their site. CharityPilot's entire relationship to it is: read it
 * once to confirm it exists and capture what was cited, then point at it.
 * Unciting removes CharityPilot's record and touches nothing in Confluence —
 * the owner's 2026-09-19 ruling, applied to a page we never owned at all.
 *
 * ## The version is the point
 *
 * A citation without a version is not evidence. "Our conflicts-of-interest
 * policy is this page" decays silently as the page is edited; "this page, at
 * version 7, cited on 21 September" is something a trustee or a regulator can
 * check. So the page is READ at citation time and the version recorded, and
 * nothing in this module then keeps it current: `staleness` is reported, not
 * repaired, because updating the number would destroy the only thing the record
 * was for.
 */
import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/app-error.js';
import type { ConfluenceClient } from './confluence-client.js';
import { getPage as getPageDefault, type ConfluencePage } from './confluence-pages.js';

export type ConfluenceReference = {
  id: string;
  documentId: string;
  cloudId: string;
  pageId: string;
  pageTitle: string;
  pageVersion: number;
  pageUrl: string | null;
  citedAt: string;
};

type ReferenceClient = {
  confluenceReference: {
    findMany(args: {
      where: Record<string, unknown>;
      orderBy?: Array<Record<string, 'asc' | 'desc'>>;
    }): Promise<Array<Record<string, unknown>>>;
    create(args: { data: Record<string, unknown> }): Promise<Record<string, unknown>>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  };
  document: {
    findFirst(args: {
      where: Record<string, unknown>;
      select: Record<string, boolean>;
    }): Promise<Record<string, unknown> | null>;
  };
};

export type ConfluenceReferenceDeps = {
  getPage?: (client: ConfluenceClient, pageId: string) => Promise<ConfluencePage | null>;
};

/** Confluence ids reach a URL path, so the same shape rule the pages module applies. */
const PAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function toReference(row: Record<string, unknown>): ConfluenceReference {
  return {
    id: String(row.id),
    documentId: String(row.documentId),
    cloudId: String(row.cloudId),
    pageId: String(row.pageId),
    pageTitle: String(row.pageTitle),
    pageVersion: Number(row.pageVersion),
    pageUrl: typeof row.pageUrl === 'string' ? row.pageUrl : null,
    citedAt: row.citedAt instanceof Date ? row.citedAt.toISOString() : String(row.citedAt),
  };
}

/**
 * Cites a page as evidence for a document.
 *
 * The page is READ first, and a page that cannot be read is not cited. That
 * refusal is the whole value of the operation: a citation recorded without
 * confirming the page exists is a governance record pointing at nothing, and it
 * would be discovered by whoever went looking for the evidence — which is
 * exactly the moment it must not fail.
 */
export async function citeConfluencePage(
  prisma: PrismaClient,
  client: ConfluenceClient,
  input: {
    organisationId: string;
    documentId: string;
    cloudId: string;
    pageId: string;
    citedById: string;
    now?: Date;
  },
  deps: ConfluenceReferenceDeps = {},
): Promise<ConfluenceReference> {
  const getPage = deps.getPage ?? getPageDefault;

  if (!PAGE_ID_PATTERN.test(input.pageId)) {
    throw new AppError(
      400,
      'CONFLUENCE_PAGE_ID_INVALID',
      'A Confluence page id must be a plain identifier.',
    );
  }

  // Scoped on the organisation as well as the id, like every other read here: a
  // document id alone must never reach another charity's row.
  const document = await prisma.document.findFirst({
    where: { id: input.documentId, organisationId: input.organisationId },
    select: { id: true },
  });
  if (document === null) {
    throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
  }

  const page = await getPage(client, input.pageId);
  if (page === null) {
    throw new AppError(
      404,
      'CONFLUENCE_PAGE_NOT_FOUND',
      'That page could not be found in this charity’s Confluence site, so it was not cited. ' +
        'A citation that points at nothing is worse than no citation: it would be discovered by ' +
        'whoever went looking for the evidence.',
      { pageId: input.pageId },
    );
  }

  const citedAt = input.now ?? new Date();
  const created = await prisma.$transaction(async (tx) => {
    const reference = await tx.confluenceReference.create({
      data: {
        organisationId: input.organisationId,
        documentId: input.documentId,
        cloudId: input.cloudId,
        pageId: page.id,
        // What the page was CALLED when it was cited. Not kept current, for the
        // same reason the version is not.
        pageTitle: page.title.slice(0, 500) || page.id,
        pageVersion: page.version,
        pageUrl: page.webUrl.length > 0 ? page.webUrl.slice(0, 2000) : null,
        citedAt,
        citedById: input.citedById,
        updatedAt: citedAt,
      },
    });
    await tx.documentControlAudit.create({ data: {
      organisationId: input.organisationId,
      documentId: input.documentId,
      actorUserId: input.citedById,
      kind: 'CONFLUENCE_REFERENCE',
      previous: 'UNLINKED',
      next: `CITED:${reference.id}`,
      reason: 'Confluence page citation added.',
    } });
    return reference;
  });

  return toReference(created);
}

/** Every page cited for one document, newest citation first. */
export async function listConfluenceReferences(
  prisma: ReferenceClient,
  input: { organisationId: string; documentId: string },
): Promise<ConfluenceReference[]> {
  const rows = await prisma.confluenceReference.findMany({
    where: { organisationId: input.organisationId, documentId: input.documentId },
    orderBy: [{ citedAt: 'desc' }],
  });
  return rows.map(toReference);
}

/**
 * Charity-wide review of citations that still belong to live Vault records.
 * These are references to charity-managed pages, never CharityPilot copies or
 * candidates for the publication-erasure route. A document with a current
 * citation cannot be deleted; separately unciting removes that current row,
 * so this is not a historical provider inventory.
 */
export async function listConfluenceReferenceInventory(
  prisma: PrismaClient,
  organisationId: string,
  before?: string,
) {
  if (before) {
    const anchor = await prisma.confluenceReference.findFirst({
      where: { id: before, organisationId }, select: { id: true },
    });
    if (!anchor) throw new AppError(404, 'CONFLUENCE_REFERENCE_CURSOR_NOT_FOUND', 'Reference cursor not found');
  }
  const rows = await prisma.confluenceReference.findMany({
    where: { organisationId, ...(before ? { id: { lt: before } } : {}) },
    select: { id: true, documentId: true, cloudId: true, pageId: true,
      pageTitle: true, pageVersion: true, citedAt: true },
    orderBy: { id: 'desc' }, take: 51,
  });
  const selected = rows.slice(0, 50);
  const documents = selected.length ? await prisma.document.findMany({
    where: { organisationId, id: { in: selected.map((row) => row.documentId) } },
    select: { id: true, name: true, lifecycleStatus: true, visibility: true },
  }) : [];
  const documentById = new Map(documents.map((row) => [row.id, row]));
  return {
    references: selected.map((row) => {
      const document = documentById.get(row.documentId);
      return { id: row.id, documentId: row.documentId, recordedSiteId: row.cloudId,
        recordedPageId: row.pageId, recordedTitle: row.pageTitle,
        citedVersion: row.pageVersion, citedAt: row.citedAt,
        documentName: document?.name ?? null, documentLifecycle: document?.lifecycleStatus ?? null,
        documentVisibility: document?.visibility ?? null };
    }),
    nextCursor: rows.length > 50 ? selected[selected.length - 1]!.id : null,
  };
}

/**
 * Removes CharityPilot's citation. Touches nothing in Confluence.
 *
 * Worth saying in the name of the thing and again here, because "remove" beside
 * a Confluence page id reads like a deletion to anybody skimming: this deletes a
 * row in CharityPilot. The page is the charity's, was never ours, and there is
 * no code path in this module that could reach it.
 */
export async function removeConfluenceReference(
  prisma: PrismaClient,
  input: { organisationId: string; referenceId: string; actorUserId: string },
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const reference = await tx.confluenceReference.findFirst({
      where: { id: input.referenceId, organisationId: input.organisationId },
      select: { id: true, documentId: true },
    });
    if (!reference) return false;
    const result = await tx.confluenceReference.deleteMany({
      where: { id: reference.id, organisationId: input.organisationId, documentId: reference.documentId },
    });
    if (result.count === 0) return false;
    await tx.documentControlAudit.create({ data: {
      organisationId: input.organisationId,
      documentId: reference.documentId,
      actorUserId: input.actorUserId,
      kind: 'CONFLUENCE_REFERENCE',
      previous: `CITED:${reference.id}`,
      next: 'UNLINKED',
      reason: 'Confluence page citation removed; the page was not changed.',
    } });
    return true;
  });
}

/**
 * Whether a cited page has moved on since it was cited.
 *
 * REPORTED, NEVER REPAIRED. Updating the recorded version would silently
 * destroy the only thing the citation was for — that a named version was the
 * evidence on a named date. A charity that wants to cite the newer version
 * cites it, which is a decision with a person and a date attached.
 */
export function citationStaleness(
  reference: Pick<ConfluenceReference, 'pageVersion'>,
  currentVersion: number | null,
): 'CURRENT' | 'SUPERSEDED' | 'UNKNOWN' {
  if (currentVersion === null) return 'UNKNOWN';
  return currentVersion > reference.pageVersion ? 'SUPERSEDED' : 'CURRENT';
}
