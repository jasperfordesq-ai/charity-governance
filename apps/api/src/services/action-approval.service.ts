import bcrypt from "bcryptjs";
import type { PrismaClient } from "@prisma/client";

/**
 * Listing and granting the approvals that stand between an agent and a
 * destructive action.
 *
 * Two realms reach this: the connector's own route, driven by
 * `charitypilot-mcp approve` at a terminal, and a page in the web
 * application, for the person who has no terminal to type at. The rule that
 * decides whether an approval may be granted lives here, once, so the two
 * cannot drift apart — a browser path that was one condition looser than the
 * terminal path would be the whole control quietly undone.
 *
 * What does NOT live here is who may ask. The connector route keeps its
 * non-browser guard and the web route keeps the ordinary origin protection;
 * this only answers "is this person's password right, and is this approval
 * theirs, unspent and unexpired".
 */

/** Same cost as a real hash, so a missing account does not answer faster. */
const DUMMY_PASSWORD_HASH =
  '$2b$12$5x1wZg/1s7XL/AUM6hR6OeX6zHNP.H0FgxiRa5EDVKtm6RFwhiVdK';

/** How many pending approvals a page will show. More than this is a loop. */
const PENDING_LIMIT = 20;

export interface ApprovalCaller {
  userId: string;
  organisationId: string;
}

export interface PendingApproval {
  approvalId: string;
  summary: string;
  method: string;
  routePattern: string;
  resourceId: string | null;
  createdAt: string;
  expiresAt: string;
}

/**
 * The approvals this person could grant right now.
 *
 * Scoped to the caller, not to the charity: an approval is a capability over
 * one action, and one administrator must not be able to grant the action
 * another one's agent asked for.
 */
export async function listPendingApprovals(
  prisma: PrismaClient,
  caller: ApprovalCaller,
  now: Date = new Date(),
): Promise<PendingApproval[]> {
  const rows = await prisma.authActionApproval.findMany({
    where: {
      userId: caller.userId,
      organisationId: caller.organisationId,
      approvedAt: null,
      consumedAt: null,
      expiresAt: { gt: now },
    },
    orderBy: [{ createdAt: "desc" }],
    take: PENDING_LIMIT,
    select: {
      id: true,
      summary: true,
      method: true,
      routePattern: true,
      resourceId: true,
      createdAt: true,
      expiresAt: true,
    },
  });

  return rows.map((row) => ({
    approvalId: row.id,
    summary: row.summary,
    method: row.method,
    routePattern: row.routePattern,
    resourceId: row.resourceId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  }));
}

export interface GrantedApproval {
  summary: string | null;
  expiresAt: string | null;
}

/**
 * Grants one approval, if the password is right and the row is the caller's,
 * unapproved, unspent and unexpired.
 *
 * Returns null for every failure without saying which, so a caller cannot map
 * the approval space by trying, and a wrong password costs the same bcrypt
 * comparison as a right one whether or not the account exists.
 */
export async function grantApproval(
  prisma: PrismaClient,
  input: ApprovalCaller & { approvalId: string; password: string },
  now: Date = new Date(),
): Promise<GrantedApproval | null> {
  const account = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { passwordHash: true },
  });

  const correct = await bcrypt.compare(
    input.password,
    account?.passwordHash ?? DUMMY_PASSWORD_HASH,
  );

  // The update is the check. Narrowing on every condition at once means there
  // is no window between deciding an approval is grantable and granting it,
  // and no branch that reveals which condition failed.
  const granted = correct
    ? await prisma.authActionApproval.updateMany({
        where: {
          id: input.approvalId,
          userId: input.userId,
          organisationId: input.organisationId,
          approvedAt: null,
          consumedAt: null,
          expiresAt: { gt: now },
        },
        data: { approvedAt: now },
      })
    : { count: 0 };

  if (granted.count !== 1) return null;

  const approval = await prisma.authActionApproval.findFirst({
    where: { id: input.approvalId },
    select: { summary: true, expiresAt: true },
  });

  return {
    summary: approval?.summary ?? null,
    expiresAt: approval?.expiresAt.toISOString() ?? null,
  };
}
