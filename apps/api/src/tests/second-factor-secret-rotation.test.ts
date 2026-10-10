import assert from 'node:assert/strict';
import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';
import test from 'node:test';

const ROOT_A = 'charity-user-rotation-test-secret-AAAAAAAAAAAAAAAA';
const ROOT_B = 'charity-user-rotation-test-secret-BBBBBBBBBBBBBBBB';
const ROOT_C = 'charity-user-rotation-test-secret-CCCCCCCCCCCCCCCC';
process.env.JWT_SECRET = ROOT_A;
process.env.OWNER_JWT_SECRET = ROOT_A;
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? 're_rotation-test';
process.env.EMAIL_FROM = process.env.EMAIL_FROM ?? 'noreply@example.org';

const { sealUserTotpSecret, openUserTotpSecret, userTotpSecretIsCurrent } =
  await import('../services/user-totp-crypto.js');
const { verifyUserLoginSecondFactor, resealUserSecondFactorSecrets } =
  await import('../services/user-second-factor.service.js');
const { sealTotpSecret, openTotpSecret, operatorTotpSecretIsCurrent } =
  await import('../services/operator-totp-crypto.js');
const { resealOperatorSecondFactorSecrets } = await import('../services/operator-second-factor.service.js');
const { generateTotpSecret, fromBase32, totp } = await import('../utils/totp.js');
const { parseResealArgs, resealAllPages } = await import('../jobs/reseal-second-factor-secrets.js');

function withRoots<T>(env: Record<string, string | undefined>, run: () => T): T {
  const names = ['JWT_SECRET', 'JWT_SECRET_PREVIOUS', 'OWNER_JWT_SECRET', 'OWNER_JWT_SECRET_PREVIOUS'];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) {
    if (n in env) {
      if (env[n] === undefined) delete process.env[n];
      else process.env[n] = env[n];
    }
  }
  const restore = () => {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  };
  let result: T;
  try {
    result = run();
  } catch (error) {
    restore();
    throw error;
  }
  // An async body must finish under the configured secrets before they are
  // restored; restoring in a synchronous finally would race it.
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    return (result as unknown as Promise<unknown>).finally(restore) as unknown as T;
  }
  restore();
  return result;
}

/** A v1 envelope exactly as the code before this change sealed it (no key id). */
function legacyUserEnvelope(root: string, secret: string) {
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(root, 'utf8'), Buffer.alloc(0),
    'charitypilot:charity-user:totp:v1', 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64') };
}

test('a user authenticator survives a JWT_SECRET rotation while the previous secret is configured', () => {
  const secret = generateTotpSecret();
  const sealed = withRoots({ JWT_SECRET: ROOT_A }, () => sealUserTotpSecret(secret));
  assert.equal(sealed.v, 2);
  withRoots({ JWT_SECRET: ROOT_B, JWT_SECRET_PREVIOUS: ROOT_A }, () => {
    assert.equal(openUserTotpSecret(sealed), secret);
    assert.equal(userTotpSecretIsCurrent(sealed), false);
  });
  withRoots({ JWT_SECRET: ROOT_B, JWT_SECRET_PREVIOUS: undefined }, () => {
    assert.throws(() => openUserTotpSecret(sealed), /no longer configured/);
  });
  withRoots({ JWT_SECRET: ROOT_B, JWT_SECRET_PREVIOUS: ROOT_C }, () => {
    assert.throws(() => openUserTotpSecret(sealed), /no longer configured/, 'a wrong previous secret is not trusted');
  });
  withRoots({ JWT_SECRET: ROOT_A, JWT_SECRET_PREVIOUS: ROOT_A }, () => {
    assert.equal(userTotpSecretIsCurrent(sealed), true, 'a previous equal to the current secret is ignored');
  });
});

test('a legacy v1 envelope opens under the current secret, then the previous, and nothing else', () => {
  const secret = generateTotpSecret();
  const legacy = legacyUserEnvelope(ROOT_A, secret);
  withRoots({ JWT_SECRET: ROOT_A, JWT_SECRET_PREVIOUS: undefined }, () => {
    assert.equal(openUserTotpSecret(legacy), secret);
    assert.equal(userTotpSecretIsCurrent(legacy), false, 'v1 is always re-sealed into a key-identified envelope');
  });
  withRoots({ JWT_SECRET: ROOT_B, JWT_SECRET_PREVIOUS: ROOT_A }, () => {
    assert.equal(openUserTotpSecret(legacy), secret);
  });
  withRoots({ JWT_SECRET: ROOT_B, JWT_SECRET_PREVIOUS: undefined }, () => {
    assert.throws(() => openUserTotpSecret(legacy), /could not be opened/);
  });
});

