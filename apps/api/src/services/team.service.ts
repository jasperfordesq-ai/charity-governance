import { Prisma, type PrismaClient } from '@prisma/client';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { AppError } from '../utils/errors.js';
import { EmailService } from './email.service.js';
import { hashOpaqueToken, issueSessionTokens } from './session-tokens.js';
import { publicOrganisationSelect, type PublicOrganisation } from '../utils/public-dtos.js';

interface InviteTeamMemberData {
  email: string;
  role: 'ADMIN' | 'MEMBER';
}

interface AcceptTeamInviteData {
  token: string;
  name: string;
  password: string;
}

const SALT_ROUNDS = 12;
const INVITE_EXPIRY_DAYS = 7;
const INVALID_INVITE_MESSAGE = 'This invite is invalid or has expired';
const TEAM_INVITE_ACCEPTED_MESSAGE = 'If the invite can be sent, we will email the recipient.';
type UserRole = 'OWNER' | 'ADMIN' | 'MEMBER';

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function ensureCanInvite(role: UserRole, invitedRole?: InviteTeamMemberData['role']) {
  if (role !== 'OWNER' && role !== 'ADMIN') {
    throw new AppError(403, 'FORBIDDEN', 'Only owners and admins can invite team members');
  }

  if (invitedRole === 'ADMIN' && role !== 'OWNER') {
    throw new AppError(403, 'FORBIDDEN', 'Only the account owner can invite admins');
  }
}

function ensureOwner(role: UserRole) {
  if (role !== 'OWNER') {
    throw new AppError(403, 'FORBIDDEN', 'Only the account owner can change team member roles');
  }
}

function invalidInviteError() {
  return new AppError(400, 'INVALID_INVITE', INVALID_INVITE_MESSAGE);
}

