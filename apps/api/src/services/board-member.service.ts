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

export class BoardMemberService {
  constructor(private prisma: PrismaClient) {}

  async list(organisationId: string, page = 1, pageSize = 50) {
    const skip = (page - 1) * pageSize;
    const [data, total] = await Promise.all([
      this.prisma.boardMember.findMany({
        where: { organisationId },
        orderBy: [{ isActive: 'desc' }, { appointedDate: 'desc' }],
        skip,
        take: pageSize,
      }),
      this.prisma.boardMember.count({ where: { organisationId } }),
    ]);
    return { data, total, page, pageSize, hasMore: skip + data.length < total };
  }

  async create(organisationId: string, data: CreateBoardMemberRequest) {
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
    };

    validateDomainCompleteState(validateBoardMemberCompleteState, createData);
    return runDomainInvariantWrite(() => this.prisma.boardMember.create({ data: createData }));
  }

  async update(organisationId: string, id: string, data: UpdateBoardMemberRequest) {
    return runDomainInvariantWrite(
      () => this.prisma.$transaction(async (transaction) => {
        await lockOrganisationForUpdate(transaction, organisationId);
        const member = await transaction.boardMember.findFirst({
          where: { id, organisationId },
        });

        if (!member) {
          throw new AppError(404, 'BOARD_MEMBER_NOT_FOUND', 'Board member not found');
        }

        const updateData = {
          ...data,
          appointedDate: data.appointedDate ? new Date(data.appointedDate) : undefined,
          termEndDate: data.termEndDate !== undefined ? (data.termEndDate ? new Date(data.termEndDate) : null) : undefined,
          conductSignedDate: data.conductSignedDate !== undefined ? (data.conductSignedDate ? new Date(data.conductSignedDate) : null) : undefined,
          inductionDate: data.inductionDate !== undefined ? (data.inductionDate ? new Date(data.inductionDate) : null) : undefined,
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

        return transaction.boardMember.update({
          where: { id },
          data: updateData,
        });
      }),
      {
        recordNotFound: {
          code: 'BOARD_MEMBER_NOT_FOUND',
          message: 'Board member not found',
        },
      },
    );
  }

  async remove(organisationId: string, id: string) {
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
