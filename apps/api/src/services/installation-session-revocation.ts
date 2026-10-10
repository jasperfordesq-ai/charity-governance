import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';

/**
 * Exposure response for a signing-secret rotation. Rotating JWT_SECRET ends
 * access tokens only: a refresh token is an opaque value checked against its
 * stored hash, so every browser and connector session survives the rotation
 * and mints new access tokens under the new secret. When a rotation follows a
 * suspected exposure, every live session has to be revoked as well.
 *
 * `user` revokes every live charity session on the installation and records
 * one ALL_SESSIONS_REVOKED event per affected member in that charity's own
 * security log, so each charity can see what happened to its people. Operator
 * sessions (`operator`) have no charity log; their count is reported only.
 *
 * Without `confirm` nothing is written; the counts are what a confirmed run
 * would revoke. Sessions already revoked or expired are left as they are.
 */
export type SessionRevocationRealm = 'user' | 'operator' | 'all';

type Client = Pick<PrismaClient, '$transaction'>;

const ACTOR_LABEL = 'Installation operator';

function cleanEvidence(value: string, maxLength: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength).trim();
}

export function validateRevocationReason(raw: string): string {
  const reason = cleanEvidence(raw, 500);
  if (reason.length < 10 || reason !== raw.trim()) {
    throw new AppError(400, 'SESSION_REVOCATION_REASON_INVALID',
      'A plain reason of 10 to 500 characters is required; it is recorded in every affected charity\'s log');
  }
  return reason;
}

export async function revokeInstallationSessions(prisma: Client, input: {
  realm: SessionRevocationRealm;
  reason: string;
  confirm: boolean;
  now?: Date;
}) {
  const reason = validateRevocationReason(input.reason);
  const now = input.now ?? new Date();
  const users = input.realm !== 'operator';
  const operators = input.realm !== 'user';
  return prisma.$transaction(async (tx) => {
    const live = { revokedAt: null, expiresAt: { gt: now } };
    let userSessions = 0;
    let operatorSessions = 0;
    const charities = new Set<string>();
    let members = 0;
    if (users) {
      const sessions = input.confirm
        ? await tx.authSession.updateManyAndReturn({
          where: live,
          data: { revokedAt: now, revocationReason: 'INSTALLATION_SESSIONS_REVOKED' },
          select: { userId: true },
        })
        : await tx.authSession.findMany({ where: live, select: { userId: true } });
      userSessions = sessions.length;
      const perUser = new Map<string, number>();
      for (const { userId } of sessions) perUser.set(userId, (perUser.get(userId) ?? 0) + 1);
      const people = perUser.size === 0 ? [] : await tx.user.findMany({
        where: { id: { in: [...perUser.keys()] } },
        select: { id: true, organisationId: true, name: true, email: true },
        orderBy: { id: 'asc' },
      });
      members = people.length;
      for (const person of people) {
        charities.add(person.organisationId);
        if (!input.confirm) continue;
        await tx.securityAuditEvent.create({ data: {
          organisationId: person.organisationId,
          type: 'ALL_SESSIONS_REVOKED',
          actorKind: 'SYSTEM',
          actorLabel: ACTOR_LABEL,
          subjectUserId: person.id,
          subjectLabel: cleanEvidence(person.name, 160) || cleanEvidence(person.email, 160) || 'Team member',
          reason,
          context: { scope: 'INSTALLATION', revokedSessionCount: perUser.get(person.id) ?? 0 },
        } });
      }
    }
    if (operators) {
      operatorSessions = input.confirm
        ? (await tx.platformOperatorSession.updateMany({ where: live, data: { revokedAt: now } })).count
        : await tx.platformOperatorSession.count({ where: live });
    }
    return { confirmed: input.confirm, realm: input.realm, userSessions, members,
      charities: charities.size, operatorSessions, revokedAt: input.confirm ? now.toISOString() : null };
  });
}
