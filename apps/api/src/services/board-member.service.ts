import type { PrismaClient } from '@prisma/client';
import type { CreateBoardMemberRequest, UpdateBoardMemberRequest } from '@charitypilot/shared';
import { AppError } from '../utils/errors.js';

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
    return this.prisma.boardMember.create({
      data: {
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
      },
    });
  }

  async update(organisationId: string, id: string, data: UpdateBoardMemberRequest) {
    const member = await this.prisma.boardMember.findFirst({
      where: { id, organisationId },
    });

    if (!member) {
      throw new AppError(404, 'BOARD_MEMBER_NOT_FOUND', 'Board member not found');
    }

    return this.prisma.boardMember.update({
      where: { id },
      data: {
        ...data,
        appointedDate: data.appointedDate ? new Date(data.appointedDate) : undefined,
        termEndDate: data.termEndDate !== undefined ? (data.termEndDate ? new Date(data.termEndDate) : null) : undefined,
        conductSignedDate: data.conductSignedDate !== undefined ? (data.conductSignedDate ? new Date(data.conductSignedDate) : null) : undefined,
        inductionDate: data.inductionDate !== undefined ? (data.inductionDate ? new Date(data.inductionDate) : null) : undefined,
      },
    });
  }

  async remove(organisationId: string, id: string) {
    const member = await this.prisma.boardMember.findFirst({
      where: { id, organisationId },
    });

    if (!member) {
      throw new AppError(404, 'BOARD_MEMBER_NOT_FOUND', 'Board member not found');
    }

    await this.prisma.boardMember.delete({ where: { id } });
  }
}
