import { Prisma, type PrismaClient, type DataLifecycleRequestKind, type DataLifecycleScope, type DataLifecycleReviewState, type DataLifecycleCoverageArea, type DataLifecycleCoverageDisposition } from '@prisma/client';
import { AppError } from '../utils/errors.js';

type Intake = {
  organisationId: string;
  actorUserId: string;
  caseReference: string;
  kind: DataLifecycleRequestKind;
  scope: DataLifecycleScope;
  receivedAt: Date;
};

type Triage = {
  organisationId: string;
  requestId: string;
  actorUserId: string;
  expectedUpdatedAt: Date;
  nextState: DataLifecycleReviewState;
  reason: string;
  evidenceRef?: string;
};

type ResponseTargetChange = {
  organisationId: string;
  requestId: string;
  actorUserId: string;
  expectedUpdatedAt: Date;
  targetResponseAt: Date | null;
  reason: string;
  evidenceRef?: string;
};

type ResponseSentChange = {
  organisationId: string;
  requestId: string;
  actorUserId: string;
  expectedUpdatedAt: Date;
  responseSentAt: Date | null;
  reason: string;
  evidenceRef?: string;
};

export const DATA_LIFECYCLE_COVERAGE_AREAS = [
  'ACCOUNT_AUTH', 'GOVERNANCE_RECORDS', 'VAULT_FILES', 'EXTERNAL_COPIES',
  'EXPORTS', 'AUDIT_LOGS', 'BACKUPS', 'BILLING_PROVIDER',
] as const satisfies readonly DataLifecycleCoverageArea[];

type CoverageChange = {
  organisationId: string;
  requestId: string;
  actorUserId: string;
  area: DataLifecycleCoverageArea;
  disposition: DataLifecycleCoverageDisposition;
  reason: string;
  evidenceRef?: string;
};

