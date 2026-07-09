import type { PrismaClient } from '@prisma/client';
import { SubscriptionPlan } from '@charitypilot/shared';
import { AppError } from '../utils/errors.js';
import { formatProviderError } from '../utils/provider-errors.js';

type DocumentStorageDeletionRecord = {
  id: string;
  organisationId: string;
  storagePath: string;
};

const STORAGE_DELETION_CLAIM_STALE_AFTER_MS = 10 * 60 * 1000;
const GIBIBYTE = 1024 * 1024 * 1024;

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
  update(args: {
    where: { id: string };
    data: {
      attempts?: { increment: number };
      lastError?: string | null;
      claimedAt?: Date | null;
      processedAt?: Date;
    };
  }): Promise<unknown>;
  findMany(args: {
    where: { processedAt: null };
    orderBy: { createdAt: 'asc' };
    take: number;
  }): Promise<DocumentStorageDeletionRecord[]>;
};

type DocumentStorageDeletionClient = {
  documentStorageDeletion: DocumentStorageDeletionDelegate;
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
  constructor(private prisma: PrismaClient) {}

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
            WHERE "processedAt" IS NULL
              AND (
                "claimedAt" IS NULL OR
                "claimedAt" < CURRENT_TIMESTAMP - (${STORAGE_DELETION_CLAIM_STALE_AFTER_MS} * INTERVAL '1 millisecond')
              )
            ORDER BY "createdAt" ASC
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED
          )
          RETURNING "id", "organisationId", "storagePath"
        `;
      });
    }

    return deletionDelegate(this.prisma).findMany({
      where: { processedAt: null },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
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

  async getStoragePath(organisationId: string, id: string): Promise<string> {
    const doc = await this.prisma.document.findFirst({
      where: { id, organisationId },
      select: { fileUrl: true },
    });

    if (!doc) {
      throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
    }

    return doc.fileUrl;
  }

  async assertStoragePathBelongsToDocument(organisationId: string, storagePath: string): Promise<void> {
    const doc = await this.prisma.document.findFirst({
      where: { organisationId, fileUrl: storagePath },
      select: { id: true },
    });

    if (!doc) {
      throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
    }
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

  async markStorageDeletionProcessed(id: string): Promise<void> {
    await deletionDelegate(this.prisma).update({
      where: { id },
      data: {
        processedAt: new Date(),
        lastError: null,
        claimedAt: null,
      },
    });
  }

  async recordStorageDeletionFailure(id: string, error: unknown): Promise<void> {
    await deletionDelegate(this.prisma).update({
      where: { id },
      data: {
        attempts: { increment: 1 },
        lastError: formatProviderError(error),
        claimedAt: null,
      },
    });
  }

  async retryPendingStorageDeletions(
    deleteFile: (organisationId: string, storagePath: string) => Promise<void>,
    limit = 25,
  ): Promise<{ processed: number; failed: number }> {
    const pending = await this.claimPendingStorageDeletions(limit);

    let processed = 0;
    let failed = 0;

    for (const deletion of pending) {
      try {
        await deleteFile(deletion.organisationId, deletion.storagePath);
        await this.markStorageDeletionProcessed(deletion.id);
        processed += 1;
      } catch (error) {
        await this.recordStorageDeletionFailure(deletion.id, error);
        failed += 1;
      }
    }

    return { processed, failed };
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
