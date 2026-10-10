import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'session-security-trace-test-jwt-secret';

const { networkPrefix, presentedTokenFingerprint, presentedTokenFingerprintFromHash, userAgentDigest,
  sessionTraceRetentionDays, pruneSessionSecurityTrace } = await import('../services/session-security-trace.js');
const { sessionSecurityTracePlugin } = await import('../plugins/session-security-trace.js');
const { requireSessionSecurityTraceRetention } = await import('../utils/env.js');
const { runSessionSecurityTracePrune } = await import('../jobs/production-scheduler.js');
const { REFRESH_TOKEN_COOKIE } = await import('../utils/auth-cookies.js');

test('the network prefix keeps a /24 or /48 and never the full address', () => {
  assert.equal(networkPrefix('203.0.113.77'), '203.0.113.0/24');
  assert.equal(networkPrefix('::ffff:198.51.100.9'), '198.51.100.0/24');
  assert.equal(networkPrefix('2001:db8:abcd:12:34::1'), '2001:db8:abcd::/48');
  assert.equal(networkPrefix('2001:db8::1'), '2001:db8:0::/48');
  assert.equal(networkPrefix('::1'), '0:0:0::/48');
  assert.equal(networkPrefix('fe80::1%eth0'), 'fe80:0:0::/48');
  for (const bad of [undefined, '', 'not-an-ip', '999.1.1.1']) assert.equal(networkPrefix(bad), null, String(bad));
});

test('the token fingerprint from the presented token equals the one from its stored hash', () => {
  const token = 'presented-refresh-token-value';
  const stored = createHash('sha256').update(token).digest('hex');
  assert.equal(presentedTokenFingerprint(token), presentedTokenFingerprintFromHash(stored));
  assert.match(presentedTokenFingerprint(token), /^[a-f0-9]{16}$/);
  assert.notEqual(presentedTokenFingerprint(token), presentedTokenFingerprint(`${token}x`));
  assert.ok(!presentedTokenFingerprint(token).includes(stored.slice(0, 16)), 'not a prefix of the stored hash');
  assert.match(userAgentDigest('Mozilla/5.0 Synthetic')!, /^[a-f0-9]{16}$/);
  assert.equal(userAgentDigest(undefined), null);
});

test('retention is off unless a whole number of days from 1 to 90 is set, and production says so', () => {
  const at = (value: string | undefined) => sessionTraceRetentionDays({ SESSION_SECURITY_TRACE_RETENTION_DAYS: value });
  assert.deepEqual([at(undefined), at(''), at('1'), at('30'), at('90')], [null, null, 1, 30, 90]);
  for (const bad of ['0', '91', '7.5', '-3', ' 30', '30d', '007']) {
    assert.equal(at(bad), null, bad);
    const issues: string[] = [];
    requireSessionSecurityTraceRetention(issues, { SESSION_SECURITY_TRACE_RETENTION_DAYS: bad });
    assert.equal(issues.length, 1, bad);
  }
  for (const fine of [undefined, '', '30']) {
    const issues: string[] = [];
    requireSessionSecurityTraceRetention(issues, { SESSION_SECURITY_TRACE_RETENTION_DAYS: fine });
    assert.deepEqual(issues, [], String(fine));
  }
});

test('the prune judges age by the database clock, and a failure raises a job alert', async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const prisma = { $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ sql: strings.join('?'), values });
    return 3;
  } };
  assert.equal(await pruneSessionSecurityTrace(prisma as never, 30), 3);
  assert.match(calls[0]!.sql, /DELETE FROM "SessionSecurityTrace"\s+WHERE "occurredAt" < CURRENT_TIMESTAMP - make_interval\(days => \?::integer\)/);
  assert.deepEqual(calls[0]!.values, [30]);
  for (const bad of [0, 91, 1.5]) await assert.rejects(pruneSessionSecurityTrace(prisma as never, bad), RangeError);
  const logged: string[] = [];
  const logger = { info: (m: string) => logged.push(m), warn: () => {}, error: (m: string) => logged.push(m) };
  const alerts: Array<{ code: string; job?: string }> = [];
  const alertSender = async (payload: { code: string }) => { alerts.push(payload); return true; };
  assert.equal(await runSessionSecurityTracePrune({ prisma: prisma as never, retentionDays: 30, logger,
    alertSender: alertSender as never }), false);
  assert.equal(alerts.length, 0);
  const broken = { $executeRaw: async () => { throw new Error('down'); } };
  assert.equal(await runSessionSecurityTracePrune({ prisma: broken as never, retentionDays: 30, logger,
    alertSender: alertSender as never }), true);
  assert.match(logged.join(' '), /retention failed/);
  assert.equal(alerts.length, 1);
  assert.match(JSON.stringify(alerts[0]), /SESSION_SECURITY_TRACE_PRUNE_FAILED/);
});

