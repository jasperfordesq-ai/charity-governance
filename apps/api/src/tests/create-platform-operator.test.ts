import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'tenant-secret-bootstrap-test';

const [{ createPlatformOperator, reissuePlatformOperatorResetToken, assertOperatorBootstrapRuntime }] = await Promise.all([
  import('../jobs/create-platform-operator.js'),
]);

function prismaStub(existing: Record<string, unknown> | null = null) {
  const created: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  return {
    created,
    updated,
    prisma: {
      platformOperator: {
        findUnique: async ({ where }: { where: Record<string, unknown> }) => {
          // Honor the where clause: only return if email matches
          if (existing && 'email' in existing && where.email === existing.email) {
            return existing;
          }
          return null;
        },
        update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          updated.push({ ...where, ...data });
          return { id: existing?.id ?? 'op-1', ...existing, ...data };
        },
        create: async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: 'op-1', ...data };
        },
      },
    } as never,
  };
}

test('the runtime guard requires production', () => {
  assert.throws(
    () => assertOperatorBootstrapRuntime({ NODE_ENV: 'development' } as NodeJS.ProcessEnv),
    /NODE_ENV=production/,
  );
});

test('the runtime guard refuses personal-server mode', () => {
  assert.throws(
    () =>
      assertOperatorBootstrapRuntime({
        NODE_ENV: 'production',
        CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server',
      } as NodeJS.ProcessEnv),
    /personal-server/,
  );
});

test('a non-canonical email is rejected', async () => {
  const { prisma } = prismaStub();
  await assert.rejects(
    () =>
      createPlatformOperator(prisma, { email: 'Owner@Example.org', name: 'Owner' }, {
        APP_ORIGIN: 'https://console.example.org',
      }),
    /canonical lowercase/,
  );
});

test('creating an operator stores a hashed reset token and no usable password', async () => {
  const { prisma, created } = prismaStub();
  const result = await createPlatformOperator(prisma, { email: 'owner@example.org', name: 'Owner' }, {
    APP_ORIGIN: 'https://console.example.org',
  });

  assert.ok(result.resetToken.length > 0);
  const row = created[0];
  assert.notEqual(row.resetToken, result.resetToken, 'only the hash of the reset token may be stored');
  assert.equal(typeof row.passwordHash, 'string');
  assert.notEqual(row.passwordHash, '', 'an unusable placeholder hash must still be present');
});

test('a duplicate operator email is refused', async () => {
  const { prisma } = prismaStub({ id: 'op-existing', email: 'owner@example.org' });
  await assert.rejects(
    () =>
      createPlatformOperator(prisma, { email: 'owner@example.org', name: 'Owner' }, {
        APP_ORIGIN: 'https://console.example.org',
      }),
    /already exists/,
  );
});

test('a different existing email does not block creation', async () => {
  const { prisma, created } = prismaStub({ id: 'op-other', email: 'other@example.org' });
  const result = await createPlatformOperator(prisma, { email: 'owner@example.org', name: 'Owner' }, {
    APP_ORIGIN: 'https://console.example.org',
  });
  assert.equal(result.operatorId, 'op-1');
  assert.equal(created[0].email, 'owner@example.org');
});

test('missing origin env vars is rejected before creating operator', async () => {
  const { prisma, created } = prismaStub();
  await assert.rejects(
    () => createPlatformOperator(prisma, { email: 'owner@example.org', name: 'Owner' }, {}),
    /OWNER_CONSOLE_ORIGIN.*APP_ORIGIN/,
  );
  assert.equal(created.length, 0, 'no operator should be created on validation failure');
});

test('invalid origin is rejected before creating operator', async () => {
  const { prisma, created } = prismaStub();
  await assert.rejects(
    () => createPlatformOperator(prisma, { email: 'owner@example.org', name: 'Owner' }, { APP_ORIGIN: '/relative/path' }),
    /absolute.*http/,
  );
  assert.equal(created.length, 0, 'no operator should be created on validation failure');
});

test('reissue on non-existent email fails clearly', async () => {
  const { prisma, created } = prismaStub();
  await assert.rejects(
    () =>
      reissuePlatformOperatorResetToken(prisma, 'nonexistent@example.org', { APP_ORIGIN: 'https://console.example.org' }),
    /not found/,
  );
  assert.equal(created.length, 0);
});

test('reissue on existing operator updates token and expiry', async () => {
  const existing = {
    id: 'op-existing',
    email: 'owner@example.org',
    name: 'Owner',
    passwordHash: 'hash-of-original',
    lifecycleStatus: 'active',
  };
  const { prisma, updated } = prismaStub(existing);
  const result = await reissuePlatformOperatorResetToken(prisma, 'owner@example.org', { APP_ORIGIN: 'https://console.example.org' });

  assert.ok(result.resetToken.length > 0);
  assert.equal(updated.length, 1);
  const update = updated[0];
  assert.notEqual(update.resetToken, result.resetToken, 'only the hash of the reset token may be stored');
  assert.ok(update.resetTokenExpiry instanceof Date);
  // Verify name, passwordHash, and lifecycleStatus were NOT changed
  assert.equal(update.name, undefined, 'name should not be updated');
  assert.equal(update.passwordHash, undefined, 'passwordHash should not be updated');
  assert.equal(update.lifecycleStatus, undefined, 'lifecycleStatus should not be updated');
});

test('create with --reissue flag calls reissue function', async () => {
  const existing = {
    id: 'op-existing',
    email: 'owner@example.org',
    name: 'Owner',
    passwordHash: 'hash-of-original',
  };
  const { prisma, updated, created } = prismaStub(existing);
  const result = await createPlatformOperator(
    prisma,
    { email: 'owner@example.org', name: 'Owner' },
    { APP_ORIGIN: 'https://console.example.org' },
    true, // reissue flag
  );

  assert.ok(result.resetToken.length > 0);
  assert.equal(created.length, 0, 'no new operator should be created');
  assert.equal(updated.length, 1, 'should reissue for existing operator');
});
