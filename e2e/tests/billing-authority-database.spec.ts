import { randomUUID } from 'node:crypto';
import { TEST_PASSWORD, expect, test, uniqueEmail } from '../fixtures';
import { IS_DEPLOYED_QA } from '../env';
import {
  createAuthenticatedStorageState,
  createVerifiedOwner,
  sha256Hex,
  withDb,
} from '../helpers/db';

test.describe('Billing authority database evidence on real PostgreSQL', () => {
  test.skip(IS_DEPLOYED_QA, 'Direct constraint probes require the identity-bound disposable database.');

  test('pre-capability grants cannot fabricate safe-release or kind-incompatible evidence', async () => {
    const principal = await createVerifiedOwner({
      email: uniqueEmail('billing-authority-constraints'),
      password: TEST_PASSWORD,
      name: 'Billing Constraint Owner',
      organisationName: 'Billing Constraint Charity',
    });
    const storageState = await createAuthenticatedStorageState({
      userId: principal.userId,
      organisationId: principal.organisationId,
      role: 'OWNER',
    });
    const refreshToken = storageState.cookies.find(
      (cookie) => cookie.name === 'charitypilot_refresh',
    )?.value;
    if (!refreshToken) throw new Error('Disposable authenticated state did not contain a refresh cookie');

    await withDb(async (client) => {
      const actor = await client.query<{ membershipVersion: number; sessionId: string }>(
        `SELECT account."membershipVersion", session."id" AS "sessionId"
           FROM "User" AS account
           JOIN "AuthSession" AS session ON session."userId" = account."id"
          WHERE account."id" = $1
            AND session."refreshTokenHash" = $2`,
        [principal.userId, sha256Hex(refreshToken)],
      );
      const evidence = actor.rows[0];
      if (!evidence) throw new Error('Owner membership/session evidence was not found');

      await expect(client.query(
        `INSERT INTO "BillingAuthorityGrant" (
           "id", "organisationId", "kind", "actorUserId", "actorSessionId",
           "actorMembershipVersion", "safeReleaseAfter"
         ) VALUES ($1, $2, 'CHECKOUT', $3, $4, $5, NOW() + INTERVAL '1 hour')`,
        [randomUUID(), principal.organisationId, principal.userId, evidence.sessionId, evidence.membershipVersion],
      )).rejects.toMatchObject({ code: '23514' });

      const grantId = randomUUID();
      await client.query(
        `INSERT INTO "BillingAuthorityGrant" (
           "id", "organisationId", "kind", "actorUserId", "actorSessionId",
           "actorMembershipVersion"
         ) VALUES ($1, $2, 'CHECKOUT', $3, $4, $5)`,
        [grantId, principal.organisationId, principal.userId, evidence.sessionId, evidence.membershipVersion],
      );

      await expect(client.query(
        `UPDATE "BillingAuthorityGrant"
            SET "state" = 'PROVIDER_STARTED',
                "providerStartedAt" = NOW(),
                "safeReleaseAfter" = NOW() - INTERVAL '1 minute'
          WHERE "id" = $1`,
        [grantId],
      )).rejects.toMatchObject({ code: '23514' });

      await expect(client.query(
        `UPDATE "BillingAuthorityGrant"
            SET "state" = 'RELEASED',
                "releasedAt" = NOW(),
                "safeReleaseAfter" = NOW() - INTERVAL '1 minute',
                "releaseReason" = 'CHECKOUT_SAFE_RELEASE_AFTER_ELAPSED',
                "releaseActor" = 'TEST:NEGATIVE_PROBE',
                "releaseEvidence" = '{"probe":true}'::jsonb
          WHERE "id" = $1`,
        [grantId],
      )).rejects.toMatchObject({ code: '23514' });

      await expect(client.query(
        `UPDATE "BillingAuthorityGrant"
            SET "state" = 'RELEASED',
                "releasedAt" = NOW(),
                "releaseReason" = 'RESTRICTED_OPERATOR_ATTESTATION',
                "releaseActor" = 'TEST:NEGATIVE_PROBE',
                "releaseEvidence" = '{"probe":true}'::jsonb
          WHERE "id" = $1`,
        [grantId],
      )).rejects.toMatchObject({ code: '23514' });

      const unchanged = await client.query<{ state: string; safeReleaseAfter: Date | null }>(
        `SELECT "state"::text AS "state", "safeReleaseAfter"
           FROM "BillingAuthorityGrant"
          WHERE "id" = $1`,
        [grantId],
      );
      expect(unchanged.rows[0]).toEqual({ state: 'CLAIMED', safeReleaseAfter: null });
    });
  });
});