test('a successful code re-seals a stale authenticator under the current secret, a failed one does not', async () => {
  const secret = generateTotpSecret();
  const actor = { id: 'user-1', organisationId: 'org-1', name: 'Rotation Trustee' };
  const factor = {
    userId: actor.id, secret: withRoots({ JWT_SECRET: ROOT_A }, () => sealUserTotpSecret(secret)) as unknown,
    pendingAt: null, enrolledAt: new Date(), lastUsedStep: null as number | null,
    failedAttempts: 0, failedWindowAt: null as Date | null, blockedUntil: null as Date | null,
  };
  const client = {
    $queryRaw: async () => [factor],
    userSecondFactor: { update: async ({ data }: { data: Partial<typeof factor> }) => { Object.assign(factor, data); } },
    userSecondFactorRecoveryCode: { updateMany: async () => ({ count: 0 }) },
    securityAuditEvent: { create: async () => ({}) },
  } as never;
  await withRoots({ JWT_SECRET: ROOT_B, JWT_SECRET_PREVIOUS: ROOT_A }, async () => {
    const before = factor.secret;
    assert.equal((await verifyUserLoginSecondFactor(client, actor, { code: '000000' }))?.code, 'SECOND_FACTOR_REQUIRED');
    assert.equal(factor.secret, before, 'a failed code never re-seals');
    assert.equal(await verifyUserLoginSecondFactor(client, actor, { code: totp(fromBase32(secret)) }), null);
    assert.equal(userTotpSecretIsCurrent(factor.secret), true);
    assert.equal(openUserTotpSecret(factor.secret), secret);
  });
  withRoots({ JWT_SECRET: ROOT_B, JWT_SECRET_PREVIOUS: undefined }, () => {
    assert.equal(openUserTotpSecret(factor.secret), secret, 'opens after the previous secret is removed');
  });
});

type PageArgs = { where?: { userId?: { gt: string } }; take?: number };

test('the batch re-seal moves stale user secrets, skips changed rows and reports unopenable ones', async () => {
  const secrets = [generateTotpSecret(), generateTotpSecret(), generateTotpSecret()];
  const rows = withRoots({ JWT_SECRET: ROOT_A }, () => secrets.map((s, i) => ({
    userId: `user-${i}`, secret: sealUserTotpSecret(s) as unknown, updatedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)),
  })));
  rows.push({ userId: 'user-broken', secret: { v: 2, kid: 'unknown', iv: 'AAAA', tag: 'AAAA', ciphertext: 'AAAA' },
    updatedAt: new Date(Date.UTC(2026, 9, 1)) });
  const currentRow = withRoots({ JWT_SECRET: ROOT_B }, () => ({ userId: 'user-current',
    secret: sealUserTotpSecret(generateTotpSecret()) as unknown, updatedAt: new Date(Date.UTC(2026, 9, 2)) }));
  rows.push(currentRow);
  const currentBefore = JSON.stringify(currentRow.secret);
  const client = {
    userSecondFactor: {
      findMany: async ({ where, take }: PageArgs = {}) => rows
        .filter((r) => where?.userId === undefined || r.userId > where.userId.gt)
        .sort((a, b) => (a.userId < b.userId ? -1 : 1))
        .slice(0, take)
        .map((r) => ({ ...r })),
      updateMany: async ({ where, data }: { where: { userId: string; updatedAt: Date }; data: { secret: unknown } }) => {
        const row = rows.find((r) => r.userId === where.userId && r.updatedAt.getTime() === where.updatedAt.getTime());
        if (!row || row.userId === 'user-1') return { count: 0 };
        row.secret = data.secret;
        row.updatedAt = new Date();
        return { count: 1 };
      },
    },
  } as never;
  await withRoots({ JWT_SECRET: ROOT_B, JWT_SECRET_PREVIOUS: ROOT_A }, async () => {
    const result = await resealUserSecondFactorSecrets(client, 100);
    assert.deepEqual([result.scanned, result.stale, result.resealed, result.skippedChanged, result.failed, result.next],
      [5, 4, 2, 1, ['user-broken'], null]);
    assert.equal(JSON.stringify(currentRow.secret), currentBefore, 'an already-current secret is not rewritten');
    assert.equal(userTotpSecretIsCurrent(rows[0]!.secret), true);
    assert.equal(userTotpSecretIsCurrent(rows[1]!.secret), false, 'the changed row was left for the next run');
    assert.equal(openUserTotpSecret(rows[2]!.secret), secrets[2]);
    await assert.rejects(resealUserSecondFactorSecrets(client, 0));
  });
});

