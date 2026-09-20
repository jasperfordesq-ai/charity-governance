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
 * Everything downstream is unchanged: Phase 5's dispatcher, its permanence
 * mapping, its dead-lettering and its operator recovery drive the row exactly as
 * before. The change is who asks for it, and when.
 *
 * **Only a RETIRED publication can be erased**, which makes this a two-step
 * workflow: delete the document in CharityPilot, then erase the Confluence copy.
 * Allowing a request against a PROCESSED row would let an administrator destroy
 * the page that a live document still points at.
 */
import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { publicationErasureTarget } from './document-publication.service.js';

export type ConfluenceErasureRequest = {
  organisationId: string;
  publicationId: string;
  reason: string;
  requestedById: string;
  now?: () => Date;
};

export type RetiredConfluencePublication = {
  id: string;
  documentId: string;
  pageTitle: string | null;
  pageId: string | null;
  retiredAt: Date | null;
  erasureRequestedAt: Date | null;
};

const PUBLICATION_SELECT = {
  id: true,
  documentId: true,
  pageTitle: true,
  pageId: true,
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
): Promise<RetiredConfluencePublication[]> {
  return prisma.documentPublication.findMany({
    where: { organisationId, provider: 'confluence', state: 'RETIRED' },
    select: PUBLICATION_SELECT,
    orderBy: { retiredAt: 'desc' },
    take: 200,
  }) as Promise<RetiredConfluencePublication[]>;
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

    const deletion = await client.documentStorageDeletion.create({
      data: {
        organisationId: input.organisationId,
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

    const stamped = await client.documentPublication.updateMany({
      // `erasureDeletionId: null` is the fence: two administrators clicking at
      // once produce one erasure, and the loser is told so rather than silently
      // queueing a second destruction of the same page.
      where: { id: publication.id, erasureDeletionId: null },
      data: { erasureRequestedAt: now(), erasureDeletionId: deletion.id },
    });

    if (stamped.count !== 1) {
      throw new AppError(
        409,
        'CONFLUENCE_ERASURE_ALREADY_REQUESTED',
        'An erasure was requested for this page at the same moment. Only one was queued.',
      );
    }

    return { deletionId: deletion.id };
  });
}
