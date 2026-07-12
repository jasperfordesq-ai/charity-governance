import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AuthEmailDeliveryService,
  authEmailCleanupBudgets,
  deriveVerifiedPasswordRecoveryToken,
  shouldRetrySecurityEmailOutcome,
  type AuthEmailDeliveryStore,
} from '../services/auth-email-delivery.service.js';
import {
  derivePasswordRecoveryToken,
  hashPasswordRecoveryToken,
} from '../services/password-recovery-crypto.js';

const ORIGINAL_RECOVERY_SECRET = process.env.AUTH_RECOVERY_SECRET;
process.env.AUTH_RECOVERY_SECRET = 'ab'.repeat(32);

afterEach(() => {
  process.env.AUTH_RECOVERY_SECRET = 'ab'.repeat(32);
});

process.once('exit', () => {
  if (ORIGINAL_RECOVERY_SECRET === undefined) delete process.env.AUTH_RECOVERY_SECRET;
  else process.env.AUTH_RECOVERY_SECRET = ORIGINAL_RECOVERY_SECRET;
});

const NOW = new Date('2026-07-11T12:00:00.000Z');
const RECOVERY_ID = '11111111-1111-4111-8111-111111111111';
const NOTICE_ID = '22222222-2222-4222-8222-222222222222';
const NONCE = 'cd'.repeat(32);
const RECOVERY_TOKEN = derivePasswordRecoveryToken({
  requestId: RECOVERY_ID,
  tokenNonceHex: NONCE,
  tokenKeyVersion: 1,
});

function emptyStore(overrides: Partial<AuthEmailDeliveryStore> = {}): AuthEmailDeliveryStore {
  return {
    async prepare() { return { staleQuarantined: 0 }; },
    async claimPasswordRecovery() { return null; },
    async finalizePasswordRecovery() { return 'UNCERTAIN'; },
    async claimSecurityNotice() { return null; },
    async finalizeSecurityNotice() { return 'UNCERTAIN'; },
    async claimOperatorReviewAlert() { return null; },
    async markOperatorReviewAlertSent() { return 0; },
    async releaseOperatorReviewAlertClaim() { return 0; },
    async cleanup() { return 0; },
    ...overrides,
  } as AuthEmailDeliveryStore;
}

test('worker sends immutable recovery and reset-notice payloads with stable idempotency keys', async () => {
  let recoveryClaimed = false;
  let noticeClaimed = false;
  const finalized: string[] = [];
  const sent: Array<Record<string, unknown>> = [];
  const store = emptyStore({
    async claimPasswordRecovery() {
      if (recoveryClaimed) return null;
      recoveryClaimed = true;
      return {
        kind: 'CLAIMED',
        claim: {
          id: RECOVERY_ID,
          claimToken: '33333333-3333-4333-8333-333333333333',
          organisationId: 'org-1',
          userId: 'user-1',
          token: RECOVERY_TOKEN,
          recipientEmail: 'owner@example.org',
          recipientName: 'Owner',
          frontendOrigin: 'https://snapshot.example.org',
          deliveryTemplateVersion: 1,
          deliveryAttemptCount: 1,
        },
      };
    },
    async finalizePasswordRecovery(_claim, outcome) {
      assert.equal(outcome.outcome, 'ACCEPTED');
      finalized.push('recovery');
      return 'ACCEPTED';
    },
    async claimSecurityNotice() {
      if (noticeClaimed) return null;
      noticeClaimed = true;
      return {
        id: NOTICE_ID,
        claimToken: '44444444-4444-4444-8444-444444444444',
        organisationId: 'org-1',
        userId: 'user-1',
        recipientEmail: 'owner@example.org',
        recipientName: 'Owner',
        changedAt: new Date('2026-07-11T11:59:00.000Z'),
        deliveryTemplateVersion: 1,
        deliveryAttemptCount: 1,
      };
    },
    async finalizeSecurityNotice(_claim, outcome) {
      assert.equal(outcome.outcome, 'ACCEPTED');
      finalized.push('notice');
      return 'ACCEPTED';
    },
    async cleanup(_now, limit) {
      assert.equal(limit, 500);
      return 4;
    },
  });
  const service = new AuthEmailDeliveryService(
    {} as never,
    {
      async sendPasswordRecoveryEmail(to, name, token, options) {
        sent.push({ kind: 'recovery', to, name, token, options });
        return { outcome: 'ACCEPTED', providerMessageId: 'provider-recovery-1' };
      },
      async sendPasswordResetCompletedNotice(to, name, changedAt, options) {
        sent.push({ kind: 'notice', to, name, changedAt, options });
        return { outcome: 'ACCEPTED', providerMessageId: 'provider-notice-1' };
      },
    },
    store,
    () => new Date(NOW),
  );

  const result = await service.processDueDeliveries({
    limit: 25,
    cleanupLimit: 500,
    staleSendingMs: 60000,
  });

  assert.deepEqual(result, {
    processed: 2,
    accepted: 2,
    rejected: 0,
    uncertain: 0,
    keyUnavailable: 0,
    retryScheduled: 0,
    staleQuarantined: 0,
    cleaned: 4,
  });
  assert.deepEqual(finalized, ['recovery', 'notice']);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], {
    kind: 'recovery',
    to: 'owner@example.org',
    name: 'Owner',
    token: RECOVERY_TOKEN,
    options: {
      idempotencyKey: `charitypilot-password-recovery-v1:${RECOVERY_ID}`,
      templateVersion: 1,
      frontendOrigin: 'https://snapshot.example.org',
    },
  });
  assert.deepEqual(sent[1], {
    kind: 'notice',
    to: 'owner@example.org',
    name: 'Owner',
    changedAt: new Date('2026-07-11T11:59:00.000Z'),
    options: {
      idempotencyKey: `charitypilot-security-email-v1:${NOTICE_ID}`,
      templateVersion: 1,
    },
  });
});

