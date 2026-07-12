import {
  Prisma,
  type AuthSessionRevocationReason,
  type PrismaClient,
  type SecurityAuditEventType,
  type UserLifecycleStatus,
  type UserRole,
} from '@prisma/client';
import crypto from 'node:crypto';
import { AppError } from '../utils/errors.js';
import { hasSubscriptionAccess } from '../utils/subscription-access.js';
import { assertBillingAuthorityAllowsOwnershipChange } from './billing-authority-interlock.js';
import { assertAuthRecoveryControlForCurrentSecret } from './auth-recovery-control.js';

type TransactionClient = Prisma.TransactionClient;

type LockedOrganisation = {
  id: string;
  lifecycleStatus: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
};

type LockedUser = {
  id: string;
  organisationId: string;
  email: string;
  name: string;
  role: UserRole;
  lifecycleStatus: UserLifecycleStatus;
  membershipVersion: number;
  membershipChangedAt: Date;
  emailVerified: boolean;
  createdAt: Date;
};

type LockedSubscription = {
  plan: 'ESSENTIALS' | 'COMPLETE';
  status: string;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
};

type MutationContext = {
  organisationId: string;
  actorId: string;
  targetUserId: string;
  expectedMembershipVersion: number;
  reason: string;
  requestId?: string;
};

type AuditInput = {
  type: SecurityAuditEventType;
  actor: LockedUser;
  subjectLabel: string;
  subjectUserId?: string;
  subjectSessionId?: string;
  reason: string;
  requestId?: string;
  context?: Record<string, unknown>;
};

const TEAM_MEMBER_LIMITS = {
  ESSENTIALS: 5,
  COMPLETE: null,
} as const;
const SERIALIZABLE_RETRY_LIMIT = 3;
const SESSION_FAMILY_LIST_LIMIT = 50;

type SessionFamilySummaryRow = {
  familyId: string;
  familyCreatedAt: Date;
  latestCreatedAt: Date;
  expiresAt: Date;
  deviceLabel: string | null;
  active: boolean;
  current: boolean;
  revokedAt: Date | null;
  revocationReason: AuthSessionRevocationReason | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sessionDisplaySuffix(familyId: string): string {
  return crypto.createHash('sha256').update(familyId).digest('hex').slice(0, 6).toUpperCase();
}

function stableIds(...ids: string[]): string[] {
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}

function cleanEvidence(value: string, maxLength: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength).trim();
}

function publicSecurityAuditType(event: {
  type: SecurityAuditEventType;
  actorKind: string;
  context: Prisma.JsonValue | null;
}): SecurityAuditEventType | 'PASSWORD_RESET_COMPLETED' {
  const context = event.context;
  if (
    event.type !== 'ALL_SESSIONS_REVOKED' ||
    !context ||
    Array.isArray(context) ||
    typeof context !== 'object' ||
    context.eventKind !== 'PASSWORD_RESET_COMPLETED'
  ) {
    return event.type;
  }

  const trustedSelfService =
    event.actorKind === 'SYSTEM' && context.method === 'PASSWORD_RECOVERY_LINK';
  const trustedPersonalServer =
    event.actorKind === 'SUPPORT' && context.method === 'PERSONAL_SERVER_OPERATOR';
  return trustedSelfService || trustedPersonalServer
    ? 'PASSWORD_RESET_COMPLETED'
    : event.type;
}

function actorLabel(actor: LockedUser): string {
  return cleanEvidence(actor.name, 160) || cleanEvidence(actor.email, 160) || 'CharityPilot user';
}

function subjectLabel(subject: LockedUser): string {
  return cleanEvidence(subject.name, 160) || cleanEvidence(subject.email, 160) || 'Team member';
}

function isRetryableTransactionConflict(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === 'P2034',
  );
}

function requestEvidence(requestId?: string): string | undefined {
  if (!requestId) return undefined;
  return cleanEvidence(requestId, 128) || undefined;
}

function memberResponse(user: LockedUser, activeSessionCount?: number) {
  const response = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    emailVerified: user.emailVerified,
    lifecycleStatus: user.lifecycleStatus,
    membershipVersion: user.membershipVersion,
    membershipChangedAt: user.membershipChangedAt.toISOString(),
    createdAt: user.createdAt.toISOString(),
  };
  return activeSessionCount === undefined
    ? response
    : { ...response, activeSessionCount };
}

