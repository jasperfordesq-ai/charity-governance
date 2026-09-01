import assert from 'node:assert/strict';
import test from 'node:test';

const [{ default: Fastify }, { healthRoutes }] = await Promise.all([
  import('fastify'),
  import('../routes/health/index.js'),
]);

const originalReadinessKey = process.env.READINESS_API_KEY;
const originalBuildCommit = process.env.CHARITYPILOT_BUILD_COMMIT;

async function buildHealthApp() {
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    $queryRaw: async () => [{ result: 1 }],
  } as never);
  await app.register(healthRoutes, { prefix: '/api/v1/health' });
  return app;
}

test('readiness payload includes buildCommit field when set', { concurrency: false }, async () => {
  process.env.READINESS_API_KEY = 'readiness-test-secret';
  process.env.CHARITYPILOT_BUILD_COMMIT = 'abc1234';
  const app = await buildHealthApp();

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health/readiness',
      headers: { 'x-charitypilot-readiness-key': 'readiness-test-secret' },
    });
    const body = response.json();

    // buildCommit should be present in the response regardless of readiness status
    assert('buildCommit' in body, 'buildCommit field should exist in readiness payload');
    assert.equal(body.buildCommit, 'abc1234');
  } finally {
    process.env.READINESS_API_KEY = originalReadinessKey;
    process.env.CHARITYPILOT_BUILD_COMMIT = originalBuildCommit;
    await app.close();
  }
});

test('readiness payload includes buildCommit: null when unset', { concurrency: false }, async () => {
  process.env.READINESS_API_KEY = 'readiness-test-secret';
  delete process.env.CHARITYPILOT_BUILD_COMMIT;
  const app = await buildHealthApp();

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health/readiness',
      headers: { 'x-charitypilot-readiness-key': 'readiness-test-secret' },
    });
    const body = response.json();

    assert('buildCommit' in body, 'buildCommit field should exist in readiness payload');
    assert.equal(body.buildCommit, null);
  } finally {
    process.env.READINESS_API_KEY = originalReadinessKey;
    process.env.CHARITYPILOT_BUILD_COMMIT = originalBuildCommit;
    await app.close();
  }
});

test('readiness payload includes buildCommit: null when empty string', { concurrency: false }, async () => {
  process.env.READINESS_API_KEY = 'readiness-test-secret';
  process.env.CHARITYPILOT_BUILD_COMMIT = '';
  const app = await buildHealthApp();

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health/readiness',
      headers: { 'x-charitypilot-readiness-key': 'readiness-test-secret' },
    });
    const body = response.json();

    assert('buildCommit' in body, 'buildCommit field should exist in readiness payload');
    assert.equal(body.buildCommit, null);
  } finally {
    process.env.READINESS_API_KEY = originalReadinessKey;
    process.env.CHARITYPILOT_BUILD_COMMIT = originalBuildCommit;
    await app.close();
  }
});

test('readiness verdict unaffected by buildCommit', { concurrency: false }, async () => {
  process.env.READINESS_API_KEY = 'readiness-test-secret';
  process.env.CHARITYPILOT_BUILD_COMMIT = 'test-commit';
  const app = await buildHealthApp();

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health/readiness',
      headers: { 'x-charitypilot-readiness-key': 'readiness-test-secret' },
    });
    const body = response.json();

    // Readiness verdict should still be based on existing checks, not buildCommit
    assert('status' in body, 'readiness response should have status field');
    assert('checks' in body, 'readiness response should have checks field');
    assert('buildCommit' in body, 'readiness response should have buildCommit field');
    assert.equal(body.buildCommit, 'test-commit');
  } finally {
    process.env.READINESS_API_KEY = originalReadinessKey;
    process.env.CHARITYPILOT_BUILD_COMMIT = originalBuildCommit;
    await app.close();
  }
});