test('worker reports only aggregate retry, rejection, uncertainty and stale counts', async () => {
  let recoveryClaims = 0;
  let noticeClaims = 0;
  const store = emptyStore({
    async prepare() { return { staleQuarantined: 2 }; },
    async claimPasswordRecovery() {
      recoveryClaims += 1;
      if (recoveryClaims > 2) return null;
      return {
        kind: 'CLAIMED',
        claim: {
          id: recoveryClaims === 1 ? RECOVERY_ID : '55555555-5555-4555-8555-555555555555',
          claimToken: '33333333-3333-4333-8333-333333333333',
          organisationId: 'org-secret',
          userId: 'user-secret',
          token: RECOVERY_TOKEN,
          recipientEmail: 'private@example.org',
          recipientName: 'Private Person',
          frontendOrigin: 'https://snapshot.example.org',
          deliveryTemplateVersion: 1,
          deliveryAttemptCount: recoveryClaims,
        },
      };
    },
    async finalizePasswordRecovery(claim) {
      return claim.id === RECOVERY_ID ? 'RETRY_SCHEDULED' : 'UNCERTAIN';
    },
    async claimSecurityNotice() {
      noticeClaims += 1;
      if (noticeClaims > 1) return null;
      return {
        id: NOTICE_ID,
        claimToken: '44444444-4444-4444-8444-444444444444',
        organisationId: 'org-secret',
        userId: 'user-secret',
        recipientEmail: 'private@example.org',
        recipientName: 'Private Person',
        changedAt: NOW,
        deliveryTemplateVersion: 1,
        deliveryAttemptCount: 3,
      };
    },
    async finalizeSecurityNotice() { return 'REJECTED'; },
  });
  const service = new AuthEmailDeliveryService(
    {} as never,
    {
      async sendPasswordRecoveryEmail() { return { outcome: 'UNCERTAIN' }; },
      async sendPasswordResetCompletedNotice() {
        return { outcome: 'REJECTED', retryable: false };
      },
    },
    store,
    () => new Date(NOW),
  );

  const result = await service.processDueDeliveries({
    limit: 3,
    cleanupLimit: 10,
    staleSendingMs: 60000,
  });

  assert.deepEqual(result, {
    processed: 3,
    accepted: 0,
    rejected: 1,
    uncertain: 1,
    keyUnavailable: 0,
    retryScheduled: 1,
    staleQuarantined: 2,
    cleaned: 0,
  });
  assert.doesNotMatch(JSON.stringify(result), /private|example|user|org|token/i);
});

