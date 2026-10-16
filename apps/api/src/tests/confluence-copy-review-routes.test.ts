import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { RetainedCopyReviewRoutesOptions } from '../routes/integrations/retained-copy-reviews.js';

process.env.JWT_SECRET ??= 'synthetic-copy-review-route-secret';
const { retainedCopyReviewRoutes } = await import('../routes/integrations/retained-copy-reviews.js');
const { signAccessToken } = await import('../utils/jwt.js');
const { AppError } = await import('../utils/app-error.js');

async function fixture(role: 'OWNER' | 'ADMIN' | 'MEMBER' = 'OWNER', clientKind = 'WEB', revoked = false, dataScope = 'FULL') {
  const calls: unknown[][] = [];
  const app = Fastify();
  await app.register(rateLimit, { global: false });
  app.decorate('prisma', {
    authSession: { findFirst: async () => revoked ? null : { id: 'session-a', familyId: 'family-a', clientKind, accessLevel: 'ADMIN', dataScope } },
    user: { findUnique: async () => ({ id: 'owner-a', organisationId: 'org-a', role, emailVerified: true }) },
  } as never);
  const deps: NonNullable<RetainedCopyReviewRoutesOptions['deps']> = {
    observe: async (_db, input) => { calls.push(['observe', input]); return {
      snapshot: { publicationId: 'pub-a' }, sourceBytesObserved: true, connection: { integrationId: 'internal-only' },
      actionAuthorized: false, syntheticVerified: false, allCopiesVerified: false,
    } as never; },
    reviews: {
      record: async (...args) => { calls.push(['record', ...args]); return { id: 'review-a', snapshotSha256: 'a'.repeat(64),
        reviewedAt: new Date(), expiresAt: new Date(), authorisesProviderIO: false } as never; },
      withdraw: async (...args) => { calls.push(['withdraw', ...args]); return { id: 'withdrawal-a' } as never; },
    },
  };
  await app.register(retainedCopyReviewRoutes, { prefix: '/reviews', deps });
  const headers = { authorization: `Bearer ${signAccessToken({ userId: 'owner-a', organisationId: 'org-a', role, sessionId: 'session-a' })}` };
  return { app, headers, calls };
}

const paths = ['/observe/pub-a', '/', '/review-a/withdraw'];
test('inventory observations are throttled and oversize reviews cannot reach persistence', async () => {
  const h = await fixture();
  try {
    for (let i = 0; i < 4; i++) assert.equal((await h.app.inject({ method: 'POST', url: '/reviews/observe/pub-a', headers: h.headers, payload: {} })).statusCode, 200);
    const throttled = await h.app.inject({ method: 'POST', url: '/reviews/observe/pub-a', headers: h.headers, payload: {} });
    assert.equal(throttled.statusCode, 429);
    assert.equal(throttled.headers['cache-control'], 'no-store');
    assert.equal(h.calls.length, 4);
    const oversized = await h.app.inject({ method: 'POST', url: '/reviews/', headers: h.headers, payload: { text: 'x'.repeat(129 * 1024) } });
    assert.equal(oversized.statusCode, 413);
    assert.equal(oversized.headers['cache-control'], 'no-store');
    assert.equal(h.calls.length, 4);
  } finally { await h.app.close(); }
});
test('Owner with withheld data scope cannot observe or record review evidence', async () => {
  const h = await fixture('OWNER', 'WEB', false, 'WITHHELD');
  try {
    for (const path of paths) assert.equal((await h.app.inject({ method: 'POST', url: `/reviews${path}`, headers: h.headers, payload: {} })).statusCode, 403);
    assert.equal(h.calls.length, 0);
  } finally { await h.app.close(); }
});
for (const [label, role, clientKind, revoked] of [
  ['admin', 'ADMIN', 'WEB', false], ['member', 'MEMBER', 'WEB', false],
  ['connector Owner', 'OWNER', 'MCP_CONNECTOR', false], ['revoked Owner', 'OWNER', 'WEB', true],
] as const) test(`copy review refuses ${label} before observation or persistence`, async () => {
  const h = await fixture(role, clientKind, revoked);
  try {
    for (const path of paths) {
      const r = await h.app.inject({ method: 'POST', url: `/reviews${path}`, headers: h.headers, payload: {} });
      assert.equal(r.statusCode, revoked ? 401 : 403);
      assert.equal(r.headers['cache-control'], 'no-store');
    }
    assert.equal(h.calls.length, 0);
  } finally { await h.app.close(); }
});

