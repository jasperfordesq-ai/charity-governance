import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';

const PAGE_SIZE = 50;
type SourceRow = {
  id: string;
  requestId: string;
  actorUserId: string;
  createdAt: Date;
  documentId?: string;
  deletionId?: string;
  linkId?: string;
};
type SourceDelegate = {
  findFirst(args: unknown): Promise<Pick<SourceRow, 'id' | 'createdAt'> | null>;
  findMany(args: unknown): Promise<SourceRow[]>;
};
type EvidenceChange = {
  id: string;
  requestId: string;
  actorUserId: string;
  action: 'LINKED' | 'WITHDRAWN';
  kind: 'VAULT_DOCUMENT' | 'STORAGE_DELETION';
  documentId?: string;
  deletionId?: string;
  linkId?: string;
  createdAt: Date;
};

function sources(prisma: PrismaClient) {
  const delegate = (value: unknown) => value as SourceDelegate;
  return [
    { prefix: 'doc-link_', kind: 'VAULT_DOCUMENT', action: 'LINKED',
      delegate: delegate(prisma.dataLifecycleDocumentLink),
      select: { id: true, requestId: true, actorUserId: true, documentId: true, createdAt: true } },
    { prefix: 'doc-withdrawal_', kind: 'VAULT_DOCUMENT', action: 'WITHDRAWN',
      delegate: delegate(prisma.dataLifecycleDocumentLinkWithdrawal),
      select: { id: true, requestId: true, actorUserId: true, linkId: true, createdAt: true } },
    { prefix: 'storage-link_', kind: 'STORAGE_DELETION', action: 'LINKED',
      delegate: delegate(prisma.dataLifecycleStorageLink),
      select: { id: true, requestId: true, actorUserId: true, deletionId: true, createdAt: true } },
    { prefix: 'storage-withdrawal_', kind: 'STORAGE_DELETION', action: 'WITHDRAWN',
      delegate: delegate(prisma.dataLifecycleStorageLinkWithdrawal),
      select: { id: true, requestId: true, actorUserId: true, linkId: true, createdAt: true } },
  ] as const;
}

/** Recent metadata only. The case page remains the place for reasoned history. */
export async function listDataLifecycleEvidenceChanges(prisma: PrismaClient, organisationId: string, before?: string) {
  const feeds = sources(prisma);
  const anchorSource = before ? feeds.find((source) => before.startsWith(source.prefix)) : undefined;
  if (before && !anchorSource) {
    throw new AppError(404, 'AUDIT_CURSOR_NOT_FOUND', 'Audit cursor not found');
  }
  const anchorId = anchorSource && before?.slice(anchorSource.prefix.length);
  if (anchorSource && !anchorId) {
    throw new AppError(404, 'AUDIT_CURSOR_NOT_FOUND', 'Audit cursor not found');
  }
  const anchor = anchorSource ? await anchorSource.delegate.findFirst({
    where: { id: anchorId, organisationId },
    select: { id: true, createdAt: true },
  }) : null;
  if (before && !anchor) {
    throw new AppError(404, 'AUDIT_CURSOR_NOT_FOUND', 'Audit cursor not found');
  }

  const batches = await Promise.all(feeds.map(async (source) => {
    const sameTime = !anchor ? null : source.prefix < anchorSource!.prefix
      ? { createdAt: anchor.createdAt }
      : source.prefix === anchorSource!.prefix
        ? { createdAt: anchor.createdAt, id: { lt: anchorId } }
        : null;
    const older = anchor ? { OR: [
      { createdAt: { lt: anchor.createdAt } },
      ...(sameTime ? [sameTime] : []),
    ] } : {};
    const rows = await source.delegate.findMany({
      where: { organisationId, ...older },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PAGE_SIZE + 1,
      select: source.select,
    });
    return rows.map((row): EvidenceChange => ({
      id: `${source.prefix}${row.id}`,
      requestId: row.requestId,
      actorUserId: row.actorUserId,
      action: source.action,
      kind: source.kind,
      ...(row.documentId ? { documentId: row.documentId } : {}),
      ...(row.deletionId ? { deletionId: row.deletionId } : {}),
      ...(row.linkId ? { linkId: row.linkId } : {}),
      createdAt: row.createdAt,
    }));
  }));
  const ordered = batches.flat().sort((a, b) =>
    b.createdAt.getTime() - a.createdAt.getTime() || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0));
  const data = ordered.slice(0, PAGE_SIZE);
  return { data, nextCursor: ordered.length > PAGE_SIZE ? data[data.length - 1].id : null };
}