function assertExpectedVersion(user: LockedUser, expected: number): void {
  if (user.membershipVersion !== expected) {
    throw new AppError(
      409,
      'MEMBERSHIP_VERSION_CONFLICT',
      'This membership changed while you were reviewing it. Refresh and try again.',
      { currentMembershipVersion: user.membershipVersion },
    );
  }
}

function assertActiveActor(actor: LockedUser): void {
  if (actor.lifecycleStatus !== 'ACTIVE') {
    throw new AppError(403, 'FORBIDDEN', 'Your membership is not active');
  }
}

function assertCanManageMember(actor: LockedUser, target: LockedUser): void {
  assertActiveActor(actor);
  if (actor.id === target.id) {
    throw new AppError(400, 'CANNOT_MANAGE_SELF', 'Use the account security controls for your own membership');
  }
  if (target.role === 'OWNER') {
    throw new AppError(409, 'OWNER_CONTINUITY_REQUIRED', 'Transfer ownership before changing the owner membership');
  }
  if (actor.role === 'OWNER') return;
  if (actor.role === 'ADMIN' && target.role === 'MEMBER') return;
  throw new AppError(403, 'FORBIDDEN', 'Your role cannot manage this team member');
}

function assertCanInspectSessions(actor: LockedUser, target: LockedUser): void {
  assertActiveActor(actor);
  if (actor.id === target.id) return;
  if (actor.role === 'OWNER' && target.role !== 'OWNER') return;
  if (actor.role === 'ADMIN' && target.role === 'MEMBER') return;
  throw new AppError(403, 'FORBIDDEN', 'Your role cannot manage these sessions');
}

async function lockOrganisation(tx: TransactionClient, organisationId: string): Promise<LockedOrganisation> {
  const rows = await tx.$queryRaw<LockedOrganisation[]>`
    SELECT "id", "lifecycleStatus"
    FROM "Organisation"
    WHERE "id" = ${organisationId}
    FOR UPDATE
  `;
  const organisation = rows[0];
  if (!organisation) throw new AppError(404, 'ORGANISATION_NOT_FOUND', 'Organisation not found');
  if (organisation.lifecycleStatus !== 'ACTIVE') {
    throw new AppError(409, 'ORGANISATION_INACTIVE', 'This organisation is not active');
  }
  return organisation;
}

