import { Prisma, type BillingAuthorityGrantKind, type BillingAuthorityGrantState } from '@prisma/client';
import { AppError } from '../utils/errors.js';

type LockedBillingAuthorityGrant = {
  id: string;
  organisationId: string;
  kind: BillingAuthorityGrantKind;
  state: BillingAuthorityGrantState;
  actorUserId: string;
  actorSessionId: string;
  actorMembershipVersion: number;
  providerResourceId: string | null;
  capabilityIssuedAt: Date | null;
  safeReleaseAfter: Date | null;
};

const RELEASE_ACTOR = 'SYSTEM:OWNERSHIP_INTERLOCK';

/**
 * The caller must already hold Organisation FOR UPDATE. This function is the
 * second lock in the ownership-change order: Organisation -> active billing
 * grant -> affected Users. The grant-creation trigger also takes an
 * Organisation lock, so a new claimant cannot appear between this check and
 * the later membership writes.
 */
export async function assertBillingAuthorityAllowsOwnershipChange(
  tx: Prisma.TransactionClient,
  organisationId: string,
  options: { now?: Date; releaseElapsedCheckout?: boolean } = {},
): Promise<{ autoReleasedGrantId: string | null; elapsedSafeGrantId: string | null }> {
  const now = options.now ?? new Date();
  const releaseElapsedCheckout = options.releaseElapsedCheckout ?? true;
  const grants = await tx.$queryRaw<LockedBillingAuthorityGrant[]>(Prisma.sql`
    SELECT
      "id", "organisationId", "kind", "state", "actorUserId",
      "actorSessionId", "actorMembershipVersion", "providerResourceId",
      "capabilityIssuedAt", "safeReleaseAfter"
    FROM "BillingAuthorityGrant"
    WHERE "organisationId" = ${organisationId}
      AND "state" <> 'RELEASED'::"BillingAuthorityGrantState"
    ORDER BY "id"
    FOR UPDATE
  `);

  if (grants.length > 1) {
    throw new AppError(
      409,
      'BILLING_AUTHORITY_STATE_CONFLICT',
      'Billing authority records require restricted reconciliation before ownership can change.',
    );
  }

  const grant = grants[0];
  if (!grant) return { autoReleasedGrantId: null, elapsedSafeGrantId: null };

  if (
    grant.kind === 'CHECKOUT' &&
    grant.state === 'CAPABILITY_ISSUED' &&
    grant.providerResourceId !== null &&
    grant.capabilityIssuedAt !== null &&
    grant.safeReleaseAfter !== null &&
    grant.safeReleaseAfter.getTime() <= now.getTime()
  ) {
    if (!releaseElapsedCheckout) {
      return { autoReleasedGrantId: null, elapsedSafeGrantId: grant.id };
    }
    const released = await tx.billingAuthorityGrant.updateMany({
      where: {
        id: grant.id,
        organisationId,
        kind: 'CHECKOUT',
        state: 'CAPABILITY_ISSUED',
        providerResourceId: grant.providerResourceId,
        capabilityIssuedAt: grant.capabilityIssuedAt,
        safeReleaseAfter: { lte: now },
      },
      data: {
        state: 'RELEASED',
        releasedAt: now,
        releaseReason: 'CHECKOUT_SAFE_RELEASE_AFTER_ELAPSED',
        releaseActor: RELEASE_ACTOR,
        releaseEvidence: {
          basis: 'EXPLICIT_SAFE_RELEASE_AFTER',
          safeReleaseAfter: grant.safeReleaseAfter.toISOString(),
          ownershipInterlockCheckedAt: now.toISOString(),
          previousState: grant.state,
        },
      },
    });
    if (released.count !== 1) {
      throw new AppError(
        409,
        'BILLING_AUTHORITY_STATE_CONFLICT',
        'Billing authority changed while ownership was being reviewed. Refresh and try again.',
      );
    }
    return { autoReleasedGrantId: grant.id, elapsedSafeGrantId: grant.id };
  }

  throw new AppError(
    409,
    'BILLING_AUTHORITY_CAPABILITY_ACTIVE',
    grant.kind === 'PORTAL'
      ? 'An issued Billing Portal capability requires explicit restricted release before ownership can change.'
      : 'An active Checkout capability must be explicitly released or reach its recorded safe-release time before ownership can change.',
    {
      kind: grant.kind,
      state: grant.state,
      safeReleaseAfter: grant.kind === 'CHECKOUT'
        ? grant.safeReleaseAfter?.toISOString() ?? null
        : null,
    },
  );
}
