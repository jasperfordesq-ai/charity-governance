import { Prisma, type PrismaClient } from '@prisma/client';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { AppError } from '../utils/errors.js';
import { EmailService } from './email.service.js';
import { hashOpaqueToken, issueSessionTokensInTransaction } from './session-tokens.js';
import { publicOrganisationSelect, type PublicOrganisationSource } from '../utils/public-dtos.js';
import { hasSubscriptionAccess } from '../utils/subscription-access.js';
import {
  isPersonalServerDeployment,
  personalServerManualInviteUrl,
} from '../utils/personal-server.js';

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
const PERSONAL_SERVER_INVITE_CREATED_MESSAGE = 'Invite created. Share the one-time link with the recipient.';
const TEAM_MEMBER_LIMITS = {
  ESSENTIALS: 5,
  COMPLETE: null,
};

type UserRole = 'OWNER' | 'ADMIN' | 'MEMBER';
type SubscriptionPlanValue = keyof typeof TEAM_MEMBER_LIMITS;
type QueryRaw = <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;

type LockedTeamListActor = {
  id: string;
  role: UserRole;
  lifecycleStatus: string;
};

type TeamCapacityClient = {
  subscription: {
    findUnique(args: {
      where: { organisationId: string };
      select: { plan: true; status: true; trialEndsAt: true; currentPeriodEnd: true };
    }): Promise<{
      plan: string;
      status?: string;
      trialEndsAt?: Date | null;
      currentPeriodEnd?: Date | null;
    } | null>;
  };
  user: {
    count(args: { where: { organisationId: string; lifecycleStatus: 'ACTIVE' } }): Promise<number>;
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
    findUnique(args: { where: { id?: string; email?: string } }): Promise<{
      id: string;
      name: string | null;
      role?: UserRole;
      organisationId?: string;
      lifecycleStatus?: string;
    } | null>;
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
      const organisations = await client.$queryRaw<Array<{ id: string; lifecycleStatus?: string }>>`
        SELECT "id", "lifecycleStatus"
        FROM "Organisation"
        WHERE "id" = ${organisationId}
        FOR UPDATE
      `;
      if (organisations.length === 0) {
        throw new AppError(404, 'ORGANISATION_NOT_FOUND', 'Organisation not found');
      }
      if (
        organisations[0].lifecycleStatus !== undefined &&
        organisations[0].lifecycleStatus !== 'ACTIVE'
      ) {
        throw new AppError(409, 'ORGANISATION_INACTIVE', 'This organisation is not active');
      }
    }

    const subscription = await client.subscription.findUnique({
      where: { organisationId },
      select: { plan: true, status: true, trialEndsAt: true, currentPeriodEnd: true },
    });

    if (!subscription) {
      throw new AppError(403, 'NO_SUBSCRIPTION', 'No active subscription. Please subscribe to continue.');
    }

    const subscriptionStatus = subscription.status;
    if (
      subscriptionStatus !== undefined &&
      !hasSubscriptionAccess({
        status: subscriptionStatus,
        trialEndsAt: subscription.trialEndsAt,
        currentPeriodEnd: subscription.currentPeriodEnd,
      }, now)
    ) {
      throw new AppError(403, 'SUBSCRIPTION_INACTIVE', 'The subscription is not active');
    }

    const limit = TEAM_MEMBER_LIMITS[subscription.plan as SubscriptionPlanValue];
    if (limit === undefined) {
      throw new AppError(500, 'SUBSCRIPTION_PLAN_UNSUPPORTED', 'Subscription plan is not supported.');
    }

    if (limit === null) {
      return;
    }

    const [memberCount, pendingInviteCount] = await Promise.all([
      client.user.count({ where: { organisationId, lifecycleStatus: 'ACTIVE' } }),
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

  async list(organisationId: string, actorId: string) {
    return this.prisma.$transaction(async (tx) => {
      const organisations = await tx.$queryRaw<Array<{ id: string; lifecycleStatus: string }>>`
        SELECT "id", "lifecycleStatus"
        FROM "Organisation"
        WHERE "id" = ${organisationId}
        FOR UPDATE
      `;
      const organisation = organisations[0];
      if (!organisation) {
        throw new AppError(404, 'ORGANISATION_NOT_FOUND', 'Organisation not found');
      }
      if (organisation.lifecycleStatus !== 'ACTIVE') {
        throw new AppError(409, 'ORGANISATION_INACTIVE', 'This organisation is not active');
      }

      const actors = await tx.$queryRaw<LockedTeamListActor[]>`
        SELECT "id", "role", "lifecycleStatus"
        FROM "User"
        WHERE "id" = ${actorId}
          AND "organisationId" = ${organisationId}
        FOR UPDATE
      `;
      const actor = actors[0];
      if (!actor || actor.lifecycleStatus !== 'ACTIVE') {
        throw new AppError(403, 'FORBIDDEN', 'Your membership cannot view this team');
      }

      const members = await tx.user.findMany({
        where: { organisationId },
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          emailVerified: true,
          lifecycleStatus: true,
          membershipVersion: true,
          membershipChangedAt: true,
          createdAt: true,
        },
      });

      const permittedSessionTargets = members.filter((member) => {
        if (actor.role === 'MEMBER') return false;
        if (actor.id === member.id) return true;
        if (actor.role === 'OWNER') return member.role !== 'OWNER';
        return member.role === 'MEMBER';
      });
      const sessionCounts = permittedSessionTargets.length === 0
        ? []
        : await tx.authSession.groupBy({
            by: ['userId'],
            where: {
              userId: { in: permittedSessionTargets.map((member) => member.id) },
              revokedAt: null,
              expiresAt: { gt: new Date() },
            },
            _count: { _all: true },
          });
      const sessionCountByUser = new Map(
        sessionCounts.map((entry) => [entry.userId, entry._count._all]),
      );

      const includeInvites = actor.role === 'OWNER' || actor.role === 'ADMIN';
      const invites = includeInvites
        ? await tx.teamInvite.findMany({
            where: { organisationId },
            include: {
              invitedBy: { select: { name: true } },
            },
            orderBy: { createdAt: 'desc' },
          })
        : [];

      const permittedSessionTargetIds = new Set(permittedSessionTargets.map((member) => member.id));
      return {
        members: members.map((member) => {
          const response = {
            ...member,
            lifecycleStatus: member.lifecycleStatus ?? 'ACTIVE',
            membershipVersion: member.membershipVersion ?? 1,
            membershipChangedAt: (member.membershipChangedAt ?? member.createdAt).toISOString(),
            createdAt: member.createdAt.toISOString(),
          };
          return permittedSessionTargetIds.has(member.id)
            ? { ...response, activeSessionCount: sessionCountByUser.get(member.id) ?? 0 }
            : response;
        }),
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
    });
  }

  async invite(
    organisationId: string,
    invitedById: string,
    invitedByRole: UserRole,
    data: InviteTeamMemberData,
  ) {
    ensureCanInvite(invitedByRole, data.role);

    const email = normalizeEmail(data.email);
    const inviteToken = crypto.randomBytes(32).toString('base64url');
    const manualInviteUrl = isPersonalServerDeployment()
      ? personalServerManualInviteUrl(inviteToken)
      : null;
    if (isPersonalServerDeployment() && !manualInviteUrl) {
      throw new AppError(
        500,
        'PERSONAL_SERVER_ORIGIN_INVALID',
        'Personal server invite origin is not configured safely',
      );
    }
    const client = this.prisma as unknown as TeamInviteClient;
    let inviteEmailPayload: { organisationName: string; inviterName: string } | null;
    try {
      const runInvite = async (tx: TeamInviteClient) => {
        if (tx.$queryRaw) {
          const organisations = await tx.$queryRaw<Array<{ id: string; lifecycleStatus?: string }>>`
            SELECT "id", "lifecycleStatus"
            FROM "Organisation"
            WHERE "id" = ${organisationId}
            FOR UPDATE
          `;
          if (organisations.length === 0) {
            throw new AppError(404, 'ORGANISATION_NOT_FOUND', 'Organisation not found');
          }
          if (
            organisations[0].lifecycleStatus !== undefined &&
            organisations[0].lifecycleStatus !== 'ACTIVE'
          ) {
            throw new AppError(409, 'ORGANISATION_INACTIVE', 'This organisation is not active');
          }
        }
        const now = new Date();
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

        if (
          !foundInviter ||
          (foundInviter.organisationId !== undefined && foundInviter.organisationId !== organisationId) ||
          (foundInviter.lifecycleStatus !== undefined && foundInviter.lifecycleStatus !== 'ACTIVE')
        ) {
          throw new AppError(403, 'FORBIDDEN', 'Your membership cannot create invitations');
        }
        ensureCanInvite(foundInviter.role ?? invitedByRole, data.role);

        if (foundExistingUser || existingInvite) {
          return null;
        }

        await this.assertCanAddTeamMember(tx, organisationId, now, true);

        const expiresAt = new Date(now);
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
      if (manualInviteUrl) {
        return { message: PERSONAL_SERVER_INVITE_CREATED_MESSAGE, manualInviteUrl };
      }

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

  async revoke(
    organisationId: string,
    inviteId: string,
    actorId: string,
    actorRole: UserRole,
    reason: string,
    requestId?: string,
  ) {
    ensureCanInvite(actorRole);

    return this.prisma.$transaction(async (tx) => {
      const organisations = await tx.$queryRaw<Array<{ id: string; lifecycleStatus: string }>>`
        SELECT "id", "lifecycleStatus"
        FROM "Organisation"
        WHERE "id" = ${organisationId}
        FOR UPDATE
      `;
      if (!organisations[0] || organisations[0].lifecycleStatus !== 'ACTIVE') {
        throw new AppError(409, 'ORGANISATION_INACTIVE', 'This organisation is not active');
      }

      const actors = await tx.$queryRaw<Array<{
        id: string;
        name: string;
        role: UserRole;
        lifecycleStatus: string;
      }>>`
        SELECT "id", "name", "role", "lifecycleStatus"
        FROM "User"
        WHERE "id" = ${actorId}
          AND "organisationId" = ${organisationId}
        FOR UPDATE
      `;
      const actor = actors[0];
      if (!actor || actor.lifecycleStatus !== 'ACTIVE') {
        throw new AppError(403, 'FORBIDDEN', 'Your membership cannot revoke invitations');
      }
      ensureCanInvite(actor.role);

      const invites = await tx.$queryRaw<Array<{
        id: string;
        email: string;
        role: UserRole;
        acceptedAt: Date | null;
        revokedAt: Date | null;
      }>>`
        SELECT "id", "email", "role", "acceptedAt", "revokedAt"
        FROM "TeamInvite"
        WHERE "id" = ${inviteId}
          AND "organisationId" = ${organisationId}
        FOR UPDATE
      `;
      const invite = invites[0];
      if (!invite) throw new AppError(404, 'INVITE_NOT_FOUND', 'Invite not found');
      if (invite.acceptedAt) {
        throw new AppError(400, 'INVITE_ACCEPTED', 'Accepted invites cannot be revoked');
      }
      if (invite.revokedAt) {
        throw new AppError(409, 'INVITE_ALREADY_REVOKED', 'This invite has already been revoked');
      }

      const now = new Date();
      const revoked = await tx.teamInvite.updateMany({
        where: {
          id: invite.id,
          organisationId,
          acceptedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: now },
      });
      if (revoked.count !== 1) {
        throw new AppError(409, 'INVITE_STATE_CONFLICT', 'This invite changed while it was being revoked');
      }
      await tx.securityAuditEvent.create({
        data: {
          organisationId,
          type: 'INVITE_REVOKED',
          actorKind: 'USER',
          actorUserId: actor.id,
          actorLabel: actor.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 160).trim() || 'CharityPilot user',
          subjectLabel: `Invitation for ${invite.email}`
            .replace(/[\u0000-\u001f\u007f]/g, ' ')
            .trim()
            .slice(0, 160)
            .trim(),
          reason,
          requestId: requestId?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 128).trim() || undefined,
          context: {
            inviteId: invite.id,
            invitedRole: invite.role,
          },
        },
      });

      return { id: invite.id, revokedAt: now.toISOString() };
    });
  }

  async acceptInvite(data: AcceptTeamInviteData) {
    const token = hashOpaqueToken(data.token);
    const preflightNow = new Date();
    const invite = await this.prisma.teamInvite.findUnique({
      where: { token },
    });

    if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt <= preflightNow) {
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

    let accepted: {
      tokens: { accessToken: string; refreshToken: string };
      user: {
      id: string;
      email: string;
      name: string;
      role: UserRole;
      emailVerified: boolean;
      organisationId: string;
      organisation: PublicOrganisationSource;
      };
    };
    try {
      accepted = await client.$transaction(async (tx) => {
        // Bcrypt intentionally happens before this authoritative clock read so
        // an invitation expiring during hashing cannot still be consumed.
        const capacityNow = new Date();
        await this.assertCanAddTeamMember(tx, invite.organisationId, capacityNow, false);
        const acceptanceNow = new Date();

        const consumed = await tx.teamInvite.updateMany({
          where: {
            id: invite.id,
            token,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: acceptanceNow },
          },
          data: { acceptedAt: acceptanceNow },
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

        const tokens = await issueSessionTokensInTransaction(
          tx as unknown as Prisma.TransactionClient,
          created,
        );

        return { user: created, tokens };
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw invalidInviteError();
      }

      if (
        err instanceof AppError &&
        [
          'ORGANISATION_NOT_FOUND',
          'ORGANISATION_INACTIVE',
          'NO_SUBSCRIPTION',
          'SUBSCRIPTION_INACTIVE',
          'TEAM_MEMBER_LIMIT_EXCEEDED',
        ].includes(err.code)
      ) {
        throw invalidInviteError();
      }

      throw err;
    }

    return { user: accepted.user, ...accepted.tokens };
  }
}
