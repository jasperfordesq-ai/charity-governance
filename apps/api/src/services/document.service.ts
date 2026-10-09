import type { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { SubscriptionPlan, type UpdateDocumentRequest } from '@charitypilot/shared';
import { AppError } from '../utils/errors.js';
import { assertUnchanged } from '../utils/optimistic-concurrency.js';
import { formatProviderError, sanitizeProviderDiagnosticText } from '../utils/provider-errors.js';
import { assertOrganisationStoragePath } from './storage.service.js';
import type { Eraser, ErasureDispatcher } from './document-erasure.js';
import {
  confluencePublishTargetForOrganisation,
  lockedConfluencePublishTargetForOrganisation,
  type ConfluencePublishTarget,
  type PublishTargetClient,
} from './confluence-publish-target.service.js';
import { publicationErasureTarget } from './document-publication.service.js';
import { parseConfluenceErasureTarget } from './confluence-erasure-target.js';
import { lockOrganisationForUpdate } from './organisation-lock.js';
import { assertDocumentSourceUnbound } from './document-source-recovery-guard.js';

/**
 * An absent field leaves the column alone; an explicit null clears it.
 *
 * `undefined` and `null` mean different things in a PATCH body, and collapsing
 * them would make clearing a review date impossible to express.
 */
const toNullableDate = (value?: string | null): Date | null | undefined =>
  value === undefined ? undefined : value === null ? null : new Date(value);

type DocumentStorageDeletionState = 'PENDING' | 'DEAD_LETTER' | 'PROCESSED';
type DocumentStorageDeletionTerminalReason =
  | 'MAX_ATTEMPTS_EXHAUSTED'
  | 'PERMANENT_STORAGE_PATH_REJECTED'
  | 'PROVIDER_NOT_ERASABLE';
export type DocumentStorageDeletionRecoveryDisposition =
  | 'REQUEUE_UNCHANGED'
  | 'REQUEUE_CORRECTED_PATH'
  | 'COMPLETE_EXTERNALLY_REMEDIATED';
export type DocumentStorageDeletionRecoveryActor =
  | { actorType: 'TENANT_USER'; actorUserId: string; operatorIdentity?: never }
  | { actorType: 'PLATFORM_OPERATOR'; actorUserId?: never; operatorIdentity: string };

type DocumentStorageDeletionRecord = {
  id: string;
  organisationId: string;
  sourceDocumentId?: string | null;
  // The Supabase object path. It is meaningful only for rows whose provider
  // addresses its objects that way; a provider that does not must read
  // `targetRef` instead and must never fall back to this field.
  storagePath: string;
  provider: string;
  targetRef: unknown | null;
  state: DocumentStorageDeletionState;
  attempts: number;
  claimedAt: Date | null;
  nextAttemptAt: Date | null;
  deadLetteredAt: Date | null;
  terminalReason: DocumentStorageDeletionTerminalReason | null;
  alertClaimToken: string | null;
  alertClaimedAt: Date | null;
  alertedAt: Date | null;
  lastError?: string | null;
  lastAttemptAt?: Date | null;
  processedAt?: Date | null;
  createdAt?: Date;
  lastRecoveryId?: string | null;
  lastRecoveryNonce?: string | null;
  lastRecoveryDisposition?: DocumentStorageDeletionRecoveryDisposition | null;
  lastRecoveredAt?: Date | null;
};

const STORAGE_DELETION_CLAIM_STALE_AFTER_MS = 10 * 60 * 1000;
const STORAGE_DELETION_ALERT_CLAIM_STALE_AFTER_MS = 10 * 60 * 1000;
const STORAGE_DELETION_RETRY_BASE_MS = 5 * 60 * 1000;
const STORAGE_DELETION_RETRY_MAX_MS = 6 * 60 * 60 * 1000;
// A route can be interrupted after reserving an object key. Wait well beyond
// the normal bounded upload before treating an unattached reservation as idle.
const UPLOAD_INTENT_STALE_AFTER_MS = 60 * 60 * 1000;
export const DOCUMENT_STORAGE_DELETION_MAX_ATTEMPTS = 5;
export const DOCUMENT_STORAGE_DELETION_ATTEMPT_TIMEOUT_MS = 10_000;
export const DOCUMENT_STORAGE_DELETION_CLAIM_SAFETY_MARGIN_MS = 60_000;
export const DOCUMENT_STORAGE_DELETION_MAX_CLAIM_BATCH = Math.floor(
  (STORAGE_DELETION_CLAIM_STALE_AFTER_MS - DOCUMENT_STORAGE_DELETION_CLAIM_SAFETY_MARGIN_MS) /
    DOCUMENT_STORAGE_DELETION_ATTEMPT_TIMEOUT_MS,
);
const GIBIBYTE = 1024 * 1024 * 1024;

export function documentStorageDeletionRetryDelayMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new TypeError('Document storage deletion attempt must be a positive integer');
  }
  return Math.min(
    STORAGE_DELETION_RETRY_BASE_MS * (2 ** (attempt - 1)),
    STORAGE_DELETION_RETRY_MAX_MS,
  );
}

type DeadLetterAlertClaim = {
  claimToken: string;
  ids: string[];
};

export type DocumentStorageCleanupResult = {
  processed: number;
  failed: number;
  retryScheduled: number;
  newlyDeadLettered: number;
  deadLetterAlert: DeadLetterAlertClaim | null;
};

export const DOCUMENT_STORAGE_QUOTA_BYTES: Record<SubscriptionPlan, number> = {
  [SubscriptionPlan.ESSENTIALS]: 2 * GIBIBYTE,
  [SubscriptionPlan.COMPLETE]: 10 * GIBIBYTE,
};

type QueryRaw = <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;

type DocumentStorageDeletionDelegate = {
  create(args: {
    data: {
      organisationId: string;
      storagePath: string;
      sourceDocumentId?: string;
      provider: string;
      targetRef?: unknown;
    };
  }): Promise<{ id: string }>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  findFirst(args: { where: Record<string, unknown>; select?: Record<string, boolean> }): Promise<DocumentStorageDeletionRecord | null>;
  findMany(args: {
    where: Record<string, unknown>;
    orderBy: Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>;
    take: number;
    select?: Record<string, boolean>;
  }): Promise<DocumentStorageDeletionRecord[]>;
};

type DocumentStorageDeletionRecoveryDelegate = {
  create(args: {
    data: {
      recoveryNonce: string;
      deletionId: string;
      organisationId: string;
      actorType: 'TENANT_USER' | 'PLATFORM_OPERATOR';
      actorUserId: string | null;
      operatorIdentity: string | null;
      reason: string;
      disposition: DocumentStorageDeletionRecoveryDisposition;
      previousAttempts: number;
      previousTerminalReason: DocumentStorageDeletionTerminalReason;
      previousStoragePath: string;
      correctedStoragePath: string | null;
    };
  }): Promise<{ id: string }>;
};

type DocumentStorageDeletionClient = {
  documentStorageDeletion: DocumentStorageDeletionDelegate;
  documentStorageDeletionRecovery: DocumentStorageDeletionRecoveryDelegate;
  $queryRaw?: QueryRaw;
  $transaction?: <T>(callback: (tx: DocumentStorageDeletionClient) => Promise<T>) => Promise<T>;
};

type DocumentQuotaClient = {
  documentUploadIntent: {
    updateMany(args: {
      where: { id: string; organisationId: string; storagePath: string; provider: string; state: 'RESERVED' };
      data: { state: 'ATTACHED'; documentId: string };
    }): Promise<{ count: number }>;
  };
  documentControlAudit: {
    create(args: { data: {
      organisationId: string; documentId: string; actorUserId: string;
      kind: string; previous: string; next: string; reason: string;
    } }): Promise<unknown>;
  };
  subscription: {
    findUnique(args: {
      where: { organisationId: string };
      select?: { plan: true };
    }): Promise<{ plan: SubscriptionPlan } | null>;
  };
  document: {
    aggregate(args: {
      where: { organisationId: string };
      _sum: { fileSize: true };
    }): Promise<{ _sum: { fileSize: number | null } }>;
    create(args: {
      data: {
        organisationId: string;
        uploadedById: string;
        name: string;
        description?: string;
        category: never;
        visibility: 'RESTRICTED';
        lifecycleStatus: 'DRAFT';
        externalPublicationApproved: false;
        fileUrl: string;
        storageProvider: string;
        fileSize: number;
        mimeType: string;
        owner?: string | null;
        approvedDate: Date | null;
        nextReviewDate: Date | null;
        boardMinuteReference?: string | null;
      };
      include: typeof publicDocumentInclude;
    }): Promise<DocumentWithStandardLinks>;
  };
  $queryRaw?: QueryRaw;
  $transaction?: <T>(callback: (tx: DocumentQuotaClient) => Promise<T>) => Promise<T>;
};

type DocumentWithStandardLinks = {
  id: string;
  organisationId: string;
  name: string;
  description?: string | null;
  category: unknown;
  visibility: 'RESTRICTED' | 'MEMBER_VISIBLE';
  contentAccessClass?: 'UNASSESSED' | 'MEMBER_SUITABLE' | 'RESTRICTED_SENSITIVE';
  memberReviewedSha256?: string | null;
  lifecycleStatus: 'UNREVIEWED' | 'DRAFT' | 'CURRENT' | 'SUPERSEDED' | 'RETIRED' | 'HISTORICAL';
  supersededByDocumentId?: string | null;
  externalPublicationApproved: boolean;
  deletionHold?: boolean;
  storageProvider?: string | null;
  fileSize: number;
  mimeType: string;
  version: number;
  owner?: string | null;
  approvedDate: Date | null;
  nextReviewDate: Date | null;
  boardMinuteReference?: string | null;
  uploadedById?: string | null;
  createdAt: Date;
  updatedAt: Date;
  standardLinks: Array<{
    standardId: string;
    standard: {
      code: string;
    };
  }>;
};

const standardLinkInclude = {
  include: { standard: { select: { id: true, code: true } } },
};

const coreStandardLinkInclude = {
  where: { standard: { isCore: true } },
  include: { standard: { select: { id: true, code: true } } },
};

const publicDocumentInclude = {
  standardLinks: standardLinkInclude,
};

const lifecycleNext: Record<string, readonly string[]> = {
  UNREVIEWED: ['DRAFT', 'CURRENT', 'SUPERSEDED', 'RETIRED', 'HISTORICAL'],
  DRAFT: ['CURRENT', 'RETIRED', 'HISTORICAL'],
  CURRENT: ['SUPERSEDED', 'RETIRED'],
  SUPERSEDED: ['HISTORICAL'],
  RETIRED: ['HISTORICAL'],
  HISTORICAL: [],
};

function scopedPublicDocumentInclude(includeAdditionalStandards: boolean) {
  return {
    standardLinks: includeAdditionalStandards ? standardLinkInclude : coreStandardLinkInclude,
  };
}

function memberDocumentSelect(includeAdditionalStandards: boolean) {
  return {
    id: true, organisationId: true, name: true, category: true,
    visibility: true, lifecycleStatus: true, externalPublicationApproved: true,
    fileSize: true, mimeType: true, version: true, approvedDate: true,
    nextReviewDate: true, createdAt: true, updatedAt: true,
    standardLinks: scopedPublicDocumentInclude(includeAdditionalStandards).standardLinks,
  } as const;
}

function includesAdditionalStandards(organisation: { complexity: string }, subscription: { plan: string } | null): boolean {
  return organisation.complexity === 'COMPLEX' && subscription?.plan === SubscriptionPlan.COMPLETE;
}

