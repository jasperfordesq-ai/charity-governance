import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { SubscriptionPlan } from '@charitypilot/shared';
import { AppError } from '../utils/errors.js';
import { formatProviderError } from '../utils/provider-errors.js';
import { assertOrganisationStoragePath } from './storage.service.js';

type DocumentStorageDeletionState = 'PENDING' | 'DEAD_LETTER' | 'PROCESSED';
type DocumentStorageDeletionTerminalReason =
  | 'MAX_ATTEMPTS_EXHAUSTED'
  | 'PERMANENT_STORAGE_PATH_REJECTED';
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
  storagePath: string;
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

function isPermanentStorageDeletionFailure(error: unknown): boolean {
  return error instanceof AppError && error.code === 'STORAGE_PATH_FORBIDDEN';
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
    deleteFile: (organisationId: string, storagePath: string, signal?: AbortSignal) => Promise<void>,
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

    try {
      await Promise.race([
        Promise.resolve().then(() => deleteFile(deletion.organisationId, deletion.storagePath, controller.signal)),
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

    return publicDocument(doc);
  }

  async remove(organisationId: string, id: string): Promise<{ storagePath: string; storageDeletionId: string }> {
    return this.prisma.$transaction(async (tx) => {
      const doc = await tx.document.findFirst({
        where: { id, organisationId },
      });

      if (!doc) {
        throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
      }

      const deletion = await deletionDelegate(tx).create({
        data: {
          organisationId,
          storagePath: doc.fileUrl,
        },
      });

      await tx.document.delete({ where: { id } });

      return { storagePath: doc.fileUrl, storageDeletionId: deletion.id };
    });
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
      const permanent = isPermanentStorageDeletionFailure(error);
      const deadLettered = permanent || attempt >= DOCUMENT_STORAGE_DELETION_MAX_ATTEMPTS;
      const terminalReason: DocumentStorageDeletionTerminalReason | null = permanent
        ? 'PERMANENT_STORAGE_PATH_REJECTED'
        : deadLettered
          ? 'MAX_ATTEMPTS_EXHAUSTED'
          : null;
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
    deleteFile: (organisationId: string, storagePath: string, signal?: AbortSignal) => Promise<void>,
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
      try {
        await this.runBoundedStorageDeletion(deleteFile, deletion);
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
