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
 * people, in their site. CharityPilot reads it to capture what was cited and
 * can explicitly re-read its current version without altering that citation.
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
import { z } from 'zod';
import { AppError } from '../utils/app-error.js';
import type { ConfluenceClient } from './confluence-client.js';
import { getPage as getPageDefault, type ConfluencePage } from './confluence-pages.js';
import { lockOrganisationForUpdate } from './organisation-lock.js';

export type ConfluenceReference = {
  id: string;
  documentId: string | null;
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
    documentId: row.documentId === null ? null : String(row.documentId),
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
    where: { deletedAt: null, id: input.documentId, organisationId: input.organisationId },
    select: { id: true },
  });
  if (document === null) {
    throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
  }
  if (await prisma.documentRecoveryEnforcement.findUnique({
    where: { organisationId: input.organisationId }, select: { id: true },
  })) {
    throw new AppError(409, 'CONFLUENCE_REFERENCE_RECOVERY_REQUIRED',
      'Citation changes require independent recovery authority for this charity.');
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
    await lockOrganisationForUpdate(tx, input.organisationId);
    if (await tx.documentRecoveryEnforcement.findUnique({
      where: { organisationId: input.organisationId }, select: { id: true },
    })) {
      throw new AppError(409, 'CONFLUENCE_REFERENCE_RECOVERY_REQUIRED',
        'Citation changes require independent recovery authority for this charity.');
    }
    // The provider read can outlast a concurrent Vault removal. Removal uses
    // the same organisation lock, so recheck the live document under that lock
    // rather than attaching evidence to a draft already in Deleted Items.
    const currentDocument = await tx.document.findFirst({
      where: { deletedAt: null, id: input.documentId, organisationId: input.organisationId },
      select: { id: true },
    });
    if (!currentDocument) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
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

export type CitationCheck = {
  referenceId: string;
  status: 'CURRENT' | 'SUPERSEDED' | 'UNKNOWN';
  currentVersion: number | null;
  checkedAt: string;
  reason: 'NOT_CONNECTED' | 'CONNECTION_CHANGED' | 'PAGE_UNAVAILABLE' | 'READ_FAILED' | 'VERSION_UNVERIFIED' | null;
};

type CitationConnection = { cloudId: string; generation: string; client: ConfluenceClient };

/** Register a selected external source without uploading or duplicating bytes.
 * The caller's UUID is the operation identity: retrying reads its original
 * citation, even if the source version has since changed. */
export async function registerConfluenceSource(
  prisma: PrismaClient,
  input: { organisationId: string; actorUserId: string; expectedSiteId: string;
    pageId: string; clientRequestId: string; now?: Date },
  deps: ConfluenceReferenceDeps & { getConnection: () => Promise<CitationConnection | null> },
): Promise<ConfluenceReference> {
  z.object({ expectedSiteId: z.string().min(1).max(160), pageId: z.string().regex(PAGE_ID_PATTERN),
    clientRequestId: z.string().uuid() }).parse(input);
  const where = { id: input.clientRequestId, organisationId: input.organisationId };
  const actorWhere = { id: input.actorUserId, organisationId: input.organisationId,
    role: { in: ['OWNER', 'ADMIN'] as Array<'OWNER' | 'ADMIN'> }, lifecycleStatus: 'ACTIVE' as const,
    organisation: { is: { lifecycleStatus: 'ACTIVE' as const } } };
  const requireActor = async (client: Pick<PrismaClient, 'user'>) => {
    const actor = await client.user.findFirst({ where: actorWhere, select: { id: true, name: true } });
    if (!actor) throw new AppError(403, 'CONFLUENCE_SOURCE_ADMIN_REQUIRED', 'An active Owner or Admin must register this source.');
    return actor;
  };
  const original = (row: { referenceKind: string; cloudId: string; pageId: string; citedById: string }) => {
    if (row.referenceKind !== 'CONFLUENCE_SOURCE' || row.cloudId !== input.expectedSiteId
      || row.pageId !== input.pageId || row.citedById !== input.actorUserId) {
      throw new AppError(409, 'CONFLUENCE_SOURCE_REQUEST_CONFLICT', 'This request already identifies another citation.');
    }
    return toReference(row as unknown as Record<string, unknown>);
  };
  await requireActor(prisma);
  const saved = await prisma.confluenceReference.findFirst({ where });
  if (saved) return original(saved);
  const refuseRemoved = async (client: Pick<PrismaClient, 'securityAuditEvent'>) => {
    if (await client.securityAuditEvent.findFirst({ where: { organisationId: input.organisationId,
      type: 'CONFLUENCE_SOURCE_REGISTERED', context: { path: ['referenceId'], equals: input.clientRequestId } }, select: { id: true } })) {
      throw new AppError(409, 'CONFLUENCE_SOURCE_ALREADY_REMOVED', 'This source was registered and later uncited. Start a new reviewed request to cite it again.');
    }
  };
  await refuseRemoved(prisma);
  if (await prisma.documentRecoveryEnforcement.findUnique({ where: { organisationId: input.organisationId } })) {
    throw new AppError(409, 'CONFLUENCE_REFERENCE_RECOVERY_REQUIRED', 'Citation changes require independent recovery authority for this charity.');
  }
  const connection = await deps.getConnection();
  if (!connection || connection.cloudId !== input.expectedSiteId) {
    throw new AppError(409, 'CONFLUENCE_REFERENCE_CONNECTION_CHANGED', 'Review the connected site before registering this source.');
  }
  const reader: ConfluenceClient = { request: async spec => {
    if (spec.method !== 'GET') throw new Error('Source registration only reads Confluence');
    return connection.client.request(spec);
  } };
  const page = await (deps.getPage ?? getPageDefault)(reader, input.pageId);
  if (!page || page.id !== input.pageId || page.status !== 'current'
    || !Number.isSafeInteger(page.version) || page.version < 1) {
    throw new AppError(404, 'CONFLUENCE_PAGE_NOT_FOUND', 'An accessible current page with a verified version is required.');
  }
  return prisma.$transaction(async tx => {
    await lockOrganisationForUpdate(tx, input.organisationId);
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${input.actorUserId} AND "organisationId"=${input.organisationId} FOR UPDATE`;
    const actor = await requireActor(tx);
    const existing = await tx.confluenceReference.findFirst({ where });
    if (existing) return original(existing);
    await refuseRemoved(tx);
    if (await tx.documentRecoveryEnforcement.findUnique({ where: { organisationId: input.organisationId } })) {
      throw new AppError(409, 'CONFLUENCE_REFERENCE_RECOVERY_REQUIRED', 'Citation changes require independent recovery authority for this charity.');
    }
    // Disconnect/reselection updates this row in its transaction. Hold it until
    // commit so a completed disconnect cannot race the final generation check.
    await tx.$queryRaw`SELECT id FROM "OrganisationIntegration" WHERE "organisationId"=${input.organisationId} AND provider='CONFLUENCE' FOR UPDATE`;
    const after = await deps.getConnection();
    if (!after || after.cloudId !== connection.cloudId || after.generation !== connection.generation) {
      throw new AppError(409, 'CONFLUENCE_REFERENCE_CONNECTION_CHANGED', 'The connected site or authorisation changed. Review the source again.');
    }
    const row = await tx.confluenceReference.create({ data: {
      id: input.clientRequestId, organisationId: input.organisationId, documentId: null,
      referenceKind: 'CONFLUENCE_SOURCE', cloudId: connection.cloudId, pageId: page.id,
      pageTitle: page.title.slice(0, 500) || page.id, pageVersion: page.version,
      pageUrl: page.webUrl ? page.webUrl.slice(0, 2000) : null,
      citedAt: input.now ?? new Date(), citedById: input.actorUserId,
    } });
    await tx.securityAuditEvent.create({ data: { organisationId: input.organisationId,
      type: 'CONFLUENCE_SOURCE_REGISTERED', actorKind: 'USER', actorUserId: input.actorUserId,
      actorLabel: actor.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 160) || 'Administrator',
      subjectLabel: 'Selected Confluence source', reason: 'External page/version registered without copying content.',
      context: { referenceId: row.id, cloudId: row.cloudId, pageId: row.pageId, pageVersion: row.pageVersion,
        citation: { ...toReference(row) }, documentId: null, providerMutationIssued: false } } });
    return toReference(row);
  });
}

/** Explicit observation only: no scheduler, citation update, or provider write. */
export async function checkConfluenceReference(
  prisma: PrismaClient,
  input: { organisationId: string; referenceId: string; now?: Date },
  deps: ConfluenceReferenceDeps & { getConnection: () => Promise<CitationConnection | null> },
): Promise<CitationCheck> {
  const where = { id: input.referenceId, organisationId: input.organisationId };
  const reference = await prisma.confluenceReference.findFirst({ where });
  if (!reference) throw new AppError(404, 'CONFLUENCE_REFERENCE_NOT_FOUND', 'That citation was not found.');
  const document = reference.documentId === null ? null : await prisma.document.findFirst({
    where: { id: reference.documentId, organisationId: input.organisationId, deletedAt: null }, select: { id: true },
  });
  if (reference.documentId !== null && !document) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
  const result = (status: CitationCheck['status'], currentVersion: number | null, reason: CitationCheck['reason']): CitationCheck => ({
    referenceId: reference.id, status, currentVersion, reason, checkedAt: (input.now ?? new Date()).toISOString(),
  });
  const connection = await deps.getConnection();
  if (!connection) return result('UNKNOWN', null, 'NOT_CONNECTED');
  if (connection.cloudId !== reference.cloudId) return result('UNKNOWN', null, 'CONNECTION_CHANGED');
  let page: ConfluencePage | null;
  try { page = await (deps.getPage ?? getPageDefault)(connection.client, reference.pageId); }
  catch { return result('UNKNOWN', null, 'READ_FAILED'); }
  const after = await deps.getConnection();
  if (!after || after.cloudId !== connection.cloudId || after.generation !== connection.generation) {
    return result('UNKNOWN', null, 'CONNECTION_CHANGED');
  }
  // An uncited row must not be resurrected by a response completing later.
  if (!await prisma.confluenceReference.findFirst({ where })) {
    throw new AppError(404, 'CONFLUENCE_REFERENCE_NOT_FOUND', 'That citation was not found.');
  }
  if (!page || page.id !== reference.pageId || page.status !== 'current') {
    return result('UNKNOWN', null, 'PAGE_UNAVAILABLE');
  }
  const status = citationStaleness(reference, page.version);
  return result(status, status === 'UNKNOWN' ? null : page.version, status === 'UNKNOWN' ? 'VERSION_UNVERIFIED' : null);
}

/**
 * Charity-wide review of file evidence and independent external-source citations.
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
    where: { organisationId, id: { in: selected.flatMap((row) => row.documentId === null ? [] : [row.documentId]) } },
    select: { id: true, name: true, lifecycleStatus: true, visibility: true },
  }) : [];
  const documentById = new Map(documents.map((row) => [row.id, row]));
  return {
    references: selected.map((row) => {
      const document = row.documentId === null ? undefined : documentById.get(row.documentId);
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
    await lockOrganisationForUpdate(tx, input.organisationId);
    const reference = await tx.confluenceReference.findFirst({
      where: { id: input.referenceId, organisationId: input.organisationId },
      select: { id: true, documentId: true, cloudId: true, pageId: true, pageVersion: true },
    });
    if (!reference) return false;
    if (await tx.documentRecoveryEnforcement.findUnique({
      where: { organisationId: input.organisationId }, select: { id: true },
    })) {
      throw new AppError(409, 'CONFLUENCE_REFERENCE_RECOVERY_REQUIRED',
        'Citation changes require independent recovery authority for this charity.');
    }
    let sourceActor: { name: string } | null = null;
    if (reference.documentId === null) {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${input.actorUserId} AND "organisationId"=${input.organisationId} FOR UPDATE`;
      sourceActor = await tx.user.findFirst({ where: { id: input.actorUserId, organisationId: input.organisationId,
        role: { in: ['OWNER', 'ADMIN'] }, lifecycleStatus: 'ACTIVE',
        organisation: { is: { lifecycleStatus: 'ACTIVE' } } }, select: { name: true } });
      if (!sourceActor) throw new AppError(403, 'CONFLUENCE_SOURCE_ADMIN_REQUIRED', 'An active Owner or Admin must remove this reference.');
    }
    const result = await tx.confluenceReference.deleteMany({
      where: { id: reference.id, organisationId: input.organisationId, documentId: reference.documentId },
    });
    if (result.count === 0) return false;
    if (reference.documentId === null) {
      await tx.securityAuditEvent.create({ data: { organisationId: input.organisationId,
        type: 'CONFLUENCE_SOURCE_REMOVED', actorKind: 'USER', actorUserId: input.actorUserId,
        actorLabel: sourceActor!.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 160) || 'Administrator',
        subjectLabel: 'Selected Confluence source', reason: 'Local reference removed; the Confluence page was not changed.',
        context: { referenceId: reference.id, cloudId: reference.cloudId, pageId: reference.pageId,
          pageVersion: reference.pageVersion, documentId: null, providerMutationIssued: false } } });
    } else await tx.documentControlAudit.create({ data: {
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
  if (currentVersion === null || !Number.isSafeInteger(currentVersion) || currentVersion < 1
    || !Number.isSafeInteger(reference.pageVersion) || reference.pageVersion < 1
    || currentVersion < reference.pageVersion) return 'UNKNOWN';
  return currentVersion > reference.pageVersion ? 'SUPERSEDED' : 'CURRENT';
}
