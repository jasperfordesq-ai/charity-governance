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
    // No approved CharityPilot retention rule authorises this legacy derived date.
    retentionDeleteAt: null,
    createdAt: member.createdAt.toISOString(),
    updatedAt: member.updatedAt.toISOString(),
  };
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

  async create(organisationId: string, input: CreateMemberInput, actorUserId: string) {
    const member = await this.prisma.$transaction(async (tx) => {
      const created = await tx.member.create({
        data: {
          organisationId,
          name: input.name,
          address: input.address ?? null,
          dateEntered: prismaDateFromCivil(input.dateEntered),
        },
      });
      await tx.governanceRegisterChangeAudit.create({ data: {
        organisationId, recordKind: 'MEMBER', recordId: created.id,
        actorUserId, action: 'CREATE', previousStatus: null,
        nextStatus: 'ACTIVE', changedFields: ['name', 'address', 'dateEntered'],
      } });
      return created;
    });
    return publicMember(member);
  }

  async update(organisationId: string, memberId: string, input: UpdateMemberInput, actorUserId: string) {
    const expectedUpdatedAt = new Date(input.expectedUpdatedAt);
    const data: Record<string, unknown> = {};

    if (input.name !== undefined) data.name = input.name;
    if ('address' in input) data.address = input.address ?? null;
    if (input.dateEntered !== undefined) data.dateEntered = prismaDateFromCivil(input.dateEntered);
    if ('dateCeased' in input) {
      const ceased = input.dateCeased ?? null;
      data.dateCeased = ceased ? prismaDateFromCivil(ceased) : null;
      // Clear the unapproved legacy date on cessation edits; this is not a purge schedule.
      data.retentionDeleteAt = null;
    }
    if (Object.keys(data).length === 0) {
      throw new AppError(400, 'MEMBER_UPDATE_EMPTY', 'Choose a register field to update.');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.member.findFirst({ where: { id: memberId, organisationId } });
      if (!existing) throw new AppError(404, 'MEMBER_NOT_FOUND', 'Member not found');
      const effectiveEntered = input.dateEntered ?? civilDateFromPrisma(existing.dateEntered);
      const effectiveCeased = 'dateCeased' in input
        ? input.dateCeased
        : existing.dateCeased ? civilDateFromPrisma(existing.dateCeased) : null;
      if (effectiveCeased && effectiveCeased < effectiveEntered) {
        throw new AppError(400, 'MEMBER_DATE_ORDER_INVALID', 'Cessation date cannot precede the entry date.');
      }
      const result = await tx.member.updateMany({
        where: { id: memberId, organisationId, updatedAt: expectedUpdatedAt }, data,
      });
      if (result.count === 0) {
        const still = await tx.member.findFirst({ where: { id: memberId, organisationId } });
        if (!still) throw new AppError(404, 'MEMBER_NOT_FOUND', 'Member not found');
        throw new AppError(409, 'CONCURRENCY_CONFLICT', 'Member was modified by another session. Refresh and try again.');
      }
      const current = await tx.member.findFirstOrThrow({ where: { id: memberId, organisationId } });
      await tx.governanceRegisterChangeAudit.create({ data: {
        organisationId, recordKind: 'MEMBER', recordId: memberId, actorUserId,
        action: 'UPDATE',
        previousStatus: existing.dateCeased ? 'CEASED' : 'ACTIVE',
        nextStatus: current.dateCeased ? 'CEASED' : 'ACTIVE',
        changedFields: Object.keys(data).sort(),
      } });
      return current;
    });
    return publicMember(updated);
  }
}
