import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { healthRoutes } from '../routes/health/index.js';

const INSTANCE_ID = '9d9899dc-9bea-45ca-a916-c9a2e023e46e';
const READINESS_KEY = 'e2e-readiness-key-with-enough-entropy';
const ENV_KEYS = [
  'NODE_ENV',
  'READINESS_API_KEY',
  'E2E_DATABASE_IDENTITY_PROBE_ENABLED',
  'E2E_DATABASE_INSTANCE_ID',
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function buildApp(queryRaw: () => Promise<unknown>) {
  const app = Fastify({ logger: false });
  app.decorate('prisma', { $queryRaw: queryRaw } as never);
  await app.register(healthRoutes, { prefix: '/api/v1/health' });
  return app;
}

function enableProbe(): void {
  process.env.NODE_ENV = 'test';
  process.env.READINESS_API_KEY = READINESS_KEY;
  process.env.E2E_DATABASE_IDENTITY_PROBE_ENABLED = 'true';
  process.env.E2E_DATABASE_INSTANCE_ID = INSTANCE_ID;
}

function validIdentity(overrides: Record<string, unknown> = {}) {
  return {
    singleton: true,
    marker_version: 1,
    purpose: 'charitypilot-e2e-disposable',
    instance_id: INSTANCE_ID,
    database_name: 'charitypilot_e2e_disposable',
    session_user: 'charitypilot_e2e_runner',
    current_user: 'charitypilot_e2e_runner',
    current_schema: 'public',
    database_comment: 'CHARITYPILOT_DISPOSABLE_E2E_DATABASE_V1',
    role_superuser: false,
    role_create_role: false,
    role_create_database: false,
    role_replication: false,
    role_bypass_rls: false,
    role_inherit: false,
    role_membership_count: 0,
    database_owner: 'charitypilot_e2e_bootstrap',
    marker_schema_owner: 'charitypilot_e2e_bootstrap',
    marker_table_owner: 'charitypilot_e2e_bootstrap',
    marker_schema_create: false,
    marker_table_mutation: false,
    ...overrides,
  };
}

test('E2E database identity probe is hidden when disabled or in production and never queries', { concurrency: false }, async () => {
  const snapshot = snapshotEnv();
  let queryCount = 0;
  const app = await buildApp(async () => {
    queryCount += 1;
    return [];
  });

  try {
    delete process.env.E2E_DATABASE_IDENTITY_PROBE_ENABLED;
    process.env.NODE_ENV = 'test';
    let response = await app.inject({ method: 'GET', url: '/api/v1/health/e2e-database-identity' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.json(), { error: 'Not found', code: 'NOT_FOUND' });

    enableProbe();
    process.env.NODE_ENV = 'production';
    response = await app.inject({
      method: 'GET',
      url: '/api/v1/health/e2e-database-identity',
      headers: { 'x-charitypilot-readiness-key': READINESS_KEY },
    });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { error: 'Not found', code: 'NOT_FOUND' });
    assert.equal(queryCount, 0);
  } finally {
    await app.close();
    restoreEnv(snapshot);
  }
});

test('E2E database identity probe rejects missing/wrong keys before querying', { concurrency: false }, async () => {
  const snapshot = snapshotEnv();
  let queryCount = 0;
  const app = await buildApp(async () => {
    queryCount += 1;
    return [];
  });
  enableProbe();

  try {
    for (const headers of [undefined, { 'x-charitypilot-readiness-key': 'wrong-key-with-enough-entropy' }]) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/health/e2e-database-identity',
        headers,
      });
      assert.equal(response.statusCode, 401);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.deepEqual(response.json(), { error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }
    assert.equal(queryCount, 0);
  } finally {
    await app.close();
    restoreEnv(snapshot);
  }
});

test('E2E database identity probe returns only the exact bound instance with no-store', { concurrency: false }, async () => {
  const snapshot = snapshotEnv();
  let queryCount = 0;
  const app = await buildApp(async () => {
    queryCount += 1;
    return [validIdentity()];
  });
  enableProbe();

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health/e2e-database-identity',
      headers: { 'x-charitypilot-readiness-key': READINESS_KEY },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.json(), { status: 'bound', instanceId: INSTANCE_ID });
    assert.equal(queryCount, 1);
  } finally {
    await app.close();
    restoreEnv(snapshot);
  }
});

test('E2E database identity probe fails closed for marker mismatch, extra rows, and query failure', { concurrency: false }, async () => {
  const snapshot = snapshotEnv();
  enableProbe();
  const cases: Array<() => Promise<unknown>> = [
    async () => [validIdentity({ instance_id: randomUUID() })],
    async () => [validIdentity({ singleton: false })],
    async () => [validIdentity({ database_name: 'charitypilot' })],
    async () => [validIdentity({ session_user: 'charitypilot_e2e_bootstrap' })],
    async () => [validIdentity({ current_schema: 'charitypilot_e2e_guard' })],
    async () => [validIdentity({ database_comment: 'copied marker' })],
    async () => [validIdentity({ role_superuser: true })],
    async () => [validIdentity({ role_create_database: true })],
    async () => [validIdentity({ role_inherit: true })],
    async () => [validIdentity({ role_membership_count: 1 })],
    async () => [validIdentity({ database_owner: 'charitypilot_e2e_runner' })],
    async () => [validIdentity({ marker_schema_owner: 'charitypilot_e2e_runner' })],
    async () => [validIdentity({ marker_table_owner: 'charitypilot_e2e_runner' })],
    async () => [validIdentity({ marker_schema_create: true })],
    async () => [validIdentity({ marker_table_mutation: true })],
    async () => [
      validIdentity(),
      validIdentity(),
    ],
    async () => { throw new Error(`do not expose ${INSTANCE_ID}`); },
  ];

  try {
    for (const queryRaw of cases) {
      const app = await buildApp(queryRaw);
      try {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/health/e2e-database-identity',
          headers: { 'x-charitypilot-readiness-key': READINESS_KEY },
        });
        assert.equal(response.statusCode, 503);
        assert.equal(response.headers['cache-control'], 'no-store');
        assert.deepEqual(response.json(), {
          error: 'Database binding unavailable',
          code: 'DATABASE_BINDING_UNAVAILABLE',
        });
        assert.doesNotMatch(response.body, new RegExp(INSTANCE_ID));
      } finally {
        await app.close();
      }
    }
  } finally {
    restoreEnv(snapshot);
  }
});

test('E2E API binding query accepts only a real/partitioned protected marker table', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'routes', 'health', 'index.ts'),
    'utf8',
  );
  assert.match(source, /marker_table\.relkind IN \('r', 'p'\)/);
});
