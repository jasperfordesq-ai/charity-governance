import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'build-identity-test-secret';

const [{ default: Fastify }, { buildIdentity, isNewerRelease }, { healthRoutes }, { signAccessToken }] =
  await Promise.all([
    import('fastify'),
    import('../utils/build-identity.js'),
    import('../routes/health/index.js'),
    import('../utils/jwt.js'),
  ]);

const authorization = `Bearer ${signAccessToken({
  userId: 'u1',
  organisationId: 'org-1',
  role: 'ADMIN',
  sessionId: 'sess-1',
})}`;

async function buildApp() {
  const app = Fastify({ logger: false });
  app.decorate('prisma', {} as never);
  await app.register(healthRoutes, { prefix: '/api/v1/health' });
  return app;
}

test('the build knows its own version', () => {
  // Read from the package manifest rather than kept in a constant beside it,
  // because a constant is a second place to remember to change.
  assert.match(buildIdentity().version ?? '', /^\d+\.\d+\.\d+/);
});

test('health says nothing about the build to a caller with no credential', async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'ok');
    assert.equal(
      response.json().build,
      undefined,
      'a version is a free hint to anyone scanning for one',
    );
  } finally {
    await app.close();
  }
});

test('health says nothing about the build to an invented credential either', async () => {
  const app = await buildApp();
  try {
    for (const invented of ['Bearer not-a-token', 'Bearer a.b.c', 'Basic abcdef']) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/health',
        headers: { authorization: invented },
      });
      assert.equal(response.json().build, undefined, `"${invented}" must learn nothing`);
    }
  } finally {
    await app.close();
  }
});

test('health tells a signed-in caller which build it is', async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { authorization },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().build.version, buildIdentity().version);
  } finally {
    await app.close();
  }
});

test('the health check still answers, credential or not', async () => {
  // Whatever else changes here, a readiness probe with no credential must
  // keep getting its two hundred.
  const app = await buildApp();
  try {
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/health' });
    const signedIn = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { authorization },
    });

    assert.equal(anonymous.statusCode, 200);
    assert.equal(signedIn.statusCode, 200);
    assert.equal(anonymous.json().status, 'ok');
    assert.equal(signedIn.json().status, 'ok');
  } finally {
    await app.close();
  }
});

test('one release is newer than another by the three numbers', () => {
  assert.equal(isNewerRelease('0.2.0', '0.1.9'), true);
  assert.equal(isNewerRelease('1.0.0', '0.9.9'), true);
  assert.equal(isNewerRelease('0.1.10', '0.1.9'), true, 'ten is after nine, not before it');
  assert.equal(isNewerRelease('0.1.0', '0.1.0'), false);
  assert.equal(isNewerRelease('0.1.0', '0.2.0'), false);
});

test('an unreadable version produces no answer rather than a wrong one', () => {
  for (const [left, right] of [
    [null, '0.1.0'],
    ['0.1.0', null],
    ['nightly', '0.1.0'],
    ['0.1.0', 'nightly'],
  ] as const) {
    assert.equal(isNewerRelease(left, right), false, `${left} vs ${right}`);
  }
});
