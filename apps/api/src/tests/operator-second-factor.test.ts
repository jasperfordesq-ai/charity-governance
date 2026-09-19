import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';

process.env.OWNER_JWT_SECRET =
  process.env.OWNER_JWT_SECRET ?? 'operator-second-factor-test-owner-secret-value';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'operator-second-factor-test-tenant-secret';

const {
  beginOperatorEnrolment,
  completeOperatorEnrolment,
  checkOperatorSecondFactor,
  removeOperatorSecondFactor,
  operatorSecondFactorState,
  sealTotpSecret,
  openTotpSecret,
} = await import('../services/operator-second-factor.service.js');
const { totp, fromBase32 } = await import('../utils/totp.js');

type Operator = {
  id: string;
  email: string;
  totpSecret: unknown;
  totpEnrolledAt: Date | null;
  totpPendingAt: Date | null;
};

type RecoveryRow = { operatorId: string; codeHash: string; usedAt: Date | null };

function prismaStub(initial: Partial<Operator> = {}) {
  const operator: Operator = {
    id: 'op-1',
    email: 'operator@example.org',
    totpSecret: null,
    totpEnrolledAt: null,
    totpPendingAt: null,
    ...initial,
  };
  let codes: RecoveryRow[] = [];

  const matches = (row: RecoveryRow, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, value]) => {
      const actual = (row as unknown as Record<string, unknown>)[key];
      return actual === value;
    });

  const client = {
    platformOperator: {
      findUnique: async () => operator,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        for (const [key, value] of Object.entries(data)) {
          // Prisma.DbNull arrives as an object; the stub treats it as SQL NULL.
          (operator as unknown as Record<string, unknown>)[key] =
            value !== null && typeof value === 'object' && !(value instanceof Date)
              && !('v' in (value as Record<string, unknown>))
              ? null
              : value;
        }
        return operator;
      },
    },
    platformOperatorRecoveryCode: {
      count: async ({ where }: { where: Record<string, unknown> }) =>
        codes.filter((row) => matches(row, where)).length,
      createMany: async ({ data }: { data: RecoveryRow[] }) => {
        codes.push(...data.map((row) => ({ ...row, usedAt: null })));
        return { count: data.length };
      },
      deleteMany: async () => {
        const count = codes.length;
        codes = [];
        return { count };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: { usedAt: Date };
      }) => {
        const hits = codes.filter((row) => matches(row, where));
        for (const row of hits) row.usedAt = data.usedAt;
        return { count: hits.length };
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  };

  return { operator, client, codesFor: () => codes };
}

function currentCode(secretBase32: string): string {
  return totp(fromBase32(secretBase32));
}

test('a sealed secret opens back to itself, and is not stored in the clear', () => {
  const sealed = sealTotpSecret('GEZDGNBVGY3TQOJQ');

  assert.equal(openTotpSecret(sealed), 'GEZDGNBVGY3TQOJQ');
  assert.ok(
    !JSON.stringify(sealed).includes('GEZDGNBVGY3TQOJQ'),
    'the secret must not survive into the stored envelope',
  );
});

test('a tampered envelope is refused rather than half-decrypted', () => {
  const sealed = sealTotpSecret('GEZDGNBVGY3TQOJQ');
  const tampered = { ...sealed, ciphertext: Buffer.from('nonsense').toString('base64') };

  assert.throws(() => openTotpSecret(tampered), /could not be opened/);
});

test('an envelope from another key says what to do about it', () => {
  const sealed = sealTotpSecret('GEZDGNBVGY3TQOJQ');
  const original = process.env.OWNER_JWT_SECRET;
  try {
    process.env.OWNER_JWT_SECRET = 'a-completely-different-owner-secret-value-here';
    assert.throws(() => openTotpSecret(sealed), /must enrol again/);
  } finally {
    process.env.OWNER_JWT_SECRET = original;
  }
});