test('a run pages through every row, so an unopenable row never blocks the rows after it', async () => {
  const secrets = [generateTotpSecret(), generateTotpSecret()];
  const rows = withRoots({ JWT_SECRET: ROOT_A }, () => [
    { userId: 'a-broken', secret: { v: 2, kid: 'unknown', iv: 'AAAA', tag: 'AAAA', ciphertext: 'AAAA' } as unknown,
      updatedAt: new Date(Date.UTC(2026, 9, 1)) },
    ...secrets.map((s, i) => ({ userId: `b-user-${i}`, secret: sealUserTotpSecret(s) as unknown,
      updatedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)) })),
  ]);
  const reads: Array<number | undefined> = [];
  const client = {
    userSecondFactor: {
      findMany: async ({ where, take }: PageArgs = {}) => {
        reads.push(take);
        return rows.filter((r) => where?.userId === undefined || r.userId > where.userId.gt)
          .sort((a, b) => (a.userId < b.userId ? -1 : 1)).slice(0, take).map((r) => ({ ...r }));
      },
      updateMany: async ({ where, data }: { where: { userId: string; updatedAt: Date }; data: { secret: unknown } }) => {
        const row = rows.find((r) => r.userId === where.userId && r.updatedAt.getTime() === where.updatedAt.getTime());
        if (!row) return { count: 0 };
        row.secret = data.secret;
        row.updatedAt = new Date();
        return { count: 1 };
      },
    },
  } as never;
  await withRoots({ JWT_SECRET: ROOT_B, JWT_SECRET_PREVIOUS: ROOT_A }, async () => {
    const first = await resealUserSecondFactorSecrets(client, 1);
    assert.deepEqual([first.failed, first.next], [['a-broken'], 'a-broken'], 'the bad row fills the first page');
    const total = await resealAllPages((after) => resealUserSecondFactorSecrets(client, 1, after));
    assert.deepEqual([total.scanned, total.stale, total.resealed, total.failed, total.remaining],
      [3, 3, 2, ['a-broken'], 1]);
    assert.ok(reads.every((take) => take === 1), 'every database read is bounded by the batch');
    assert.equal(openUserTotpSecret(rows[2]!.secret), secrets[1]);
    assert.equal(userTotpSecretIsCurrent(rows[1]!.secret), true);
  });
  await assert.rejects(resealAllPages(async () => ({ scanned: 1, stale: 0, resealed: 0, skippedChanged: 0,
    failed: [], next: 'same' })), /did not advance/);
});

test('operator authenticators rotate with OWNER_JWT_SECRET_PREVIOUS and re-seal in batch', async () => {
  const secret = generateTotpSecret();
  const sealed = withRoots({ OWNER_JWT_SECRET: ROOT_A }, () => sealTotpSecret(secret));
  const rows = [{ id: 'op-1', totpSecret: sealed as unknown, updatedAt: new Date(Date.UTC(2026, 9, 1)) }];
  const client = {
    platformOperator: {
      findMany: async () => rows.map((r) => ({ ...r })),
      updateMany: async ({ where, data }: { where: { id: string; updatedAt: Date }; data: { totpSecret: unknown } }) => {
        const row = rows.find((r) => r.id === where.id && r.updatedAt.getTime() === where.updatedAt.getTime());
        if (!row) return { count: 0 };
        row.totpSecret = data.totpSecret;
        return { count: 1 };
      },
    },
  } as never;
  await withRoots({ OWNER_JWT_SECRET: ROOT_B, OWNER_JWT_SECRET_PREVIOUS: undefined }, async () => {
    assert.throws(() => openTotpSecret(sealed), /OWNER_JWT_SECRET_PREVIOUS/);
  });
  await withRoots({ OWNER_JWT_SECRET: ROOT_B, OWNER_JWT_SECRET_PREVIOUS: ROOT_A }, async () => {
    assert.equal(openTotpSecret(sealed), secret);
    assert.equal(operatorTotpSecretIsCurrent(sealed), false);
    const result = await resealOperatorSecondFactorSecrets(client, 10);
    assert.deepEqual([result.resealed, result.next, result.failed], [1, null, []]);
    assert.equal(operatorTotpSecretIsCurrent(rows[0]!.totpSecret), true);
  });
  withRoots({ OWNER_JWT_SECRET: ROOT_B, OWNER_JWT_SECRET_PREVIOUS: undefined }, () => {
    assert.equal(openTotpSecret(rows[0]!.totpSecret), secret);
  });
});

test('the re-seal command accepts only a realm and an optional bounded batch', () => {
  assert.deepEqual(parseResealArgs(['user']), { realm: 'user', batch: 100 });
  assert.deepEqual(parseResealArgs(['operator', '--batch', '25']), { realm: 'operator', batch: 25 });
  assert.deepEqual(parseResealArgs(['user', '--batch', '1000']), { realm: 'user', batch: 1000 });
  for (const argv of [[], ['users'], ['user', '--batch'], ['user', '--batch', '0'], ['user', '--batch', '99999'],
    ['user', '--batch', '1001'],
    ['user', '--limit', '5'], ['user', '--batch', '5', 'extra']]) {
    assert.throws(() => parseResealArgs(argv), Error, argv.join(' '));
  }
});
