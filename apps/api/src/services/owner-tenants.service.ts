import { Prisma, type PrismaClient, type SecurityAuditEventType } from '@prisma/client';
import { AppError } from '../utils/errors.js';

// This file holds the ONLY unscoped Organisation reads in the codebase. No
// tenant-facing route may import it; see the sole-writer test in
// apps/api/src/tests/owner-sole-writer.test.ts.

export type TenantLifecycleStatus = 'ACTIVE' | 'SUSPENDED' | 'CLOSED';

export type TenantSummary = {
  id: string;
  name: string;
  lifecycleStatus: TenantLifecycleStatus;
  lifecycleVersion: number;
  plan: string | null;
  subscriptionStatus: string | null;
  trialEndsAt: Date | null;
  userCount: number;
  createdAt: Date;
};

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const tenantSelect = {
  id: true,
  name: true,
  rcnNumber: true,
  croNumber: true,
  lifecycleStatus: true,
  lifecycleVersion: true,
  createdAt: true,
  subscription: { select: { plan: true, status: true, trialEndsAt: true } },
  _count: { select: { users: true } },
} as const;

type TenantRow = {
  id: string;
  name: string;
  lifecycleStatus: TenantLifecycleStatus;
  lifecycleVersion: number;
  createdAt: Date;
  subscription: { plan: string; status: string; trialEndsAt: Date | null } | null;
  _count: { users: number };
};

function toSummary(row: TenantRow): TenantSummary {
  return {
    id: row.id,
    name: row.name,
    lifecycleStatus: row.lifecycleStatus,
    lifecycleVersion: row.lifecycleVersion,
    plan: row.subscription?.plan ?? null,
    subscriptionStatus: row.subscription?.status ?? null,
    trialEndsAt: row.subscription?.trialEndsAt ?? null,
    userCount: row._count.users,
    createdAt: row.createdAt,
  };
}

export async function listTenants(
  prisma: PrismaClient,
  query: { q?: string; status?: TenantLifecycleStatus; cursor?: string; limit?: number },
): Promise<{ tenants: TenantSummary[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  const where: Record<string, unknown> = {};
  if (query.status) where.lifecycleStatus = query.status;
  if (query.q) {
    const contains = { contains: query.q, mode: 'insensitive' as const };
    where.OR = [
      { name: contains },
      { rcnNumber: contains },
      { croNumber: contains },
      { users: { some: { email: contains, role: 'OWNER' } } },
    ];
  }

  const rows = (await prisma.organisation.findMany({
    where,
    select: tenantSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  })) as unknown as TenantRow[];

  return {
    tenants: rows.map(toSummary),
    nextCursor: rows.length === limit ? (rows[rows.length - 1]?.id ?? null) : null,
  };
}

export async function getTenant(prisma: PrismaClient, id: string): Promise<TenantSummary> {
  const row = (await prisma.organisation.findUnique({
    where: { id },
    select: tenantSelect,
  })) as unknown as TenantRow | null;

  if (!row) {
    throw new AppError(404, 'TENANT_NOT_FOUND', 'Organisation not found');
  }
  return toSummary(row);
}

export type TenantLifecycleAction = 'SUSPEND' | 'REACTIVATE' | 'CLOSE';

// CLOSED is deliberately terminal here. Leaving it is a deliberate shell
// operation, because that is where data-retention obligations begin.
const ALLOWED_TRANSITIONS: Record<TenantLifecycleAction, { from: TenantLifecycleStatus[]; to: TenantLifecycleStatus }> = {
  SUSPEND: { from: ['ACTIVE'], to: 'SUSPENDED' },
  REACTIVATE: { from: ['SUSPENDED'], to: 'ACTIVE' },
  CLOSE: { from: ['ACTIVE', 'SUSPENDED'], to: 'CLOSED' },
};

const AUDIT_TYPE = {
  SUSPEND: 'ORGANISATION_SUSPENDED',
  REACTIVATE: 'ORGANISATION_REACTIVATED',
  CLOSE: 'ORGANISATION_CLOSED',
} as const satisfies Record<TenantLifecycleAction, SecurityAuditEventType>;

export async function transitionTenantLifecycle(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    action: TenantLifecycleAction;
    reason: string;
    expectedLifecycleVersion: number;
    operator: { id: string; email: string };
  },
): Promise<TenantSummary> {
  const reason = input.reason.trim();
  if (!reason) {
    throw new AppError(400, 'REASON_REQUIRED', 'A reason is required for a lifecycle change');
  }

  return prisma.$transaction(async (tx) => {
    // Lock the row first, exactly as jobs/recover-team-ownership.ts does, so a
    // concurrent transition cannot interleave between the read and the write.
    const locked = (await tx.$queryRaw(
      Prisma.sql`SELECT "id", "lifecycleStatus", "lifecycleVersion" FROM "Organisation" WHERE "id" = ${input.tenantId} FOR UPDATE`,
    )) as { id: string; lifecycleStatus: TenantLifecycleStatus; lifecycleVersion: number }[];

    const current = locked[0];
    if (!current) {
      throw new AppError(404, 'TENANT_NOT_FOUND', 'Organisation not found');
    }

    if (current.lifecycleVersion !== input.expectedLifecycleVersion) {
      throw new AppError(
        409,
        'TENANT_LIFECYCLE_CONFLICT',
        'This organisation changed since you loaded it. Reload and try again.',
      );
    }

    const transition = ALLOWED_TRANSITIONS[input.action];
    if (!transition.from.includes(current.lifecycleStatus)) {
      throw new AppError(
        409,
        'TENANT_TRANSITION_NOT_ALLOWED',
        `Cannot ${input.action.toLowerCase()} an organisation that is ${current.lifecycleStatus}`,
      );
    }

    await tx.organisation.update({
      where: { id: input.tenantId },
      data: {
        lifecycleStatus: transition.to,
        lifecycleVersion: { increment: 1 },
        lifecycleChangedAt: new Date(),
      },
    });

    await tx.securityAuditEvent.create({
      data: {
        organisationId: input.tenantId,
        type: AUDIT_TYPE[input.action],
        actorKind: 'SUPPORT',
        actorUserId: null,
        actorLabel: input.operator.email,
        subjectLabel: `Organisation ${input.tenantId}`,
        reason,
        context: {
          operatorId: input.operator.id,
          previousStatus: current.lifecycleStatus,
          newStatus: transition.to,
          previousLifecycleVersion: current.lifecycleVersion,
        },
      },
    });

    const row = (await tx.organisation.findUnique({
      where: { id: input.tenantId },
      select: tenantSelect,
    })) as unknown as TenantRow;

    return toSummary(row);
  });
}