async function buildApp(env: string | undefined, rows: Array<Record<string, unknown>>, createFails = false,
  logLines: string[] = []) {
  const saved = process.env.SESSION_SECURITY_TRACE_RETENTION_DAYS;
  if (env === undefined) delete process.env.SESSION_SECURITY_TRACE_RETENTION_DAYS;
  else process.env.SESSION_SECURITY_TRACE_RETENTION_DAYS = env;
  const app = Fastify({ trustProxy: true,
    logger: { level: 'error', stream: { write: (line: string) => { logLines.push(line); } } } });
  app.decorate('prisma', { sessionSecurityTrace: { create: async ({ data }: { data: Record<string, unknown> }) => {
    if (createFails) throw new Error('database is on fire');
    rows.push(data);
    return data;
  } } } as never);
  await app.register(cookie);
  try {
    await app.register(sessionSecurityTracePlugin);
  } finally {
    if (saved === undefined) delete process.env.SESSION_SECURITY_TRACE_RETENTION_DAYS;
    else process.env.SESSION_SECURITY_TRACE_RETENTION_DAYS = saved;
  }
  for (const path of ['/api/v1/auth/login', '/api/v1/auth/refresh', '/api/v1/auth/logout',
    '/api/v1/auth/connector/refresh', '/api/v1/auth/change-password']) {
    app.post(path, async (_request, reply) => reply.status(path.endsWith('logout') ? 200 : 401).send({}));
  }
  app.get('/api/v1/auth/refresh', async () => ({}));
  return app;
}

test('with tracing on, each sign-in, refresh and sign-out request leaves one minimal row', async () => {
  const rows: Array<Record<string, unknown>> = [];
  const app = await buildApp('30', rows);
  const ua = { 'user-agent': 'Synthetic Browser', 'x-forwarded-for': '203.0.113.77' };
  await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: ua,
    cookies: { [REFRESH_TOKEN_COOKIE]: 'cookie-token' } });
  await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: ua, payload: { refreshToken: 'body-token' } });
  await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: ua,
    payload: { email: 'a@example.org', password: 'secret', refreshToken: 'ignored' } });
  // The connector scope has no cookie; one sent anyway is not read.
  await app.inject({ method: 'POST', url: '/api/v1/auth/connector/refresh', headers: ua,
    cookies: { [REFRESH_TOKEN_COOKIE]: 'stray-cookie' } });
  await app.inject({ method: 'POST', url: '/api/v1/auth/change-password', headers: ua });
  await app.inject({ method: 'GET', url: '/api/v1/auth/refresh', headers: ua });
  assert.deepEqual(rows.map((r) => [r.routePattern, r.statusCode, r.presentedTokenFingerprint]), [
    ['/api/v1/auth/refresh', 401, presentedTokenFingerprint('cookie-token')],
    ['/api/v1/auth/logout', 200, presentedTokenFingerprint('body-token')],
    ['/api/v1/auth/login', 401, null],
    ['/api/v1/auth/connector/refresh', 401, null],
  ]);
  for (const row of rows) {
    assert.deepEqual([row.networkPrefix, row.userAgentDigest], ['203.0.113.0/24', userAgentDigest('Synthetic Browser')]);
    assert.equal(typeof row.requestId, 'string');
    assert.ok(!JSON.stringify(row).includes('cookie-token') && !JSON.stringify(row).includes('203.0.113.77'));
  }
  await app.close();
});

test('with tracing off there is no hook, and a failed write never changes the response', async () => {
  const rows: Array<Record<string, unknown>> = [];
  const off = await buildApp(undefined, rows);
  await off.inject({ method: 'POST', url: '/api/v1/auth/logout', payload: { refreshToken: 'x' } });
  assert.equal(rows.length, 0);
  await off.close();
  const logLines: string[] = [];
  const failing = await buildApp('30', rows, true, logLines);
  const response = await failing.inject({ method: 'POST', url: '/api/v1/auth/logout', payload: { refreshToken: 'x' } });
  assert.equal(response.statusCode, 200);
  // The lost row is reported by name, with its route, not as a hook failure.
  const logged = logLines.map((line) => JSON.parse(line) as { msg: string; routePattern?: string });
  assert.ok(logged.some((entry) => entry.msg === 'Failed to record session security trace'
    && entry.routePattern === '/api/v1/auth/logout'), JSON.stringify(logged));
  await failing.close();
});
