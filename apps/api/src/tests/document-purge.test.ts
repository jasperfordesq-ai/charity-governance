import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { DocumentPurgeService, purgeAuthorizationInput, purgeDispositionInput } from '../services/document-purge.service.js';
import { registerDocumentPurgeRoutes } from '../routes/documents/purge.js';

const date = new Date('2026-09-30T12:00:00Z');
const bytes = Buffer.from('retained synthetic bytes');
const plan = Object.fromEntries(['PRIMARY','VERSIONS','CONFLUENCE','EXPORTS','AUDIT','BACKUPS'].map(area =>
  [area, { disposition: area === 'PRIMARY' ? 'DISPOSE' : 'RETAIN_APPROVED', evidenceRef: `PLAN-${area}-001` }]));
const input = { documentId: 'doc-a', policyId: 'policy-a', expectedUpdatedAt: date.toISOString(),
  evidenceRef: 'AUTH-001', reason: 'Synthetic evidence reviewed for disposal.', authorityConfirmed: true, dispositionPlan: plan };

function fixture() {
  const state = { role: 'OWNER', bytes, auth: null as any, writes: [] as any[], claims: 0,
    document: { id: 'doc-a', organisationId: 'org-a', updatedAt: date, deletedAt: date,
      deletionHold: false, fileUrl: 'org-a/pinned.txt', storageProvider: 'local', fileSize: bytes.length,
      recoverySha256: createHash('sha256').update(bytes).digest('hex'), recoveryUntil: date } as any,
    databaseFailure: null as any, listArgs: null as any, dispositionArgs: null as any, dispositionRows: [] as any[] };
  const tx: any = {
    $queryRaw: async () => [],
    user: { findFirst: async ({ where }: any) => where.id === 'owner-a' && where.organisationId === 'org-a' && state.role === 'OWNER' ? { id: 'owner-a' } : null },
    document: { findFirst: async ({ where }: any) => state.document?.id === where.id && where.organisationId === 'org-a' ? state.document : null },
    documentPurgeAuthorization: {
      findFirst: async ({ where }: any) => state.auth?.id === where.id && state.auth.organisationId === where.organisationId ? state.auth : null,
      findMany: async (args: any) => { state.listArgs = args; return []; },
      create: async ({ data }: any) => { if (state.databaseFailure) throw state.databaseFailure; state.writes.push(data);
        state.auth = { ...data, id: 'auth-a', withdrawal: null, claim: null }; return state.auth; },
    },
    documentPurgeDispositionEvent: {
      findFirst: async ({ where }: any) => state.dispositionRows.find(row => row.id === where.id && row.organisationId === where.organisationId && row.authorizationId === where.authorizationId) ?? null,
      findMany: async (args: any) => { state.dispositionArgs = args; return state.dispositionRows; },
      create: async (args: any) => { if (state.databaseFailure) throw state.databaseFailure; state.dispositionArgs = args; state.writes.push(args.data); return args.data; },
    },
    documentPurgeAuthorizationWithdrawal: { create: async ({ data }: any) => { state.writes.push(data); return data; } },
    documentPurgeClaim: { create: async ({ data }: any) => {
      if (state.databaseFailure) throw state.databaseFailure;
      state.claims++; state.auth.claim = { id: 'claim-a', deletionId: data.deletionId, claimedAt: date, transactionId: 12n };
      return { id: 'claim-a', deletionId: data.deletionId, claimedAt: date };
    } },
  };
  const prisma = { ...tx, $transaction: async (fn: any) => fn(tx) } as PrismaClient;
  return { state, service: new DocumentPurgeService(prisma, async (org, path, provider) => {
    assert.deepEqual([org, path, provider], ['org-a', 'org-a/pinned.txt', 'local']); return state.bytes;
  }) };
}