function inviteAccepted() {
  return { message: TEAM_INVITE_ACCEPTED_MESSAGE };
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export class TeamService {
  private emailService: EmailService;

  constructor(
    private prisma: PrismaClient,
    emailService?: EmailService,
  ) {
    this.emailService = emailService ?? new EmailService();
  }

  async list(organisationId: string) {
    const [members, invites] = await Promise.all([
      this.prisma.user.findMany({
        where: { organisationId },
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          emailVerified: true,
          createdAt: true,
        },
      }),
      this.prisma.teamInvite.findMany({
        where: { organisationId },
        include: {
          invitedBy: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      members: members.map((member) => ({
        ...member,
        createdAt: member.createdAt.toISOString(),
      })),
      invites: invites.map((invite) => ({
        id: invite.id,
        email: invite.email,
        role: invite.role,
        invitedByName: invite.invitedBy?.name ?? null,
        acceptedAt: invite.acceptedAt?.toISOString() ?? null,
        revokedAt: invite.revokedAt?.toISOString() ?? null,
        expiresAt: invite.expiresAt.toISOString(),
        createdAt: invite.createdAt.toISOString(),
      })),
    };
  }

  async invite(
    organisationId: string,
    invitedById: string,
    invitedByRole: UserRole,
    data: InviteTeamMemberData,
  ) {
    ensureCanInvite(invitedByRole, data.role);

    const email = normalizeEmail(data.email);
    const now = new Date();
    const [organisation, inviter, existingUser, , existingInvite] = await Promise.all([
      this.prisma.organisation.findUnique({ where: { id: organisationId } }),
      this.prisma.user.findUnique({ where: { id: invitedById } }),
      this.prisma.user.findUnique({ where: { email } }),
      this.prisma.teamInvite.updateMany({
        where: {
          organisationId,
          email,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { lte: now },
        },
        data: { revokedAt: now },
      }),
      this.prisma.teamInvite.findFirst({
        where: {
          organisationId,
          email,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: now },
        },
      }),
    ]);

    if (!organisation) {
      throw new AppError(404, 'ORGANISATION_NOT_FOUND', 'Organisation not found');
    }

    if (existingInvite) {
      return inviteAccepted();
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + INVITE_EXPIRY_DAYS);

    const inviteToken = crypto.randomBytes(32).toString('base64url');
    try {
      await this.prisma.teamInvite.create({
        data: {
          organisationId,
          email,
          role: data.role,
          token: hashOpaqueToken(inviteToken),
          invitedById,
          expiresAt,
        },
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return inviteAccepted();
      }

      throw err;
    }

    if (!existingUser) {
      void this.emailService.sendTeamInvite(
        email,
        organisation.name,
        inviter?.name ?? 'A CharityPilot admin',
        inviteToken,
        data.role,
      );
    }

    return inviteAccepted();
  }

  async revoke(organisationId: string, inviteId: string, actorRole: UserRole) {
    ensureCanInvite(actorRole);

    const invite = await this.prisma.teamInvite.findFirst({
      where: { id: inviteId, organisationId },
    });

    if (!invite) {
      throw new AppError(404, 'INVITE_NOT_FOUND', 'Invite not found');
    }

    if (invite.acceptedAt) {
      throw new AppError(400, 'INVITE_ACCEPTED', 'Accepted invites cannot be revoked');
    }

    const revoked = await this.prisma.teamInvite.update({
      where: { id: inviteId },
      data: { revokedAt: new Date() },
    });

    return { id: revoked.id, revokedAt: revoked.revokedAt?.toISOString() ?? null };
  }

  async updateMemberRole(
    organisationId: string,
    actorId: string,
    actorRole: UserRole,
    memberId: string,
    role: UserRole,
  ) {
    ensureOwner(actorRole);

    if (role === 'OWNER') {
      throw new AppError(400, 'OWNER_TRANSFER_UNSUPPORTED', 'Owner transfer is not supported yet');
    }

    if (memberId === actorId) {
      throw new AppError(400, 'CANNOT_CHANGE_OWN_ROLE', 'You cannot change your own role');
    }

    const member = await this.prisma.user.findFirst({
      where: { id: memberId, organisationId },
    });

    if (!member) {
      throw new AppError(404, 'MEMBER_NOT_FOUND', 'Team member not found');
    }

    if (member.role === 'OWNER') {
      throw new AppError(400, 'CANNOT_DEMOTE_OWNER', 'The account owner cannot be demoted here');
    }

    const updated = await this.prisma.user.update({
      where: { id: member.id },
      data: { role },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        emailVerified: true,
        createdAt: true,
      },
    });

    return { ...updated, createdAt: updated.createdAt.toISOString() };
  }

  async acceptInvite(data: AcceptTeamInviteData) {
    const token = hashOpaqueToken(data.token);
    const now = new Date();
    const invite = await this.prisma.teamInvite.findUnique({
      where: { token },
    });

    if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt <= now) {
      throw invalidInviteError();
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email: invite.email },
    });

    if (existingUser) {
      throw invalidInviteError();
    }

    const passwordHash = await bcrypt.hash(data.password, SALT_ROUNDS);

    let user: {
      id: string;
      email: string;
      name: string;
      role: UserRole;
      emailVerified: boolean;
      organisationId: string;
      organisation: PublicOrganisation;
    };
    try {
      user = await this.prisma.$transaction(async (tx) => {
        const consumed = await tx.teamInvite.updateMany({
          where: {
            id: invite.id,
            token,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: now },
          },
          data: { acceptedAt: now },
        });

        if (consumed.count !== 1) {
          throw invalidInviteError();
        }

        const created = await tx.user.create({
          data: {
            email: invite.email,
            name: data.name,
            passwordHash,
            role: invite.role,
            organisationId: invite.organisationId,
            emailVerified: true,
          },
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            emailVerified: true,
            organisationId: true,
            organisation: { select: publicOrganisationSelect },
          },
        });

        return created;
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw invalidInviteError();
      }

      throw err;
    }

    const tokens = await issueSessionTokens(this.prisma, user);

    return { user, ...tokens };
  }
}