export class DataLifecycleService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(organisationId: string, before?: string) {
    const take = 50;
    const anchor = before ? await this.prisma.dataLifecycleRequest.findFirst({
      where: { id: before, organisationId },
      select: { id: true, receivedAt: true },
    }) : null;
    if (before && !anchor) {
      throw new AppError(404, 'DATA_LIFECYCLE_CURSOR_NOT_FOUND', 'Request cursor not found');
    }
    const rows = await this.prisma.dataLifecycleRequest.findMany({
      where: {
        organisationId,
        ...(anchor ? { OR: [
          { receivedAt: { lt: anchor.receivedAt } },
          { receivedAt: anchor.receivedAt, id: { lt: anchor.id } },
        ] } : {}),
      },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });
    const items = rows.slice(0, take);
    return { items, nextCursor: rows.length > take ? items[items.length - 1].id : null };
  }

  async listDueTargets(organisationId: string, before?: string) {
    const now = new Date();
    const anchor = before ? await this.prisma.dataLifecycleRequest.findFirst({
      where: { id: before, organisationId, responseSentAt: null, targetResponseAt: { lte: now } },
      select: { id: true, targetResponseAt: true },
    }) : null;
    if (before && !anchor?.targetResponseAt) {
      throw new AppError(404, 'DATA_LIFECYCLE_TARGET_CURSOR_NOT_FOUND', 'Due-target cursor not found');
    }
    const rows = await this.prisma.dataLifecycleRequest.findMany({
      where: {
        organisationId, responseSentAt: null, targetResponseAt: { lte: now },
        ...(anchor?.targetResponseAt ? { OR: [
          { targetResponseAt: { gt: anchor.targetResponseAt } },
          { targetResponseAt: anchor.targetResponseAt, id: { gt: anchor.id } },
        ] } : {}),
      },
      orderBy: [{ targetResponseAt: 'asc' }, { id: 'asc' }],
      take: 51,
      select: { id: true, caseReference: true, kind: true, scope: true, receivedAt: true,
        reviewState: true, targetResponseAt: true, responseSentAt: true, updatedAt: true },
    });
    const items = rows.slice(0, 50);
    return { items, nextCursor: rows.length > 50 ? items[items.length - 1].id : null };
  }

  async get(organisationId: string, requestId: string) {
    const record = await this.prisma.dataLifecycleRequest.findFirst({ where: { id: requestId, organisationId } });
    if (!record) throw new AppError(404, 'DATA_LIFECYCLE_REQUEST_NOT_FOUND', 'Request not found');
    return record;
  }

  async getByReference(organisationId: string, caseReference: string) {
    const record = await this.prisma.dataLifecycleRequest.findFirst({
      where: { organisationId, caseReference },
    });
    if (!record) throw new AppError(404, 'DATA_LIFECYCLE_REQUEST_NOT_FOUND', 'Request not found');
    return record;
  }

  async listCoverage(organisationId: string, requestId: string) {
    await this.get(organisationId, requestId);
    return Promise.all(DATA_LIFECYCLE_COVERAGE_AREAS.map(async (area) => ({
      area,
      latest: await this.prisma.dataLifecycleCoverageEvent.findFirst({
        where: { organisationId, requestId, area },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      }),
    })));
  }

  async listCoverageEvents(organisationId: string, requestId: string, before?: string) {
    await this.get(organisationId, requestId);
    const anchor = before ? await this.prisma.dataLifecycleCoverageEvent.findFirst({
      where: { id: before, organisationId, requestId },
      select: { id: true, occurredAt: true },
    }) : null;
    if (before && !anchor) {
      throw new AppError(404, 'DATA_LIFECYCLE_COVERAGE_CURSOR_NOT_FOUND', 'Coverage history cursor not found');
    }
    const rows = await this.prisma.dataLifecycleCoverageEvent.findMany({
      where: {
        organisationId, requestId,
        ...(anchor ? { OR: [
          { occurredAt: { lt: anchor.occurredAt } },
          { occurredAt: anchor.occurredAt, id: { lt: anchor.id } },
        ] } : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: 51,
    });
    const items = rows.slice(0, 50);
    return { items, nextCursor: rows.length > 50 ? items[items.length - 1].id : null };
  }

  async recordCoverage(input: CoverageChange) {
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.dataLifecycleRequest.findFirst({
        where: { id: input.requestId, organisationId: input.organisationId },
        select: { id: true },
      });
      if (!request) throw new AppError(404, 'DATA_LIFECYCLE_REQUEST_NOT_FOUND', 'Request not found');
      return tx.dataLifecycleCoverageEvent.create({ data: input });
    });
  }

  async listEvents(organisationId: string, requestId: string, before?: string) {
    await this.get(organisationId, requestId);
    const anchor = before ? await this.prisma.dataLifecycleReviewEvent.findFirst({
      where: { id: before, organisationId, requestId },
      select: { id: true, occurredAt: true },
    }) : null;
    if (before && !anchor) {
      throw new AppError(404, 'DATA_LIFECYCLE_EVENT_CURSOR_NOT_FOUND', 'Review history cursor not found');
    }
    const rows = await this.prisma.dataLifecycleReviewEvent.findMany({
      where: {
        organisationId, requestId,
        ...(anchor ? { OR: [
          { occurredAt: { lt: anchor.occurredAt } },
          { occurredAt: anchor.occurredAt, id: { lt: anchor.id } },
        ] } : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: 51,
    });
    const items = rows.slice(0, 50);
    return { items, nextCursor: rows.length > 50 ? items[items.length - 1].id : null };
  }

  async listTargetEvents(organisationId: string, requestId: string, before?: string) {
    await this.get(organisationId, requestId);
    const anchor = before ? await this.prisma.dataLifecycleTargetEvent.findFirst({
      where: { id: before, organisationId, requestId },
      select: { id: true, occurredAt: true },
    }) : null;
    if (before && !anchor) {
      throw new AppError(404, 'DATA_LIFECYCLE_TARGET_CURSOR_NOT_FOUND', 'Response-target history cursor not found');
    }
    const rows = await this.prisma.dataLifecycleTargetEvent.findMany({
      where: {
        organisationId, requestId,
        ...(anchor ? { OR: [
          { occurredAt: { lt: anchor.occurredAt } },
          { occurredAt: anchor.occurredAt, id: { lt: anchor.id } },
        ] } : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: 51,
    });
    const items = rows.slice(0, 50);
    return { items, nextCursor: rows.length > 50 ? items[items.length - 1].id : null };
  }

  async listResponseEvents(organisationId: string, requestId: string, before?: string) {
    await this.get(organisationId, requestId);
    const anchor = before ? await this.prisma.dataLifecycleResponseEvent.findFirst({
      where: { id: before, organisationId, requestId },
      select: { id: true, occurredAt: true },
    }) : null;
    if (before && !anchor) {
      throw new AppError(404, 'DATA_LIFECYCLE_RESPONSE_CURSOR_NOT_FOUND', 'Response history cursor not found');
    }
    const rows = await this.prisma.dataLifecycleResponseEvent.findMany({
      where: {
        organisationId, requestId,
        ...(anchor ? { OR: [
          { occurredAt: { lt: anchor.occurredAt } },
          { occurredAt: anchor.occurredAt, id: { lt: anchor.id } },
        ] } : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: 51,
    });
    const items = rows.slice(0, 50);
    return { items, nextCursor: rows.length > 50 ? items[items.length - 1]!.id : null };
  }

  async listStorageLinks(organisationId: string, requestId: string, before?: string) {
    await this.get(organisationId, requestId);
    const anchor = before ? await this.prisma.dataLifecycleStorageLink.findFirst({
      where: { id: before, organisationId, requestId },
      select: { id: true, createdAt: true },
    }) : null;
    if (before && !anchor) {
      throw new AppError(404, 'DATA_LIFECYCLE_STORAGE_CURSOR_NOT_FOUND', 'Storage-link cursor not found');
    }
    const rows = await this.prisma.dataLifecycleStorageLink.findMany({
      where: {
        organisationId, requestId,
        ...(anchor ? { OR: [
          { createdAt: { lt: anchor.createdAt } },
          { createdAt: anchor.createdAt, id: { lt: anchor.id } },
        ] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 51,
      select: {
        id: true, deletionId: true, actorUserId: true, reason: true, createdAt: true,
        withdrawal: { select: { actorUserId: true, reason: true, createdAt: true } },
        deletion: { select: {
          sourceDocumentId: true, provider: true, state: true, attempts: true, processedAt: true,
          activeObjectAbsentAt: true, terminalReason: true,
        } },
      },
    });
    const items = rows.slice(0, 50);
    return { items, nextCursor: rows.length > 50 ? items[items.length - 1].id : null };
  }

  async listDocumentLinks(organisationId: string, requestId: string, before?: string) {
    await this.get(organisationId, requestId);
    const anchor = before ? await this.prisma.dataLifecycleDocumentLink.findFirst({
      where: { id: before, organisationId, requestId },
      select: { id: true, createdAt: true },
    }) : null;
    if (before && !anchor) {
      throw new AppError(404, 'DATA_LIFECYCLE_DOCUMENT_CURSOR_NOT_FOUND', 'Document-link cursor not found');
    }
    const rows = await this.prisma.dataLifecycleDocumentLink.findMany({
      where: {
        organisationId, requestId,
        ...(anchor ? { OR: [
          { createdAt: { lt: anchor.createdAt } },
          { createdAt: anchor.createdAt, id: { lt: anchor.id } },
        ] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 51,
      select: {
        id: true, documentId: true, actorUserId: true, reason: true, createdAt: true,
        withdrawal: { select: { actorUserId: true, reason: true, createdAt: true } },
      },
    });
    const items = rows.slice(0, 50);
    return { items, nextCursor: rows.length > 50 ? items[items.length - 1].id : null };
  }

  async linkDocument(input: {
    organisationId: string; requestId: string; documentId: string;
    actorUserId: string; reason: string;
  }) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const request = await tx.dataLifecycleRequest.findFirst({
          where: { id: input.requestId, organisationId: input.organisationId },
          select: { id: true },
        });
        if (!request) throw new AppError(404, 'DATA_LIFECYCLE_REQUEST_NOT_FOUND', 'Request not found');
        const document = await tx.document.findFirst({
          where: { id: input.documentId, organisationId: input.organisationId },
          select: { id: true },
        });
        if (!document) throw new AppError(404, 'DATA_LIFECYCLE_DOCUMENT_NOT_FOUND', 'Vault document not found');
        return tx.dataLifecycleDocumentLink.create({ data: input });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientUnknownRequestError &&
        error.message.includes('Data lifecycle link requires a live document in the same charity')) {
        throw new AppError(409, 'DATA_LIFECYCLE_DOCUMENT_CHANGED', 'The Vault document changed. Refresh and try again.');
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') {
          throw new AppError(409, 'DATA_LIFECYCLE_DOCUMENT_ALREADY_LINKED', 'This Vault document is already linked to the request');
        }
        if (error.code === 'P2003' || error.code === 'P2004') {
          throw new AppError(409, 'DATA_LIFECYCLE_DOCUMENT_CHANGED', 'The case or Vault document changed. Refresh and try again.');
        }
      }
      throw error;
    }
  }

  async withdrawDocumentLink(input: {
    organisationId: string; requestId: string; linkId: string;
    actorUserId: string; reason: string;
  }) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const link = await tx.dataLifecycleDocumentLink.findFirst({
          where: { id: input.linkId, organisationId: input.organisationId, requestId: input.requestId },
          select: { id: true },
        });
        if (!link) throw new AppError(404, 'DATA_LIFECYCLE_DOCUMENT_LINK_NOT_FOUND', 'Document link not found');
        return tx.dataLifecycleDocumentLinkWithdrawal.create({ data: input });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError(409, 'DATA_LIFECYCLE_DOCUMENT_LINK_WITHDRAWN', 'This document link is already withdrawn');
      }
      throw error;
    }
  }

  async findStorageDeletionsBySource(organisationId: string, sourceDocumentId: string, before?: string) {
    const anchor = before ? await this.prisma.documentStorageDeletion.findFirst({
      where: { id: before, organisationId, sourceDocumentId },
      select: { id: true, createdAt: true },
    }) : null;
    if (before && !anchor) {
      throw new AppError(404, 'STORAGE_DELETION_CURSOR_NOT_FOUND', 'Storage job cursor not found');
    }
    const rows = await this.prisma.documentStorageDeletion.findMany({
      where: {
        organisationId, sourceDocumentId,
        ...(anchor ? { OR: [
          { createdAt: { lt: anchor.createdAt } },
          { createdAt: anchor.createdAt, id: { lt: anchor.id } },
        ] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 51,
      select: {
        id: true, sourceDocumentId: true, provider: true, state: true,
        attempts: true, processedAt: true, activeObjectAbsentAt: true,
        terminalReason: true, createdAt: true,
      },
    });
    const items = rows.slice(0, 50);
    return { items, nextCursor: rows.length > 50 ? items[items.length - 1].id : null };
  }

  async linkStorageDeletion(input: {
    organisationId: string; requestId: string; deletionId: string;
    actorUserId: string; reason: string;
  }) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const request = await tx.dataLifecycleRequest.findFirst({
          where: { id: input.requestId, organisationId: input.organisationId },
          select: { id: true },
        });
        if (!request) throw new AppError(404, 'DATA_LIFECYCLE_REQUEST_NOT_FOUND', 'Request not found');
        const deletion = await tx.documentStorageDeletion.findFirst({
          where: { id: input.deletionId, organisationId: input.organisationId },
          select: { id: true },
        });
        if (!deletion) throw new AppError(404, 'STORAGE_DELETION_NOT_FOUND', 'Storage deletion job not found');
        return tx.dataLifecycleStorageLink.create({ data: input });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError(409, 'DATA_LIFECYCLE_STORAGE_ALREADY_LINKED', 'This storage job is already linked to the request');
      }
      throw error;
    }
  }

  async withdrawStorageLink(input: {
    organisationId: string; requestId: string; linkId: string;
    actorUserId: string; reason: string;
  }) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const link = await tx.dataLifecycleStorageLink.findFirst({
          where: { id: input.linkId, organisationId: input.organisationId, requestId: input.requestId },
          select: { id: true },
        });
        if (!link) throw new AppError(404, 'DATA_LIFECYCLE_STORAGE_LINK_NOT_FOUND', 'Storage link not found');
        return tx.dataLifecycleStorageLinkWithdrawal.create({ data: input });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError(409, 'DATA_LIFECYCLE_STORAGE_LINK_WITHDRAWN', 'This storage link is already withdrawn');
      }
      throw error;
    }
  }

  listRecentEvents(organisationId: string) {
    return this.prisma.dataLifecycleReviewEvent.findMany({
      where: { organisationId },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: 100,
      // The broad overview does not duplicate free-text case reasons or
      // evidence references. The per-case history retains those details.
      select: {
        id: true, requestId: true, actorUserId: true, previousState: true,
        nextState: true, occurredAt: true,
      },
    });
  }

  async create(input: Intake) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const record = await tx.dataLifecycleRequest.create({ data: {
          organisationId: input.organisationId, caseReference: input.caseReference,
          kind: input.kind, scope: input.scope, receivedAt: input.receivedAt,
          enteredById: input.actorUserId,
        } });
        await tx.dataLifecycleReviewEvent.create({ data: {
          organisationId: input.organisationId, requestId: record.id,
          actorUserId: input.actorUserId, previousState: null, nextState: 'OPEN',
          reason: 'Request recorded for assessment.',
        } });
        return record;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError(409, 'DATA_LIFECYCLE_CASE_EXISTS', 'This case reference is already recorded');
      }
      throw error;
    }
  }

  async triage(input: Triage) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.dataLifecycleRequest.findFirst({
        where: { id: input.requestId, organisationId: input.organisationId },
      });
      if (!current) throw new AppError(404, 'DATA_LIFECYCLE_REQUEST_NOT_FOUND', 'Request not found');
      if (current.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
        throw new AppError(409, 'DATA_LIFECYCLE_REQUEST_CHANGED', 'This request changed. Reload it before recording a new review.');
      }
      if (current.reviewState === input.nextState) {
        throw new AppError(400, 'DATA_LIFECYCLE_NO_STATE_CHANGE', 'Choose a different review state');
      }
      const previousState = current.reviewState;
      const changed = await tx.dataLifecycleRequest.updateMany({
        where: { id: input.requestId, organisationId: input.organisationId, updatedAt: input.expectedUpdatedAt },
        data: { reviewState: input.nextState },
      });
      if (changed.count !== 1) {
        throw new AppError(409, 'DATA_LIFECYCLE_REQUEST_CHANGED', 'This request changed. Reload it before recording a new review.');
      }
      await tx.dataLifecycleReviewEvent.create({ data: {
        organisationId: input.organisationId, requestId: input.requestId,
        actorUserId: input.actorUserId, previousState,
        nextState: input.nextState, reason: input.reason,
        evidenceRef: input.evidenceRef ?? null,
      } });
      return (await tx.dataLifecycleRequest.findFirst({
        where: { id: input.requestId, organisationId: input.organisationId },
      }))!;
    });
  }

  async setResponseTarget(input: ResponseTargetChange) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.dataLifecycleRequest.findFirst({
        where: { id: input.requestId, organisationId: input.organisationId },
      });
      if (!current) throw new AppError(404, 'DATA_LIFECYCLE_REQUEST_NOT_FOUND', 'Request not found');
      if (current.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
        throw new AppError(409, 'DATA_LIFECYCLE_REQUEST_CHANGED', 'This request changed. Reload it before changing its response target.');
      }
      if (input.targetResponseAt && input.targetResponseAt.getTime() < current.receivedAt.getTime()) {
        throw new AppError(400, 'DATA_LIFECYCLE_TARGET_BEFORE_RECEIPT', 'The response target cannot precede the recorded receipt.');
      }
      const previousTargetAt = current.targetResponseAt ?? null;
      if (previousTargetAt?.getTime() === input.targetResponseAt?.getTime()) {
        throw new AppError(409, 'DATA_LIFECYCLE_TARGET_UNCHANGED', 'Choose a different response target.');
      }
      const changed = await tx.dataLifecycleRequest.updateMany({
        where: { id: input.requestId, organisationId: input.organisationId, updatedAt: input.expectedUpdatedAt },
        data: { targetResponseAt: input.targetResponseAt },
      });
      if (changed.count !== 1) {
        throw new AppError(409, 'DATA_LIFECYCLE_REQUEST_CHANGED', 'This request changed. Reload it before changing its response target.');
      }
      await tx.dataLifecycleTargetEvent.create({ data: {
        organisationId: input.organisationId, requestId: input.requestId, actorUserId: input.actorUserId,
        previousTargetAt, nextTargetAt: input.targetResponseAt,
        reason: input.reason, evidenceRef: input.evidenceRef ?? null,
      } });
      return (await tx.dataLifecycleRequest.findFirst({
        where: { id: input.requestId, organisationId: input.organisationId },
      }))!;
    });
  }

  async setResponseSentAt(input: ResponseSentChange) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.dataLifecycleRequest.findFirst({
        where: { id: input.requestId, organisationId: input.organisationId },
      });
      if (!current) throw new AppError(404, 'DATA_LIFECYCLE_REQUEST_NOT_FOUND', 'Request not found');
      if (current.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
        throw new AppError(409, 'DATA_LIFECYCLE_REQUEST_CHANGED', 'This request changed. Reload it before recording a response.');
      }
      if (input.responseSentAt && (input.responseSentAt.getTime() < current.receivedAt.getTime() ||
        input.responseSentAt.getTime() > Date.now())) {
        throw new AppError(400, 'DATA_LIFECYCLE_RESPONSE_DATE_INVALID', 'The response time must be after receipt and cannot be in the future.');
      }
      if (input.responseSentAt && !input.evidenceRef) {
        throw new AppError(400, 'DATA_LIFECYCLE_RESPONSE_EVIDENCE_REQUIRED', 'Record the controlled-archive evidence reference for a sent response.');
      }
      const previousResponseAt = current.responseSentAt ?? null;
      if (previousResponseAt?.getTime() === input.responseSentAt?.getTime()) {
        throw new AppError(409, 'DATA_LIFECYCLE_RESPONSE_UNCHANGED', 'Choose a different response time.');
      }
      const changed = await tx.dataLifecycleRequest.updateMany({
        where: { id: input.requestId, organisationId: input.organisationId, updatedAt: input.expectedUpdatedAt },
        data: { responseSentAt: input.responseSentAt },
      });
      if (changed.count !== 1) {
        throw new AppError(409, 'DATA_LIFECYCLE_REQUEST_CHANGED', 'This request changed. Reload it before recording a response.');
      }
      await tx.dataLifecycleResponseEvent.create({ data: {
        organisationId: input.organisationId, requestId: input.requestId, actorUserId: input.actorUserId,
        previousResponseAt, nextResponseAt: input.responseSentAt,
        reason: input.reason, evidenceRef: input.evidenceRef ?? null,
      } });
      return (await tx.dataLifecycleRequest.findFirst({
        where: { id: input.requestId, organisationId: input.organisationId },
      }))!;
    });
  }
}
