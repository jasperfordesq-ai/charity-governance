/**
 * The explicit erasure workflow.
 *
 * Until 2026-09-20 an ordinary document deletion enqueued a `confluence`
 * erasure row itself, and the page and its attachments were deleted and purged
 * without anyone asking for it. The owner ruled that an ordinary deletion
 * removes CharityPilot's record and its reference only, and that destroying the
 * Confluence source requires an explicit erasure workflow. This is that
 * workflow, and it is now the ONLY place a `confluence` erasure row is written.
 *
 * The storage-deletion worker rechecks the retired publication link and local
 * document absence before it calls the Confluence eraser. The dispatcher,
 * dead-letter and operator recovery paths still drive the queued row.
 *
 * **Only a RETIRED publication can be erased**, which makes this a two-step
 * workflow: delete the document in CharityPilot, then erase the Confluence copy.
 * Allowing a request against a PROCESSED row would let an administrator destroy
 * the page that a live document still points at.
 */
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AppError } from '../utils/errors.js';
import { publicationErasureTarget } from './document-publication.service.js';
import { integrationAuditActor, recordIntegrationAuditEvent } from './integration-audit.service.js';

export type ConfluenceErasureRequest = {
  organisationId: string;
  publicationId: string;
  reason: string;
  requestedById: string;
  requestId?: string;
  now?: () => Date;
};

export type RetiredConfluencePublication = {
  id: string;
  documentId: string;
  pageTitle: string | null;
  pageId: string | null;
  cloudId: string | null;
  spaceId: string | null;
  retiredAt: Date | null;
  erasureRequestedAt: Date | null;
};

const PUBLICATION_SELECT = {
  id: true,
  documentId: true,
  pageTitle: true,
  pageId: true,
  cloudId: true,
  spaceId: true,
  retiredAt: true,
  erasureRequestedAt: true,
} as const;

/**
 * The retired publications this charity could still ask to erase.
 *
 * Without this the erase route is unreachable: the document is gone, so its id
 * is no longer in any list a charity can see, and nothing else names the
 * publication. `pageTitle` is what an administrator recognises — it carries the
 * document's name — and it is the only human-readable thing left once the
 * document row has been deleted.
 */
export async function listRetiredConfluencePublications(
  prisma: PrismaClient,
  organisationId: string,
  before?: string,
): Promise<{ publications: RetiredConfluencePublication[]; nextCursor: string | null }> {
  const anchor = before ? await prisma.documentPublication.findFirst({
    where: { id: before, organisationId, provider: 'confluence', state: 'RETIRED' },
    select: { id: true },
  }) : null;
  if (before && !anchor) {
    throw new AppError(404, 'CONFLUENCE_PUBLICATION_CURSOR_NOT_FOUND', 'Publication cursor not found');
  }
  const rows = await prisma.documentPublication.findMany({
    where: { organisationId, provider: 'confluence', state: 'RETIRED',
      ...(anchor ? { id: { lt: anchor.id } } : {}) },
    select: PUBLICATION_SELECT,
    orderBy: { id: 'desc' },
    take: 51,
  }) as RetiredConfluencePublication[];
  const publications = rows.slice(0, 50);
  return { publications, nextCursor: rows.length > 50 ? publications[publications.length - 1].id : null };
}

export async function requestConfluenceErasure(
  prisma: PrismaClient,
  input: ConfluenceErasureRequest,
): Promise<{ deletionId: string }> {
  const now = input.now ?? (() => new Date());

  return prisma.$transaction(async (tx) => {
    const client = tx as unknown as PrismaClient;

    const publication = await client.documentPublication.findFirst({
      where: {
        id: input.publicationId,
        organisationId: input.organisationId,
        provider: 'confluence',
        state: 'RETIRED',
      },
    });

    if (!publication) {
      // One code for "not yours", "not there" and "not retired" deliberately:
      // telling a caller which of the three it was would confirm the existence
      // of another charity's publication id.
      throw new AppError(
        404,
        'CONFLUENCE_PUBLICATION_NOT_FOUND',
        'No retired Confluence publication with that id belongs to this charity. A page can only ' +
          'be erased after its document has been deleted in CharityPilot.',
      );
    }

    // RETIRED is written after ordinary document removal today, but a state
    // label alone must not authorise remote destruction if an inconsistent or
    // future path leaves the CharityPilot document live (including on hold).
    const liveDocument = await client.document.findFirst({
      where: { id: publication.documentId, organisationId: input.organisationId },
      select: { id: true },
    });
    if (liveDocument) {
      throw new AppError(
        409,
        'CONFLUENCE_DOCUMENT_STILL_PRESENT',
        'The CharityPilot document still exists. Review its retention and publication state before requesting erasure of the Confluence copy.',
      );
    }

    if (publication.erasureDeletionId !== null) {
      throw new AppError(
        409,
        'CONFLUENCE_ERASURE_ALREADY_REQUESTED',
        'An erasure has already been requested for this page. Check the document storage deletion ' +
          'queue for its progress rather than requesting a second one.',
      );
    }

    // Built through parseConfluenceErasureTarget, the arbiter that refuses an
    // empty or untrimmed id PERMANENTLY. Running it here means a malformed
    // target aborts this request while an operator is present to see it, rather
    // than dead-lettering hours later.
    const targetRef = publicationErasureTarget(publication);

    // The source-identity trigger must see a retired publication already
    // linked to this job. Reserve the ID locally, stamp the publication first,
    // then insert the job; the transaction rolls both back on any failure.
    const deletionId = randomUUID();
    const stamped = await client.documentPublication.updateMany({
      // `erasureDeletionId: null` is the fence: two administrators clicking at
      // once produce one erasure, and the loser is told so.
      where: { id: publication.id, erasureDeletionId: null },
      data: { erasureRequestedAt: now(), erasureDeletionId: deletionId },
    });

    if (stamped.count !== 1) {
      throw new AppError(
        409,
        'CONFLUENCE_ERASURE_ALREADY_REQUESTED',
        'An erasure was requested for this page at the same moment. Only one was queued.',
      );
    }

    const deletion = await client.documentStorageDeletion.create({
      data: {
        id: deletionId,
        organisationId: input.organisationId,
        sourceDocumentId: publication.documentId,
        // NOT how the row is addressed — the eraser reads targetRef. The column
        // is NOT NULL and this is what tells an operator which document a
        // dead-lettered row belongs to, now that the Document row is gone.
        storagePath: publication.retiredStoragePath ?? `publication:${publication.id}`,
        provider: 'confluence',
        targetRef,
        // Persisted, not just validated and dropped: a DPO or regulator asking
        // who authorised destroying a specific page, and why, must get an
        // actual answer from this row. The route already bounds `reason` to
        // 10-500 characters before this is ever called; the database CHECK
        // added alongside these columns enforces the same bound independently.
        reason: input.reason,
        requestedById: input.requestedById,
      },
    });

    // The deletion must never commit without the record of who requested it.
    // If the audit insert fails, Prisma rolls the queued deletion and the
    // publication stamp back with it.
    await recordIntegrationAuditEvent(client, {
      organisationId: input.organisationId,
      type: 'CONFLUENCE_ERASURE_REQUESTED',
      actor: await integrationAuditActor(client, {
        userId: input.requestedById,
        organisationId: input.organisationId,
      }),
      subjectLabel: `Confluence publication ${input.publicationId}`,
      reason: input.reason,
      context: {
        publicationId: input.publicationId,
        storageDeletionId: deletion.id,
        provider: 'CONFLUENCE',
      },
      requestId: input.requestId,
    });

    return { deletionId: deletion.id };
  });
}