async function documentStandardLinkScope(prisma: PrismaClient, organisationId: string): Promise<boolean> {
  const [organisation, subscription] = await Promise.all([
    prisma.organisation.findUniqueOrThrow({
      where: { id: organisationId },
      select: { complexity: true },
    }),
    prisma.subscription.findUnique({
      where: { organisationId },
      select: { plan: true },
    }),
  ]);

  return includesAdditionalStandards(organisation, subscription);
}

function deletionDelegate(prisma: unknown): DocumentStorageDeletionDelegate {
  return (prisma as DocumentStorageDeletionClient).documentStorageDeletion;
}

function deletionRecoveryDelegate(prisma: unknown): DocumentStorageDeletionRecoveryDelegate {
  return (prisma as DocumentStorageDeletionClient).documentStorageDeletionRecovery;
}

// ---------------------------------------------------------------------------
// Confluence publication: enqueue and requeue approved current documents
// ---------------------------------------------------------------------------

/**
 * The narrow enqueue/requeue delegate. Publication custody and retirement are
 * handled by the publication worker. Recoverable removal retains the document
 * and never invokes the former immediate-delete retirement path.
 */
type DocumentPublicationCreateClient = {
  documentPublication: {
    create(args: {
      data: { organisationId: string; documentId: string; provider: string };
    }): Promise<{ id: string }>;
    findFirst(args: {
      where: Record<string, unknown>;
      select?: Record<string, boolean>;
    }): Promise<{
      id: string;
      cloudId: string | null;
      pageId: string | null;
      attachmentId: string | null;
      attempts: number;
      state: string;
      claimedAt: Date | null;
    } | null>;
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  };
  $queryRaw?: QueryRaw;
  $transaction?: <T>(callback: (tx: DocumentPublicationCreateClient) => Promise<T>) => Promise<T>;
};

function publicationDelegate(prisma: unknown) {
  return (prisma as DocumentPublicationCreateClient).documentPublication;
}

// Failures that no number of retries can clear, and the terminal reason each
// one dead-letters with. `PROVIDER_NOT_ERASABLE` covers several spellings of
// one condition — this deployment has no way to erase these bytes: the
// dispatcher finding no eraser for the row's provider, StorageService refusing
// a provider it has no backend for on either the delete or the download path,
// and the three Confluence refusals below. Retrying cannot acquire a backend
// any more than it can acquire a permission.
//
// The Confluence three, and why each is permanent rather than transient:
//
// - `CONFLUENCE_PURGE_FORBIDDEN` — the connected grant lacks the permission
//   purge requires. Retrying does not acquire a permission; a human must
//   reconnect with it or empty the site's trash themselves.
// - `ERASURE_TARGET_MALFORMED` — the row does not name anything erasable.
//   Retrying does not repair a record the publish pipeline wrote incorrectly.
// - `CONFLUENCE_NOT_CONNECTED` — the charity's Confluence connection is gone
//   or dead. Retrying does not reconnect it.
//
// **What is deliberately absent matters as much as what is here.**
// `CONFLUENCE_ERASURE_UNVERIFIED` (the page still read back) and every
// transport, 5xx, rate-limit, refresh-in-flight and timeout code are transient
// and must stay transient. A predicate that dead-lettered those would turn a
// five-minute Atlassian blip into a permanent failure that a human has to
// clear by hand — and would stop the pipeline ever proving the erasure it
// could have proved on the next attempt.
const PERMANENT_STORAGE_DELETION_TERMINAL_REASONS: Record<string, DocumentStorageDeletionTerminalReason> = {
  STORAGE_PATH_FORBIDDEN: 'PERMANENT_STORAGE_PATH_REJECTED',
  PROVIDER_NOT_ERASABLE: 'PROVIDER_NOT_ERASABLE',
  STORAGE_DELETE_PROVIDER_UNSUPPORTED: 'PROVIDER_NOT_ERASABLE',
  STORAGE_DOWNLOAD_PROVIDER_UNSUPPORTED: 'PROVIDER_NOT_ERASABLE',
  CONFLUENCE_PURGE_FORBIDDEN: 'PROVIDER_NOT_ERASABLE',
  ERASURE_TARGET_MALFORMED: 'PROVIDER_NOT_ERASABLE',
  CONFLUENCE_NOT_CONNECTED: 'PROVIDER_NOT_ERASABLE',
};

function permanentStorageDeletionTerminalReason(
  error: unknown,
): DocumentStorageDeletionTerminalReason | null {
  if (!(error instanceof AppError)) return null;
  return Object.prototype.hasOwnProperty.call(PERMANENT_STORAGE_DELETION_TERMINAL_REASONS, error.code)
    ? PERMANENT_STORAGE_DELETION_TERMINAL_REASONS[error.code]
    : null;
}