test('observation binds actor and tenant to authentication and exposes no connection credentials or authority', async () => {
  const h = await fixture();
  try {
    const r = await h.app.inject({ method: 'POST', url: '/reviews/observe/pub-a', headers: h.headers, payload: {} });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(h.calls, [['observe', { organisationId: 'org-a', actorUserId: 'owner-a', publicationId: 'pub-a' }]]);
    assert.equal(r.json().data.actionAuthorized, false);
    assert.equal(r.json().data.syntheticVerified, false);
    assert.equal(r.json().data.allCopiesVerified, false);
    assert.equal(r.json().data.connection, undefined);
    assert.equal(r.headers['cache-control'], 'no-store');
    for (const extra of [{ organisationId: 'org-b' }, { integrationId: 'foreign' }, { pageId: 'remote' }]) {
      const refusal = await h.app.inject({ method: 'POST', url: '/reviews/observe/pub-a', headers: h.headers, payload: extra });
      assert.equal(refusal.statusCode, 400);
    }
    assert.equal(h.calls.length, 1);
  } finally { await h.app.close(); }
});

test('record and withdrawal pass authenticated scope to the guarded services without issuing permission', async () => {
  const h = await fixture();
  try {
    const review = { synthetic: 'fixture body validated by the real service in its own tests' };
    const r = await h.app.inject({ method: 'POST', url: '/reviews/', headers: h.headers, payload: review });
    assert.equal(r.statusCode, 201);
    assert.deepEqual(h.calls[0], ['record', 'org-a', 'owner-a', review]);
    assert.equal(r.json().data.authorisesProviderIO, false);
    const withdrawal = { evidenceRef: 'C01-WITHDRAW', reason: 'Withdraw the exact synthetic review.' };
    const w = await h.app.inject({ method: 'POST', url: '/reviews/review-a/withdraw', headers: h.headers, payload: withdrawal });
    assert.equal(w.statusCode, 201);
    assert.deepEqual(h.calls[1], ['withdraw', 'org-a', 'owner-a', 'review-a', withdrawal]);
    assert.equal(w.json().data.authorisesProviderIO, false);
    assert.equal((await h.app.inject({ method: 'POST', url: '/reviews/review-a/execute', headers: h.headers, payload: {} })).statusCode, 404);
  } finally { await h.app.close(); }
});

test('unauthenticated and ambiguous-query requests cannot reach review dependencies', async () => {
  const h = await fixture();
  try {
    assert.equal((await h.app.inject({ method: 'POST', url: '/reviews/observe/pub-a', payload: {} })).statusCode, 401);
    for (const path of paths) {
      assert.equal((await h.app.inject({ method: 'POST', url: `/reviews${path}?organisationId=org-b`, headers: h.headers, payload: {} })).statusCode, 400);
    }
    assert.equal(h.calls.length, 0);
  } finally { await h.app.close(); }
});

test('service refusal remains a refusal and cannot become a recorded success', async () => {
  const app = Fastify();
  app.decorate('prisma', {
    authSession: { findFirst: async () => ({ id: 'session-a', clientKind: 'WEB', accessLevel: 'ADMIN' }) },
    user: { findUnique: async () => ({ id: 'owner-a', organisationId: 'org-a', role: 'OWNER', emailVerified: true }) },
  } as never);
  await app.register(retainedCopyReviewRoutes, { prefix: '/reviews', deps: {
    observe: async () => { throw new AppError(409, 'CONFLUENCE_COPY_SOURCE_UNVERIFIED', 'Source changed.'); },
  } });
  try {
    const authorization = `Bearer ${signAccessToken({ userId: 'owner-a', organisationId: 'org-a', role: 'OWNER', sessionId: 'session-a' })}`;
    const r = await app.inject({ method: 'POST', url: '/reviews/observe/pub-a', headers: { authorization }, payload: {} });
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().code, 'CONFLUENCE_COPY_SOURCE_UNVERIFIED');
    assert.equal(r.headers['cache-control'], 'no-store');
  } finally { await app.close(); }
});