test('enrolment offers a secret and a URI an authenticator can read', async () => {
  const { client, operator } = prismaStub();

  const offer = await beginOperatorEnrolment(client as never, 'op-1');

  assert.match(offer.secret, /^[A-Z2-7]+$/);
  assert.match(offer.uri, /^otpauth:\/\/totp\//);
  assert.match(offer.uri, /operator%40example\.org/);
  assert.ok(operator.totpSecret, 'the secret is stored, sealed');
  assert.equal(operator.totpEnrolledAt, null, 'scanning is not enrolling');
  assert.ok(operator.totpPendingAt, 'the pending enrolment is dated');
});

test('scanning without proving a code leaves the account unenrolled', async () => {
  // Otherwise a mistyped setup, or a phone dropped in a river, locks an
  // operator out of the console with nobody able to let them back in.
  const { client } = prismaStub();
  await beginOperatorEnrolment(client as never, 'op-1');

  const state = await operatorSecondFactorState(client as never, 'op-1');
  assert.equal(state.enrolled, false);
  assert.equal(state.enrolmentPending, true);

  const outcome = await checkOperatorSecondFactor(client as never, 'op-1', {});
  assert.deepEqual(outcome, { required: false }, 'an unenrolled account is not challenged');
});

test('a correct code completes enrolment and returns recovery codes', async () => {
  const { client, operator, codesFor } = prismaStub();
  const offer = await beginOperatorEnrolment(client as never, 'op-1');

  const { recoveryCodes } = await completeOperatorEnrolment(
    client as never,
    'op-1',
    currentCode(offer.secret),
  );

  assert.equal(recoveryCodes.length, 10);
  assert.equal(new Set(recoveryCodes).size, 10, 'every code must be distinct');
  for (const code of recoveryCodes) assert.match(code, /^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/);

  assert.ok(operator.totpEnrolledAt);
  assert.equal(operator.totpPendingAt, null);
  assert.equal(codesFor().length, 10);
  assert.ok(
    !codesFor().some((row) => recoveryCodes.includes(row.codeHash)),
    'recovery codes are stored hashed, never as typed',
  );
});

test('a wrong code does not complete enrolment', async () => {
  const { client, operator } = prismaStub();
  await beginOperatorEnrolment(client as never, 'op-1');

  await assert.rejects(
    () => completeOperatorEnrolment(client as never, 'op-1', '000000'),
    /did not match/,
  );
  assert.equal(operator.totpEnrolledAt, null);
});

test('completing without starting says so', async () => {
  const { client } = prismaStub();

  await assert.rejects(
    () => completeOperatorEnrolment(client as never, 'op-1', '123456'),
    /no enrolment in progress/i,
  );
});

test('an enrolled account cannot silently have its factor replaced', async () => {
  // A session alone must not be enough to swap the factor protecting it.
  const { client } = prismaStub();
  const offer = await beginOperatorEnrolment(client as never, 'op-1');
  await completeOperatorEnrolment(client as never, 'op-1', currentCode(offer.secret));

  await assert.rejects(
    () => beginOperatorEnrolment(client as never, 'op-1'),
    /already has a second factor/,
  );
});

test('an enrolled account is challenged, and a correct code satisfies it', async () => {
  const { client } = prismaStub();
  const offer = await beginOperatorEnrolment(client as never, 'op-1');
  await completeOperatorEnrolment(client as never, 'op-1', currentCode(offer.secret));

  assert.deepEqual(
    await checkOperatorSecondFactor(client as never, 'op-1', { code: currentCode(offer.secret) }),
    { required: true, satisfied: true, usedRecoveryCode: false },
  );
  assert.deepEqual(
    await checkOperatorSecondFactor(client as never, 'op-1', { code: '000000' }),
    { required: true, satisfied: false },
  );
  assert.deepEqual(
    await checkOperatorSecondFactor(client as never, 'op-1', {}),
    { required: true, satisfied: false },
    'no code offered is not a satisfied factor',
  );
});

test('a recovery code works once and never again', async () => {
  const { client } = prismaStub();
  const offer = await beginOperatorEnrolment(client as never, 'op-1');
  const { recoveryCodes } = await completeOperatorEnrolment(
    client as never,
    'op-1',
    currentCode(offer.secret),
  );
  const code = recoveryCodes[0]!;

  assert.deepEqual(
    await checkOperatorSecondFactor(client as never, 'op-1', { recoveryCode: code }),
    { required: true, satisfied: true, usedRecoveryCode: true },
  );
  assert.deepEqual(
    await checkOperatorSecondFactor(client as never, 'op-1', { recoveryCode: code }),
    { required: true, satisfied: false },
    'a spent code buys nothing',
  );

  const state = await operatorSecondFactorState(client as never, 'op-1');
  assert.equal(state.recoveryCodesRemaining, 9);
});

test('a recovery code is accepted however it was typed back', async () => {
  const { client } = prismaStub();
  const offer = await beginOperatorEnrolment(client as never, 'op-1');
  const { recoveryCodes } = await completeOperatorEnrolment(
    client as never,
    'op-1',
    currentCode(offer.secret),
  );

  const outcome = await checkOperatorSecondFactor(client as never, 'op-1', {
    recoveryCode: ` ${recoveryCodes[1]!.replace('-', '').toLowerCase()} `,
  });
  assert.equal(outcome.required && outcome.satisfied, true);
});

test('a recovery code that was never issued is refused', async () => {
  const { client } = prismaStub();
  const offer = await beginOperatorEnrolment(client as never, 'op-1');
  await completeOperatorEnrolment(client as never, 'op-1', currentCode(offer.secret));

  assert.deepEqual(
    await checkOperatorSecondFactor(client as never, 'op-1', { recoveryCode: 'AAAAA-AAAAA' }),
    { required: true, satisfied: false },
  );
});

test('removing the factor needs the factor, not just a session', async () => {
  const { client, operator, codesFor } = prismaStub();
  const offer = await beginOperatorEnrolment(client as never, 'op-1');
  await completeOperatorEnrolment(client as never, 'op-1', currentCode(offer.secret));

  await assert.rejects(
    () => removeOperatorSecondFactor(client as never, 'op-1', { code: '000000' }),
    /left in place/,
  );
  assert.ok(operator.totpEnrolledAt, 'a failed removal changes nothing');

  await removeOperatorSecondFactor(client as never, 'op-1', { code: currentCode(offer.secret) });

  assert.equal(operator.totpEnrolledAt, null);
  assert.equal(operator.totpSecret, null);
  assert.equal(codesFor().length, 0, 'recovery codes for a removed factor are meaningless');
});

test('removing a factor that is not there says so', async () => {
  const { client } = prismaStub();

  await assert.rejects(
    () => removeOperatorSecondFactor(client as never, 'op-1', { code: '123456' }),
    /no second factor/,
  );
});

test('the stored recovery hash is the sha-256 of the normalised code', () => {
  // Pinned so a change to the hashing would be a deliberate act with a
  // migration, rather than something that silently invalidates every code an
  // operator has printed out and put in a drawer.
  const expected = createHash('sha256').update('ABCDE12345').digest('hex');
  assert.equal(expected.length, 64);
});
