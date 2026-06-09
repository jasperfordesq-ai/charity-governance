import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

const [{ default: Fastify }, { securityHeadersPlugin }] = await Promise.all([
  import('fastify'),
  import('../plugins/security-headers.js'),
]);

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
});

async function buildSecurityHeadersApp() {
  const app = Fastify({ logger: false });
  await app.register(securityHeadersPlugin);

  app.get('/ok', async () => ({ ok: true }));

  return app;
}

test('API responses include baseline security headers', async () => {
  process.env.NODE_ENV = 'test';
  const app = await buildSecurityHeadersApp();

  try {
    const response = await app.inject({ method: 'GET', url: '/ok' });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.equal(response.headers['referrer-policy'], 'strict-origin-when-cross-origin');
    assert.equal(response.headers['permissions-policy'], 'camera=(), microphone=(), geolocation=(), payment=()');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers.pragma, 'no-cache');
    assert.equal(response.headers.expires, '0');
    assert.equal(
      response.headers['content-security-policy'],
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    assert.equal(response.headers['strict-transport-security'], undefined);
  } finally {
    await app.close();
  }
});

test('API responses include HSTS in production', async () => {
  process.env.NODE_ENV = 'production';
  const app = await buildSecurityHeadersApp();

  try {
    const response = await app.inject({ method: 'GET', url: '/ok' });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['strict-transport-security'], 'max-age=63072000; includeSubDomains; preload');
  } finally {
    await app.close();
  }
});

test('API responses preserve route-specific content security policies', async () => {
  process.env.NODE_ENV = 'test';
  const routeSpecificCsp = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'";
  const app = Fastify({ logger: false });

  await app.register(securityHeadersPlugin);
  app.get('/html', async (_request, reply) => {
    return reply.header('Content-Security-Policy', routeSpecificCsp).type('text/html').send('<!doctype html>');
  });

  try {
    const response = await app.inject({ method: 'GET', url: '/html' });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-security-policy'], routeSpecificCsp);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  } finally {
    await app.close();
  }
});

test('API responses preserve route-specific cache policies', async () => {
  process.env.NODE_ENV = 'test';
  const routeSpecificCachePolicy = 'public, max-age=60';
  const app = Fastify({ logger: false });

  await app.register(securityHeadersPlugin);
  app.get('/cacheable', async (_request, reply) => {
    return reply.header('Cache-Control', routeSpecificCachePolicy).send({ ok: true });
  });

  try {
    const response = await app.inject({ method: 'GET', url: '/cacheable' });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], routeSpecificCachePolicy);
    assert.equal(response.headers.pragma, undefined);
    assert.equal(response.headers.expires, undefined);
  } finally {
    await app.close();
  }
});