async function lockSubscription(
  tx: TransactionClient,
  organisationId: string,
): Promise<LockedSubscription | null> {
  const rows = await tx.$queryRaw<LockedSubscription[]>`
    SELECT "plan", "status", "trialEndsAt", "currentPeriodEnd"
    FROM "Subscription"
    WHERE "organisationId" = ${organisationId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function lockUsers(
  tx: TransactionClient,
  organisationId: string,
  userIds: string[],
): Promise<Map<string, LockedUser>> {
  const ids = stableIds(...userIds);
  if (ids.length === 0) return new Map();
  const rows = await tx.$queryRaw<LockedUser[]>(Prisma.sql`
    SELECT
      "id", "organisationId", "email", "name", "role", "lifecycleStatus",
      "membershipVersion", "membershipChangedAt", "emailVerified", "createdAt"
    FROM "User"
    WHERE "organisationId" = ${organisationId}
      AND "id" IN (${Prisma.join(ids)})
    ORDER BY "id"
    FOR UPDATE
  `);
  return new Map(rows.map((row) => [row.id, row]));
}

function requireActorAndTarget(
  users: Map<string, LockedUser>,
  actorId: string,
  targetUserId: string,
): { actor: LockedUser; target: LockedUser } {
  const actor = users.get(actorId);
  if (!actor) throw new AppError(403, 'FORBIDDEN', 'Your membership is unavailable');
  const target = users.get(targetUserId);
  if (!target) throw new AppError(404, 'MEMBER_NOT_FOUND', 'Team member not found');
  return { actor, target };
}

async function appendAudit(tx: TransactionClient, input: AuditInput): Promise<void> {
  await tx.securityAuditEvent.create({
    data: {
      organisationId: input.actor.organisationId,
      type: input.type,
      actorKind: 'USER',
      actorUserId: input.actor.id,
      actorLabel: actorLabel(input.actor),
      subjectLabel: input.subjectLabel,
      subjectUserId: input.subjectUserId,
      subjectSessionId: input.subjectSessionId,
      reason: input.reason,
      requestId: requestEvidence(input.requestId),
      context: input.context as Prisma.InputJsonValue | undefined,
    },
  });
}

async function cancelReservedReminders(
  tx: TransactionClient,
  organisationId: string,
  userId: string,
  explanation: string,
): Promise<number> {
  const cancelled = await tx.deadlineReminderLog.updateMany({
    where: {
      organisationId,
      userId,
      status: 'RESERVED',
    },
    data: {
      status: 'SKIPPED',
      error: explanation,
      attemptedAt: null,
      sentAt: null,
    },
  });
  return cancelled.count;
}

async function revokeActiveSessions(
  tx: TransactionClient,
  userId: string,
  reason: AuthSessionRevocationReason,
  now: Date,
): Promise<number> {
  const revoked = await tx.authSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: now, revocationReason: reason },
  });
  return revoked.count;
}

export class TeamLifecycleService {
  constructor(private prisma: PrismaClient) {}

  private async transitionToInactive(
    input: MutationContext,
    nextStatus: 'SUSPENDED' | 'REMOVED',
  ) {
    return this.prisma.$transaction(async (tx) => {
      await assertAuthRecoveryControlForCurrentSecret(tx);
      await lockOrganisation(tx, input.organisationId);
      const users = await lockUsers(tx, input.organisationId, [input.actorId, input.targetUserId]);
      const { actor, target } = requireActorAndTarget(users, input.actorId, input.targetUserId);
      assertCanManageMember(actor, target);
      assertExpectedVersion(target, input.expectedMembershipVersion);

      if (nextStatus === 'SUSPENDED' && target.lifecycleStatus !== 'ACTIVE') {
        throw new AppError(409, 'MEMBERSHIP_STATE_CONFLICT', 'Only an active membership can be suspended');
      }
      if (nextStatus === 'REMOVED' && target.lifecycleStatus === 'REMOVED') {
        throw new AppError(409, 'MEMBERSHIP_STATE_CONFLICT', 'This membership has already been removed');
      }

      const now = new Date();
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "PasswordRecoveryRequest"
        WHERE "userId" = ${target.id}
          AND "organisationId" = ${input.organisationId}
          AND "terminatedAt" IS NULL
        ORDER BY "id"
        FOR UPDATE
      `;
      const updated = await tx.user.update({
        where: { id: target.id },
        data: {
          lifecycleStatus: nextStatus,
          verifyToken: null,
          verifyTokenExpiry: null,
        },
      });
      const terminatedRecoveryRequests = await tx.passwordRecoveryRequest.updateMany({
        where: {
          userId: target.id,
          organisationId: input.organisationId,
          terminatedAt: null,
        },
        data: {
          terminatedAt: now,
          terminationReason: 'ACCOUNT_INACTIVE',
          nextDeliveryAttemptAt: null,
        },
      });
      const sessionCount = await revokeActiveSessions(
        tx,
        target.id,
        nextStatus === 'SUSPENDED' ? 'MEMBER_SUSPENDED' : 'MEMBER_REMOVED',
        now,
      );
      const reminderCount = await cancelReservedReminders(
        tx,
        input.organisationId,
        target.id,
        nextStatus === 'SUSPENDED'
          ? 'Recipient membership was suspended before reminder delivery'
          : 'Recipient membership was removed before reminder delivery',
      );

      await appendAudit(tx, {
        type: nextStatus === 'SUSPENDED' ? 'MEMBER_SUSPENDED' : 'MEMBER_REMOVED',
        actor,
        subjectLabel: subjectLabel(target),
        subjectUserId: target.id,
        reason: input.reason,
        requestId: input.requestId,
        context: {
          previousLifecycleStatus: target.lifecycleStatus,
          lifecycleStatus: nextStatus,
          previousMembershipVersion: target.membershipVersion,
          terminatedRecoveryRequestCount: terminatedRecoveryRequests.count,
          revokedSessionCount: sessionCount,
          skippedReminderCount: reminderCount,
        },
      });

      return memberResponse(updated, 0);
    });
  }

  suspendMember(input: MutationContext) {
    return this.transitionToInactive(input, 'SUSPENDED');
  }

  removeMember(input: MutationContext) {
    return this.transitionToInactive(input, 'REMOVED');
  }

  async changeMemberRole(input: MutationContext & { role: UserRole }) {
    return this.prisma.$transaction(async (tx) => {
      await lockOrganisation(tx, input.organisationId);
      const users = await lockUsers(tx, input.organisationId, [input.actorId, input.targetUserId]);
      const { actor, target } = requireActorAndTarget(users, input.actorId, input.targetUserId);
      assertActiveActor(actor);
      if (actor.role !== 'OWNER') {
        throw new AppError(403, 'FORBIDDEN', 'Only the current owner can change team member roles');
      }
      if (actor.id === target.id) {
        throw new AppError(400, 'CANNOT_CHANGE_OWN_ROLE', 'Transfer ownership to change the owner role');
      }
      if (target.role === 'OWNER' || input.role === 'OWNER') {
        throw new AppError(409, 'OWNER_CONTINUITY_REQUIRED', 'Use the ownership transfer workflow');
      }
      if (target.lifecycleStatus !== 'ACTIVE') {
        throw new AppError(409, 'MEMBERSHIP_STATE_CONFLICT', 'Reactivate this membership before changing its role');
      }
      assertExpectedVersion(target, input.expectedMembershipVersion);
      if (target.role === input.role) return memberResponse(target);

      const updated = await tx.user.update({
        where: { id: target.id },
        data: { role: input.role },
      });
      await appendAudit(tx, {
        type: 'MEMBER_ROLE_CHANGED',
        actor,
        subjectLabel: subjectLabel(target),
        subjectUserId: target.id,
        reason: input.reason,
        requestId: input.requestId,
        context: {
          previousRole: target.role,
          role: input.role,
          previousMembershipVersion: target.membershipVersion,
        },
      });
      return memberResponse(updated);
    });
  }

  async reactivateMember(input: MutationContext) {
    return this.prisma.$transaction(async (tx) => {
      await lockOrganisation(tx, input.organisationId);
      const subscription = await lockSubscription(tx, input.organisationId);
      const now = new Date();
      if (!subscription || !hasSubscriptionAccess(subscription, now)) {
        throw new AppError(
          403,
          'SUBSCRIPTION_INACTIVE',
          'Reactivate the subscription before restoring a team membership',
        );
      }

      const users = await lockUsers(tx, input.organisationId, [input.actorId, input.targetUserId]);
      const { actor, target } = requireActorAndTarget(users, input.actorId, input.targetUserId);
      assertCanManageMember(actor, target);
      assertExpectedVersion(target, input.expectedMembershipVersion);
      if (target.lifecycleStatus !== 'SUSPENDED') {
        throw new AppError(409, 'MEMBERSHIP_STATE_CONFLICT', 'Only a suspended membership can be reactivated');
      }

      const limit = TEAM_MEMBER_LIMITS[subscription.plan];
      if (limit !== null) {
        const [activeMembers, pendingInvites] = await Promise.all([
          tx.user.count({
            where: { organisationId: input.organisationId, lifecycleStatus: 'ACTIVE' },
          }),
          tx.teamInvite.count({
            where: {
              organisationId: input.organisationId,
              acceptedAt: null,
              revokedAt: null,
              expiresAt: { gt: now },
            },
          }),
        ]);
        if (activeMembers + pendingInvites >= limit) {
          throw new AppError(
            409,
            'TEAM_MEMBER_LIMIT_EXCEEDED',
            'No team place is currently available for this reactivation',
            { limit, activeMembers, pendingInvites },
          );
        }
      }

      const updated = await tx.user.update({
        where: { id: target.id },
        data: { lifecycleStatus: 'ACTIVE' },
      });
      await appendAudit(tx, {
        type: 'MEMBER_REACTIVATED',
        actor,
        subjectLabel: subjectLabel(target),
        subjectUserId: target.id,
        reason: input.reason,
        requestId: input.requestId,
        context: {
          previousLifecycleStatus: target.lifecycleStatus,
          lifecycleStatus: 'ACTIVE',
          previousMembershipVersion: target.membershipVersion,
          restoredSessions: 0,
        },
      });
      return memberResponse(updated, 0);
    });
  }

  async transferOwnership(input: {
    organisationId: string;
    actorId: string;
    targetMemberId: string;
    expectedCurrentOwnerVersion: number;
    expectedTargetVersion: number;
    reason: string;
    requestId?: string;
  }) {
    for (let attempt = 0; attempt < SERIALIZABLE_RETRY_LIMIT; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          await lockOrganisation(tx, input.organisationId);
          const billingAuthority = await assertBillingAuthorityAllowsOwnershipChange(
            tx,
            input.organisationId,
          );
          const users = await lockUsers(tx, input.organisationId, [input.actorId, input.targetMemberId]);
          const { actor, target } = requireActorAndTarget(users, input.actorId, input.targetMemberId);
          assertActiveActor(actor);
          if (actor.role !== 'OWNER') {
            throw new AppError(403, 'FORBIDDEN', 'Only the current owner can transfer ownership');
          }
          if (actor.id === target.id) {
            throw new AppError(400, 'OWNERSHIP_TARGET_INVALID', 'Choose another active team member');
          }
          assertExpectedVersion(actor, input.expectedCurrentOwnerVersion);
          assertExpectedVersion(target, input.expectedTargetVersion);
          if (target.lifecycleStatus !== 'ACTIVE' || !target.emailVerified) {
            throw new AppError(409, 'OWNERSHIP_TARGET_INVALID', 'The new owner must be active and email verified');
          }
          if (target.role === 'OWNER') {
            throw new AppError(409, 'OWNERSHIP_STATE_CONFLICT', 'This person is already the owner');
          }

          // Demote first because the immediate partial unique index forbids a
          // transient second owner; the deferred continuity trigger permits the
          // temporary zero-owner state until this transaction commits.
          const previousOwner = await tx.user.update({
            where: { id: actor.id },
            data: { role: 'ADMIN' },
          });
          const newOwner = await tx.user.update({
            where: { id: target.id },
            data: { role: 'OWNER' },
          });
          const now = new Date();
          const previousOwnerSessions = await revokeActiveSessions(tx, actor.id, 'OWNERSHIP_CHANGED', now);
          const newOwnerSessions = await revokeActiveSessions(tx, target.id, 'OWNERSHIP_CHANGED', now);
          const reminderCount = await cancelReservedReminders(
            tx,
            input.organisationId,
            actor.id,
            'Recipient ownership changed before reminder delivery',
          );

          await appendAudit(tx, {
            type: 'OWNERSHIP_TRANSFERRED',
            actor,
            subjectLabel: subjectLabel(target),
            subjectUserId: target.id,
            reason: input.reason,
            requestId: input.requestId,
            context: {
              previousOwnerId: actor.id,
              previousOwnerRole: actor.role,
              previousOwnerNewRole: 'ADMIN',
              targetPreviousRole: target.role,
              previousOwnerMembershipVersion: actor.membershipVersion,
              targetMembershipVersion: target.membershipVersion,
              previousOwnerRevokedSessionCount: previousOwnerSessions,
              newOwnerRevokedSessionCount: newOwnerSessions,
              skippedReminderCount: reminderCount,
              billingAuthorityAutoReleasedGrantId: billingAuthority.autoReleasedGrantId,
            },
          });

          return {
            previousOwner: memberResponse(previousOwner, 0),
            newOwner: memberResponse(newOwner, 0),
          };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (!isRetryableTransactionConflict(error)) throw error;
        if (attempt === SERIALIZABLE_RETRY_LIMIT - 1) {
          throw new AppError(
            409,
            'OWNERSHIP_WRITE_CONFLICT',
            'Team ownership changed concurrently. Refresh and try again.',
          );
        }
      }
    }

    throw new AppError(409, 'OWNERSHIP_WRITE_CONFLICT', 'Team ownership could not be updated. Try again.');
  }

  async listSessions(input: {
    organisationId: string;
    actorId: string;
    targetUserId: string;
    currentSessionId?: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await lockOrganisation(tx, input.organisationId);
      const users = await lockUsers(tx, input.organisationId, [input.actorId, input.targetUserId]);
      const locked = requireActorAndTarget(users, input.actorId, input.targetUserId);
      assertCanInspectSessions(locked.actor, locked.target);
      const currentSessionId = input.currentSessionId ?? '';
      const families = await tx.$queryRaw<SessionFamilySummaryRow[]>`
        WITH current_family AS MATERIALIZED (
          SELECT session."familyId", session."familyCreatedAt"
          FROM "AuthSession" AS session
          WHERE session."userId" = ${locked.target.id}
            AND session."id" = ${currentSessionId}
          LIMIT 1
        ),
        recent_families AS MATERIALIZED (
          SELECT DISTINCT session."familyId", session."familyCreatedAt"
          FROM "AuthSession" AS session
          WHERE session."userId" = ${locked.target.id}
            AND NOT EXISTS (
              SELECT 1
              FROM current_family
              WHERE current_family."familyId" = session."familyId"
            )
          ORDER BY session."familyCreatedAt" DESC, session."familyId" DESC
          LIMIT ${SESSION_FAMILY_LIST_LIMIT}
        ),
        selected_families AS MATERIALIZED (
          SELECT candidate."familyId", candidate."familyCreatedAt", candidate."current"
          FROM (
            SELECT
              current_family."familyId",
              current_family."familyCreatedAt",
              TRUE AS "current"
            FROM current_family
            UNION ALL
            SELECT
              recent_families."familyId",
              recent_families."familyCreatedAt",
              FALSE AS "current"
            FROM recent_families
          ) AS candidate
          ORDER BY
            candidate."current" DESC,
            candidate."familyCreatedAt" DESC,
            candidate."familyId" DESC
          LIMIT ${SESSION_FAMILY_LIST_LIMIT}
        )
        SELECT
          selected_families."familyId",
          selected_families."familyCreatedAt",
          latest."createdAt" AS "latestCreatedAt",
          COALESCE(active."expiresAt", latest."expiresAt") AS "expiresAt",
          latest."deviceLabel",
          active."expiresAt" IS NOT NULL AS "active",
          selected_families."current",
          CASE WHEN active."expiresAt" IS NULL THEN latest."revokedAt" ELSE NULL END AS "revokedAt",
          CASE
            WHEN active."expiresAt" IS NULL THEN latest."revocationReason"
            ELSE NULL
          END AS "revocationReason"
        FROM selected_families
        CROSS JOIN LATERAL (
          SELECT
            session."deviceLabel",
            session."expiresAt",
            session."revokedAt",
            session."revocationReason",
            session."createdAt"
          FROM "AuthSession" AS session
          WHERE session."userId" = ${locked.target.id}
            AND session."familyId" = selected_families."familyId"
          ORDER BY session."createdAt" DESC, session."id" DESC
          LIMIT 1
        ) AS latest
        LEFT JOIN LATERAL (
          SELECT session."expiresAt"
          FROM "AuthSession" AS session
          WHERE session."userId" = ${locked.target.id}
            AND session."familyId" = selected_families."familyId"
            AND session."revokedAt" IS NULL
            AND session."expiresAt" > CURRENT_TIMESTAMP
          LIMIT 1
        ) AS active ON TRUE
        ORDER BY
          selected_families."familyCreatedAt" DESC,
          selected_families."familyId" DESC
      `;

      return families.map((family) => {
        return {
          familyId: family.familyId,
          displaySuffix: sessionDisplaySuffix(family.familyId),
          familyCreatedAt: family.familyCreatedAt.toISOString(),
          latestCreatedAt: family.latestCreatedAt.toISOString(),
          expiresAt: family.expiresAt.toISOString(),
          deviceLabel: family.deviceLabel,
          active: family.active,
          current: family.current,
          revokedAt: family.revokedAt?.toISOString() ?? null,
          revocationReason: family.revocationReason,
        };
      });
    });
  }

  async revokeSessionFamily(input: MutationContext & { familyId: string; currentSessionId?: string }) {
    if (!UUID_PATTERN.test(input.familyId)) {
      throw new AppError(404, 'SESSION_NOT_FOUND', 'Session not found');
    }
    return this.prisma.$transaction(async (tx) => {
      await lockOrganisation(tx, input.organisationId);
      const users = await lockUsers(tx, input.organisationId, [input.actorId, input.targetUserId]);
      const { actor, target } = requireActorAndTarget(users, input.actorId, input.targetUserId);
      assertCanInspectSessions(actor, target);
      assertExpectedVersion(target, input.expectedMembershipVersion);

      const family = await tx.$queryRaw<Array<{ id: string; revokedAt: Date | null }>>`
        SELECT "id", "revokedAt"
        FROM "AuthSession"
        WHERE "userId" = ${target.id}
          AND "familyId" = ${input.familyId}::uuid
        ORDER BY "id"
        FOR UPDATE
      `;
      if (family.length === 0) throw new AppError(404, 'SESSION_NOT_FOUND', 'Session not found');
      const revokedCurrentSession = Boolean(
        input.currentSessionId && family.some((session) => session.id === input.currentSessionId),
      );

      const now = new Date();
      const revoked = await tx.authSession.updateMany({
        where: { userId: target.id, familyId: input.familyId, revokedAt: null },
        data: {
          revokedAt: now,
          revocationReason: actor.id === target.id
            ? 'USER_SESSION_REVOKED'
            : 'ADMIN_SESSION_REVOKED',
        },
      });
      if (revoked.count === 0) {
        throw new AppError(409, 'SESSION_ALREADY_REVOKED', 'This session is already revoked');
      }

      await appendAudit(tx, {
        type: 'SESSION_REVOKED',
        actor,
        subjectLabel: subjectLabel(target),
        subjectUserId: target.id,
        subjectSessionId: input.familyId,
        reason: input.reason,
        requestId: input.requestId,
        context: {
          scope: 'SESSION_FAMILY',
          initiatedBy: actor.id === target.id ? 'SELF' : 'ADMINISTRATOR',
          revokedSessionCount: revoked.count,
        },
      });
      return { familyId: input.familyId, revokedSessionCount: revoked.count, revokedCurrentSession };
    });
  }

  async revokeAllSessions(input: MutationContext) {
    return this.prisma.$transaction(async (tx) => {
      await lockOrganisation(tx, input.organisationId);
      const users = await lockUsers(tx, input.organisationId, [input.actorId, input.targetUserId]);
      const { actor, target } = requireActorAndTarget(users, input.actorId, input.targetUserId);
      assertCanInspectSessions(actor, target);
      assertExpectedVersion(target, input.expectedMembershipVersion);

      const now = new Date();
      const revokedSessionCount = await revokeActiveSessions(
        tx,
        target.id,
        actor.id === target.id
          ? 'USER_ALL_SESSIONS_REVOKED'
          : 'ADMIN_ALL_SESSIONS_REVOKED',
        now,
      );
      if (revokedSessionCount === 0) {
        throw new AppError(409, 'NO_ACTIVE_SESSIONS', 'This member has no active sessions');
      }
      await appendAudit(tx, {
        type: 'ALL_SESSIONS_REVOKED',
        actor,
        subjectLabel: subjectLabel(target),
        subjectUserId: target.id,
        reason: input.reason,
        requestId: input.requestId,
        context: {
          initiatedBy: actor.id === target.id ? 'SELF' : 'ADMINISTRATOR',
          revokedSessionCount,
        },
      });
      return { revokedSessionCount };
    });
  }

  async listSecurityAudit(organisationId: string, actorId: string) {
    return this.prisma.$transaction(async (tx) => {
      await lockOrganisation(tx, organisationId);
      const users = await lockUsers(tx, organisationId, [actorId]);
      const actor = users.get(actorId);
      if (
        !actor ||
        actor.lifecycleStatus !== 'ACTIVE' ||
        (actor.role !== 'OWNER' && actor.role !== 'ADMIN')
      ) {
        throw new AppError(403, 'FORBIDDEN', 'Your role cannot view the security audit');
      }

      const events = await tx.securityAuditEvent.findMany({
        where: { organisationId },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: 20,
        select: {
          type: true,
          actorKind: true,
          actorLabel: true,
          subjectLabel: true,
          reason: true,
          context: true,
          occurredAt: true,
        },
      });
      return events.map((event) => ({
        type: publicSecurityAuditType(event),
        actorLabel: event.actorLabel,
        subjectLabel: event.subjectLabel,
        reason: event.reason,
        occurredAt: event.occurredAt.toISOString(),
      }));
    });
  }
}
