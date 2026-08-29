import type { PrismaClient } from '@prisma/client';
import type { z } from 'zod';
import { AppError } from '../utils/errors.js';
import { civilDateFromPrisma, prismaDateFromCivil } from '../utils/civil-date.js';
import type { createMemberSchema, updateMemberSchema } from '@charitypilot/shared';

type CreateMemberInput = z.infer<typeof createMemberSchema>;
type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

function publicMember(member: {
  id: string;
  organisationId: string;
  name: string;
  address: string | null;
  dateEntered: Date;
  dateCeased: Date | null;
  retentionDeleteAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: member.id,
    organisationId: member.organisationId,
    name: member.name,
    address: member.address,
    dateEntered: civilDateFromPrisma(member.dateEntered),
    dateCeased: member.dateCeased ? civilDateFromPrisma(member.dateCeased) : null,
    retentionDeleteAt: member.retentionDeleteAt ? civilDateFromPrisma(member.retentionDeleteAt) : null,
    createdAt: member.createdAt.toISOString(),
    updatedAt: member.updatedAt.toISOString(),
  };
}

function addOneYear(date: string): string {
  // date is YYYY-MM-DD; retain the same MM-DD, advance year by 1
  const [year, rest] = [date.slice(0, 4), date.slice(4)];
  return `${String(Number(year) + 1)}${rest}`;
}

export class MemberService {
  constructor(private prisma: PrismaClient) {}

  async list(organisationId: string, includeFormer = false) {
    const members = await this.prisma.member.findMany({
      where: {
        organisationId,
        ...(includeFormer ? {} : { dateCeased: null }),
      },
      orderBy: [{ dateCeased: 'asc' }, { name: 'asc' }],
    });
    return members.map(publicMember);
  }

  async create(organisationId: string, input: CreateMemberInput) {
    const member = await this.prisma.member.create({
      data: {
        organisationId,
        name: input.name,
        address: input.address ?? null,
        dateEntered: prismaDateFromCivil(input.dateEntered),
      },
    });
    return publicMember(member);
  }

  async update(organisationId: string, memberId: string, input: UpdateMemberInput) {
    const existing = await this.prisma.member.findFirst({
      where: { id: memberId, organisationId },
    });
    if (!existing) {
      throw new AppError(404, 'MEMBER_NOT_FOUND', 'Member not found');
    }
    const expectedUpdatedAt = new Date(input.expectedUpdatedAt);
    const data: Record<string, unknown> = {};

    if (input.name !== undefined) data.name = input.name;
    if ('address' in input) data.address = input.address ?? null;
    if (input.dateEntered !== undefined) data.dateEntered = prismaDateFromCivil(input.dateEntered);
    if ('dateCeased' in input) {
      const ceased = input.dateCeased ?? null;
      data.dateCeased = ceased ? prismaDateFromCivil(ceased) : null;
      // retentionDeleteAt = dateCeased + 1 year, or null if not ceased
      data.retentionDeleteAt = ceased ? prismaDateFromCivil(addOneYear(ceased)) : null;
    }

    const result = await this.prisma.member.updateMany({
      where: { id: memberId, organisationId, updatedAt: expectedUpdatedAt },
      data,
    });
    if (result.count === 0) {
      const still = await this.prisma.member.findFirst({ where: { id: memberId, organisationId } });
      if (!still) throw new AppError(404, 'MEMBER_NOT_FOUND', 'Member not found');
      throw new AppError(409, 'CONCURRENCY_CONFLICT', 'Member was modified by another session. Refresh and try again.');
    }
    const updated = await this.prisma.member.findFirstOrThrow({ where: { id: memberId, organisationId } });
    return publicMember(updated);
  }
}