test('worker quarantines a queued request whose stored hash does not match the configured key without provider I/O', async () => {
  assert.equal(
    deriveVerifiedPasswordRecoveryToken({
      requestId: RECOVERY_ID,
      tokenNonce: NONCE,
      tokenKeyVersion: 1,
      tokenHash: hashPasswordRecoveryToken(RECOVERY_TOKEN),
    }),
    RECOVERY_TOKEN,
  );
  process.env.AUTH_RECOVERY_SECRET = 'ef'.repeat(32);
  assert.equal(
    deriveVerifiedPasswordRecoveryToken({
      requestId: RECOVERY_ID,
      tokenNonce: NONCE,
      tokenKeyVersion: 1,
      tokenHash: hashPasswordRecoveryToken(RECOVERY_TOKEN),
    }),
    null,
  );
  assert.equal(
    deriveVerifiedPasswordRecoveryToken({
      requestId: RECOVERY_ID,
      tokenNonce: NONCE,
      tokenKeyVersion: 2,
      tokenHash: hashPasswordRecoveryToken(RECOVERY_TOKEN),
    }),
    null,
  );
  assert.equal(
    deriveVerifiedPasswordRecoveryToken({
      requestId: RECOVERY_ID,
      tokenNonce: 'not-a-canonical-nonce',
      tokenKeyVersion: 1,
      tokenHash: hashPasswordRecoveryToken(RECOVERY_TOKEN),
    }),
    null,
  );
  process.env.AUTH_RECOVERY_SECRET = 'not-canonical=';
  assert.throws(
    () => deriveVerifiedPasswordRecoveryToken({
      requestId: RECOVERY_ID,
      tokenNonce: NONCE,
      tokenKeyVersion: 1,
      tokenHash: hashPasswordRecoveryToken(RECOVERY_TOKEN),
    }),
    /AUTH_RECOVERY_SECRET/,
  );
  process.env.AUTH_RECOVERY_SECRET = 'ef'.repeat(32);

  let claimCalls = 0;
  let providerCalls = 0;
  const service = new AuthEmailDeliveryService(
    {} as never,
    {
      async sendPasswordRecoveryEmail() {
        providerCalls += 1;
        return { outcome: 'UNCERTAIN' };
      },
      async sendPasswordResetCompletedNotice() {
        providerCalls += 1;
        return { outcome: 'UNCERTAIN' };
      },
    },
    emptyStore({
      async claimPasswordRecovery() {
        claimCalls += 1;
        return claimCalls === 1 ? { kind: 'KEY_UNAVAILABLE' } : null;
      },
    }),
    () => new Date(NOW),
  );

  const result = await service.processDueDeliveries({
    limit: 2,
    cleanupLimit: 10,
    staleSendingMs: 60_000,
  });

  assert.equal(providerCalls, 0);
  assert.deepEqual(result, {
    processed: 1,
    accepted: 0,
    rejected: 0,
    uncertain: 0,
    keyUnavailable: 1,
    retryScheduled: 0,
    staleQuarantined: 0,
    cleaned: 0,
  });
});

test('worker rejects unsafe operational bounds before touching storage', async () => {
  let touched = false;
  const service = new AuthEmailDeliveryService(
    {} as never,
    {
      async sendPasswordRecoveryEmail() { return { outcome: 'UNCERTAIN' }; },
      async sendPasswordResetCompletedNotice() { return { outcome: 'UNCERTAIN' }; },
    },
    emptyStore({
      async prepare() { touched = true; return { staleQuarantined: 0 }; },
    }),
  );

  await assert.rejects(
    () => service.processDueDeliveries({ limit: 0, cleanupLimit: 500, staleSendingMs: 60000 }),
    /limit must be an integer from 1 to 100/,
  );
  await assert.rejects(
    () => service.processDueDeliveries({ limit: 1, cleanupLimit: 2, staleSendingMs: 60000 }),
    /cleanup limit must be an integer from 3 to 1000/,
  );
  await assert.rejects(
    () => service.processDueDeliveries({ limit: 1, cleanupLimit: 3, staleSendingMs: 1000 }),
    /stale-send threshold must be at least 16000/,
  );
  assert.equal(touched, false);
});

test('operator-review alerts use durable exact claims and acknowledge or release through the store', async () => {
  const events: Array<Record<string, unknown>> = [];
  const claim = {
    claimToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    affectedCount: 3,
  };
  const service = new AuthEmailDeliveryService(
    {} as never,
    {
      async sendPasswordRecoveryEmail() { return { outcome: 'UNCERTAIN' }; },
      async sendPasswordResetCompletedNotice() { return { outcome: 'UNCERTAIN' }; },
    },
    emptyStore({
      async claimOperatorReviewAlert(now, limit) {
        events.push({ action: 'claim', now, limit });
        return claim;
      },
      async markOperatorReviewAlertSent(received, now) {
        events.push({ action: 'ack', claim: received, now });
        return received.affectedCount;
      },
      async releaseOperatorReviewAlertClaim(received) {
        events.push({ action: 'release', claim: received });
        return received.affectedCount;
      },
    }),
    () => new Date(NOW),
  );

  assert.deepEqual(await service.claimOperatorReviewAlert(500), claim);
  assert.equal(await service.markOperatorReviewAlertSent(claim), 3);
  assert.equal(await service.releaseOperatorReviewAlertClaim(claim), 3);
  assert.deepEqual(events, [
    { action: 'claim', now: NOW, limit: 500 },
    { action: 'ack', claim, now: NOW },
    { action: 'release', claim },
  ]);
  await assert.rejects(
    () => service.claimOperatorReviewAlert(1),
    /alert limit must be an integer from 2 to 1000/,
  );
});

