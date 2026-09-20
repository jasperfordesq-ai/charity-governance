import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'rate-limit-key-test-secret';

const [{ sessionOrAddressRateLimitKey }, { signAccessToken }] = await Promise.all([
  import('../utils/rate-limit-key.js'),
  import('../utils/jwt.js'),
]);

function request(headers: Record<string, string | string[] | undefined>, ip = '203.0.113.9') {
  return { headers, ip } as never;
}

function tokenFor(sessionId: string) {
  return signAccessToken({
    userId: 'u1',
    organisationId: 'org-1',
    role: 'ADMIN',
    sessionId,
  });
}

test('a request with no credential is counted against its address', () => {
  assert.equal(sessionOrAddressRateLimitKey(request({})), '203.0.113.9');
});

test('the web application keeps its address bucket, because it authenticates with a cookie', () => {
  // A cookie is never read here. The only credential this looks at is the
  // Authorization header, so a browser session cannot be moved off the
  // address bucket by anything it sends.
  const key = sessionOrAddressRateLimitKey(
    request({ cookie: `charitypilot_access=${tokenFor('sess-web')}` }),
  );
  assert.equal(key, '203.0.113.9');
});

test('a verified session is counted against itself, not against the machine it runs on', () => {
  const key = sessionOrAddressRateLimitKey(
    request({ authorization: `Bearer ${tokenFor('sess-connector')}` }),
  );
  assert.equal(key, 'session:sess-connector');
});

test('two sessions from one address do not spend each other’s budget', () => {
  const first = sessionOrAddressRateLimitKey(
    request({ authorization: `Bearer ${tokenFor('sess-a')}` }),
  );
  const second = sessionOrAddressRateLimitKey(
    request({ authorization: `Bearer ${tokenFor('sess-b')}` }),
  );
  assert.notEqual(first, second);
});

test('one session is counted the same whichever address it arrives from', () => {
  const token = tokenFor('sess-roaming');
  assert.equal(
    sessionOrAddressRateLimitKey(request({ authorization: `Bearer ${token}` }, '198.51.100.4')),
    sessionOrAddressRateLimitKey(request({ authorization: `Bearer ${token}` }, '203.0.113.9')),
  );
});

// The reason the signature is verified rather than the token merely hashed.
// Without this, anybody could evade the address limiter entirely by sending a
// different invented bearer value on every request.
test('an invented bearer token buys no bucket of its own', () => {
  for (const invented of ['not-a-token', 'a.b.c', `${tokenFor('sess-real')}tampered`]) {
    assert.equal(
      sessionOrAddressRateLimitKey(request({ authorization: `Bearer ${invented}` })),
      '203.0.113.9',
      `"${invented}" must fall back to the address`,
    );
  }
});

test('a token signed with the wrong secret buys no bucket of its own', async () => {
  const jwt = (await import('jsonwebtoken')).default;
  const forged = jwt.sign(
    { userId: 'u1', organisationId: 'org-1', role: 'ADMIN', sessionId: 'sess-forged' },
    'a-different-secret',
    {
      algorithm: 'HS256',
      issuer: 'charitypilot-api',
      audience: 'charitypilot-web',
      expiresIn: '15m',
    },
  );

  assert.equal(
    sessionOrAddressRateLimitKey(request({ authorization: `Bearer ${forged}` })),
    '203.0.113.9',
  );
});

test('an expired token buys no bucket of its own', async () => {
  const jwt = (await import('jsonwebtoken')).default;
  const stale = jwt.sign(
    { userId: 'u1', organisationId: 'org-1', role: 'ADMIN', sessionId: 'sess-stale' },
    process.env.JWT_SECRET as string,
    {
      algorithm: 'HS256',
      issuer: 'charitypilot-api',
      audience: 'charitypilot-web',
      expiresIn: '-1s',
    },
  );

  assert.equal(
    sessionOrAddressRateLimitKey(request({ authorization: `Bearer ${stale}` })),
    '203.0.113.9',
  );
});

test('a session identifier can never be mistaken for an address', () => {
  // The prefix is the whole reason: a deployment behind a proxy that reported
  // a session id as an address would otherwise share one bucket between them.
  const key = sessionOrAddressRateLimitKey(
    request({ authorization: `Bearer ${tokenFor('203.0.113.9')}` }),
  );
  assert.notEqual(key, '203.0.113.9');
  assert.equal(key, 'session:203.0.113.9');
});

// ── the limiter actually keyed by it ───────────────────────────────────────

test('two connector sessions from one address each get their own allowance', async () => {
  const [{ default: Fastify }, { default: rateLimit }] = await Promise.all([
    import('fastify'),
    import('@fastify/rate-limit'),
  ]);

  const app = Fastify({ logger: false });
  await app.register(rateLimit, {
    max: 2,
    timeWindow: '1 minute',
    keyGenerator: sessionOrAddressRateLimitKey,
  });
  app.get('/thing', async () => ({ ok: true }));

  const call = (sessionId: string) =>
    app.inject({
      method: 'GET',
      url: '/thing',
      headers: { authorization: `Bearer ${tokenFor(sessionId)}` },
    });

  assert.equal((await call('sess-one')).statusCode, 200);
  assert.equal((await call('sess-one')).statusCode, 200);
  assert.equal((await call('sess-one')).statusCode, 429, 'a session spends its own allowance');
  assert.equal(
    (await call('sess-two')).statusCode,
    200,
    'a second session on the same address must not have been spent by the first',
  );

  await app.close();
});

test('an unauthenticated flood still spends the address allowance', async () => {
  const [{ default: Fastify }, { default: rateLimit }] = await Promise.all([
    import('fastify'),
    import('@fastify/rate-limit'),
  ]);

  const app = Fastify({ logger: false });
  await app.register(rateLimit, {
    max: 2,
    timeWindow: '1 minute',
    keyGenerator: sessionOrAddressRateLimitKey,
  });
  app.get('/thing', async () => ({ ok: true }));

  // A different invented bearer value each time: the shape of an attempt to
  // mint a fresh bucket per request.
  const call = (invented: string) =>
    app.inject({ method: 'GET', url: '/thing', headers: { authorization: `Bearer ${invented}` } });

  assert.equal((await call('one')).statusCode, 200);
  assert.equal((await call('two')).statusCode, 200);
  assert.equal((await call('three')).statusCode, 429, 'invented tokens must share one bucket');

  await app.close();
});

test('the shared limiter is registered with this key generator', async () => {
  // The function above is only worth anything if the server uses it. A source
  // assertion rather than a boot, because starting the real server needs a
  // database, and this is the one line that would be silently dropped.
  const { readFile } = await import('node:fs/promises');
  const server = await readFile(new URL('../../src/server.ts', import.meta.url), 'utf8');

  assert.match(
    server,
    /await app\.register\(rateLimit, \{[\s\S]{0,600}?keyGenerator: sessionOrAddressRateLimitKey,[\s\S]{0,200}?\}\);/,
    'server.ts must pass sessionOrAddressRateLimitKey to the shared rate limiter',
  );
});