test('purge plan requires explicit authority and six evidenced stores without asserted absence', () => {
  assert.equal(purgeAuthorizationInput.safeParse(input).success, true);
  for (const change of [{ authorityConfirmed: false }, { dispositionPlan: { PRIMARY: plan.PRIMARY } },
    { dispositionPlan: { ...plan, BACKUPS: { disposition: 'VERIFIED_ABSENT', evidenceRef: 'PLAN-001' } } },
    { dispositionPlan: { ...plan, PRIMARY: { disposition: 'RETAIN_APPROVED', evidenceRef: 'PLAN-001' } } },
    { storagePath: 'injected/path' }, { evidenceRef: 'https://private.example/evidence' }]) {
    assert.equal(purgeAuthorizationInput.safeParse({ ...input, ...change }).success, false);
  }
});

test('authorization takes its object identity from the scoped retained record', async () => {
  const { service, state } = fixture();
  await service.authorize('org-a', 'owner-a', input);
  assert.equal(state.writes[0].storagePath, 'org-a/pinned.txt');
  assert.equal(state.writes[0].sha256, state.document.recoverySha256);
  assert.equal(state.claims, 0);
});

for (const mode of ['admin', 'foreign', 'changed-bytes', 'hold', 'stale'] as const) {
  test(`authorization refuses ${mode} before recording authority`, async () => {
    const { service, state } = fixture();
    if (mode === 'admin') state.role = 'ADMIN';
    if (mode === 'changed-bytes') state.bytes = Buffer.alloc(bytes.length, 'x');
    if (mode === 'hold') state.document.deletionHold = true;
    if (mode === 'stale') state.document.updatedAt = new Date(date.getTime() + 1);
    await assert.rejects(service.authorize(mode === 'foreign' ? 'org-b' : 'org-a', 'owner-a', input));
    assert.equal(state.writes.length, 0);
  });
}

test('claim retries return one serializable receipt without a second write', async () => {
  const { service, state } = fixture(); await service.authorize('org-a', 'owner-a', input);
  const first = await service.claim('org-a', 'owner-a', 'auth-a', { confirmPermanentPurge: true });
  const second = await service.claim('org-a', 'owner-a', 'auth-a', { confirmPermanentPurge: true });
  assert.deepEqual(first, second); assert.doesNotThrow(() => JSON.stringify(second)); assert.equal(state.claims, 1);
  await assert.rejects(service.withdraw('org-a', 'owner-a', 'auth-a', { evidenceRef: 'CANCEL-001', reason: 'Cancel synthetic disposal decision.' }), { code: 'PURGE_CANNOT_WITHDRAW' });
});

test('claim refuses withdrawn authority, foreign lookup and changed bytes', async () => {
  const { service, state } = fixture(); await service.authorize('org-a', 'owner-a', input);
  await assert.rejects(service.claim('org-a', 'owner-a', 'foreign-auth', { confirmPermanentPurge: true }), { statusCode: 404 });
  state.auth.withdrawal = { id: 'withdrawn' };
  await assert.rejects(service.claim('org-a', 'owner-a', 'auth-a', { confirmPermanentPurge: true }), { code: 'PURGE_AUTHORIZATION_WITHDRAWN' });
  state.auth.withdrawal = null; state.bytes = Buffer.alloc(bytes.length, 'x');
  await assert.rejects(service.claim('org-a', 'owner-a', 'auth-a', { confirmPermanentPurge: true }), { code: 'PURGE_FILE_CHANGED' });
  assert.equal(state.claims, 0);
});

test('database race refusal is a review conflict rather than raw database output', async () => {
  const { service, state } = fixture(); await service.authorize('org-a', 'owner-a', input);
  state.databaseFailure = { code: 'P2004', message: 'sensitive database details' };
  await assert.rejects(service.claim('org-a', 'owner-a', 'auth-a', { confirmPermanentPurge: true }),
    (error: any) => error.statusCode === 409 && !error.message.includes('sensitive database details'));
});

