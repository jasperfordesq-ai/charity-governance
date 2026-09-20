/**
 * What a charity can be told about the Confluence copy of its own documents.
 *
 * ## Read separately, because there is no relation, by design
 *
 * `Document` has no Prisma relation to `DocumentPublication`, and that is not
 * an oversight to be tidied up. A relation would make the mirror part of the
 * document, and the mirror is a *reference to something in somebody else's
 * system* that may be stale by up to a reconcile interval. Keeping it a
 * separate read keeps the DPO-agreed architecture visible in the code:
 * CharityPilot is authoritative for the document; Confluence holds a copy whose
 * state we last observed at a particular time.
 *
 * It also keeps the failure modes apart. A document must load whether or not
 * its mirror can be read.
 *
 * ## Batched, because a list is the common case
 *
 * `mirrorsForDocuments` takes every id on the page and issues one query. The
 * obvious per-document read would be an N+1 across a documents list, on a page
 * a trustee opens constantly.
 */
import type { DocumentPublicationRemoteState } from './confluence-reconcile.service.js';

/** What a charity is told about the publication itself. */
export type DocumentMirrorPublicationState =
  | 'NOT_PUBLISHED'
  | 'PENDING'
  | 'PUBLISHED'
  | 'FAILED'
  | 'RETIRED';

export type DocumentMirror = {
  publication: DocumentMirrorPublicationState;
  pageUrl: string | null;
  remote: {
    state: DocumentPublicationRemoteState;
    title: string | null;
    version: number | null;
    lastReconciledAt: string | null;
    reconcileError: string | null;
  } | null;
};

type MirrorRow = {
  documentId: unknown;
  state: unknown;
  cloudId: unknown;
  pageId: unknown;
  pageTitle: unknown;
  remoteState: unknown;
  remoteTitle: unknown;
  remoteVersion: unknown;
  lastReconciledAt: unknown;
  reconcileError: unknown;
};

type MirrorClient = {
  documentPublication: {
    findMany(args: {
      where: Record<string, unknown>;
      select: Record<string, boolean>;
    }): Promise<Array<Record<string, unknown>>>;
  };
};

/**
 * Maps the outbox state onto what a trustee is told.
 *
 * DEAD_LETTER becomes FAILED rather than being surfaced by its internal name:
 * "dead letter" is a queue term and means nothing to a charity, and the only
 * thing that matters to them is that it stopped and somebody can retry it.
 */
function publicationStateOf(state: unknown): DocumentMirrorPublicationState {
  switch (state) {
    case 'PROCESSED':
      return 'PUBLISHED';
    case 'PENDING':
      return 'PENDING';
    case 'DEAD_LETTER':
      return 'FAILED';
    case 'RETIRED':
      return 'RETIRED';
    default:
      return 'NOT_PUBLISHED';
  }
}

/**
 * The page's address, or null.
 *
 * Built from the recorded `cloudId` and `pageId` rather than from a stored URL,
 * and only for a page that was actually published. A URL stored at publish time
 * would be a second copy of the same fact that could disagree with the
 * identifiers the eraser uses — and the identifiers are the ones that matter.
 *
 * `/wiki/pages/viewpage.action?pageId=` is Confluence's own stable redirect and
 * survives a page being renamed or moved between spaces, which a
 * `/spaces/KEY/pages/...` link does not.
 */
function pageUrlOf(row: MirrorRow, siteUrl: string | null): string | null {
  if (typeof row.pageId !== 'string' || row.pageId.length === 0) return null;
  if (siteUrl === null || siteUrl.length === 0) return null;
  return `${siteUrl.replace(/\/+$/, '')}/wiki/pages/viewpage.action?pageId=${encodeURIComponent(row.pageId)}`;
}

function toMirror(row: MirrorRow, siteUrl: string | null): DocumentMirror {
  const publication = publicationStateOf(row.state);
  const remoteState = row.remoteState;

  return {
    publication,
    pageUrl: pageUrlOf(row, siteUrl),
    // Null means never checked, which is a different answer from UNKNOWN and is
    // rendered differently: one says the reconcile job has not reached this
    // page, the other says the site refused to tell us about it.
    remote:
      typeof remoteState === 'string'
        ? {
            state: remoteState as DocumentPublicationRemoteState,
            title: typeof row.remoteTitle === 'string' ? row.remoteTitle : null,
            version: typeof row.remoteVersion === 'number' ? row.remoteVersion : null,
            lastReconciledAt:
              row.lastReconciledAt instanceof Date ? row.lastReconciledAt.toISOString() : null,
            // A code, never upstream text — the column's CHECK enforces the
            // shape, and this is where it would otherwise reach a screen.
            reconcileError: typeof row.reconcileError === 'string' ? row.reconcileError : null,
          }
        : null,
  };
}

