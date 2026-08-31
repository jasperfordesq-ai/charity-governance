import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'tenant-secret-for-owner-jwt-test';
process.env.OWNER_JWT_SECRET = 'owner-secret-for-owner-jwt-test';

const [{ signOperatorAccessToken, verifyOperatorAccessToken, assertOwnerJwtSecretConfigured }, { signAccessToken }] =
  await Promise.all([import('../utils/owner-jwt.js'), import('../utils/jwt.js')]);

test('an operator token round-trips', () => {
  const token = signOperatorAccessToken({ operatorId: 'op-1', sessionId: 's-1' });
  assert.deepEqual(verifyOperatorAccessToken(token), { operatorId: 'op-1', sessionId: 's-1' });
});

test('a tenant token is rejected by the operator verifier', () => {
  const tenantToken = signAccessToken({
    userId: 'u-1',
    organisationId: 'org-1',
    role: 'OWNER',
    sessionId: 's-1',
  });
  assert.throws(() => verifyOperatorAccessToken(tenantToken));
});

test('a token signed with the tenant secret but operator claims is rejected', async () => {
  // Proves isolation comes from the SECRET, not only from the claim shape:
  // an attacker who learns JWT_SECRET still cannot mint an owner token.
  const jwt = (await import('jsonwebtoken')).default;
  const forged = jwt.sign({ operatorId: 'op-1', sessionId: 's-1' }, process.env.JWT_SECRET as string, {
    algorithm: 'HS256',
    issuer: 'charitypilot-owner-api',
    audience: 'charitypilot-owner',
    expiresIn: '30m',
  });
  assert.throws(() => verifyOperatorAccessToken(forged));
});

test('a payload missing operatorId is rejected', async () => {
  const jwt = (await import('jsonwebtoken')).default;
  const bad = jwt.sign({ sessionId: 's-1' }, process.env.OWNER_JWT_SECRET as string, {
    algorithm: 'HS256',
    issuer: 'charitypilot-owner-api',
    audience: 'charitypilot-owner',
    expiresIn: '30m',
  });
  assert.throws(() => verifyOperatorAccessToken(bad), /Invalid operator token payload/);
});

test('the boot guard rejects a missing secret', () => {
  assert.throws(
    () => assertOwnerJwtSecretConfigured({ JWT_SECRET: 'a' } as NodeJS.ProcessEnv),
    /OWNER_JWT_SECRET/,
  );
});

test('the boot guard rejects a secret shorter than the JWT_SECRET floor', () => {
  assert.throws(
    () =>
      assertOwnerJwtSecretConfigured({
        JWT_SECRET: 'tenant-secret-for-owner-jwt-test',
        OWNER_JWT_SECRET: 'too-short',
      } as NodeJS.ProcessEnv),
    /OWNER_JWT_SECRET must be at least 32 characters/,
  );
});

test('the boot guard rejects a secret equal to JWT_SECRET', () => {
  const same = 'same-secret-repeated-across-both-owner-and-tenant';
  assert.throws(
    () => assertOwnerJwtSecretConfigured({ JWT_SECRET: same, OWNER_JWT_SECRET: same } as NodeJS.ProcessEnv),
    /must not equal JWT_SECRET/,
  );
});

test('the boot guard accepts distinct secrets', () => {
  assert.doesNotThrow(() =>
    assertOwnerJwtSecretConfigured({
      JWT_SECRET: 'tenant-secret-for-owner-jwt-test',
      OWNER_JWT_SECRET: 'owner-secret-for-owner-jwt-test-32',
    } as NodeJS.ProcessEnv),
  );
});