function publicDocument(doc: DocumentWithStandardLinks, includeAdminFields = false) {
  return {
    id: doc.id,
    organisationId: doc.organisationId,
    name: doc.name,
    description: includeAdminFields ? doc.description ?? null : null,
    category: doc.category,
    visibility: doc.visibility,
    ...(includeAdminFields ? { contentAccessClass: doc.contentAccessClass ?? 'UNASSESSED',
      memberByteReviewVerified: Boolean(doc.memberReviewedSha256) } : {}),
    lifecycleStatus: doc.lifecycleStatus,
    ...(includeAdminFields ? { supersededByDocumentId: doc.supersededByDocumentId ?? null } : {}),
    ...(includeAdminFields ? { deletionHold: doc.deletionHold ?? false } : {}),
    ...(includeAdminFields ? { storageProviderVerified: Boolean(doc.storageProvider) } : {}),
    externalPublicationApproved: doc.externalPublicationApproved,
    fileSize: doc.fileSize,
    mimeType: doc.mimeType,
    version: doc.version,
    owner: includeAdminFields ? doc.owner ?? null : null,
    approvedDate: doc.approvedDate,
    nextReviewDate: doc.nextReviewDate,
    boardMinuteReference: includeAdminFields ? doc.boardMinuteReference ?? null : null,
    uploadedById: includeAdminFields ? doc.uploadedById ?? null : null,
    standardLinks: doc.standardLinks.map((link) => ({
      standardId: link.standardId,
      standardCode: link.standard.code,
    })),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export class DocumentService {
  private readonly deletionAttemptTimeoutMs: number;

  constructor(
    private prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
    deletionAttemptTimeoutMs = DOCUMENT_STORAGE_DELETION_ATTEMPT_TIMEOUT_MS,
  ) {
    if (!Number.isInteger(deletionAttemptTimeoutMs) || deletionAttemptTimeoutMs < 10 || deletionAttemptTimeoutMs > DOCUMENT_STORAGE_DELETION_ATTEMPT_TIMEOUT_MS) {
      throw new TypeError(`Document storage deletion timeout must be an integer between 10 and ${DOCUMENT_STORAGE_DELETION_ATTEMPT_TIMEOUT_MS} milliseconds`);
    }
    this.deletionAttemptTimeoutMs = deletionAttemptTimeoutMs;
  }

  private async runBoundedStorageDeletion(
    erase: Eraser,
    deletion: DocumentStorageDeletionRecord,
  ): Promise<Date | void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AppError(504, 'STORAGE_DELETE_TIMEOUT', 'Document storage deletion timed out.'));
      }, this.deletionAttemptTimeoutMs);
    });

    // An eraser is asked to stop through `controller.signal`, but nothing
    // forces it to: the attempt that loses this race is still in flight and may
    // reject long afterwards, when the caller has already moved on. In Node an
    // unhandled rejection terminates the process by default, so one slow
    // erasure that eventually fails could take down the scheduler that was
    // about to process every other row.
    //
    // **`Promise.race` is what prevents that, and it has to stay the thing that
    // does.** `race` attaches a rejection handler to *every* entrant, so the
    // loser's late rejection is observed and discarded by `race` itself; a
    // separate `.catch()` on the attempt would be dead code, which is why there
    // is none here. What is not safe is a refactor that stops handing the
    // attempt to `race` — observing only its fulfilment (`attempt.then(() =>
    // …)`) leaves a derived promise whose rejection nothing handles, and the
    // process dies. That was measured, not assumed, and it is pinned by
    // 'a late rejection from a timed-out storage deletion attempt is observed
    // rather than left unhandled' in document-storage-cleanup.test.ts.
    try {
      return await Promise.race([
        Promise.resolve().then(async () => {
          if (deletion.provider === 'confluence') {
            // Jobs run after the request transaction. A RETIRED label alone
            // cannot justify remote destruction if its linked Vault record
            // has reappeared or the queued job no longer belongs to it.
            const publications = await this.prisma.documentPublication.findMany({
              where: {
                organisationId: deletion.organisationId,
                provider: 'confluence',
                state: 'RETIRED',
                erasureDeletionId: deletion.id,
              },
              select: { documentId: true, cloudId: true, pageId: true, attachmentId: true },
              take: 2,
            });
            if (publications.length !== 1 ||
              (deletion.sourceDocumentId != null && deletion.sourceDocumentId !== publications[0]!.documentId)) {
              throw new AppError(409, 'CONFLUENCE_ERASURE_SOURCE_UNVERIFIED',
                'The queued Confluence erasure is not linked to a retired publication for this charity. Review the job before retrying.');
            }
            controller.signal.throwIfAborted();
            const queuedTarget = parseConfluenceErasureTarget(deletion.targetRef);
            const publishedTarget = publicationErasureTarget(publications[0]!);
            if (queuedTarget.cloudId !== publishedTarget.cloudId ||
              queuedTarget.pageId !== publishedTarget.pageId ||
              queuedTarget.attachmentIds.length !== publishedTarget.attachmentIds.length ||
              queuedTarget.attachmentIds.some((id, index) => id !== publishedTarget.attachmentIds[index])) {
              throw new AppError(409, 'CONFLUENCE_ERASURE_TARGET_CHANGED',
                'The queued Confluence erasure target no longer matches the retired publication. Review the page and attachment IDs before retrying.');
            }
            const liveDocument = await this.prisma.document.findFirst({
              // Recoverable records still protect their external copies.
              where: { id: publications[0]!.documentId, organisationId: deletion.organisationId },
              select: { id: true },
            });
            if (liveDocument) {
              throw new AppError(409, 'CONFLUENCE_DOCUMENT_STILL_PRESENT',
                'The CharityPilot document still exists. Review its retention and publication state before erasing the Confluence copy.');
            }
          }
          controller.signal.throwIfAborted();
          return erase(
            {
              organisationId: deletion.organisationId,
              storagePath: deletion.storagePath,
              targetRef: deletion.targetRef,
            },
            controller.signal,
          );
        }),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async assertStorageQuota(client: DocumentQuotaClient, organisationId: string, requestedBytes: number): Promise<void> {
    if (client.$queryRaw) {
      await client.$queryRaw`
        SELECT "id"
        FROM "Organisation"
        WHERE "id" = ${organisationId}
        FOR UPDATE
      `;
    }

    const subscription = await client.subscription.findUnique({
      where: { organisationId },
      select: { plan: true },
    });

    if (!subscription) {
      throw new AppError(403, 'NO_SUBSCRIPTION', 'No active subscription. Please subscribe to continue.');
    }

    const quotaBytes = DOCUMENT_STORAGE_QUOTA_BYTES[subscription.plan];
    const usage = await client.document.aggregate({
      where: { organisationId },
      _sum: { fileSize: true },
    });
    const usedBytes = usage._sum.fileSize ?? 0;

    if (usedBytes + requestedBytes > quotaBytes) {
      throw new AppError(
        403,
        'DOCUMENT_STORAGE_QUOTA_EXCEEDED',
        'Document storage quota exceeded. Upgrade your plan or remove existing documents before uploading more.',
        {
          quotaBytes,
          usedBytes,
          requestedBytes,
        },
      );
    }
  }

  private async claimPendingStorageDeletions(limit: number): Promise<DocumentStorageDeletionRecord[]> {
    const client = this.prisma as unknown as DocumentStorageDeletionClient;

    if (client.$transaction && client.$queryRaw) {
      return client.$transaction(async (tx) => {
        if (!tx.$queryRaw) {
          return [];
        }

        return tx.$queryRaw<DocumentStorageDeletionRecord[]>`
          UPDATE "DocumentStorageDeletion"
          SET "claimedAt" = CURRENT_TIMESTAMP,
              "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" IN (
            SELECT candidate."id"
            FROM "DocumentStorageDeletion" candidate
            WHERE candidate."state" = 'PENDING'
              AND candidate."processedAt" IS NULL
              AND candidate."attempts" < ${DOCUMENT_STORAGE_DELETION_MAX_ATTEMPTS}
              AND candidate."nextAttemptAt" <= CURRENT_TIMESTAMP
              AND (
                candidate."claimedAt" IS NULL OR
                candidate."claimedAt" < CURRENT_TIMESTAMP - (${STORAGE_DELETION_CLAIM_STALE_AFTER_MS} * INTERVAL '1 millisecond')
              )
              -- The byte permit is not yet available. Leave every job for
              -- the enforced purge's exact provider key pending, including
              -- an unexpected ordinary alias. Unrelated cleanup continues.
              -- Database triggers remain the activation/claim race authority.
              AND NOT EXISTS (
                SELECT 1 FROM "DocumentPurgeClaim" claim
                JOIN "DocumentRecoveryEnforcement" binding
                  ON binding."organisationId" = claim."organisationId"
                JOIN "DocumentPurgeAuthorization" auth
                  ON auth."id" = claim."authorizationId"
                WHERE candidate."organisationId" = claim."organisationId"
                  AND candidate."provider" = auth."provider"
                  AND candidate."storagePath" = auth."storagePath"
              )
            ORDER BY candidate."nextAttemptAt" ASC, candidate."createdAt" ASC
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED
          )
          RETURNING
            "id",
            "organisationId",
            "sourceDocumentId",
            "storagePath",
            "provider",
            "targetRef",
            "state",
            "attempts",
            "claimedAt",
            "nextAttemptAt",
            "deadLetteredAt",
            "terminalReason",
            "alertClaimToken",
            "alertClaimedAt",
            "alertedAt"
        `;
      });
    }

    const now = this.now();
    const staleBefore = new Date(now.getTime() - STORAGE_DELETION_CLAIM_STALE_AFTER_MS);
    const candidates = await deletionDelegate(this.prisma).findMany({
      where: {
        state: 'PENDING',
        processedAt: null,
        attempts: { lt: DOCUMENT_STORAGE_DELETION_MAX_ATTEMPTS },
        nextAttemptAt: { lte: now },
        OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
      },
      orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
      take: limit,
    });
    const claimed: DocumentStorageDeletionRecord[] = [];
    for (const candidate of candidates) {
      const claim = await deletionDelegate(this.prisma).updateMany({
        where: {
          id: candidate.id,
          state: 'PENDING',
          processedAt: null,
          attempts: candidate.attempts,
          nextAttemptAt: { lte: now },
          OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
        },
        data: { claimedAt: now },
      });
      if (claim.count === 1) claimed.push({ ...candidate, claimedAt: now });
    }
    return claimed;
  }

  private async claimUnalertedDeadLetters(limit: number): Promise<DeadLetterAlertClaim | null> {
    const client = this.prisma as unknown as DocumentStorageDeletionClient;
    const claimToken = randomUUID();

    if (client.$transaction && client.$queryRaw) {
      const claimed = await client.$transaction(async (tx) => {
        if (!tx.$queryRaw) return [];
        return tx.$queryRaw<Array<{ id: string }>>`
          UPDATE "DocumentStorageDeletion"
          SET "alertClaimToken" = ${claimToken},
              "alertClaimedAt" = CURRENT_TIMESTAMP,
              "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" IN (
            SELECT "id"
            FROM "DocumentStorageDeletion"
            WHERE "state" = 'DEAD_LETTER'
              AND "alertedAt" IS NULL
              AND (
                "alertClaimedAt" IS NULL OR
                "alertClaimedAt" < CURRENT_TIMESTAMP - (${STORAGE_DELETION_ALERT_CLAIM_STALE_AFTER_MS} * INTERVAL '1 millisecond')
              )
            ORDER BY "deadLetteredAt" ASC, "createdAt" ASC
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED
          )
          RETURNING "id"
        `;
      });
      return claimed.length > 0 ? { claimToken, ids: claimed.map(({ id }) => id) } : null;
    }

    const now = this.now();
    const staleBefore = new Date(now.getTime() - STORAGE_DELETION_ALERT_CLAIM_STALE_AFTER_MS);
    const candidates = await deletionDelegate(this.prisma).findMany({
      where: {
        state: 'DEAD_LETTER',
        alertedAt: null,
        OR: [{ alertClaimedAt: null }, { alertClaimedAt: { lt: staleBefore } }],
      },
      orderBy: [{ deadLetteredAt: 'asc' }, { createdAt: 'asc' }],
      take: limit,
      select: { id: true },
    });
    const ids: string[] = [];
    for (const candidate of candidates) {
      const claim = await deletionDelegate(this.prisma).updateMany({
        where: {
          id: candidate.id,
          state: 'DEAD_LETTER',
          alertedAt: null,
          OR: [{ alertClaimedAt: null }, { alertClaimedAt: { lt: staleBefore } }],
        },
        data: { alertClaimToken: claimToken, alertClaimedAt: now },
      });
      if (claim.count === 1) ids.push(candidate.id);
    }
    return ids.length > 0 ? { claimToken, ids } : null;
  }

  async markDeadLetterAlertSent(claim: DeadLetterAlertClaim): Promise<number> {
    if (claim.ids.length === 0) return 0;
    const result = await deletionDelegate(this.prisma).updateMany({
      where: {
        id: { in: claim.ids },
        state: 'DEAD_LETTER',
        alertedAt: null,
        alertClaimToken: claim.claimToken,
      },
      data: {
        alertedAt: this.now(),
        alertClaimToken: null,
        alertClaimedAt: null,
      },
    });
    return result.count;
  }

  async releaseDeadLetterAlertClaim(claim: DeadLetterAlertClaim): Promise<number> {
    if (claim.ids.length === 0) return 0;
    const result = await deletionDelegate(this.prisma).updateMany({
      where: {
        id: { in: claim.ids },
        state: 'DEAD_LETTER',
        alertedAt: null,
        alertClaimToken: claim.claimToken,
      },
      data: { alertClaimToken: null, alertClaimedAt: null },
    });
    return result.count;
  }

  async list(organisationId: string, page = 1, pageSize = 50, viewerRole: 'OWNER' | 'ADMIN' | 'MEMBER' = 'MEMBER', before?: string) {
    const skip = (page - 1) * pageSize;
    const baseWhere: Prisma.DocumentWhereInput = viewerRole === 'MEMBER'
      ? { organisationId, deletedAt: null, visibility: 'MEMBER_VISIBLE' as const, contentAccessClass: 'MEMBER_SUITABLE' as const,
        memberReviewedSha256: { not: null },
        storageProvider: { in: ['local', 'supabase'] }, lifecycleStatus: { notIn: ['UNREVIEWED', 'DRAFT'] as Array<'UNREVIEWED' | 'DRAFT'> } }
      : { organisationId, deletedAt: null };
    const anchor = before ? await this.prisma.document.findFirst({
      where: { ...baseWhere, id: before }, select: { id: true, createdAt: true },
    }) : null;
    if (before && !anchor) throw new AppError(404, 'DOCUMENT_CURSOR_NOT_FOUND', 'Document cursor not found');
    const where: Prisma.DocumentWhereInput = anchor ? { ...baseWhere, OR: [
      { createdAt: { lt: anchor.createdAt } },
      { createdAt: anchor.createdAt, id: { lt: anchor.id } },
    ] } : baseWhere;
    const includeAdditionalStandards = await documentStandardLinkScope(this.prisma, organisationId);
    if (viewerRole === 'MEMBER') {
      const [rows, total] = await Promise.all([
        this.prisma.document.findMany({
          where, select: memberDocumentSelect(includeAdditionalStandards),
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: anchor ? 0 : skip, take: pageSize + 1,
        }),
        this.prisma.document.count({ where: baseWhere }),
      ]);
      const data = rows.slice(0, pageSize);
      const hasMore = rows.length > pageSize;
      return { data: data.map((doc) => publicDocument(doc)), total, page, pageSize, hasMore,
        nextCursor: hasMore ? data.at(-1)?.id ?? null : null };
    }
    const [rows, total] = await Promise.all([
      this.prisma.document.findMany({
        where,
        include: scopedPublicDocumentInclude(includeAdditionalStandards),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: anchor ? 0 : skip,
        take: pageSize + 1,
      }),
      this.prisma.document.count({ where: baseWhere }),
    ]);
    const data = rows.slice(0, pageSize);
    const hasMore = rows.length > pageSize;
    return { data: data.map((doc) => publicDocument(doc, true)), total, page, pageSize, hasMore,
      nextCursor: hasMore ? data.at(-1)?.id ?? null : null };
  }

  async getById(organisationId: string, id: string, viewerRole: 'OWNER' | 'ADMIN' | 'MEMBER' = 'MEMBER') {
    const includeAdditionalStandards = await documentStandardLinkScope(this.prisma, organisationId);
    if (viewerRole === 'MEMBER') {
      const doc = await this.prisma.document.findFirst({
        where: { deletedAt: null, id, organisationId, visibility: 'MEMBER_VISIBLE', contentAccessClass: 'MEMBER_SUITABLE',
          memberReviewedSha256: { not: null },
          storageProvider: { in: ['local', 'supabase'] }, lifecycleStatus: { notIn: ['UNREVIEWED', 'DRAFT'] } },
        select: memberDocumentSelect(includeAdditionalStandards),
      });
      if (!doc) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
      return publicDocument(doc);
    }
    const doc = await this.prisma.document.findFirst({
      where: { deletedAt: null, id, organisationId },
      include: scopedPublicDocumentInclude(includeAdditionalStandards),
    });

    if (!doc) {
      throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
    }

    return publicDocument(doc, true);
  }

  /**
   * Changes a document's card. The stored file is never touched here.
   *
   * A rename leaves a mirrored Confluence page under its original title. That
   * is deliberate: `DocumentPublication.pageTitle` records what the page is
   * actually called, so the two names differing is visible in the data rather
   * than hidden, and re-titling a page a charity's own people may have linked
   * to belongs to the publish pipeline, not to an edit here.
   */
  async update(
    organisationId: string,
    id: string,
    data: UpdateDocumentRequest,
    expectedUpdatedAt?: string,
    actorUserId?: string,
    visibilityReason?: string,
    lifecycleReason?: string,
    publicationApprovalReason?: string,
    contentAccessReason?: string,
    verifiedSha256?: string,
  ) {
    const includeAdditionalStandards = await documentStandardLinkScope(this.prisma, organisationId);

    const updated = await this.prisma.$transaction(async (tx) => {
      await assertDocumentSourceUnbound(tx, organisationId);
      const existing = await tx.document.findFirst({
        where: { deletedAt: null, id, organisationId },
        select: { id: true, updatedAt: true, category: true, visibility: true, contentAccessClass: true,
          memberReviewedSha256: true, lifecycleStatus: true, storageProvider: true,
          supersededByDocumentId: true, externalPublicationApproved: true,
          externalPublicationSiteId: true, externalPublicationSpaceId: true },
      });

      if (!existing) {
        throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
      }
      const previousPublicationSiteId = existing.externalPublicationSiteId ?? null;
      const previousPublicationSpaceId = existing.externalPublicationSpaceId ?? null;
      assertUnchanged(existing, expectedUpdatedAt, 'DOCUMENT_UPDATE_CONFLICT');

      if (data.visibility && data.visibility !== existing.visibility && (!actorUserId || !visibilityReason)) {
        throw new AppError(400, 'DOCUMENT_VISIBILITY_REASON_REQUIRED', 'A reason and acting user are required to change visibility.');
      }
      if (data.visibility && data.visibility === existing.visibility) {
        throw new AppError(409, 'DOCUMENT_VISIBILITY_UNCHANGED', 'Document visibility has not changed. Refresh the document before reviewing access.');
      }
      if (data.contentAccessClass && (!actorUserId || !contentAccessReason)) {
        throw new AppError(400, 'DOCUMENT_CONTENT_ACCESS_REASON_REQUIRED', 'A reason and acting user are required to assess document content access.');
      }
      if (data.contentAccessClass && data.contentAccessClass === existing.contentAccessClass
        && !(data.contentAccessClass === 'MEMBER_SUITABLE' && !existing.memberReviewedSha256)) {
        throw new AppError(409, 'DOCUMENT_CONTENT_ACCESS_UNCHANGED', 'Content access assessment has not changed. Refresh the document before reviewing access.');
      }
      if (data.contentAccessClass === 'MEMBER_SUITABLE' && !/^[0-9a-f]{64}$/.test(verifiedSha256 ?? '')) {
        throw new AppError(409, 'DOCUMENT_REVIEWED_BYTES_REQUIRED', 'Download and review the current file before allowing Member access.');
      }
      if (data.contentAccessClass === 'MEMBER_SUITABLE') {
        const receipt = await tx.documentDownloadPreparationAudit.findFirst({
          where: { organisationId, documentId: id, actorUserId,
            documentUpdatedAt: existing.updatedAt, reviewSha256: verifiedSha256 },
          select: { id: true },
        });
        if (!receipt) {
          throw new AppError(409, 'DOCUMENT_REVIEW_DOWNLOAD_REQUIRED',
            'Download the current file with this account before recording a Member-suitable review.');
        }
      }
      if (data.lifecycleStatus) {
        if (!actorUserId || !lifecycleReason || !lifecycleNext[existing.lifecycleStatus]?.includes(data.lifecycleStatus)) {
          throw new AppError(409, 'DOCUMENT_LIFECYCLE_TRANSITION_INVALID', 'This lifecycle change is not permitted. Review the current status and provide a reason.');
        }
      }
      if (data.lifecycleStatus === 'SUPERSEDED') {
        if (!data.replacementDocumentId || data.replacementDocumentId === id) {
          throw new AppError(400, 'DOCUMENT_REPLACEMENT_REQUIRED', 'Choose a different current document as the replacement.');
        }
        const replacement = await tx.document.findFirst({
          where: { deletedAt: null, id: data.replacementDocumentId, organisationId },
          select: { id: true, category: true, lifecycleStatus: true },
        });
        if (!replacement || replacement.lifecycleStatus !== 'CURRENT' || replacement.category !== (data.category ?? existing.category)) {
          throw new AppError(409, 'DOCUMENT_REPLACEMENT_INVALID', 'The replacement must be a current document in this charity and category.');
        }
      }
      if (data.category !== undefined && data.category !== existing.category) {
        if (existing.supersededByDocumentId) {
          throw new AppError(409, 'DOCUMENT_REPLACEMENT_CATEGORY_CONFLICT',
            'A superseded document must keep the category of its recorded replacement.');
        }
        const predecessor = await tx.document.findFirst({
          where: { organisationId, supersededByDocumentId: id },
          select: { id: true },
        });
        if (predecessor) {
          throw new AppError(409, 'DOCUMENT_REPLACEMENT_CATEGORY_CONFLICT',
            'A document used as a replacement must keep its category. Review its linked historical documents first.');
        }
      }
      const metadataFields = (['name', 'description', 'category', 'owner', 'approvedDate', 'nextReviewDate', 'boardMinuteReference'] as const)
        .filter((field) => data[field] !== undefined);
      if (metadataFields.length > 0 && !actorUserId) {
        throw new AppError(400, 'DOCUMENT_EDIT_ACTOR_REQUIRED', 'An acting user is required for document metadata edits.');
      }
      const revokeContentAssessment = metadataFields.length > 0 &&
        existing.contentAccessClass === 'MEMBER_SUITABLE' && data.contentAccessClass === undefined;
      if (revokeContentAssessment && data.visibility === 'MEMBER_VISIBLE') {
        throw new AppError(409, 'DOCUMENT_CONTENT_ACCESS_REVIEW_REQUIRED',
          'The document metadata changed. Review the updated record before allowing Member access again.');
      }
      const nextLifecycleStatus = data.lifecycleStatus ?? existing.lifecycleStatus;
      const nextVisibility = revokeContentAssessment ? 'RESTRICTED' : data.visibility ?? existing.visibility;
      const nextContentAccessClass = revokeContentAssessment ? 'UNASSESSED' : data.contentAccessClass ?? existing.contentAccessClass;
      const nextReviewedSha256 = revokeContentAssessment || (data.contentAccessClass && data.contentAccessClass !== 'MEMBER_SUITABLE')
        ? null : data.contentAccessClass === 'MEMBER_SUITABLE' ? verifiedSha256! : existing.memberReviewedSha256;
      if (nextVisibility === 'MEMBER_VISIBLE' && nextLifecycleStatus === 'UNREVIEWED') {
        throw new AppError(409, 'DOCUMENT_LIFECYCLE_UNREVIEWED',
          'Classify this document before allowing Member access.');
      }
      if (nextVisibility === 'MEMBER_VISIBLE' && nextLifecycleStatus === 'DRAFT') {
        throw new AppError(409, 'DOCUMENT_LIFECYCLE_DRAFT',
          'Move this draft to a reviewed lifecycle state before allowing Member access.');
      }
      if (nextVisibility === 'MEMBER_VISIBLE' && nextContentAccessClass !== 'MEMBER_SUITABLE') {
        throw new AppError(409, 'DOCUMENT_CONTENT_ACCESS_NOT_MEMBER_SUITABLE',
          'Review the full file and metadata as suitable for every active Member before allowing access.');
      }
      if (nextVisibility === 'MEMBER_VISIBLE' && !nextReviewedSha256) {
        throw new AppError(409, 'DOCUMENT_REVIEWED_BYTES_REQUIRED',
          'Review the current stored file before allowing Member access.');
      }
      if (nextVisibility === 'MEMBER_VISIBLE' && !data.contentAccessClass
        && verifiedSha256 !== existing.memberReviewedSha256) {
        throw new AppError(409, 'DOCUMENT_REVIEWED_BYTES_CHANGED',
          'The stored file differs from the last Member review. Restrict it and review the current file again.');
      }
      if ((data.contentAccessClass === 'MEMBER_SUITABLE' || nextVisibility === 'MEMBER_VISIBLE')
        && existing.storageProvider !== 'local' && existing.storageProvider !== 'supabase') {
        throw new AppError(409, 'DOCUMENT_STORAGE_PROVIDER_UNVERIFIED',
          'Verify which provider holds this file before assessing or allowing Member access.');
      }
      if (data.externalPublicationApproved === true && nextLifecycleStatus !== 'CURRENT') {
        throw new AppError(409, 'DOCUMENT_NOT_CURRENT', 'Only a current document can be approved for external publication.');
      }
      let approvalTarget: ConfluencePublishTarget | null = null;
      if (data.externalPublicationApproved === true) {
        approvalTarget = await lockedConfluencePublishTargetForOrganisation(tx, organisationId);
        if (!approvalTarget) {
          throw new AppError(409, 'CONFLUENCE_DESTINATION_REQUIRED', 'Choose a connected Confluence space before approving this document for publication.');
        }
        if (data.reviewedPublicationSiteId !== approvalTarget.cloudId ||
            data.reviewedPublicationSpaceId !== approvalTarget.spaceId) {
          throw new AppError(409, 'DOCUMENT_PUBLICATION_TARGET_CHANGED',
            'The selected Confluence site or space changed since it was reviewed. Reopen the approval and review the current destination.');
        }
      }
      if (data.externalPublicationApproved !== undefined) {
        if (!actorUserId || !publicationApprovalReason ||
          (data.externalPublicationApproved === false && !existing.externalPublicationApproved) ||
          (data.externalPublicationApproved === true && existing.externalPublicationApproved
            && previousPublicationSiteId === approvalTarget?.cloudId
            && previousPublicationSpaceId === approvalTarget?.spaceId)) {
          throw new AppError(409, 'DOCUMENT_PUBLICATION_APPROVAL_UNCHANGED', 'Publication approval did not change. Review the current decision and provide a reason.');
        }
      }
      const approvalPublication = data.externalPublicationApproved === true
        ? await tx.documentPublication.findFirst({
          where: { organisationId, documentId: id, provider: 'confluence' },
          select: { id: true, state: true, terminalReason: true, cloudId: true, spaceId: true, pageId: true },
        }) : null;
      if (approvalPublication?.terminalReason === 'REMOTE_WRITE_OUTCOME_UNKNOWN') {
        throw new AppError(409, 'DOCUMENT_PUBLICATION_REMOTE_OUTCOME_UNKNOWN',
          'The previous Confluence write may have completed. Reconcile that copy before approving another publication.');
      }
      if (approvalPublication?.pageId && (approvalPublication.cloudId !== approvalTarget!.cloudId ||
        approvalPublication.spaceId !== approvalTarget!.spaceId)) {
        throw new AppError(409, 'DOCUMENT_PUBLICATION_DESTINATION_CHANGED',
          'An existing Confluence page belongs to another site or space. Review that copy before approving this destination.');
      }
      const nextPublicationApproval = nextLifecycleStatus === 'CURRENT'
        ? data.externalPublicationApproved ?? existing.externalPublicationApproved
        : false;
      const nextPublicationSiteId = nextPublicationApproval
        ? approvalTarget?.cloudId ?? previousPublicationSiteId : null;
      const nextPublicationSpaceId = nextPublicationApproval
        ? approvalTarget?.spaceId ?? previousPublicationSpaceId : null;
      const changingControl = revokeContentAssessment || data.visibility !== undefined || data.contentAccessClass !== undefined || data.lifecycleStatus !== undefined || data.externalPublicationApproved !== undefined;

      let result;
      try {
        result = await tx.document.update({
          where: changingControl
            ? { id, organisationId, deletedAt: null, visibility: existing.visibility, contentAccessClass: existing.contentAccessClass,
              memberReviewedSha256: existing.memberReviewedSha256, lifecycleStatus: existing.lifecycleStatus,
              externalPublicationApproved: existing.externalPublicationApproved, updatedAt: existing.updatedAt }
            : { id, organisationId, deletedAt: null, updatedAt: existing.updatedAt },
          data: {
            name: data.name,
            description: data.description,
            category: data.category,
            visibility: revokeContentAssessment ? 'RESTRICTED' : data.visibility,
            contentAccessClass: revokeContentAssessment ? 'UNASSESSED' : data.contentAccessClass,
            memberReviewedSha256: nextReviewedSha256,
            lifecycleStatus: data.lifecycleStatus,
            ...(data.lifecycleStatus ? { supersededByDocumentId: data.lifecycleStatus === 'SUPERSEDED'
              ? data.replacementDocumentId
              : data.lifecycleStatus === 'HISTORICAL' ? existing.supersededByDocumentId ?? null : null } : {}),
            externalPublicationApproved: nextPublicationApproval,
            externalPublicationSiteId: nextPublicationSiteId,
            externalPublicationSpaceId: nextPublicationSpaceId,
            owner: data.owner,
            approvedDate: toNullableDate(data.approvedDate),
            nextReviewDate: toNullableDate(data.nextReviewDate),
            boardMinuteReference: data.boardMinuteReference,
          },
          include: scopedPublicDocumentInclude(includeAdditionalStandards),
        });
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2025') {
          throw new AppError(409, 'DOCUMENT_UPDATE_CONFLICT', 'Document changed. Refresh the document and try again.');
        }
        const databaseError = typeof error === 'object' && error !== null && 'meta' in error
          ? (error.meta as { database_error?: unknown } | undefined)?.database_error
          : undefined;
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2004'
          && typeof databaseError === 'string'
          && /Document replacement category mismatch|Referenced replacement category cannot change/.test(databaseError)) {
          throw new AppError(409, 'DOCUMENT_REPLACEMENT_CATEGORY_CONFLICT',
            'The replacement lineage changed. Refresh the documents and review their categories.');
        }
        throw error;
      }
      if (metadataFields.length > 0) {
        await tx.documentControlAudit.create({ data: {
          organisationId, documentId: id, actorUserId: actorUserId!, kind: 'METADATA',
          previous: existing.updatedAt.toISOString(), next: result.updatedAt.toISOString(),
          reason: `Metadata edit applied to fields: ${metadataFields.join(', ')}.`,
        } });
      }
      if (data.visibility && data.visibility !== existing.visibility) {
        await tx.documentVisibilityAudit.create({
          data: {
            organisationId,
            documentId: id,
            actorUserId: actorUserId!,
            previous: existing.visibility,
            next: data.visibility,
            reason: visibilityReason!,
          },
        });
      }
      if (revokeContentAssessment && existing.visibility === 'MEMBER_VISIBLE' && !data.visibility) {
        await tx.documentVisibilityAudit.create({ data: {
          organisationId, documentId: id, actorUserId: actorUserId!,
          previous: 'MEMBER_VISIBLE', next: 'RESTRICTED',
          reason: `Automatically restricted because document metadata changed: ${metadataFields.join(', ')}.`,
        } });
      }
      if (data.contentAccessClass || revokeContentAssessment) {
        await tx.documentControlAudit.create({ data: {
          organisationId, documentId: id, actorUserId: actorUserId!, kind: 'CONTENT_ACCESS',
          previous: existing.contentAccessClass, next: nextContentAccessClass,
          reason: revokeContentAssessment
            ? `Automatically reset because document metadata changed: ${metadataFields.join(', ')}.`
            : contentAccessReason!,
        } });
      }
      if (data.lifecycleStatus) {
        await tx.documentControlAudit.create({ data: {
          organisationId, documentId: id, actorUserId: actorUserId!, kind: 'LIFECYCLE',
          previous: existing.lifecycleStatus, next: data.lifecycleStatus, reason: lifecycleReason!,
        } });
        if (data.lifecycleStatus === 'SUPERSEDED' || (existing.supersededByDocumentId && data.lifecycleStatus !== 'HISTORICAL')) {
          await tx.documentControlAudit.create({ data: {
            organisationId, documentId: id, actorUserId: actorUserId!, kind: 'REPLACEMENT',
            previous: existing.supersededByDocumentId ?? '',
            next: data.lifecycleStatus === 'SUPERSEDED' ? data.replacementDocumentId! : '',
            reason: lifecycleReason!,
          } });
        }
      }
      if (nextPublicationApproval !== existing.externalPublicationApproved) {
        await tx.documentControlAudit.create({ data: {
          organisationId, documentId: id, actorUserId: actorUserId!, kind: 'PUBLICATION',
          previous: String(existing.externalPublicationApproved), next: String(nextPublicationApproval),
          reason: data.externalPublicationApproved !== undefined
            ? publicationApprovalReason!
            : `Automatically revoked because lifecycle changed from ${existing.lifecycleStatus} to ${nextLifecycleStatus}.`,
        } });
      }
      if (nextPublicationSiteId !== previousPublicationSiteId ||
          nextPublicationSpaceId !== previousPublicationSpaceId) {
        await tx.documentControlAudit.create({ data: {
          organisationId, documentId: id, actorUserId: actorUserId!, kind: 'PUBLICATION_TARGET',
          previous: JSON.stringify({ siteId: previousPublicationSiteId, spaceId: previousPublicationSpaceId }),
          next: JSON.stringify({ siteId: nextPublicationSiteId, spaceId: nextPublicationSpaceId }),
          reason: data.externalPublicationApproved !== undefined
            ? publicationApprovalReason!
            : `Automatically cleared because lifecycle changed from ${existing.lifecycleStatus} to ${nextLifecycleStatus}.`,
        } });
      }
      if (data.externalPublicationApproved === true) {
        const publication = approvalPublication;
        if (!publication) {
          await tx.documentPublication.create({ data: { organisationId, documentId: id, provider: 'confluence' } });
        } else if (publication.state === 'PROCESSED' || publication.state === 'DEAD_LETTER') {
          const requeued = await tx.documentPublication.updateMany({
            where: { id: publication.id, organisationId, state: publication.state },
            data: {
              state: 'PENDING', reason: 'METADATA', requeuedAt: this.now(), attempts: 0,
              lastError: null, nextAttemptAt: this.now(), claimedAt: null, deadLetteredAt: null,
              remoteWriteStartedAt: null,
              terminalReason: null, alertClaimToken: null, alertClaimedAt: null, alertedAt: null, processedAt: null,
            },
          });
          if (requeued.count !== 1) {
            throw new AppError(409, 'DOCUMENT_PUBLICATION_CONFLICT', 'The publication queue changed. Refresh and try again.');
          }
        } else if (publication.state !== 'PENDING') {
          throw new AppError(409, 'DOCUMENT_PUBLICATION_RETIRED', 'The prior publication was retired and cannot be revived.');
        }
      }
      return result;
    });

    // The mirror's metadata is stale from this moment until it is republished.
    // The content property carries the approved date, the next review date and
    // the minute reference — exactly the fields this update can change — so a
    // charity editing an approval date and seeing the old one on the Confluence
    // page is reading a governance record that disagrees with CharityPilot's.
    //
    // Outside the transaction and best-effort, for the same reason the upload
    // path's enqueue is: the authoritative Irish copy is already updated, and a
    // mirror that is briefly behind is recoverable where a failed edit is not.
    if (data.externalPublicationApproved !== true && updated.lifecycleStatus === 'CURRENT' && updated.externalPublicationApproved) {
      await this.enqueueConfluencePublication(organisationId, id, 'METADATA');
    }

    return publicDocument(updated, true);
  }

  async getDownloadDescriptor(organisationId: string, id: string, viewerRole: 'OWNER' | 'ADMIN' | 'MEMBER'): Promise<{
    storagePath: string;
    storageProvider: string | null;
    fileSize: number;
    contentAccessClass: 'UNASSESSED' | 'MEMBER_SUITABLE' | 'RESTRICTED_SENSITIVE';
    lifecycleStatus: 'UNREVIEWED' | 'DRAFT' | 'CURRENT' | 'SUPERSEDED' | 'RETIRED' | 'HISTORICAL';
    mimeType: string;
    name: string;
    visibility: 'RESTRICTED' | 'MEMBER_VISIBLE';
    updatedAt: Date;
  }> {
    const doc = await this.prisma.document.findFirst({
      where: viewerRole === 'MEMBER'
        ? { id, organisationId, deletedAt: null, visibility: 'MEMBER_VISIBLE', contentAccessClass: 'MEMBER_SUITABLE',
          memberReviewedSha256: { not: null },
          storageProvider: { in: ['local', 'supabase'] }, lifecycleStatus: { notIn: ['UNREVIEWED', 'DRAFT'] } }
        : { id, organisationId, deletedAt: null },
      select: { fileUrl: true, storageProvider: true, fileSize: true, mimeType: true, name: true, updatedAt: true,
        visibility: true, contentAccessClass: true, lifecycleStatus: true },
    });

    if (!doc) {
      throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
    }

    return {
      storagePath: doc.fileUrl,
      storageProvider: doc.storageProvider,
      fileSize: doc.fileSize,
      contentAccessClass: doc.contentAccessClass,
      lifecycleStatus: doc.lifecycleStatus,
      mimeType: doc.mimeType,
      name: doc.name,
      visibility: doc.visibility,
      updatedAt: doc.updatedAt,
    };
  }

  async create(
    organisationId: string,
    userId: string,
    data: {
      name: string;
      description?: string;
      category: string;
      /** Storage path within Supabase Storage (used as fileUrl column) */
      fileUrl: string;
      fileSize: number;
      mimeType: string;
      owner?: string | null;
      approvedDate?: string | null;
      nextReviewDate?: string | null;
      boardMinuteReference?: string | null;
    },
    uploadIntentId: string,
    uploadedProvider: string,
  ) {
    const client = this.prisma as unknown as DocumentQuotaClient;

    const createDocument = async (tx: DocumentQuotaClient) => {
      await this.assertStorageQuota(tx, organisationId, data.fileSize);

      const created = await tx.document.create({
        data: {
          organisationId,
          uploadedById: userId,
          name: data.name,
          description: data.description,
          category: data.category as never,
          visibility: 'RESTRICTED',
          lifecycleStatus: 'DRAFT',
          externalPublicationApproved: false,
          fileUrl: data.fileUrl,
          storageProvider: uploadedProvider,
          fileSize: data.fileSize,
          mimeType: data.mimeType,
          owner: data.owner,
          approvedDate: data.approvedDate ? new Date(data.approvedDate) : null,
          nextReviewDate: data.nextReviewDate ? new Date(data.nextReviewDate) : null,
          boardMinuteReference: data.boardMinuteReference,
        },
        include: publicDocumentInclude,
      });
      await tx.documentControlAudit.create({ data: {
        organisationId, documentId: created.id, actorUserId: userId, kind: 'UPLOAD',
        previous: 'NONE', next: 'RESTRICTED/DRAFT',
        reason: 'Document uploaded into restricted draft state.',
      } });
      const attached = await tx.documentUploadIntent.updateMany({
        where: {
          id: uploadIntentId, organisationId, storagePath: data.fileUrl,
          provider: uploadedProvider, state: 'RESERVED',
        },
        data: { state: 'ATTACHED', documentId: created.id },
      });
      if (attached.count !== 1) {
        throw new AppError(409, 'DOCUMENT_UPLOAD_INTENT_CONFLICT', 'The upload reservation changed. Try again.');
      }
      return created;
    };

    const doc = client.$transaction ? await client.$transaction(createDocument) : await createDocument(client);

    // A draft has no external-publication approval and is never queued by
    // upload. An administrator must classify and approve it separately.

    return publicDocument(doc, true);
  }

  /**
   * Best-effort metadata requeue for an already-current, approved document.
   * Initial publication approval and its first enqueue occur atomically in
   * `update`; this helper is not an approval path. A connected Confluence
   * integration and chosen space remain necessary for each requeue.
   *
   * Best-effort, by design: metadata edits have already committed, so a
   * temporary mirror outage does not roll back the authoritative document.
   */
  private async enqueueConfluencePublication(
    organisationId: string,
    documentId: string,
    reason: 'CREATE' | 'METADATA' | 'FILE' = 'METADATA',
  ): Promise<void> {
    try {
      const target = await confluencePublishTargetForOrganisation(
        this.prisma as unknown as PublishTargetClient,
        organisationId,
      );
      if (target === null) return;
      const approved = await this.prisma.document.findFirst({
        where: { deletedAt: null, id: documentId, organisationId, lifecycleStatus: 'CURRENT',
          externalPublicationApproved: true, externalPublicationSiteId: target.cloudId,
          externalPublicationSpaceId: target.spaceId },
        select: { id: true },
      });
      if (!approved) return;

      if (reason === 'CREATE') {
        await publicationDelegate(this.prisma).create({
          data: { organisationId, documentId, provider: 'confluence' },
        });
        return;
      }

      // A RE-QUEUE REUSES THE ROW, and must, because the row is the only thing
      // that remembers which Confluence page this document became. A second
      // row would publish a second page and leave the first orphaned with a
      // charity's governance document on it.
      //
      // `attempts: 0` and a cleared `lastError`/`deadLetteredAt`: a change is a
      // new piece of work, and carrying the previous attempt count would let
      // one bad afternoon dead-letter every future edit of that document. The
      // page identifiers are deliberately NOT cleared — the publisher adopts
      // `pageId` without a lookup, which is exactly how it republishes rather
      // than creating again.
      //
      // Scoped to states that can be re-queued. A RETIRED row belongs to a
      // deleted document and must never be revived: reviving one would
      // republish a document the charity deleted, which is the precise thing
      // the owner's 2026-09-19 ruling exists to prevent.
      const requeued = await publicationDelegate(this.prisma).updateMany({
        where: {
          documentId,
          organisationId,
          provider: 'confluence',
          state: { in: ['PROCESSED', 'DEAD_LETTER'] },
        },
        data: {
          state: 'PENDING',
          reason,
          requeuedAt: new Date(),
          attempts: 0,
          lastError: null,
          nextAttemptAt: new Date(),
          claimedAt: null,
          remoteWriteStartedAt: null,
          deadLetteredAt: null,
          terminalReason: null,
          alertClaimToken: null,
          alertClaimedAt: null,
          alertedAt: null,
          processedAt: null,
        },
      });

      if (requeued.count === 0) {
        const existing = await publicationDelegate(this.prisma).findFirst({
          where: { documentId, organisationId, provider: 'confluence' },
          select: { id: true },
        });
        if (!existing) {
          await publicationDelegate(this.prisma).create({
            data: { organisationId, documentId, provider: 'confluence' },
          });
        }
      }
    } catch (error) {
      // Log and move on. The document is already safely in Supabase; a
      // charity that cannot be mirrored on this upload is simply not
      // mirrored yet, which is recoverable, unlike a failed upload.
      console.error(
        `[document-publication] Could not enqueue a Confluence publication for document ${documentId} ` +
          `(organisation ${organisationId}); the upload itself already succeeded.`,
        error,
      );
    }
  }

  async setDeletionHold(input: {
    organisationId: string;
    documentId: string;
    actorUserId: string;
    expectedUpdatedAt: Date;
    held: boolean;
    reason: string;
  }): Promise<{ id: string; deletionHold: boolean; updatedAt: Date }> {
    return this.prisma.$transaction(async (tx) => {
      // Serialize the ordinary hold path with recovery binding. Until hold
      // decisions have independent replay facts, neither placement nor
      // release may proceed after this charity is bound.
      await tx.$queryRaw`SELECT id FROM "Organisation" WHERE id=${input.organisationId} FOR UPDATE`;
      const enforcement = await tx.documentRecoveryEnforcement.findUnique({
        where: { organisationId: input.organisationId }, select: { id: true },
      });
      if (enforcement) throw new AppError(409, 'DOCUMENT_HOLD_RECOVERY_REQUIRED',
        'This charity requires an independently recorded document hold decision.');
      const existing = await tx.document.findFirst({
        where: { id: input.documentId, organisationId: input.organisationId },
        select: { id: true, deletionHold: true, updatedAt: true },
      });
      if (!existing) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
      if (existing.deletionHold === input.held) {
        throw new AppError(409, 'DOCUMENT_DELETION_HOLD_UNCHANGED', 'The deletion hold has not changed. Refresh the document.');
      }
      let updated;
      try {
        updated = await tx.document.update({
          where: {
            id: input.documentId, organisationId: input.organisationId,
            updatedAt: input.expectedUpdatedAt, deletionHold: existing.deletionHold,
          },
          data: { deletionHold: input.held },
          select: { id: true, deletionHold: true, updatedAt: true },
        });
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2025') {
          throw new AppError(409, 'DOCUMENT_UPDATE_CONFLICT', 'Document changed. Refresh and review the deletion hold.');
        }
        throw error;
      }
      await tx.documentControlAudit.create({ data: {
        organisationId: input.organisationId,
        documentId: input.documentId,
        actorUserId: input.actorUserId,
        kind: 'DELETION_HOLD',
        previous: String(existing.deletionHold),
        next: String(input.held),
        reason: input.reason,
      } });
      return updated;
    });
  }

  async verifyWrittenStorageProvider(input: {
    organisationId: string;
    documentId: string;
    actorUserId: string;
    expectedUpdatedAt: Date;
  }, inspect: (storagePath: string, provider: 'local' | 'supabase') => Promise<{ present: boolean; size: number | null }>): Promise<{
    id: string; storageProviderVerified: true; updatedAt: Date;
  }> {
    const doc = await this.prisma.document.findFirst({
      where: { deletedAt: null, id: input.documentId, organisationId: input.organisationId },
      select: { id: true, fileUrl: true, fileSize: true, storageProvider: true },
    });
    if (!doc) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
    if (doc.storageProvider) {
      throw new AppError(409, 'DOCUMENT_STORAGE_PROVIDER_ALREADY_VERIFIED', 'This document already has a recorded storage provider.');
    }

    // Both stores must answer. A connection failure or missing credentials do
    // not prove absence, and a same-key object in both stores is ambiguous.
    const [local, supabase] = await Promise.all([
      inspect(doc.fileUrl, 'local'),
      inspect(doc.fileUrl, 'supabase'),
    ]);
    const present = ([['local', local], ['supabase', supabase]] as const)
      .filter(([, result]) => result.present);
    if (present.length !== 1 || present[0]![1].size !== doc.fileSize) {
      throw new AppError(409, 'DOCUMENT_STORAGE_PROVIDER_AMBIGUOUS', 'Storage custody could not be established from one matching active object. Review the file and provider evidence.');
    }
    const provider = present[0]![0];

    return this.prisma.$transaction(async (tx) => {
      await assertDocumentSourceUnbound(tx, input.organisationId);
      let updated;
      try {
        updated = await tx.document.update({
          where: {
            deletedAt: null, id: input.documentId, organisationId: input.organisationId,
            storageProvider: null, fileUrl: doc.fileUrl, fileSize: doc.fileSize,
            updatedAt: input.expectedUpdatedAt,
          },
          data: { storageProvider: provider },
          select: { id: true, updatedAt: true },
        });
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2025') {
          throw new AppError(409, 'DOCUMENT_UPDATE_CONFLICT', 'Document changed during storage review. Refresh and try again.');
        }
        throw error;
      }
      await tx.documentControlAudit.create({ data: {
        organisationId: input.organisationId, documentId: input.documentId,
        actorUserId: input.actorUserId, kind: 'STORAGE_PROVIDER',
        previous: 'UNVERIFIED', next: provider,
        reason: 'Only one supported provider had an active object matching the recorded file size during custody review.',
      } });
      return { ...updated, storageProviderVerified: true as const };
    });
  }

  async markStorageDeletionProcessed(id: string, claimedAt: Date | null = null, activeObjectAbsentAt?: Date): Promise<boolean> {
    const result = await deletionDelegate(this.prisma).updateMany({
      where: {
        id,
        state: 'PENDING',
        processedAt: null,
        claimedAt,
      },
      data: {
        state: 'PROCESSED',
        processedAt: this.now(),
        ...(activeObjectAbsentAt ? { activeObjectAbsentAt } : {}),
        nextAttemptAt: null,
        lastError: null,
        claimedAt: null,
        deadLetteredAt: null,
        terminalReason: null,
        alertClaimToken: null,
        alertClaimedAt: null,
        alertedAt: null,
      },
    });
    return result.count === 1;
  }

  async recordStorageDeletionFailure(
    id: string,
    error: unknown,
    claimedAt: Date | null = null,
  ): Promise<{
    status: 'retry-scheduled' | 'dead-lettered' | 'ignored';
    attempts: number | null;
    nextAttemptAt: Date | null;
    terminalReason: DocumentStorageDeletionTerminalReason | null;
  }> {
    const client = this.prisma as unknown as DocumentStorageDeletionClient;
    const recordFailure = async (tx: DocumentStorageDeletionClient) => {
      const current = await deletionDelegate(tx).findFirst({
        where: {
          id,
          state: 'PENDING',
          processedAt: null,
          claimedAt,
        },
        select: {
          id: true,
          attempts: true,
          claimedAt: true,
        },
      });
      if (!current) {
        return {
          status: 'ignored' as const,
          attempts: null,
          nextAttemptAt: null,
          terminalReason: null,
        };
      }

      const attempt = current.attempts + 1;
      const now = this.now();
      const permanentReason = permanentStorageDeletionTerminalReason(error);
      const deadLettered = permanentReason !== null || attempt >= DOCUMENT_STORAGE_DELETION_MAX_ATTEMPTS;
      const terminalReason: DocumentStorageDeletionTerminalReason | null = permanentReason
        ?? (deadLettered ? 'MAX_ATTEMPTS_EXHAUSTED' : null);
      const nextAttemptAt = deadLettered
        ? null
        : new Date(now.getTime() + documentStorageDeletionRetryDelayMs(attempt));
      const update = await deletionDelegate(tx).updateMany({
        where: {
          id,
          state: 'PENDING',
          processedAt: null,
          attempts: current.attempts,
          claimedAt,
        },
        data: {
          state: deadLettered ? 'DEAD_LETTER' : 'PENDING',
          attempts: attempt,
          lastError: formatProviderError(error).slice(0, 500),
          lastAttemptAt: now,
          nextAttemptAt,
          claimedAt: null,
          deadLetteredAt: deadLettered ? now : null,
          terminalReason,
          alertClaimToken: null,
          alertClaimedAt: null,
          alertedAt: null,
        },
      });
      if (update.count !== 1) {
        return {
          status: 'ignored' as const,
          attempts: null,
          nextAttemptAt: null,
          terminalReason: null,
        };
      }
      return {
        status: deadLettered ? 'dead-lettered' as const : 'retry-scheduled' as const,
        attempts: attempt,
        nextAttemptAt,
        terminalReason,
      };
    };

    return client.$transaction ? client.$transaction(recordFailure) : recordFailure(client);
  }

  async reconcileStaleUploadIntents(limit = 25): Promise<{ attached: number; queued: number; failed: number }> {
    const boundedLimit = Math.min(50, Math.max(1, Number.isInteger(limit) ? limit : 25));
    const staleBefore = new Date(this.now().getTime() - UPLOAD_INTENT_STALE_AFTER_MS);
    const candidates = await this.prisma.documentUploadIntent.findMany({
      where: { state: 'RESERVED', createdAt: { lte: staleBefore } },
      orderBy: [
        { lastReconcileAttemptAt: { sort: 'asc', nulls: 'first' } },
        { createdAt: 'asc' },
        { id: 'asc' },
      ],
      take: boundedLimit,
      select: { id: true },
    });
    let attached = 0;
    let queued = 0;
    let failed = 0;

    for (const candidate of candidates) {
      try {
        // Stamp outside the settlement transaction. A failed settlement rolls
        // back its deletion row and state transition, while this timestamp
        // moves the still-RESERVED intent behind other stale reservations.
        const attempted = await this.prisma.documentUploadIntent.updateMany({
          where: { id: candidate.id, state: 'RESERVED', createdAt: { lte: staleBefore } },
          data: { lastReconcileAttemptAt: this.now() },
        });
        if (attempted.count !== 1) continue;
        const outcome = await this.prisma.$transaction(async (tx) => {
          const intent = await tx.documentUploadIntent.findFirst({
            where: { id: candidate.id, state: 'RESERVED', createdAt: { lte: staleBefore } },
            select: { id: true, organisationId: true, storagePath: true, provider: true },
          });
          if (!intent) return 'changed' as const;

          const liveDocument = await tx.document.findFirst({
            where: { organisationId: intent.organisationId, fileUrl: intent.storagePath },
            select: { id: true },
          });
          if (liveDocument) {
            const result = await tx.documentUploadIntent.updateMany({
              where: { id: intent.id, state: 'RESERVED' },
              data: { state: 'ATTACHED', documentId: liveDocument.id },
            });
            if (result.count !== 1) throw new Error('Upload intent changed during attachment reconciliation');
            return 'attached' as const;
          }

          const deletion = await tx.documentStorageDeletion.create({
            data: {
              organisationId: intent.organisationId,
              storagePath: intent.storagePath,
              provider: intent.provider,
              targetRef: { source: 'UPLOAD_INTENT', intentId: intent.id },
            },
            select: { id: true },
          });
          const result = await tx.documentUploadIntent.updateMany({
            where: { id: intent.id, state: 'RESERVED' },
            data: { state: 'CLEANUP_PENDING', cleanupDeletionId: deletion.id },
          });
          if (result.count !== 1) throw new Error('Upload intent changed during cleanup reconciliation');
          return 'queued' as const;
        });
        if (outcome === 'attached') attached += 1;
        if (outcome === 'queued') queued += 1;
      } catch {
        // The transaction rolls back any deletion row it created. Keep the
        // reservation for another run and return a count for operator alerting.
        failed += 1;
      }
    }
    return { attached, queued, failed };
  }

  async retryPendingStorageDeletions(
    dispatch: ErasureDispatcher,
    limit = 25,
  ): Promise<DocumentStorageCleanupResult> {
    const boundedLimit = Math.min(
      DOCUMENT_STORAGE_DELETION_MAX_CLAIM_BATCH,
      Math.max(1, Number.isInteger(limit) ? limit : 25),
    );
    const pending = await this.claimPendingStorageDeletions(boundedLimit);

    let processed = 0;
    let retryScheduled = 0;
    let newlyDeadLettered = 0;

    for (const deletion of pending) {
      const erase = dispatch(deletion.provider);
      if (!erase) {
        // Unerasable by this deployment. Record the attempt — one was genuinely
        // made, and the audit trail should say so — but dead-letter now instead
        // of waiting for the attempt budget to run out, which would only delay
        // the operator alert while telling them nothing they do not already know.
        const failure = await this.recordStorageDeletionFailure(
          deletion.id,
          new AppError(
            501,
            'PROVIDER_NOT_ERASABLE',
            `No eraser is registered for document storage provider "${deletion.provider}".`,
          ),
          deletion.claimedAt,
        );
        if (failure.status === 'retry-scheduled') retryScheduled += 1;
        if (failure.status === 'dead-lettered') newlyDeadLettered += 1;
        continue;
      }

      let activeObjectAbsentAt: Date | void;
      try {
        if (deletion.provider === 'supabase' || deletion.provider === 'local') {
          const liveDocument = await this.prisma.document.findFirst({
            where: { organisationId: deletion.organisationId, fileUrl: deletion.storagePath },
            select: { id: true },
          });
          if (liveDocument) {
            throw new AppError(
              409, 'STORAGE_TARGET_STILL_REFERENCED',
              'A live document still references this storage path. Erasure requires review.',
            );
          }
        }
        activeObjectAbsentAt = await this.runBoundedStorageDeletion(erase, deletion);
        if ((deletion.provider === 'supabase' || deletion.provider === 'local') &&
          (!(activeObjectAbsentAt instanceof Date) || !Number.isFinite(activeObjectAbsentAt.getTime()))) {
          throw new AppError(500, 'STORAGE_DELETE_UNVERIFIED', 'Primary storage deletion has no active-object absence observation.');
        }
      } catch (error) {
        const failure = await this.recordStorageDeletionFailure(deletion.id, error, deletion.claimedAt);
        if (failure.status === 'retry-scheduled') retryScheduled += 1;
        if (failure.status === 'dead-lettered') newlyDeadLettered += 1;
        continue;
      }

      const finalized = await this.markStorageDeletionProcessed(
        deletion.id, deletion.claimedAt,
        (deletion.provider === 'supabase' || deletion.provider === 'local') && activeObjectAbsentAt instanceof Date
          ? activeObjectAbsentAt : undefined,
      );
      if (finalized) processed += 1;
    }

    const deadLetterAlert = await this.claimUnalertedDeadLetters(boundedLimit);
    return {
      processed,
      failed: retryScheduled + newlyDeadLettered,
      retryScheduled,
      newlyDeadLettered,
      deadLetterAlert,
    };
  }

  async listDeadLetterStorageDeletions(organisationId: string, limit = 50, after?: string) {
    const boundedLimit = Math.min(100, Math.max(1, Number.isInteger(limit) ? limit : 50));
    const deletion = deletionDelegate(this.prisma);
    const anchor = after ? await deletion.findFirst({
      where: { id: after, organisationId, state: 'DEAD_LETTER' },
      select: { id: true, deadLetteredAt: true, createdAt: true },
    }) : null;
    if (after && !anchor) {
      throw new AppError(404, 'DOCUMENT_STORAGE_DEAD_LETTER_CURSOR_NOT_FOUND', 'Failed deletion cursor not found.');
    }
    if (anchor && !anchor.deadLetteredAt) {
      throw new AppError(409, 'DOCUMENT_STORAGE_DEAD_LETTER_DATE_MISSING', 'Failed deletion date is missing.');
    }
    const rows = await deletion.findMany({
      where: { organisationId, state: 'DEAD_LETTER', ...(anchor ? { OR: [
        { deadLetteredAt: { gt: anchor.deadLetteredAt } },
        { deadLetteredAt: anchor.deadLetteredAt, createdAt: { gt: anchor.createdAt } },
        { deadLetteredAt: anchor.deadLetteredAt, createdAt: anchor.createdAt, id: { gt: anchor.id } },
      ] } : {}) },
      orderBy: [{ deadLetteredAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: boundedLimit + 1,
      select: {
        id: true,
        provider: true,
        attempts: true,
        lastError: true,
        lastAttemptAt: true,
        deadLetteredAt: true,
        terminalReason: true,
        alertedAt: true,
        createdAt: true,
      },
    });
    const page = rows.slice(0, boundedLimit);
    return {
      data: page.map((row) => ({
        id: row.id,
        // A Supabase dead-letter and a Confluence one need entirely different
        // remedies (fix our storage vs. a human with space-admin rights in
        // the charity's own Atlassian site), so the administrator has to be
        // able to tell them apart from the list, not just from a detail view.
        provider: row.provider,
        attempts: row.attempts,
        // Older retained rows may predate write-time scrubbing. Keep the
        // diagnostic useful to an Admin without replaying raw provider text.
        lastError: row.lastError ? sanitizeProviderDiagnosticText(row.lastError) : null,
        lastAttemptAt: row.lastAttemptAt ?? null,
        deadLetteredAt: row.deadLetteredAt,
        terminalReason: row.terminalReason,
        alertedAt: row.alertedAt,
        createdAt: row.createdAt,
      })),
      nextCursor: rows.length > boundedLimit ? page[page.length - 1]!.id : null,
    };
  }

  async recoverDeadLetterStorageDeletion(input: {
    organisationId: string;
    deletionId: string;
    actor: DocumentStorageDeletionRecoveryActor;
    reason: string;
    disposition: DocumentStorageDeletionRecoveryDisposition;
    correctedStoragePath?: string;
    expectedAttempts?: number;
    expectedTerminalReason?: DocumentStorageDeletionTerminalReason;
  }): Promise<{
    id: string;
    status: 'PENDING' | 'PROCESSED';
    disposition: DocumentStorageDeletionRecoveryDisposition;
    nextAttemptAt: Date | null;
  }> {
    const reason = input.reason.replace(/\r\n?/g, '\n').trim();
    // Counts Unicode code points, not UTF-16 units, to agree with the
    // `char_length`-based `DocumentStorageDeletionRecovery_reason_bounded`
    // CHECK this guard backs — the same reasoning as the bounds refinements
    // on `requeueStorageDeletionSchema` in `routes/documents/index.ts` and
    // `confluenceErasureSchema` in `routes/integrations/index.ts`. A plain
    // `reason.length` here would accept five astral-plane characters (ten
    // UTF-16 units, five code points) that the CHECK then rejects, turning
    // this guard's 400 into a 500.
    const reasonCodePointLength = Array.from(reason).length;
    if (
      reasonCodePointLength < 10 ||
      reasonCodePointLength > 500 ||
      /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/.test(reason)
    ) {
      throw new AppError(400, 'INVALID_RECOVERY_REASON', 'Give a safe recovery reason between 10 and 500 characters.');
    }

    if (!['REQUEUE_UNCHANGED', 'REQUEUE_CORRECTED_PATH', 'COMPLETE_EXTERNALLY_REMEDIATED'].includes(input.disposition)) {
      throw new AppError(400, 'INVALID_RECOVERY_DISPOSITION', 'Choose a supported document storage recovery disposition.');
    }

    let actorUserId: string | null = null;
    let operatorIdentity: string | null = null;
    if (input.actor.actorType === 'TENANT_USER') {
      actorUserId = input.actor.actorUserId.trim();
      if (!actorUserId || actorUserId.length > 200) {
        throw new AppError(400, 'INVALID_RECOVERY_ACTOR', 'Document storage recovery actor is invalid.');
      }
      if (input.disposition !== 'REQUEUE_UNCHANGED') {
        throw new AppError(
          403,
          'PLATFORM_RECOVERY_REQUIRED',
          'Corrected-path and externally remediated dispositions require platform operations.',
        );
      }
    } else {
      operatorIdentity = input.actor.operatorIdentity.trim();
      if (
        operatorIdentity.length < 3 ||
        operatorIdentity.length > 160 ||
        /[\u0000-\u001f\u007f@:\\/]/u.test(operatorIdentity) ||
        /^(?:admin|administrator|operator|system|unknown)$/iu.test(operatorIdentity)
      ) {
        throw new AppError(400, 'INVALID_RECOVERY_ACTOR', 'A safe named platform operator identity is required.');
      }
    }

    const correctedStoragePath = input.correctedStoragePath?.trim();
    if (input.disposition === 'REQUEUE_CORRECTED_PATH' && !correctedStoragePath) {
      throw new AppError(400, 'CORRECTED_STORAGE_PATH_REQUIRED', 'Corrected-path recovery requires a corrected storage path.');
    }
    if (input.disposition !== 'REQUEUE_CORRECTED_PATH' && correctedStoragePath !== undefined) {
      throw new AppError(400, 'CORRECTED_STORAGE_PATH_NOT_ALLOWED', 'Only corrected-path recovery accepts a corrected storage path.');
    }
    const safeCorrectedStoragePath = correctedStoragePath
      ? assertOrganisationStoragePath(input.organisationId, correctedStoragePath)
      : null;

    const client = this.prisma as unknown as DocumentStorageDeletionClient;
    const recover = async (tx: DocumentStorageDeletionClient) => {
      if (!tx.$queryRaw) {
        throw new AppError(503, 'STORAGE_DELETION_RECOVERY_UNAVAILABLE', 'Storage deletion recovery is temporarily unavailable.');
      }
      const lockedOrganisation = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "Organisation"
        WHERE "id" = ${input.organisationId}
        FOR UPDATE
      `;
      const organisationExists =
        lockedOrganisation.length === 1 && lockedOrganisation[0]?.id === input.organisationId;
      if (
        lockedOrganisation.length > 1 ||
        (lockedOrganisation.length === 1 && !organisationExists) ||
        (!organisationExists && input.actor.actorType !== 'PLATFORM_OPERATOR')
      ) {
        throw new AppError(404, 'STORAGE_DELETION_NOT_FOUND', 'Storage deletion recovery item not found.');
      }
      const locked = await tx.$queryRaw<DocumentStorageDeletionRecord[]>`
        SELECT
          "id",
          "organisationId",
          "storagePath",
          "provider",
          "targetRef",
          "state",
          "attempts",
          "lastAttemptAt",
          "claimedAt",
          "nextAttemptAt",
          "deadLetteredAt",
          "terminalReason",
          "alertClaimToken",
          "alertClaimedAt",
          "alertedAt"
        FROM "DocumentStorageDeletion"
        WHERE "id" = ${input.deletionId}
          AND "organisationId" = ${input.organisationId}
          AND "state" = 'DEAD_LETTER'
        FOR UPDATE
      `;
      const deletion = locked.length === 1 ? locked[0] : null;
      if (!deletion || !deletion.terminalReason) {
        throw new AppError(404, 'STORAGE_DELETION_NOT_FOUND', 'Storage deletion recovery item not found.');
      }
      if (deletion.alertClaimToken) {
        throw new AppError(409, 'STORAGE_DELETION_ALERT_IN_PROGRESS', 'The recovery item is being alerted. Try again shortly.');
      }
      if (
        (input.expectedAttempts !== undefined && input.expectedAttempts !== deletion.attempts) ||
        (input.expectedTerminalReason !== undefined && input.expectedTerminalReason !== deletion.terminalReason)
      ) {
        throw new AppError(409, 'STORAGE_DELETION_RECOVERY_CONFLICT', 'The reviewed recovery item changed. Refresh and try again.');
      }

      // `REQUEUE_CORRECTED_PATH` is Supabase vocabulary end to end: it
      // validates a `correctedStoragePath` against the organisation's object
      // prefix and writes it into `storagePath`, the field a Supabase eraser
      // addresses its object by. A provider that addresses its content some
      // other way reads `targetRef` and never looks at `storagePath` at all,
      // so "correcting the path" of such a row corrects nothing and requeues
      // an erasure that will fail exactly as before — while the audit trail
      // records an operator having fixed it.
      //
      // Until Confluence rows could dead-letter this was safe by absence: no
      // non-Supabase row ever reached DEAD_LETTER. A forbidden purge now
      // dead-letters one by design, so the refusal has to be explicit.
      //
      // The refusal is scoped to the path vocabulary, not to the provider:
      // `REQUEUE_UNCHANGED` (re-run the real eraser, which re-proves erasure
      // with its own verification read) and `COMPLETE_EXTERNALLY_REMEDIATED`
      // (a human with space-admin rights emptied the site's trash) are both
      // meaningful for a Confluence row and stay open. Closing them would push
      // an operator towards attesting to an erasure the platform could have
      // proved.
      if (input.disposition === 'REQUEUE_CORRECTED_PATH' && deletion.provider !== 'supabase') {
        throw new AppError(
          409,
          'CORRECTED_STORAGE_PATH_PROVIDER_UNSUPPORTED',
          'Storage-path recovery is only meaningful for Supabase-backed deletions, and this one ' +
            `is stored with provider "${deletion.provider}". Reconnect or repair the provider and ` +
            'requeue it unchanged, or record that it was erased in the provider directly with the ' +
            'externally remediated disposition.',
          { provider: deletion.provider },
        );
      }

      if (
        input.disposition === 'REQUEUE_UNCHANGED' &&
        deletion.terminalReason === 'PERMANENT_STORAGE_PATH_REJECTED'
      ) {
        throw new AppError(
          409,
          'PERMANENT_STORAGE_PATH_REQUIRES_DISPOSITION',
          'A permanently rejected storage path requires a corrected path or externally remediated completion.',
        );
      }
      if (safeCorrectedStoragePath && safeCorrectedStoragePath === deletion.storagePath) {
        throw new AppError(409, 'CORRECTED_STORAGE_PATH_UNCHANGED', 'The corrected storage path must differ from the rejected path.');
      }
      if (safeCorrectedStoragePath) {
        const [pathUsage] = await tx.$queryRaw<Array<{ liveDocument: boolean; otherDeletion: boolean }>>`
          SELECT
            EXISTS (
              SELECT 1
              FROM "Document"
              WHERE "fileUrl" = ${safeCorrectedStoragePath}
            ) AS "liveDocument",
            EXISTS (
              SELECT 1
              FROM "DocumentStorageDeletion"
              WHERE "id" <> ${deletion.id}
                AND "storagePath" = ${safeCorrectedStoragePath}
            ) AS "otherDeletion"
        `;
        if (!pathUsage || pathUsage.liveDocument !== false || pathUsage.otherDeletion !== false) {
          throw new AppError(
            409,
            'CORRECTED_STORAGE_PATH_IN_USE',
            'The corrected storage path is already referenced and cannot be recovered automatically.',
          );
        }
      }

      const recoveryNonce = randomUUID();
      const recovery = await deletionRecoveryDelegate(tx).create({
        data: {
          recoveryNonce,
          deletionId: deletion.id,
          organisationId: input.organisationId,
          actorType: input.actor.actorType,
          actorUserId,
          operatorIdentity,
          reason,
          disposition: input.disposition,
          previousAttempts: deletion.attempts,
          previousTerminalReason: deletion.terminalReason,
          previousStoragePath: deletion.storagePath,
          correctedStoragePath: safeCorrectedStoragePath,
        },
      });
      const recoveredAt = this.now();
      const nextAttemptAt = input.disposition === 'COMPLETE_EXTERNALLY_REMEDIATED' ? null : recoveredAt;
      const processed = input.disposition === 'COMPLETE_EXTERNALLY_REMEDIATED';
      const update = await deletionDelegate(tx).updateMany({
        where: {
          id: deletion.id,
          organisationId: input.organisationId,
          state: 'DEAD_LETTER',
          attempts: deletion.attempts,
          terminalReason: deletion.terminalReason,
          storagePath: deletion.storagePath,
          alertClaimToken: null,
        },
        data: {
          state: processed ? 'PROCESSED' : 'PENDING',
          attempts: processed ? deletion.attempts : 0,
          storagePath: safeCorrectedStoragePath ?? deletion.storagePath,
          lastError: null,
          lastAttemptAt: processed ? deletion.lastAttemptAt ?? null : null,
          nextAttemptAt,
          claimedAt: null,
          deadLetteredAt: null,
          terminalReason: null,
          alertClaimToken: null,
          alertClaimedAt: null,
          alertedAt: null,
          processedAt: processed ? recoveredAt : null,
          lastRecoveryId: recovery.id,
          lastRecoveryNonce: recoveryNonce,
          lastRecoveryDisposition: input.disposition,
          lastRecoveredAt: recoveredAt,
        },
      });
      if (update.count !== 1) {
        throw new AppError(409, 'STORAGE_DELETION_RECOVERY_CONFLICT', 'The recovery item changed. Refresh and try again.');
      }
      return {
        id: deletion.id,
        status: processed ? 'PROCESSED' as const : 'PENDING' as const,
        disposition: input.disposition,
        nextAttemptAt,
      };
    };

    if (!client.$transaction) {
      throw new AppError(503, 'STORAGE_DELETION_RECOVERY_UNAVAILABLE', 'Storage deletion recovery is temporarily unavailable.');
    }
    return client.$transaction(recover);
  }

  async linkStandard(organisationId: string, documentId: string, standardId: string, actorUserId: string) {
    const [doc, standard, organisation, subscription] = await Promise.all([
      this.prisma.document.findFirst({
        where: { deletedAt: null, id: documentId, organisationId },
      }),
      this.prisma.governanceStandard.findUnique({
        where: { id: standardId },
        select: { id: true, isCore: true },
      }),
      this.prisma.organisation.findUniqueOrThrow({
        where: { id: organisationId },
        select: { complexity: true },
      }),
      this.prisma.subscription.findUnique({
        where: { organisationId },
        select: { plan: true },
      }),
    ]);

    if (!doc) {
      throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
    }
    if (doc.lifecycleStatus !== 'CURRENT') {
      throw new AppError(409, 'DOCUMENT_NOT_CURRENT', 'Only a current document may be linked as active governance evidence.');
    }

    if (!standard) {
      throw new AppError(404, 'STANDARD_NOT_FOUND', 'Governance standard not found');
    }

    if (!standard.isCore && (organisation.complexity !== 'COMPLEX' || subscription?.plan !== SubscriptionPlan.COMPLETE)) {
      throw new AppError(
        403,
        'COMPLIANCE_STANDARD_NOT_INCLUDED_IN_PLAN',
        'This governance standard requires the Complete plan and a complex organisation profile.',
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockOrganisationForUpdate(tx, organisationId);
        if (await tx.documentRecoveryEnforcement.findUnique({
          where: { organisationId }, select: { id: true },
        })) {
          throw new AppError(409, 'DOCUMENT_STANDARD_LINK_RECOVERY_REQUIRED',
            'Standard-link changes require independent recovery authority for this charity.');
        }
        const link = await tx.documentStandardLink.create({ data: { documentId, standardId } });
        await tx.documentControlAudit.create({ data: {
          organisationId, documentId, actorUserId, kind: 'STANDARD_LINK',
          previous: 'UNLINKED', next: standardId,
          reason: 'Governance standard linked to document.',
        } });
        return link;
      });
    } catch (error) {
      const databaseError = typeof error === 'object' && error !== null && 'meta' in error
        ? (error.meta as { database_error?: unknown } | undefined)?.database_error
        : undefined;
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2004'
        && typeof databaseError === 'string'
        && databaseError.includes('Document standard link requires current document')) {
        throw new AppError(409, 'DOCUMENT_NOT_CURRENT', 'Only a current document may be linked as active governance evidence.');
      }
      throw error;
    }
  }

  async unlinkStandard(organisationId: string, documentId: string, standardId: string, actorUserId: string) {
    const doc = await this.prisma.document.findFirst({
      where: { deletedAt: null, id: documentId, organisationId },
    });

    if (!doc) {
      throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
    }

    await this.prisma.$transaction(async (tx) => {
      await lockOrganisationForUpdate(tx, organisationId);
      if (await tx.documentRecoveryEnforcement.findUnique({
        where: { organisationId }, select: { id: true },
      })) {
        throw new AppError(409, 'DOCUMENT_STANDARD_LINK_RECOVERY_REQUIRED',
          'Standard-link changes require independent recovery authority for this charity.');
      }
      const removed = await tx.documentStandardLink.deleteMany({ where: { documentId, standardId } });
      if (removed.count > 0) {
        await tx.documentControlAudit.create({ data: {
          organisationId, documentId, actorUserId, kind: 'STANDARD_UNLINK',
          previous: standardId, next: 'UNLINKED',
          reason: 'Governance standard unlinked from document.',
        } });
      }
    });
  }
}