test('real Prisma trigger error shape reports an expiry refusal without masking unrelated failures', async () => {
  const { service, state } = fixture(); await service.authorize('org-a', 'owner-a', input);
  const failure = (message: string) => Object.assign(new Error(message), { name: 'PrismaClientUnknownRequestError' });
  state.databaseFailure = failure('Database error: Purge claim must wait for retention and recovery expiry');
  await assert.rejects(service.claim('org-a', 'owner-a', 'auth-a', { confirmPermanentPurge: true }), { statusCode: 409, code: 'PURGE_NOT_DUE' });
  state.databaseFailure = failure('Database error: Purge claim requires an unheld removed draft');
  await assert.rejects(service.claim('org-a', 'owner-a', 'auth-a', { confirmPermanentPurge: true }), { statusCode: 409, code: 'PURGE_REVIEW_CHANGED' });
  state.databaseFailure = failure('Unexpected database engine failure');
  await assert.rejects(service.claim('org-a', 'owner-a', 'auth-a', { confirmPermanentPurge: true }), state.databaseFailure);
});

test('history is tenant/document scoped, bounded and omits physical object identity', async () => {
  const { service, state } = fixture(); await service.list('org-a', { documentId: 'doc-a' });
  assert.deepEqual(state.listArgs.where, { organisationId: 'org-a', documentId: 'doc-a' });
  assert.equal(state.listArgs.take, 51);
  for (const field of ['storagePath', 'sha256', 'provider', 'transactionId']) assert.equal(state.listArgs.select[field], undefined);
  await assert.rejects(service.list('org-a', { documentId: 'doc-a', before: 'foreign-cursor' }), { statusCode: 404 });
  await service.list('org-a', {});
  assert.deepEqual(state.listArgs.where, { organisationId: 'org-a', documentId: undefined });
  state.auth = { id: 'foreign-auth', organisationId: 'org-b' };
  await assert.rejects(service.list('org-a', { before: 'foreign-auth' }), { statusCode: 404 });
});

test('purge routes restrict mutations to Owner web sessions and history to administrators', async () => {
  for (const role of ['OWNER', 'ADMIN', 'MEMBER'] as const) for (const clientKind of ['WEB', 'MCP_CONNECTOR'] as const) {
    const app = Fastify(); let calls = 0;
    app.addHook('onRequest', async request => {
      request.user = { userId: 'owner-a', organisationId: 'org-a', role } as any;
      request.authSession = { clientKind, accessLevel: 'ADMIN' } as any;
    });
    const invoke = async () => { calls++; return {}; };
    registerDocumentPurgeRoutes(app, { list: invoke, authorize: invoke, withdraw: invoke, claim: invoke, listDispositions: invoke, recordDisposition: invoke } as any);
    try {
      for (const [method, url] of [['GET','/purge-authorizations?documentId=doc-a'], ['POST','/purge-authorizations'],
        ['POST','/purge-authorizations/auth-a/withdraw'], ['POST','/purge-authorizations/auth-a/claim'], ['GET','/purge-authorizations/auth-a/dispositions'], ['POST','/purge-authorizations/auth-a/dispositions']] as const) {
        const allowed = clientKind === 'WEB' && (method === 'GET' ? role !== 'MEMBER' : role === 'OWNER');
        const before = calls;
        const response = await app.inject({ method, url, ...(method === 'POST' ? { payload: {} } : {}) });
        assert.equal(response.statusCode, allowed ? (url === '/purge-authorizations' ? 201 : 200) : 403, `${role}/${clientKind}/${url}`);
        assert.equal(calls - before, allowed ? 1 : 0);
      }
    } finally { await app.close(); }
  }
});

const disposition = { area: 'VERSIONS', scopeRef: 'VERSION-SET-001', revision: 1,
  status: 'VERIFIED_ABSENT', observedAt: date.toISOString(), nextReviewAt: null,
  evidenceRef: 'PROVIDER-RECEIPT-001', reason: 'Reviewed exact scope against provider evidence.', evidenceReviewed: true };

