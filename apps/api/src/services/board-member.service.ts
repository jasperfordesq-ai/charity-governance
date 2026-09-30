import type { PrismaClient } from '@prisma/client';
import {
  validateBoardMemberCompleteState,
  type CreateBoardMemberRequest,
  type UpdateBoardMemberRequest,
} from '@charitypilot/shared';
import {
  runDomainInvariantWrite,
  validateDomainCompleteState,
} from '../utils/domain-validation.js';
import { AppError } from '../utils/errors.js';
import { lockOrganisationForUpdate } from './organisation-lock.js';
import { assertUnchanged } from '../utils/optimistic-concurrency.js';

export class BoardMemberService {
  constructor(private prisma: PrismaClient) {}

  private readonly memberViewSelect = {
    id: true, organisationId: true, name: true, role: true,
    appointedDate: true, termEndDate: true, isActive: true,
    conductSigned: true, conductSignedDate: true,
    inductionCompleted: true, inductionDate: true,
  } as const;

  async list(organisationId: string, page = 1, pageSize = 50, viewerRole: 'OWNER' | 'ADMIN' | 'MEMBER' = 'MEMBER') {
    const skip = (page - 1) * pageSize;
    const [data, total] = await Promise.all([
      this.prisma.boardMember.findMany({
        where: { organisationId },
        orderBy: [{ isActive: 'desc' }, { appointedDate: 'desc' }],
        ...(viewerRole === 'MEMBER' ? { select: this.memberViewSelect } : {}),
        skip,
        take: pageSize,
      }),
      this.prisma.boardMember.count({ where: { organisationId } }),
    ]);
    return { data, total, page, pageSize, hasMore: skip + data.length < total };
  }

  /**
   * One trustee.
   *
   * `list` pages fifty at a time, so an agent following a reference from a
   * conflict record or a resolution had to walk the register to resolve one
   * identifier it already held.
   */
  async getById(organisationId: string, id: string, viewerRole: 'OWNER' | 'ADMIN' | 'MEMBER' = 'MEMBER') {
    const member = await this.prisma.boardMember.findFirst({
      where: { id, organisationId },
      ...(viewerRole === 'MEMBER' ? { select: this.memberViewSelect } : {}),
    });
    if (!member) {
      throw new AppError(404, 'BOARD_MEMBER_NOT_FOUND', 'Board member not found');
    }
    return member;
  }

  async create(organisationId: string, data: CreateBoardMemberRequest, actorUserId: string) {
    const createData = {
      organisationId,
      name: data.name,
      role: data.role,
      email: data.email,
      appointedDate: new Date(data.appointedDate),
      termEndDate: data.termEndDate ? new Date(data.termEndDate) : undefined,
      conductSigned: data.conductSigned ?? false,
      conductSignedDate: data.conductSignedDate ? new Date(data.conductSignedDate) : undefined,
      inductionCompleted: data.inductionCompleted ?? false,
      inductionDate: data.inductionDate ? new Date(data.inductionDate) : undefined,
      dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : undefined,
      residentialAddress: data.residentialAddress,
      otherDirectorships: data.otherDirectorships,
      formerNames: data.formerNames,
      appointmentKind: data.appointmentKind,
    };

    validateDomainCompleteState(validateBoardMemberCompleteState, createData);
    return runDomainInvariantWrite(() => this.prisma.$transaction(async (transaction) => {
      await lockOrganisationForUpdate(transaction, organisationId);
      const row = await transaction.boardMember.create({ data: createData });
      await transaction.governanceRegisterChangeAudit.create({ data: {
        organisationId, recordKind: 'TRUSTEE', recordId: row.id, actorUserId,
        action: 'CREATE', changedFields: Object.keys(data),
      } });
      return row;
    }));
  }

  async update(
    organisationId: string,
    id: string,
    data: UpdateBoardMemberRequest,
    expectedUpdatedAt: string | undefined,
    actorUserId: string,
  ) {
    return runDomainInvariantWrite(
      () => this.prisma.$transaction(async (transaction) => {
        await lockOrganisationForUpdate(transaction, organisationId);
        const member = await transaction.boardMember.findFirst({
          where: { id, organisationId },
        });

        if (!member) {
          throw new AppError(404, 'BOARD_MEMBER_NOT_FOUND', 'Board member not found');
        }
        assertUnchanged(member, expectedUpdatedAt, 'BOARD_MEMBER_UPDATE_CONFLICT');

        const updateData = {
          ...data,
          appointedDate: data.appointedDate ? new Date(data.appointedDate) : undefined,
          termEndDate: data.termEndDate !== undefined ? (data.termEndDate ? new Date(data.termEndDate) : null) : undefined,
          conductSignedDate: data.conductSignedDate !== undefined ? (data.conductSignedDate ? new Date(data.conductSignedDate) : null) : undefined,
          inductionDate: data.inductionDate !== undefined ? (data.inductionDate ? new Date(data.inductionDate) : null) : undefined,
          dateOfBirth: data.dateOfBirth !== undefined ? (data.dateOfBirth ? new Date(data.dateOfBirth) : null) : undefined,
        };
        validateDomainCompleteState(validateBoardMemberCompleteState, {
          appointedDate: updateData.appointedDate ?? member.appointedDate,
          termEndDate: updateData.termEndDate === undefined ? member.termEndDate : updateData.termEndDate,
          conductSigned: data.conductSigned === undefined ? member.conductSigned : data.conductSigned,
          conductSignedDate: updateData.conductSignedDate === undefined
            ? member.conductSignedDate
            : updateData.conductSignedDate,
          inductionCompleted: data.inductionCompleted === undefined
            ? member.inductionCompleted
            : data.inductionCompleted,
          inductionDate: updateData.inductionDate === undefined ? member.inductionDate : updateData.inductionDate,
        });

        const row = await transaction.boardMember.update({
          where: { id },
          data: updateData,
        });
        await transaction.governanceRegisterChangeAudit.create({ data: {
          organisationId, recordKind: 'TRUSTEE', recordId: id, actorUserId,
          action: 'UPDATE',
          changedFields: Object.entries(data).filter(([, value]) => value !== undefined).map(([field]) => field),
        } });
        return row;
      }),
      {
        recordNotFound: {
          code: 'BOARD_MEMBER_NOT_FOUND',
          message: 'Board member not found',
        },
      },
    );
  }

  async remove(organisationId: string, id: string, actorUserId: string) {
    await runDomainInvariantWrite(
      () => this.prisma.$transaction(async (transaction) => {
        await lockOrganisationForUpdate(transaction, organisationId);
        const member = await transaction.boardMember.findFirst({
          where: { id, organisationId },
          select: { id: true },
        });

        if (!member) {
          throw new AppError(404, 'BOARD_MEMBER_NOT_FOUND', 'Board member not found');
        }

        await transaction.conflictRecord.updateMany({
          where: { organisationId, boardMemberId: id },
          data: { boardMemberId: null },
        });
        await transaction.boardMember.delete({ where: { id } });
        await transaction.governanceRegisterChangeAudit.create({ data: {
          organisationId, recordKind: 'TRUSTEE', recordId: id, actorUserId,
          action: 'DELETE', changedFields: [],
        } });
      }),
      {
        boardMemberForeignKeyFailure: 'delete-conflict',
        recordNotFound: {
          code: 'BOARD_MEMBER_NOT_FOUND',
          message: 'Board member not found',
        },
      },
    );
  }
}
