import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { z } from 'zod';
import {
  forgotPasswordSchema,
  loginSchema,
  MAX_ACCOUNT_EMAIL_LENGTH,
  registerSchema,
  resetPasswordSchema,
} from '../schemas/auth.js';
import {
  BCRYPT_PASSWORD_MAX_UTF8_BYTES,
  BCRYPT_PASSWORD_MAX_UTF8_BYTES_MESSAGE,
  passwordUtf8ByteLength,
} from '../schemas/password.js';
import { acceptTeamInviteSchema, inviteTeamMemberSchema } from '../schemas/team.js';

type PasswordParseResult = z.SafeParseReturnType<unknown, unknown>;

interface PasswordSchemaCase {
  label: string;
  parse: (password: unknown) => PasswordParseResult;
}

const passwordSchemas: readonly PasswordSchemaCase[] = [
  {
    label: 'register',
    parse: (password) => registerSchema.safeParse({
      email: 'member@charitypilot.ie',
      password,
      name: 'Member Name',
      organisationName: 'Example Charity',
    }),
  },
  {
    label: 'login',
    parse: (password) => loginSchema.safeParse({ email: 'member@charitypilot.ie', password }),
  },
  {
    label: 'reset-password',
    parse: (password) => resetPasswordSchema.safeParse({ token: 'reset-token', password }),
  },
  {
    label: 'accept-invite',
    parse: (password) => acceptTeamInviteSchema.safeParse({
      token: 'invite-token',
      name: 'Invited Member',
      password,
    }),
  },
] as const;

const complexPasswordSchemas = passwordSchemas.filter(({ label }) => label !== 'login');

function assertAccepted(schemaCase: PasswordSchemaCase, password: unknown): void {
  const parsed = schemaCase.parse(password);
  assert.equal(parsed.success, true, `${schemaCase.label} should accept the password`);
}

function assertRejectedWithByteBoundary(schemaCase: PasswordSchemaCase, password: unknown): void {
  const parsed = schemaCase.parse(password);
  assert.equal(parsed.success, false, `${schemaCase.label} should reject the password`);
  if (parsed.success) return;
  assert.ok(
    parsed.error.issues.some(({ message }) => message === BCRYPT_PASSWORD_MAX_UTF8_BYTES_MESSAGE),
    `${schemaCase.label} should report the shared bcrypt UTF-8 byte boundary`,
  );
}

test('all bcrypt password inputs accept an exact 72-byte complex ASCII password', () => {
  const password = `A1a${'b'.repeat(69)}`;
  assert.equal(password.length, 72);
  assert.equal(passwordUtf8ByteLength(password), BCRYPT_PASSWORD_MAX_UTF8_BYTES);
  for (const schemaCase of passwordSchemas) assertAccepted(schemaCase, password);
});

test('all bcrypt password inputs enforce UTF-8 bytes rather than JavaScript characters', () => {
  const exactBoundary = `A1a${'é'.repeat(34)}b`;
  const overBoundary = `A1a${'é'.repeat(35)}`;
  assert.equal(exactBoundary.length, 38);
  assert.equal(passwordUtf8ByteLength(exactBoundary), 72);
  assert.equal(overBoundary.length, 38);
  assert.equal(passwordUtf8ByteLength(overBoundary), 73);

  for (const schemaCase of passwordSchemas) {
    assertAccepted(schemaCase, exactBoundary);
    assertRejectedWithByteBoundary(schemaCase, overBoundary);
  }
});

test('inputs with the same first 72 bcrypt bytes but different suffixes are both rejected', () => {
  const bcryptPrefix = `A1a${'b'.repeat(69)}`;
  const first = `${bcryptPrefix}X`;
  const second = `${bcryptPrefix}Y`;
  const encoder = new TextEncoder();
  assert.deepEqual(
    encoder.encode(first).slice(0, BCRYPT_PASSWORD_MAX_UTF8_BYTES),
    encoder.encode(second).slice(0, BCRYPT_PASSWORD_MAX_UTF8_BYTES),
  );
  assert.notDeepEqual(encoder.encode(first), encoder.encode(second));

  for (const schemaCase of passwordSchemas) {
    assertRejectedWithByteBoundary(schemaCase, first);
    assertRejectedWithByteBoundary(schemaCase, second);
  }
});

test('register, reset-password, and accept-invite preserve existing minimum and complexity rules', () => {
  for (const schemaCase of complexPasswordSchemas) {
    for (const password of ['Aa1x', 'lowercase1', 'UPPERCASE1', 'NoNumberHere']) {
      assert.equal(
        schemaCase.parse(password).success,
        false,
        `${schemaCase.label} should preserve the existing rule for ${password}`,
      );
    }
  }
  assert.equal(loginSchema.safeParse({ email: 'member@charitypilot.ie', password: '' }).success, false);
});

test('password boundaries remain strict string inputs', () => {
  for (const schemaCase of passwordSchemas) {
    for (const password of [72, null, { value: 'A1accepted' }, ['A1accepted']]) {
      assert.equal(schemaCase.parse(password).success, false, `${schemaCase.label} must reject non-string input`);
    }
  }
});

test('legacy 128-character caps remain present alongside the stricter bcrypt byte cap', () => {
  const password = `A1a${'b'.repeat(126)}`;
  assert.equal(password.length, 129);
  for (const schemaCase of complexPasswordSchemas) {
    const parsed = schemaCase.parse(password);
    assert.equal(parsed.success, false);
    if (parsed.success) continue;
    assert.ok(parsed.error.issues.some(({ code }) => code === 'too_big'));
    assert.ok(parsed.error.issues.some(({ message }) => message === BCRYPT_PASSWORD_MAX_UTF8_BYTES_MESSAGE));
  }
});

test('every account identity schema enforces the shared 254-character email ceiling', () => {
  const suffix = '@example.com';
  const maximumEmail = `${'a'.repeat(MAX_ACCOUNT_EMAIL_LENGTH - suffix.length)}${suffix}`;
  const overlongEmail = `a${maximumEmail}`;
  assert.equal(maximumEmail.length, 254);
  assert.equal(overlongEmail.length, 255);

  const schemas = [
    registerSchema.pick({ email: true }),
    loginSchema.pick({ email: true }),
    forgotPasswordSchema,
    inviteTeamMemberSchema.pick({ email: true }),
  ];
  for (const schema of schemas) {
    assert.equal(schema.safeParse({ email: maximumEmail }).success, true);
    assert.equal(schema.safeParse({ email: overlongEmail }).success, false);
  }
});
