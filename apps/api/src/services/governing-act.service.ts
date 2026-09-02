import type {
  CreateGoverningActRequest,
  UpdateGoverningActRequest,
  CreateResolutionRequest,
  UpdateResolutionRequest,
  GoverningActQuery,
  VoidGoverningActRequest,
} from '@charitypilot/shared';
import {
  Prisma,
  type GoverningAct,
  type GoverningActStatus,
  type GoverningActVoid,
  type PrismaClient,
  type Resolution,
} from '@prisma/client';
import { AppError } from '../utils/errors.js';

const toDate = (value?: string | null) => (value ? new Date(value) : null);

// Rule 2: minutes are not evidence until the governing act is APPROVED.
const EVIDENCED_STATUSES: GoverningActStatus[] = ['APPROVED'];

function govActNotFound() {
  return new AppError(404, 'GOVERNING_ACT_NOT_FOUND', 'Governing act not found');
}

function resolutionNotFound() {
  return new AppError(404, 'RESOLUTION_NOT_FOUND', 'Resolution not found');
}

const SERIALIZABLE_RETRY_LIMIT = 3;

function removalConflict() {
  return new AppError(
    409,
    'GOVERNING_ACT_UPDATE_CONFLICT',
    'Another change to the minute book landed while this record was being removed. Reload and try again.',
  );
}

function isSerializationConflict(error: unknown): boolean {
  // An AppError is this service's own deliberate refusal, never a database
  // conflict. It also interpolates a user-supplied act reference into its
  // message, so it must never reach the SQLSTATE text match below.
  if (error instanceof AppError) return false;
  if (!error || typeof error !== 'object') return false;

  const candidate = error as {
    code?: unknown;
    meta?: { code?: unknown };
    message?: unknown;
  };
  return (
    candidate.code === 'P2034' ||
    candidate.meta?.code === '40001' ||
    (typeof candidate.message === 'string' && candidate.message.includes('40001'))
  );
}

export type BoardSubmission = {
  id: string;
  name: string;
  category: string;
  approvalAsserted: boolean;
  approvedDate: Date | null;
  boardMinuteReference: string | null;
  resolution: {
    id: string;
    text: string;
    itemNumber: string | null;
    governingAct: {
      id: string;
      reference: string;
      actDate: Date;
      status: GoverningActStatus;
      title: string;
    };
  } | null;
  evidenced: boolean;
};

export type BoardSubmissionsResponse = {
  evidenced: BoardSubmission[];
  outstanding: {
    notEvidenced: BoardSubmission[];
    notSubmitted: BoardSubmission[];
  };
};

export class GoverningActService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(organisationId: string, query: GoverningActQuery): Promise<GoverningAct[]> {
    // No year means the whole minute book. Defaulting to the current year hides
    // older acts by accident, and an act nobody looks at is an act nobody checks.
    const yearFilter =
      query.year === undefined
        ? {}
        : {
            actDate: {
              gte: new Date(`${query.year}-01-01`),
              lte: new Date(`${query.year}-12-31`),
            },
          };