test('cleanup uses one shared fair transaction budget across all three evidence categories', () => {
  const budgets = authEmailCleanupBudgets(500);
  assert.deepEqual(budgets, { recovery: 167, securityNotice: 167, rateBucket: 166 });
  assert.equal(budgets.recovery + budgets.securityNotice + budgets.rateBucket, 500);
  assert.deepEqual(authEmailCleanupBudgets(3), { recovery: 1, securityNotice: 1, rateBucket: 1 });
  assert.throws(() => authEmailCleanupBudgets(2), /integer from 3 to 1000/);
});

test('only a definite retryable rejection can schedule another identical send', () => {
  assert.equal(
    shouldRetrySecurityEmailOutcome({ outcome: 'REJECTED', retryable: true }),
    true,
  );
  assert.equal(
    shouldRetrySecurityEmailOutcome({ outcome: 'REJECTED', retryable: false }),
    false,
  );
  assert.equal(shouldRetrySecurityEmailOutcome({ outcome: 'UNCERTAIN' }), false);
  assert.equal(
    shouldRetrySecurityEmailOutcome({
      outcome: 'ACCEPTED',
      providerMessageId: 'provider-id',
    }),
    false,
  );
});

test('Prisma worker bounds stale, expiry and inactive-account repair with locked batches', () => {
  const source = readFileSync(
    join(process.cwd(), 'src', 'services', 'auth-email-delivery.service.ts'),
    'utf8',
  );
  const boundedSelections = source.match(/LIMIT \$\{(?:limit|budgets\.[a-zA-Z]+)\}[\s\S]{0,80}FOR UPDATE(?: OF [a-z]+)? SKIP LOCKED/g) ?? [];
  assert.ok(
    boundedSelections.length >= 7,
    'stale recovery, stale notice, inactive, expiry, and cleanup selections must be bounded and skip locked',
  );
  assert.match(
    source,
    /account\."lifecycleStatus" <> 'ACTIVE'[\s\S]*organisation\."lifecycleStatus" <> 'ACTIVE'/,
  );
  assert.match(
    source,
    /"terminationReason" = 'ACCOUNT_INACTIVE'::"PasswordRecoveryTerminationReason"/,
  );
  assert.match(
    source,
    /"terminationReason" = 'ACCOUNT_INACTIVE'::"PasswordRecoveryTerminationReason",[\s\S]{0,120}"nextDeliveryAttemptAt" = NULL/,
  );
  assert.match(
    source,
    /"terminationReason" = 'EXPIRED'::"PasswordRecoveryTerminationReason",[\s\S]{0,120}"nextDeliveryAttemptAt" = NULL/,
  );
  assert.match(source, /"terminatedAt" = COALESCE\("terminatedAt", \$\{now\}\)/);
  assert.match(
    source,
    /"terminationReason" = COALESCE\([\s\S]{0,160}'DELIVERY_REJECTED'::"PasswordRecoveryTerminationReason"/,
  );
  assert.match(
    source,
    /FROM "PasswordRecoveryRequest"[\s\S]{0,220}"evidenceRetentionAnchorAt" < \$\{retainedAfter\}[\s\S]{0,180}"claimToken" IS NULL[\s\S]{0,120}"deliveryState" <> 'SENDING'/,
  );
  assert.equal((source.match(/"evidenceRetentionAnchorAt" < \$\{retainedAfter\}/gu) ?? []).length, 2);
  assert.match(source, /export class PrismaAuthEmailDeliveryStore/);
  assert.match(source, /"tokenHash"[\s\S]*deriveVerifiedPasswordRecoveryToken/);
  assert.match(source, /crypto\.timingSafeEqual\(derivedHash, storedHash\)/);
  assert.match(
    source,
    /"terminationReason" = 'KEY_UNAVAILABLE'::"PasswordRecoveryTerminationReason"/,
  );
  assert.match(source, /AUTH_OPERATOR_REVIEW_ALERT_CLAIM_STALE_MS/);
  assert.match(source, /"reviewAlertClaimedAt" < \$\{staleBefore\}/);
  assert.match(source, /"reviewAlertClaimToken" = \$\{claimToken\}::uuid/);
  assert.match(source, /acknowledgement lost its exact claim/);
  assert.match(source, /release lost its exact claim/);
  assert.match(
    source,
    /"reviewAlertClaimToken" IS NULL[\s\S]{0,600}"reviewAlertedAt" IS NOT NULL/,
  );
  assert.match(source, /SELECT "id", "lifecycleStatus"[\s\S]*FOR SHARE/);
});