test('downstream evidence requires a defined scope and explicit review and never permits primary absence claims', () => {
  assert.equal(purgeDispositionInput.safeParse(disposition).success, true);
  for (const change of [{ area: 'PRIMARY' }, { scopeRef: 'https://private.example/object' },
    { evidenceReviewed: false }, { revision: 0 }, { revision: 1.5 }, { status: 'ERASED' },
    { status: 'RETAINED_APPROVED' }, { status: 'FAILED' }, { observedAt: 'yesterday' },
    { storagePath: 'injected/path' }, { actorUserId: 'owner-b' }]) {
    assert.equal(purgeDispositionInput.safeParse({ ...disposition, ...change }).success, false, JSON.stringify(change));
  }
});

test('recording downstream evidence is scoped, Owner-only, post-claim and cannot dispatch another job', async () => {
  const { service, state } = fixture(); await service.authorize('org-a', 'owner-a', input);
  await assert.rejects(service.recordDisposition('org-a', 'owner-a', 'auth-a', disposition), { code: 'PURGE_NOT_CLAIMED' });
  await service.claim('org-a', 'owner-a', 'auth-a', { confirmPermanentPurge: true });
  await assert.rejects(service.recordDisposition('org-b', 'owner-a', 'auth-a', disposition), { statusCode: 403 });
  await assert.rejects(service.recordDisposition('org-a', 'owner-a', 'foreign-auth', disposition), { statusCode: 404 });
  state.role = 'ADMIN';
  await assert.rejects(service.recordDisposition('org-a', 'owner-a', 'auth-a', disposition), { statusCode: 403 });
  state.role = 'OWNER';
  await service.recordDisposition('org-a', 'owner-a', 'auth-a', disposition);
  assert.equal(state.claims, 1);
  assert.equal(state.dispositionArgs.data.organisationId, 'org-a');
  assert.equal(state.dispositionArgs.data.authorizationId, 'auth-a');
  assert.equal(state.dispositionArgs.data.evidenceReviewed, undefined);
  assert.deepEqual(state.dispositionArgs.data.observedAt, date);
  state.databaseFailure = Object.assign(new Error('Purge disposition revision changed; refresh history'), { name: 'PrismaClientUnknownRequestError' });
  await assert.rejects(service.recordDisposition('org-a', 'owner-a', 'auth-a', disposition), { statusCode: 409, code: 'PURGE_DISPOSITION_REVIEW_CHANGED' });
});

test('downstream history paginates within one charity and authorization without claiming complete erasure', async () => {
  const { service, state } = fixture(); await service.authorize('org-a', 'owner-a', input);
  state.dispositionRows = Array.from({ length: 51 }, (_, i) => ({ id: `event-${i}`, organisationId: 'org-a', authorizationId: 'auth-a', occurredAt: date }));
  const first = await service.listDispositions('org-a', 'auth-a', {});
  assert.equal(first.items.length, 50); assert.equal(first.nextCursor, 'event-49');
  assert.deepEqual(state.dispositionArgs.where, { organisationId: 'org-a', authorizationId: 'auth-a' });
  assert.equal(state.dispositionArgs.take, 51);
  assert.equal('erased' in first, false);
  await service.listDispositions('org-a', 'auth-a', { before: first.nextCursor });
  assert.deepEqual(state.dispositionArgs.where.OR, [{ occurredAt: { lt: date } }, { occurredAt: date, id: { lt: 'event-49' } }]);
  await assert.rejects(service.listDispositions('org-b', 'auth-a', {}), { statusCode: 404 });
  await assert.rejects(service.listDispositions('org-a', 'auth-a', { before: 'foreign-cursor' }), { statusCode: 404 });
  for (const field of ['storagePath', 'sha256', 'provider', 'transactionId']) assert.equal(state.dispositionArgs.select[field], undefined);
});