export const NOT_PUBLISHED: DocumentMirror = {
  publication: 'NOT_PUBLISHED',
  pageUrl: null,
  remote: null,
};

/**
 * One mirror per document id asked for, in a single query.
 *
 * Every id asked for appears in the result, so a caller never has to decide
 * what a missing key means: a document with no publication row gets
 * `NOT_PUBLISHED`, which is the truth about it.
 */
export async function mirrorsForDocuments(
  prisma: MirrorClient,
  input: { organisationId: string; documentIds: string[]; siteUrl?: string | null },
): Promise<Map<string, DocumentMirror>> {
  const mirrors = new Map<string, DocumentMirror>();
  for (const id of input.documentIds) mirrors.set(id, NOT_PUBLISHED);
  if (input.documentIds.length === 0) return mirrors;

  const rows = (await prisma.documentPublication.findMany({
    // Scoped on the organisation as well as the ids. A document id alone must
    // never reach another charity's row — the same rule every read in this
    // codebase follows.
    where: {
      organisationId: input.organisationId,
      provider: 'confluence',
      documentId: { in: input.documentIds } as unknown as boolean,
    },
    select: {
      documentId: true,
      state: true,
      cloudId: true,
      pageId: true,
      pageTitle: true,
      remoteState: true,
      remoteTitle: true,
      remoteVersion: true,
      lastReconciledAt: true,
      reconcileError: true,
    },
  })) as unknown as MirrorRow[];

  for (const row of rows) {
    if (typeof row.documentId !== 'string') continue;
    mirrors.set(row.documentId, toMirror(row, input.siteUrl ?? null));
  }

  return mirrors;
}

/** The mirror for one document. */
export async function mirrorForDocument(
  prisma: MirrorClient,
  input: { organisationId: string; documentId: string; siteUrl?: string | null },
): Promise<DocumentMirror> {
  const mirrors = await mirrorsForDocuments(prisma, {
    organisationId: input.organisationId,
    documentIds: [input.documentId],
    siteUrl: input.siteUrl ?? null,
  });
  return mirrors.get(input.documentId) ?? NOT_PUBLISHED;
}

type RetryClient = {
  documentPublication: {
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
};

/**
 * Puts a failed publication back in the queue.
 *
 * Scoped to `DEAD_LETTER` and nothing else, which is what makes this safe to
 * expose. A PENDING row is already queued and re-queueing it would reset a
 * backoff that exists to protect a rate-limited upstream; a PROCESSED row is
 * fine; and a RETIRED row belongs to a deleted document, so republishing it
 * would push a document the charity deleted back to their site — the exact
 * thing the owner's 2026-09-19 ruling forbids.
 *
 * Returns false when nothing matched, which the route turns into a 409 rather
 * than a silent success: an administrator who pressed "try again" is entitled
 * to know that nothing was tried.
 */
export async function retryFailedPublication(
  prisma: RetryClient,
  input: { organisationId: string; documentId: string; now?: Date },
): Promise<boolean> {
  const at = input.now ?? new Date();
  const result = await prisma.documentPublication.updateMany({
    where: {
      organisationId: input.organisationId,
      documentId: input.documentId,
      provider: 'confluence',
      state: 'DEAD_LETTER',
    },
    data: {
      state: 'PENDING',
      attempts: 0,
      lastError: null,
      nextAttemptAt: at,
      claimedAt: null,
      deadLetteredAt: null,
      terminalReason: null,
      alertClaimToken: null,
      alertClaimedAt: null,
      alertedAt: null,
      processedAt: null,
      // Not a CREATE: the row already names a page, and the CHECK refuses a
      // re-queue that claims to be a first publication.
      reason: 'METADATA',
      requeuedAt: at,
    },
  });
  return result.count > 0;
}
