import bcrypt from 'bcryptjs';
import type { PrismaClient } from '@prisma/client';

/**
 * Approvals for the operator realm.
 *
 * A near-twin of `action-approval.service.ts`, and deliberately so: the two
 * realms have different identity columns and nothing else different, and the
 * safest way to hold two security-critical paths in step is to make them read
 * the same. Where this differs from its twin, there is a comment saying why.
 *
 * The one structural difference is the identity. A charity approval is bound
 * to a user and an organisation; an operator belongs to neither. Sharing one
 * table would mean two nullable identity columns and a check constraint saying
 * exactly one is set — a branching invariant on the row that stands between an
 * agent and a closed charity.
 */

// Spent on an operator that does not exist, so a wrong password costs the same
// whether or not the account is real.
const DUMMY_PASSWORD_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

export interface PendingOperatorApproval {
  approvalId: string;
  summary: string;
  method: string;
  routePattern: string;
  resourceId: string | null;
  resourceLabel: string | null;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Every approval this operator has been asked for and has not yet granted.
 *
 * Read by the console, so an operator who is not at the terminal that asked
 * can still see what is waiting. Nothing here grants anything.
 */
export async function listPendingOperatorApprovals(
  prisma: PrismaClient,
  operatorId: string,
  now: Date = new Date(),
): Promise<PendingOperatorApproval[]> {
  const rows = await prisma.operatorActionApproval.findMany({
    where: {
      operatorId,
      approvedAt: null,
      consumedAt: null,
      expiresAt: { gt: now },
    },
    select: {
      id: true,
      summary: true,
      method: true,
      routePattern: true,
      resourceId: true,
      resourceLabel: true,
      createdAt: true,
      expiresAt: true,
    },
    orderBy: [{ createdAt: 'desc' }],
    take: 50,
  });

  return rows.map((row) => ({
    approvalId: row.id,
    summary: row.summary,
    method: row.method,
    routePattern: row.routePattern,
    resourceId: row.resourceId,
    resourceLabel: row.resourceLabel,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  }));
}

export interface GrantedOperatorApproval {
  summary: string;
  expiresAt: Date;
  resourceId: string | null;
  resourceLabel: string | null;
}

/**
 * Grants one approval, if the password is right and the row is this operator's,
 * unapproved, unspent and unexpired.
 *
 * Returns null for every failure without saying which, so a caller cannot map
 * the approval space by trying, and a wrong password costs the same bcrypt
 * comparison as a right one whether or not the operator exists.
 *
 * No second factor here, unlike connecting. The code is a proof of possession
 * for establishing a session; this is a person confirming one specific action
 * inside a session they already hold, and a six-digit code typed for every
 * deletion trains people to type codes at prompts.
 */
export async function grantOperatorApproval(
  prisma: PrismaClient,
  input: { approvalId: string; password: string; operatorId: string },
  now: Date = new Date(),
): Promise<GrantedOperatorApproval | null> {
  const account = await prisma.platformOperator.findUnique({
    where: { id: input.operatorId },
    select: { passwordHash: true, lifecycleStatus: true },
  });

  const correct = await bcrypt.compare(
    input.password,
    account?.passwordHash ?? DUMMY_PASSWORD_HASH,
  );

  // The update is the check. Narrowing on every condition at once means there
  // is no window between deciding an approval is grantable and granting it,
  // and no branch that reveals which condition failed.
  const granted =
    correct && account?.lifecycleStatus === 'ACTIVE'
      ? await prisma.operatorActionApproval.updateMany({
          where: {
            id: input.approvalId,
            operatorId: input.operatorId,
            approvedAt: null,
            consumedAt: null,
            expiresAt: { gt: now },
          },
          data: { approvedAt: now },
        })
      : { count: 0 };

  if (granted.count !== 1) return null;

  const approval = await prisma.operatorActionApproval.findFirst({
    where: { id: input.approvalId },
    select: { summary: true, expiresAt: true, resourceId: true, resourceLabel: true },
  });

  if (!approval) return null;

  return {
    summary: approval.summary,
    expiresAt: approval.expiresAt,
    resourceId: approval.resourceId,
    resourceLabel: approval.resourceLabel,
  };
}
