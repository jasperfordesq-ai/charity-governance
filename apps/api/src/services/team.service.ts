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
const TEAM_MEMBER_LIMITS = {
  ESSENTIALS: 5,
  COMPLETE: null,
};

type UserRole = 'OWNER' | 'ADMIN' | 'MEMBER';
type SubscriptionPlanValue = keyof typeof TEAM_MEMBER_LIMITS;
type QueryRaw = <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;

type TeamCapacityClient = {
  subscription: {
    findUnique(args: {
      where: { organisationId: string };
      select: { plan: true };
    }): Promise<{ plan: string } | null>;
  };
  user: {
    count(args: { where: { organisationId: string } }): Promise<number>;
  };
  teamInvite: {
    count(args: {
      where: {
        organisationId: string;
        acceptedAt: null;
        revokedAt: null;
        expiresAt: { gt: Date };
      };
    }): Promise<number>;
  };
  $queryRaw?: QueryRaw;
};

type TeamInviteClient = TeamCapacityClient & {
  organisation: {
    findUnique(args: { where: { id: string } }): Promise<{ name: string } | null>;
  };
  user: TeamCapacityClient['user'] & {
    findUnique(args: { where: { id?: string; email?: string } }): Promise<{ id: string; name: string | null } | null>;
  };
  teamInvite: TeamCapacityClient['teamInvite'] & {
    updateMany(args: {
      where: {
        organisationId: string;
        email: string;
        acceptedAt: null;
        revokedAt: null;
        expiresAt: { lte: Date };
      };
      data: { revokedAt: Date };
    }): Promise<{ count: number }>;
    findFirst(args: {
      where: {
        organisationId: string;
        email: string;
        acceptedAt: null;
        revokedAt: null;
        expiresAt: { gt: Date };
      };
    }): Promise<{ id: string } | null>;
    create(args: {
      data: {
        organisationId: string;
        email: string;
        role: InviteTeamMemberData['role'];
        token: string;
        invitedById: string;
        expiresAt: Date;
      };
    }): Promise<unknown>;
  };
  $transaction?: <T>(callback: (tx: TeamInviteClient) => Promise<T>) => Promise<T>;
};

type TeamAcceptClient = PrismaClient & {
  $queryRaw?: QueryRaw;
  $transaction: <T>(callback: (tx: TeamAcceptClient) => Promise<T>) => Promise<T>;
};

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

  private async assertCanAddTeamMember(
    client: TeamCapacityClient,
    organisationId: string,
    now: Date,
    includePendingInvites: boolean,
  ): Promise<void> {
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

    const limit = TEAM_MEMBER_LIMITS[subscription.plan as SubscriptionPlanValue];
    if (limit === undefined) {
      throw new AppError(500, 'SUBSCRIPTION_PLAN_UNSUPPORTED', 'Subscription plan is not supported.');
    }

    if (limit === null) {
      return;
    }

    const [memberCount, pendingInviteCount] = await Promise.all([
      client.user.count({ where: { organisationId } }),
      includePendingInvites
        ? client.teamInvite.count({
            where: {
              organisationId,
              acceptedAt: null,
              revokedAt: null,
              expiresAt: { gt: now },
            },
          })
        : Promise.resolve(0),
    ]);

    if (memberCount + pendingInviteCount >= limit) {
      throw new AppError(
        403,
        'TEAM_MEMBER_LIMIT_EXCEEDED',
        'Team member limit exceeded. Upgrade your plan or remove pending invites before adding more team members.',
        {
          limit,
          memberCount,
          pendingInviteCount,
        },
      );
    }
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
    const inviteToken = crypto.randomBytes(32).toString('base64url');
    const client = this.prisma as unknown as TeamInviteClient;
    let inviteEmailPayload: { organisationName: string; inviterName: string } | null;
    try {
      const runInvite = async (tx: TeamInviteClient) => {
        const [foundOrganisation, foundInviter, foundExistingUser, , existingInvite] = await Promise.all([
          tx.organisation.findUnique({ where: { id: organisationId } }),
          tx.user.findUnique({ where: { id: invitedById } }),
          tx.user.findUnique({ where: { email } }),
          tx.teamInvite.updateMany({
            where: {
              organisationId,
              email,
              acceptedAt: null,
              revokedAt: null,
              expiresAt: { lte: now },
            },
            data: { revokedAt: now },
          }),
          tx.teamInvite.findFirst({
            where: {
              organisationId,
              email,
              acceptedAt: null,
              revokedAt: null,
              expiresAt: { gt: now },
            },
          }),
        ]);

        if (!foundOrganisation) {
          throw new AppError(404, 'ORGANISATION_NOT_FOUND', 'Organisation not found');
        }

        if (existingInvite) {
          return null;
        }

        await this.assertCanAddTeamMember(tx, organisationId, now, true);

        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + INVITE_EXPIRY_DAYS);

        await tx.teamInvite.create({
          data: {
            organisationId,
            email,
            role: data.role,
            token: hashOpaqueToken(inviteToken),
            invitedById,
            expiresAt,
          },
        });
        if (foundExistingUser) {
          return null;
        }

        return {
          organisationName: foundOrganisation.name,
          inviterName: foundInviter?.name ?? 'A CharityPilot admin',
        };
      };

      if (client.$transaction) {
        inviteEmailPayload = await client.$transaction(runInvite);
      } else {
        inviteEmailPayload = await runInvite(client);
      }
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return inviteAccepted();
      }

      throw err;
    }

    if (inviteEmailPayload) {
      void this.emailService.sendTeamInvite(
        email,
        inviteEmailPayload.organisationName,
        inviteEmailPayload.inviterName,
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
    const client = this.prisma as unknown as TeamAcceptClient;

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
      user = await client.$transaction(async (tx) => {
        await this.assertCanAddTeamMember(tx, invite.organisationId, now, false);

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
