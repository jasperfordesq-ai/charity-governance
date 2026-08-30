import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'tenant-secret-bootstrap-test';

const [{ createPlatformOperator, assertOperatorBootstrapRuntime }] = await Promise.all([
  import('../jobs/create-platform-operator.js'),
]);

function prismaStub(existing: unknown = null) {
  const created: Record<string, unknown>[] = [];
  return {
    created,
    prisma: {
      platformOperator: {
        findUnique: async () => existing,
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
    () => createPlatformOperator(prisma, { email: 'Owner@Example.org', name: 'Owner' }),
    /canonical lowercase/,
  );
});

test('creating an operator stores a hashed reset token and no usable password', async () => {
  const { prisma, created } = prismaStub();
  const result = await createPlatformOperator(prisma, { email: 'owner@example.org', name: 'Owner' });

  assert.ok(result.resetToken.length > 0);
  const row = created[0];
  assert.notEqual(row.resetToken, result.resetToken, 'only the hash of the reset token may be stored');
  assert.equal(typeof row.passwordHash, 'string');
  assert.notEqual(row.passwordHash, '', 'an unusable placeholder hash must still be present');
});

test('a duplicate operator email is refused', async () => {
  const { prisma } = prismaStub({ id: 'op-existing' });
  await assert.rejects(
    () => createPlatformOperator(prisma, { email: 'owner@example.org', name: 'Owner' }),
    /already exists/,
  );
});
