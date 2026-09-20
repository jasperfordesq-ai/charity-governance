import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { SubscriptionPlan, type UpdateDocumentRequest } from '@charitypilot/shared';
import { AppError } from '../utils/errors.js';
import { assertUnchanged } from '../utils/optimistic-concurrency.js';
import { formatProviderError } from '../utils/provider-errors.js';
import { assertOrganisationStoragePath } from './storage.service.js';
import {
  createPrismaOrganisationStorageResolver,
  resolveProviderForOrganisation,
} from './document-storage-resolution.js';
import type { Eraser, ErasureDispatcher } from './document-erasure.js';
import {
  confluencePublishTargetForOrganisation,
  type PublishTargetClient,
} from './confluence-publish-target.service.js';
import { DOCUMENT_PUBLICATION_MAX_ATTEMPTS } from './document-publication.service.js';

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
        fileUrl: string;
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
  description: string | null;
  category: unknown;
  fileSize: number;
  mimeType: string;
  version: number;
  owner: string | null;
  approvedDate: Date | null;
  nextReviewDate: Date | null;
  boardMinuteReference: string | null;
  uploadedById: string | null;
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

function scopedPublicDocumentInclude(includeAdditionalStandards: boolean) {
  return {
    standardLinks: includeAdditionalStandards ? standardLinkInclude : coreStandardLinkInclude,
  };
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
// Confluence publication: enqueue on upload, retire on delete
// ---------------------------------------------------------------------------

/**
 * The narrow slice of `DocumentPublication` this file touches. It never writes
 * any of the location columns and never reads `spaceId`, `pageTitle` or
 * `publishedAt` — those belong to the publish worker (Task 6) alone.
 *
 * It does *read* `cloudId`, `pageId` and `attachmentId`, because retiring a
 * publication has to leave the row addressable: those three columns are the
 * only record of where the Confluence copy is, and an explicit, separately
 * authorised erasure will need them. Nothing here interprets or acts on them
 * beyond deciding whether a page exists to keep addressable.
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

type ConfluencePublicationRow = {
  id: string;
  cloudId: string | null;
  pageId: string | null;
  attachmentId: string | null;
  attempts: number;
  state: string;
  claimedAt: Date | null;
};

function publicationDelegate(prisma: unknown) {
  return (prisma as DocumentPublicationCreateClient).documentPublication;
}

/**
 * Far enough in the future that no plausible change to
 * `DOCUMENT_PUBLICATION_MAX_ATTEMPTS` could ever make a cancelled row due for
 * another attempt. Belt-and-suspenders alongside pushing `attempts` past the
 * current ceiling — see {@link DocumentService.retireConfluencePublication}.
 */
const CANCELLED_PUBLICATION_NEXT_ATTEMPT_AT = new Date('9999-12-31T00:00:00.000Z');

const RETIRED_PUBLICATION_MESSAGE =
  'The document was deleted in CharityPilot. The Confluence page was deliberately left in place; ' +
  'destroying it is a separate, explicitly authorised erasure.';

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

function publicDocument(doc: DocumentWithStandardLinks) {
  return {
    id: doc.id,
    organisationId: doc.organisationId,
    name: doc.name,
    description: doc.description,
    category: doc.category,
    fileSize: doc.fileSize,
    mimeType: doc.mimeType,
    version: doc.version,
    owner: doc.owner,
    approvedDate: doc.approvedDate,
    nextReviewDate: doc.nextReviewDate,
    boardMinuteReference: doc.boardMinuteReference,
    uploadedById: doc.uploadedById,
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
  ): Promise<void> {
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
      await Promise.race([
        Promise.resolve().then(() =>
          erase(
            {
              organisationId: deletion.organisationId,
              storagePath: deletion.storagePath,
              targetRef: deletion.targetRef,
            },
            controller.signal,
          ),
        ),
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
            SELECT "id"
            FROM "DocumentStorageDeletion"
            WHERE "state" = 'PENDING'
              AND "processedAt" IS NULL
              AND "attempts" < ${DOCUMENT_STORAGE_DELETION_MAX_ATTEMPTS}
              AND "nextAttemptAt" <= CURRENT_TIMESTAMP
              AND (
                "claimedAt" IS NULL OR
                "claimedAt" < CURRENT_TIMESTAMP - (${STORAGE_DELETION_CLAIM_STALE_AFTER_MS} * INTERVAL '1 millisecond')
              )
            ORDER BY "nextAttemptAt" ASC, "createdAt" ASC
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED
          )
          RETURNING
            "id",
            "organisationId",
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

  async list(organisationId: string, page = 1, pageSize = 50) {
    const skip = (page - 1) * pageSize;
    const includeAdditionalStandards = await documentStandardLinkScope(this.prisma, organisationId);
    const [data, total] = await Promise.all([
      this.prisma.document.findMany({
        where: { organisationId },
        include: scopedPublicDocumentInclude(includeAdditionalStandards),
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.document.count({ where: { organisationId } }),
    ]);
    return { data: data.map(publicDocument), total, page, pageSize, hasMore: skip + data.length < total };
  }

  async getById(organisationId: string, id: string) {
    const includeAdditionalStandards = await documentStandardLinkScope(this.prisma, organisationId);
    const doc = await this.prisma.document.findFirst({
      where: { id, organisationId },
      include: scopedPublicDocumentInclude(includeAdditionalStandards),
    });

    if (!doc) {
      throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
    }

    return publicDocument(doc);
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
  ) {
    const includeAdditionalStandards = await documentStandardLinkScope(this.prisma, organisationId);

    const updated = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.document.findFirst({
        where: { id, organisationId },
        select: { id: true, updatedAt: true },
      });

      if (!existing) {
        throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
      }
      assertUnchanged(existing, expectedUpdatedAt, 'DOCUMENT_UPDATE_CONFLICT');

      return tx.document.update({
        where: { id },
        data: {
          name: data.name,
          description: data.description,
          category: data.category,
          owner: data.owner,
          approvedDate: toNullableDate(data.approvedDate),
          nextReviewDate: toNullableDate(data.nextReviewDate),
          boardMinuteReference: data.boardMinuteReference,
        },
        include: scopedPublicDocumentInclude(includeAdditionalStandards),
      });
    });

    return publicDocument(updated);
  }

  async getDownloadDescriptor(organisationId: string, id: string): Promise<{
    storagePath: string;
    mimeType: string;
    name: string;
  }> {
    const doc = await this.prisma.document.findFirst({
      where: { id, organisationId },
      select: { fileUrl: true, mimeType: true, name: true },
    });

    if (!doc) {
      throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
    }

    return {
      storagePath: doc.fileUrl,
      mimeType: doc.mimeType,
      name: doc.name,
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
  ) {
    const client = this.prisma as unknown as DocumentQuotaClient;

    const createDocument = async (tx: DocumentQuotaClient) => {
      await this.assertStorageQuota(tx, organisationId, data.fileSize);

      return tx.document.create({
        data: {
          organisationId,
          uploadedById: userId,
          name: data.name,
          description: data.description,
          category: data.category as never,
          fileUrl: data.fileUrl,
          fileSize: data.fileSize,
          mimeType: data.mimeType,
          owner: data.owner,
          approvedDate: data.approvedDate ? new Date(data.approvedDate) : null,
          nextReviewDate: data.nextReviewDate ? new Date(data.nextReviewDate) : null,
          boardMinuteReference: data.boardMinuteReference,
        },
        include: publicDocumentInclude,
      });
    };

    const doc = client.$transaction ? await client.$transaction(createDocument) : await createDocument(client);

    // Deliberately *outside* the transaction above, and never allowed to
    // throw past this call — see `enqueueConfluencePublication`. A genuine
    // database error raised inside a Postgres transaction poisons every later
    // statement in it, including the COMMIT, so catching the JS exception
    // from *inside* that transaction would not have protected the upload.
    // Only running this after the document already exists can satisfy the
    // rule it exists for: portal upload is a guaranteed path for every
    // charity, and this integration is alpha, so an enqueue failure is never
    // allowed to fail the upload.
    await this.enqueueConfluencePublication(organisationId, doc.id);

    return publicDocument(doc);
  }

  /**
   * Queues a Confluence publication for a document just written to the
   * authoritative Irish copy — when, and only when, the organisation has
   * chosen somewhere to publish it. `confluencePublishTargetForOrganisation`
   * is Task 3's gate: a `CONNECTED` integration alone is not enough, because
   * connecting is the opt-in and choosing a space is the destination, and
   * neither substitutes for the other. There is no separate alpha flag.
   *
   * Best-effort, by design: any failure here — a missing gate, a database
   * error, a thrown exception of any shape — is logged and swallowed. Never
   * rethrown. See the comment at the call site for why this cannot even run
   * inside the document's own creation transaction.
   */
  private async enqueueConfluencePublication(organisationId: string, documentId: string): Promise<void> {
    try {
      const target = await confluencePublishTargetForOrganisation(
        this.prisma as unknown as PublishTargetClient,
        organisationId,
      );
      if (target === null) return;

      await publicationDelegate(this.prisma).create({
        data: { organisationId, documentId, provider: 'confluence' },
      });
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

  async remove(organisationId: string, id: string): Promise<{ storagePath: string; storageDeletionId: string }> {
    const result = await this.prisma.$transaction(async (tx) => {
      const doc = await tx.document.findFirst({
        where: { id, organisationId },
      });

      if (!doc) {
        throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
      }

      // Stamp the provider the organisation resolves to *now*, reusing the same
      // resolution StorageService uses so the row cannot disagree with the
      // deleter. Providers are plain registry strings, never a Prisma enum, so
      // a new provider never needs a migration.
      //
      // Why resolving at delete time is correct here, and not merely
      // convenient: the spec asks for the provider a document was *actually
      // written to*, and `Document` carries no such column yet. The spec's own
      // standing mitigation is that changing an organisation's provider while
      // it holds documents is unsupported, which is exactly what makes the
      // organisation's current provider equal to the one it was written to.
      // If `Document` ever gains a written-to provider column, read it here
      // instead — this call is the placeholder for it, not the answer the spec
      // asks for.
      //
      // `operation: 'delete'` deliberately: the production local-provider veto
      // exists to stop a deployment *writing* bytes to an unvalidated local
      // path. Refusing to enqueue an erasure for bytes that already exist would
      // strand them and break the provable-erasure guarantee this pipeline is
      // for.
      const provider = await resolveProviderForOrganisation(
        organisationId,
        createPrismaOrganisationStorageResolver(tx),
        undefined,
        { operation: 'delete' },
      );

      const deletion = await deletionDelegate(tx).create({
        data: {
          organisationId,
          storagePath: doc.fileUrl,
          provider,
        },
      });

      await tx.document.delete({ where: { id } });

      return { storagePath: doc.fileUrl, storageDeletionId: deletion.id };
    });

    // Deliberately outside the transaction, and deliberately best-effort — both
    // for the same reason. Under the owner's ruling of 2026-09-19 an ordinary
    // deletion removes our record and our reference and leaves the Confluence
    // page standing, so nothing about the page is at risk if this fails: the
    // page is being kept either way. What is left here is bookkeeping, and
    // bookkeeping must never fail a user's deletion. (Before that ruling this
    // call had to run *inside* the transaction, because a missed row meant a
    // page nobody could find and nobody could erase.)
    await this.retireConfluencePublication(id, result.storagePath);

    return result;
  }

  /**
   * Reads this document's Confluence publication row **under a row lock**, so
   * that whatever it returns is still true at COMMIT.
   *
   * Without the lock the delete path and the publish worker were unordered:
   * the delete sampled `pageId` with a plain `findFirst`, and the worker wrote
   * `pageId` from its own transaction (`attachPublicationPage`) whenever it
   * liked. A page created inside that window got no `confluence` erasure row —
   * a page in a charity's Confluence that nothing can find and nothing will
   * erase, which is the exact outcome this pipeline exists to prevent.
   *
   * `FOR UPDATE` closes it from both sides, and both sides matter:
   *
   * - A worker that has **not** claimed this row yet cannot claim it while the
   *   lock is held: `claimPendingPublications` claims with `FOR UPDATE SKIP
   *   LOCKED`, so it skips this row entirely and never reaches `createPage`.
   * - A worker that **has** claimed it and is mid-attempt cannot commit
   *   `attachPublicationPage` while the lock is held — that write blocks until
   *   this transaction ends, so the value read here is the value that is still
   *   true when the decision taken from it commits.
   *
   * Same claim mechanics as `claimPendingStorageDeletions` and
   * `claimPendingPublications`: raw SQL when the client can issue it, and the
   * delegate as the fallback for a client that cannot (a test double). The
   * fallback cannot lock, which is why it is a fallback and not the path
   * production takes.
   *
   * **Residual, deliberately not closed here.** A worker already between
   * `createPage` and `recordPage` when this lock is taken has made a page this
   * read cannot see. The second locked look in
   * {@link DocumentService.retireConfluencePublication} catches it when the
   * write lands before that second read; a write landing after even that
   * leaves a page whose row was retired — loudly, as the worker's own
   * `claimLost`, not silently. Closing that last sliver means refusing the
   * delete while any attempt is in flight, which is a product decision, not a
   * bug fix.
   */
  private async lockConfluencePublication(
    tx: unknown,
    documentId: string,
    select: Record<string, boolean>,
  ): Promise<ConfluencePublicationRow | null> {
    const client = tx as DocumentPublicationCreateClient;

    if (client.$queryRaw) {
      const locked = await client.$queryRaw<ConfluencePublicationRow[]>`
        SELECT "id", "cloudId", "pageId", "attachmentId", "attempts", "state", "claimedAt"
        FROM "DocumentPublication"
        WHERE "documentId" = ${documentId}
          AND "provider" = 'confluence'
        FOR UPDATE
      `;
      return locked[0] ?? null;
    }

    return publicationDelegate(tx).findFirst({
      where: { documentId, provider: 'confluence' },
      select,
    });
  }

  /**
   * Settles a Confluence publication whose document has just been deleted.
   *
   * Two jobs, and only the first changed with the owner's ruling:
   *
   * - **Stop the retry loop.** Left alone, a worker keeps trying to publish a
   *   document `readDocument` can no longer find, burning all five attempts and
   *   dead-lettering as MAX_ATTEMPTS_EXHAUSTED — noise that trains an operator
   *   to ignore alerts, for an entirely ordinary user action.
   * - **Keep the page addressable.** A row naming a page is retired, never
   *   deleted and never erased. Its identifiers are the only thing that can
   *   still address that page, and an explicit erasure will need them.
   *
   * The three cases, and why each is safe:
   *
   * - **no page id, nothing in flight** — nothing exists in the charity's site
   *   and nothing is about to, because the lock is what a would-be claimer
   *   skips. The row is deleted outright; it records nothing.
   * - **no page id, an attempt in flight** — that attempt may be between
   *   `createPage` and `recordPage` right now, with its write blocked on this
   *   very lock. Deleting the row would make that write match nothing and leave
   *   a real page with no record of it anywhere. The row is parked instead and
   *   the caller takes one more locked look, by which time the blocked write
   *   has landed.
   * - **a page id is recorded** — retire it.
   *
   * **Residual, deliberately accepted.** Retiring clears `claimedAt`, so an
   * attempt that had recorded its page but not yet its attachment loses its
   * claim and reports it (`claimLost`) rather than finishing. The attachment it
   * uploaded is then in Confluence without this row naming it, and a later
   * erasure will not look for it. That is the incompleteness the connect
   * disclosure already states — "an attachment CharityPilot did not record is
   * never looked for" — and under the ruling it is no longer dangerous: nothing
   * is being destroyed, so an unrecorded attachment is an incomplete proof
   * rather than an unerasable orphan.
   */
  private async retireConfluencePublication(documentId: string, storagePath: string): Promise<void> {
    /** Returns whether an attempt was still in flight — the one case a single pass cannot decide. */
    const settle = async (tx: unknown): Promise<boolean> => {
      const publication = await this.lockConfluencePublication(tx, documentId, {
        id: true,
        cloudId: true,
        pageId: true,
        attachmentId: true,
        attempts: true,
        state: true,
        claimedAt: true,
      });
      if (publication === null) return false;

      if (publication.pageId === null) {
        if (publication.claimedAt === null) {
          await publicationDelegate(tx).deleteMany({
            where: { id: publication.id, pageId: null },
          });
          return false;
        }

        if (publication.state === 'PENDING') {
          await publicationDelegate(tx).updateMany({
            where: { id: publication.id, state: 'PENDING' },
            data: {
              attempts: Math.max(publication.attempts, DOCUMENT_PUBLICATION_MAX_ATTEMPTS),
              nextAttemptAt: CANCELLED_PUBLICATION_NEXT_ATTEMPT_AT,
              lastError: RETIRED_PUBLICATION_MESSAGE,
            },
          });
        }
        return true;
      }

      // No `state` guard on the where clause: the row is held under FOR UPDATE,
      // so the value just read is still true at this write. Retiring a row that
      // is already RETIRED is a no-op in practice (the document can only be
      // deleted once) and harmless if it happens.
      await publicationDelegate(tx).updateMany({
        where: { id: publication.id },
        data: {
          state: 'RETIRED',
          retiredAt: this.now(),
          retiredStoragePath: storagePath,
          nextAttemptAt: null,
          claimedAt: null,
          alertClaimToken: null,
          alertClaimedAt: null,
          lastError: RETIRED_PUBLICATION_MESSAGE,
        },
      });

      return false;
    };

    try {
      const client = this.prisma as unknown as DocumentPublicationCreateClient;
      const pass = async (): Promise<boolean> =>
        client.$transaction ? client.$transaction(settle) : settle(this.prisma);

      // At most two passes, never a loop. A write blocked on the first pass's
      // lock lands the instant that pass commits, so the second pass sees the
      // page id it recorded and retires it.
      if (await pass()) await pass();
    } catch (error) {
      console.error(
        `[document-publication] Could not retire the Confluence publication for deleted document ${documentId}.`,
        error,
      );
    }
  }

  async markStorageDeletionProcessed(id: string, claimedAt: Date | null = null): Promise<boolean> {
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

      try {
        await this.runBoundedStorageDeletion(erase, deletion);
      } catch (error) {
        const failure = await this.recordStorageDeletionFailure(deletion.id, error, deletion.claimedAt);
        if (failure.status === 'retry-scheduled') retryScheduled += 1;
        if (failure.status === 'dead-lettered') newlyDeadLettered += 1;
        continue;
      }

      const finalized = await this.markStorageDeletionProcessed(deletion.id, deletion.claimedAt);
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

  async listDeadLetterStorageDeletions(organisationId: string, limit = 50) {
    const boundedLimit = Math.min(100, Math.max(1, Number.isInteger(limit) ? limit : 50));
    const rows = await deletionDelegate(this.prisma).findMany({
      where: { organisationId, state: 'DEAD_LETTER' },
      orderBy: [{ deadLetteredAt: 'asc' }, { createdAt: 'asc' }],
      take: boundedLimit,
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
    return {
      data: rows.map((row) => ({
        id: row.id,
        // A Supabase dead-letter and a Confluence one need entirely different
        // remedies (fix our storage vs. a human with space-admin rights in
        // the charity's own Atlassian site), so the administrator has to be
        // able to tell them apart from the list, not just from a detail view.
        provider: row.provider,
        attempts: row.attempts,
        lastError: row.lastError ?? null,
        lastAttemptAt: row.lastAttemptAt ?? null,
        deadLetteredAt: row.deadLetteredAt,
        terminalReason: row.terminalReason,
        alertedAt: row.alertedAt,
        createdAt: row.createdAt,
      })),
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
    if (
      reason.length < 10 ||
      reason.length > 500 ||
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

  async linkStandard(organisationId: string, documentId: string, standardId: string) {
    const [doc, standard, organisation, subscription] = await Promise.all([
      this.prisma.document.findFirst({
        where: { id: documentId, organisationId },
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

    return this.prisma.documentStandardLink.create({
      data: { documentId, standardId },
    });
  }

  async unlinkStandard(organisationId: string, documentId: string, standardId: string) {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, organisationId },
    });

    if (!doc) {
      throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
    }

    await this.prisma.documentStandardLink.deleteMany({
      where: { documentId, standardId },
    });
  }
}
