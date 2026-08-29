import type {
  CreateGoverningActRequest,
  UpdateGoverningActRequest,
  CreateResolutionRequest,
  UpdateResolutionRequest,
  GoverningActQuery,
} from '@charitypilot/shared';
import type { GoverningAct, GoverningActStatus, PrismaClient, Resolution } from '@prisma/client';
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
    const year = query.year ?? new Date().getFullYear();
    return this.prisma.governingAct.findMany({
      where: {
        organisationId,
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.status ? { status: query.status } : {}),
        actDate: {
          gte: new Date(`${year}-01-01`),
          lte: new Date(`${year}-12-31`),
        },
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

    await this.prisma.document.updateMany({
      where: { id: documentId, organisationId, updatedAt: expectedInstant },
      data: {
        ...(approvedByResolutionId !== undefined ? { approvedByResolutionId } : {}),
        ...(approvalAsserted !== undefined ? { approvalAsserted } : {}),
      },
    });
  }

  private async requireGoverningAct(organisationId: string, id: string): Promise<GoverningAct> {
    const act = await this.prisma.governingAct.findFirst({ where: { id, organisationId } });
    if (!act) throw govActNotFound();
    return act;
  }
}