    return this.prisma.governingAct.findMany({
      where: {
        organisationId,
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...yearFilter,
      },
      include: { resolutions: true },
      orderBy: [{ actDate: 'asc' }, { reference: 'asc' }],
    });
  }

  async create(organisationId: string, data: CreateGoverningActRequest): Promise<GoverningAct> {
    if (data.approvedAtActId) {
      await this.requireGoverningAct(organisationId, data.approvedAtActId);
    }
    return this.prisma.governingAct.create({
      data: {
        organisationId,
        kind: data.kind,
        status: data.status ?? 'SCHEDULED',
        actDate: new Date(data.actDate as string),
        reference: data.reference,
        title: data.title,
        statutoryBasis: data.statutoryBasis ?? null,
        approvedAtActId: data.approvedAtActId ?? null,
        approvedAt: toDate(data.approvedAt as string | null),
        documentId: data.documentId ?? null,
        notes: data.notes ?? null,
      },
      include: { resolutions: true },
    });
  }

  async update(
    organisationId: string,
    id: string,
    data: UpdateGoverningActRequest,
  ): Promise<GoverningAct> {
    const { expectedUpdatedAt, ...changes } = data;
    const expectedInstant = new Date(expectedUpdatedAt);

    const act = await this.prisma.governingAct.findFirst({ where: { id, organisationId } });
    if (!act) throw govActNotFound();
    if (act.updatedAt.getTime() !== expectedInstant.getTime()) {
      throw new AppError(
        409,
        'GOVERNING_ACT_UPDATE_CONFLICT',
        'This record changed since it was loaded. Refresh and review the latest values.',
      );
    }

    if (changes.approvedAtActId) {
      await this.requireGoverningAct(organisationId, changes.approvedAtActId);
    }

    const updated = await this.prisma.governingAct.updateMany({
      where: { id, organisationId, updatedAt: expectedInstant },
      data: {
        ...(changes.kind !== undefined ? { kind: changes.kind } : {}),
        ...(changes.status !== undefined ? { status: changes.status } : {}),
        ...(changes.actDate !== undefined ? { actDate: new Date(changes.actDate as string) } : {}),
        ...(changes.reference !== undefined ? { reference: changes.reference } : {}),
        ...(changes.title !== undefined ? { title: changes.title } : {}),
        ...'statutoryBasis' in changes ? { statutoryBasis: changes.statutoryBasis ?? null } : {},
        ...('approvedAtActId' in changes ? { approvedAtActId: changes.approvedAtActId ?? null } : {}),
        ...('approvedAt' in changes ? { approvedAt: toDate(changes.approvedAt as string | null) } : {}),
        ...('documentId' in changes ? { documentId: changes.documentId ?? null } : {}),
        ...('notes' in changes ? { notes: changes.notes ?? null } : {}),
      },
    });

    if (updated.count !== 1) {
      throw new AppError(
        409,
        'GOVERNING_ACT_UPDATE_CONFLICT',
        'This record changed since it was loaded. Refresh and review the latest values.',
      );
    }

    return (await this.prisma.governingAct.findFirst({
      where: { id, organisationId },
      include: { resolutions: true },
    }))!;
  }

  async createResolution(
    organisationId: string,
    governingActId: string,
    data: CreateResolutionRequest,
  ): Promise<Resolution> {
    await this.requireGoverningAct(organisationId, governingActId);
    return this.prisma.resolution.create({
      data: {
        organisationId,
        governingActId,
        itemNumber: data.itemNumber ?? null,
        text: data.text,
        carried: data.carried ?? true,
        abstentions: data.abstentions ?? null,
        conflictRecordId: data.conflictRecordId ?? null,
      },
    });
  }

  async updateResolution(
    organisationId: string,
    resolutionId: string,
    data: UpdateResolutionRequest,
  ): Promise<Resolution> {
    const { expectedUpdatedAt, ...changes } = data;
    const expectedInstant = new Date(expectedUpdatedAt);

    const resolution = await this.prisma.resolution.findFirst({
      where: { id: resolutionId, organisationId },
    });
    if (!resolution) throw resolutionNotFound();
    if (resolution.updatedAt.getTime() !== expectedInstant.getTime()) {
      throw new AppError(
        409,
        'RESOLUTION_UPDATE_CONFLICT',
        'This resolution changed since it was loaded. Refresh and review the latest values.',
      );
    }

    const updated = await this.prisma.resolution.updateMany({
      where: { id: resolutionId, organisationId, updatedAt: expectedInstant },
      data: {
        ...(changes.text !== undefined ? { text: changes.text } : {}),
        ...(changes.carried !== undefined ? { carried: changes.carried } : {}),
        ...('itemNumber' in changes ? { itemNumber: changes.itemNumber ?? null } : {}),
        ...('abstentions' in changes ? { abstentions: changes.abstentions ?? null } : {}),
        ...('conflictRecordId' in changes ? { conflictRecordId: changes.conflictRecordId ?? null } : {}),
      },
    });

    if (updated.count !== 1) {
      throw new AppError(
        409,
        'RESOLUTION_UPDATE_CONFLICT',
        'This resolution changed since it was loaded. Refresh and review the latest values.',
      );
    }

    return (await this.prisma.resolution.findFirst({ where: { id: resolutionId, organisationId } }))!;
  }

  async getBoardSubmissions(organisationId: string): Promise<BoardSubmissionsResponse> {
    const documents = await this.prisma.document.findMany({
      where: { organisationId },
      include: {
        approvedByResolution: {
          include: {
            governingAct: {
              select: { id: true, reference: true, actDate: true, status: true, title: true },
            },
          },
        },
      },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });

    const evidenced: BoardSubmission[] = [];
    const notEvidenced: BoardSubmission[] = [];
    const notSubmitted: BoardSubmission[] = [];

    for (const doc of documents) {
      const resolution = doc.approvedByResolution;

      // Rule 2: only count as evidenced if the governing act is APPROVED.
      const isEvidenced =
        resolution !== null &&
        EVIDENCED_STATUSES.includes(resolution.governingAct.status as GoverningActStatus);

      const submission: BoardSubmission = {
        id: doc.id,
        name: doc.name,
        category: doc.category,
        approvalAsserted: doc.approvalAsserted,
        approvedDate: doc.approvedDate,
        boardMinuteReference: doc.boardMinuteReference,
        resolution: resolution
          ? {
              id: resolution.id,
              text: resolution.text,
              itemNumber: resolution.itemNumber,
              governingAct: {
                id: resolution.governingAct.id,
                reference: resolution.governingAct.reference,
                actDate: resolution.governingAct.actDate,
                status: resolution.governingAct.status as GoverningActStatus,
                title: resolution.governingAct.title,
              },
            }
          : null,
        evidenced: isEvidenced,
      };

      if (isEvidenced) {
        evidenced.push(submission);
      } else if (doc.approvalAsserted || resolution !== null) {
        // Has a claim or a resolution pointing to unapproved minutes
        notEvidenced.push(submission);
      } else {
        notSubmitted.push(submission);
      }
    }

    return { evidenced, outstanding: { notEvidenced, notSubmitted } };
  }

  async setDocumentApproval(
    organisationId: string,
    documentId: string,
    approvedByResolutionId: string | null | undefined,
    approvalAsserted: boolean | undefined,
    expectedUpdatedAt: string,
  ): Promise<void> {
    const expectedInstant = new Date(expectedUpdatedAt);

    const doc = await this.prisma.document.findFirst({ where: { id: documentId, organisationId } });
    if (!doc) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
    if (doc.updatedAt.getTime() !== expectedInstant.getTime()) {
      throw new AppError(
        409,
        'DOCUMENT_UPDATE_CONFLICT',
        'This document changed since it was loaded. Refresh and review the latest values.',
      );
    }

    // Rule 1: require a resolution for any true approval.
    // approvalAsserted=true without a resolution is permitted (shows as "asserted, not evidenced").
    if (approvedByResolutionId) {
      const resolution = await this.prisma.resolution.findFirst({
        where: { id: approvedByResolutionId, organisationId },
        include: {
          governingAct: { select: { id: true, status: true, reference: true } },
        },
      });
      if (!resolution) throw resolutionNotFound();

      // Rule 2: draft/circulated minutes are not evidence.
      if (!EVIDENCED_STATUSES.includes(resolution.governingAct.status as GoverningActStatus)) {
        throw new AppError(
          422,
          'MINUTES_NOT_YET_APPROVED',
          `The minutes for ${resolution.governingAct.reference} are ${resolution.governingAct.status} — ` +
            'minutes are not evidence until they are APPROVED at a subsequent meeting. ' +
            'To record this as an unverified claim, use approvalAsserted instead.',
        );
      }
    }

    const updated = await this.prisma.document.updateMany({
      where: { id: documentId, organisationId, updatedAt: expectedInstant },
      data: {
        ...(approvedByResolutionId !== undefined ? { approvedByResolutionId } : {}),
        ...(approvalAsserted !== undefined ? { approvalAsserted } : {}),
      },
    });

    // The guarded write is the only authority on whether the caller's version
    // was still current. Reporting success on a zero-row update would tell an
    // administrator that approval evidence was recorded when it was not.
    if (updated.count !== 1) {
      throw new AppError(
        409,
        'DOCUMENT_UPDATE_CONFLICT',
        'This document changed since it was loaded. Refresh and review the latest values.',
      );
    }
  }

  /**
   * Permanently remove a governing act and its resolutions, retaining a full
   * snapshot in the audit trail.
   *
   * Marking a false record SUPERSEDED is not enough: it still reads as an act
   * that genuinely occurred, and anyone scanning the minute book sees a real
   * entry. A fabricated statutory record has to be removable.
   *
   * It refuses when removal would damage a surviving record - if another act
   * cites this one as the meeting that approved its minutes, or if a document's
   * approval evidence hangs off one of its resolutions. Those links must be
   * dealt with deliberately first, not severed as a side effect.
   */
  async voidAct(
    organisationId: string,
    id: string,
    userId: string,
    data: VoidGoverningActRequest,
  ): Promise<GoverningActVoid> {
    const expectedInstant = new Date(data.expectedUpdatedAt);

    // Resolve the actor from the user record rather than a token claim, so the
    // audit trail records who the system believes they are.
    const actor = await this.prisma.user.findFirst({
      where: { id: userId, organisationId },
      select: { id: true, email: true },
    });
    if (!actor) throw new AppError(403, 'ACTOR_NOT_FOUND', 'Acting user not found in this organisation');

    // Both dependency foreign keys are ON DELETE SET NULL, so nothing at the
    // database level refuses this delete: a link the refusal checks did not see
    // is silently detached rather than raising. The checks are the only
    // protection, so they have to be serialized with the delete. Under READ
    // COMMITTED a concurrent link that commits after these SELECTs stays
    // invisible to them and the delete proceeds. Serializable turns that
    // interleaving into a serialization failure instead of lost evidence.
    //
    // That failure is an expected outcome, not a fault: retry it a bounded
    // number of times, then report the conflict the caller can act on rather
    // than letting Prisma's P2034 escape as an opaque 500. Nothing committed
    // on an aborted attempt, so a retry re-reads the act and re-checks its
    // version from scratch.
    for (let attempt = 0; attempt < SERIALIZABLE_RETRY_LIMIT; attempt += 1) {
      try {
        return await this.removeActInSerializableTransaction(
          organisationId,
          id,
          expectedInstant,
          actor,
          data,
        );
      } catch (error) {
        if (!isSerializationConflict(error)) throw error;
        if (attempt < SERIALIZABLE_RETRY_LIMIT - 1) continue;
        throw removalConflict();
      }
    }

    throw removalConflict();
  }

  private async removeActInSerializableTransaction(
    organisationId: string,
    id: string,
    expectedInstant: Date,
    actor: { id: string; email: string },
    data: VoidGoverningActRequest,
  ): Promise<GoverningActVoid> {
    return this.prisma.$transaction(async (tx) => {
      const act = await tx.governingAct.findFirst({
        where: { id, organisationId },
        include: { resolutions: true },
      });
      if (!act) throw govActNotFound();
      if (act.updatedAt.getTime() !== expectedInstant.getTime()) {
        throw new AppError(
          409,
          'GOVERNING_ACT_UPDATE_CONFLICT',
          'This record changed since it was loaded. Refresh and review the latest values.',
        );
      }

      // Another act's minutes were approved at this one - removing it would leave
      // that approval pointing at nothing.
      const dependents = await tx.governingAct.findMany({
        where: { organisationId, approvedAtActId: id },
        select: { reference: true },
      });
      if (dependents.length > 0) {
        throw new AppError(
          422,
          'GOVERNING_ACT_HAS_DEPENDENTS',
          `Cannot remove ${act.reference}: it is recorded as the meeting that approved the minutes of ` +
            `${dependents.map((d) => d.reference).join(', ')}. Clear that link on those acts first.`,
        );
      }

      // A document's approval evidence points at one of this act's resolutions.
      const resolutionIds = act.resolutions.map((r) => r.id);
      if (resolutionIds.length > 0) {
        const evidencedDocuments = await tx.document.findMany({
          where: { organisationId, approvedByResolutionId: { in: resolutionIds } },
          select: { name: true },
        });
        if (evidencedDocuments.length > 0) {
          throw new AppError(
            422,
            'GOVERNING_ACT_EVIDENCES_DOCUMENTS',
            `Cannot remove ${act.reference}: its resolutions are the recorded approval for ` +
              `${evidencedDocuments.map((d) => d.name).join(', ')}. Detach that approval first.`,
          );
        }
      }

      const record = await tx.governingActVoid.create({
        data: {
          organisationId,
          reference: act.reference,
          kind: act.kind,
          status: act.status,
          actDate: act.actDate,
          title: act.title,
          statutoryBasis: act.statutoryBasis,
          notes: act.notes,
          resolutionCount: act.resolutions.length,
          snapshot: {
            act: {
              id: act.id,
              kind: act.kind,
              status: act.status,
              actDate: act.actDate.toISOString(),
              reference: act.reference,
              title: act.title,
              statutoryBasis: act.statutoryBasis,
              approvedAtActId: act.approvedAtActId,
              approvedAt: act.approvedAt ? act.approvedAt.toISOString() : null,
              documentId: act.documentId,
              notes: act.notes,
              createdAt: act.createdAt.toISOString(),
              updatedAt: act.updatedAt.toISOString(),
            },
            resolutions: act.resolutions.map((r) => ({
              id: r.id,
              itemNumber: r.itemNumber,
              text: r.text,
              carried: r.carried,
              abstentions: r.abstentions,
              conflictRecordId: r.conflictRecordId,
              createdAt: r.createdAt.toISOString(),
            })),
          },
          reason: data.reason,
          voidedByUserId: actor.id,
          voidedByEmail: actor.email,
        },
      });

      await tx.resolution.deleteMany({ where: { governingActId: id, organisationId } });

      const removed = await tx.governingAct.deleteMany({
        where: { id, organisationId, updatedAt: expectedInstant },
      });
      if (removed.count !== 1) {
        throw new AppError(
          409,
          'GOVERNING_ACT_UPDATE_CONFLICT',
          'This record changed while it was being removed. Nothing was deleted.',
        );
      }

      return record;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async listVoids(organisationId: string): Promise<GoverningActVoid[]> {
    return this.prisma.governingActVoid.findMany({
      where: { organisationId },
      orderBy: { voidedAt: 'desc' },
    });
  }

  private async requireGoverningAct(organisationId: string, id: string): Promise<GoverningAct> {
    const act = await this.prisma.governingAct.findFirst({ where: { id, organisationId } });
    if (!act) throw govActNotFound();
    return act;
  }
}
