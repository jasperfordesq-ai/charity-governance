import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';

/** Recorded page identifiers linked to publication rows that are not retired. */
export async function listOtherConfluenceCopies(prisma: PrismaClient, organisationId: string, before?: string) {
  const scope = { organisationId, provider: 'confluence', state: { not: 'RETIRED' as const },
    pageId: { not: null } };
  if (before) {
    const anchor = await prisma.documentPublication.findFirst({
      where: { ...scope, id: before }, select: { id: true },
    });
    if (!anchor) throw new AppError(404, 'CONFLUENCE_COPY_CURSOR_NOT_FOUND', 'Copy cursor not found');
  }
  const rows = await prisma.documentPublication.findMany({
    where: { ...scope, ...(before ? { id: { lt: before } } : {}) },
    select: { id: true, documentId: true, pageTitle: true, state: true, publishedAt: true,
      cloudId: true, spaceId: true, pageId: true,
      remoteState: true, lastReconciledAt: true },
    orderBy: { id: 'desc' }, take: 51,
  });
  const selected = rows.slice(0, 50);
  const documents = selected.length ? await prisma.document.findMany({
    where: { organisationId, id: { in: selected.map((row) => row.documentId) } },
    select: { id: true, name: true, lifecycleStatus: true, externalPublicationApproved: true,
      externalPublicationSiteId: true, externalPublicationSpaceId: true },
  }) : [];
  const documentById = new Map(documents.map((row) => [row.id, row]));
  return {
    copies: selected.map((row) => {
      const document = documentById.get(row.documentId);
      const approvalMatchesRecordedPage = document?.externalPublicationApproved
        && document.externalPublicationSiteId && document.externalPublicationSpaceId
        && row.cloudId && row.spaceId
        ? document.externalPublicationSiteId === row.cloudId
          && document.externalPublicationSpaceId === row.spaceId : null;
      return { id: row.id, documentId: row.documentId, pageTitle: row.pageTitle,
        publicationState: row.state, publishedAt: row.publishedAt,
        recordedSiteId: row.cloudId, recordedSpaceId: row.spaceId, recordedPageId: row.pageId,
        lastObservedRemoteState: row.remoteState, lastObservedAt: row.lastReconciledAt,
        documentName: document?.name ?? null, documentLifecycle: document?.lifecycleStatus ?? null,
        publicationApproved: document?.externalPublicationApproved ?? null,
        approvalMatchesRecordedPage };
    }),
    nextCursor: rows.length > 50 ? selected[selected.length - 1]!.id : null,
  };
}
