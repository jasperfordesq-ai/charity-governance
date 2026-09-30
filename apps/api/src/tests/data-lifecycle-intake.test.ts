import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'data-lifecycle-intake-test-secret';

const [{ default: Fastify }, { dataLifecycleRoutes }, { signAccessToken }] = await Promise.all([
  import('fastify'), import('../routes/data-lifecycle/index.js'), import('../utils/jwt.js'),
]);

type Role = 'MEMBER' | 'ADMIN';
const token = (role: Role) => `Bearer ${signAccessToken({
  userId: 'u1', organisationId: 'org-1', role, sessionId: 's1',
})}`;

async function appFor(role: Role, overrides: Record<string, unknown>) {
  const app = Fastify({ logger: false });
  const models = {
    authSession: { findFirst: async () => ({ id: 's1' }) },
    user: { findUnique: async () => ({ id: 'u1', organisationId: 'org-1', role, emailVerified: true }) },
    ...overrides,
  } as Record<string, unknown>;
  models.$transaction ??= async (callback: (tx: typeof models) => Promise<unknown>) => callback(models);
  app.decorate('prisma', models as never);
  await app.register(dataLifecycleRoutes, { prefix: '/data-lifecycle' });
  return app;
}

test('Members cannot list, create or triage lifecycle cases before database access', async () => {
  let reads = 0;
  const app = await appFor('MEMBER', {
    dataLifecycleRequest: {
      findMany: async () => { reads += 1; return []; },
      create: async () => { reads += 1; return {}; },
      findFirst: async () => { reads += 1; return null; },
    },
    dataLifecycleReviewEvent: { findMany: async () => { reads += 1; return []; } },
  });
  try {
    for (const [method, path] of [
      ['GET', '/data-lifecycle/requests'],
      ['GET', '/data-lifecycle/audit'],
      ['GET', '/data-lifecycle/storage-deletions/by-source?sourceDocumentId=doc-1'],
      ['GET', '/data-lifecycle/requests/case-1/document-links'],
      ['GET', '/data-lifecycle/requests/case-1/target-events'],
      ['GET', '/data-lifecycle/requests/case-1/response-events'],
      ['GET', '/data-lifecycle/requests/case-1/coverage'],
      ['GET', '/data-lifecycle/requests/case-1/coverage-events'],
      ['GET', '/data-lifecycle/requests/due-targets'],
      ['POST', '/data-lifecycle/requests'],
      ['POST', '/data-lifecycle/requests/case-1/document-links'],
      ['POST', '/data-lifecycle/requests/case-1/triage'],
      ['POST', '/data-lifecycle/requests/case-1/response-target'],
      ['POST', '/data-lifecycle/requests/case-1/response-sent'],
      ['POST', '/data-lifecycle/requests/case-1/coverage'],
    ]) {
      const response = await app.inject({ method: method as 'GET' | 'POST', url: path,
        headers: { authorization: token('MEMBER') } });
      assert.equal(response.statusCode, 403, path);
    }
    assert.equal(reads, 0);
  } finally { await app.close(); }
});

test('Admin connector sessions cannot read or change controlled data-request cases by direct API call', async () => {
  let caseAccesses = 0;
  const app = await appFor('ADMIN', {
    authSession: { findFirst: async () => ({
      id: 's1', clientKind: 'MCP_CONNECTOR', accessLevel: 'ADMIN', dataScope: 'FULL',
    }) },
    dataLifecycleRequest: {
      findMany: async () => { caseAccesses += 1; return []; },
      create: async () => { caseAccesses += 1; return {}; },
    },
  });
  try {
    for (const [method, path] of [
      ['GET', '/data-lifecycle/requests'],
      ['GET', '/data-lifecycle/requests/case-1'],
      ['GET', '/data-lifecycle/requests/case-1/events'],
      ['POST', '/data-lifecycle/requests'],
      ['POST', '/data-lifecycle/requests/case-1/triage'],
    ]) {
      const response = await app.inject({ method: method as 'GET' | 'POST', url: path,
        headers: { authorization: token('ADMIN') } });
      assert.equal(response.statusCode, 403, path);
      assert.equal(response.json().code, 'WEB_SESSION_REQUIRED');
    }
    assert.equal(caseAccesses, 0);
  } finally { await app.close(); }
});

test('coverage assessments are Admin-only, tenant-bound and do not expose another case', async () => {
  const events: Array<Record<string, unknown>> = [];
  const coverageQueries: Array<Record<string, unknown>> = [];
  const app = await appFor('ADMIN', {
    dataLifecycleRequest: { findFirst: async (args: Record<string, unknown>) =>
      (args.where as { id: string; organisationId: string }).id === 'case-1'
        && (args.where as { organisationId: string }).organisationId === 'org-1'
        ? { id: 'case-1', organisationId: 'org-1' } : null },
    dataLifecycleCoverageEvent: {
      create: async (args: { data: Record<string, unknown> }) => {
        coverageQueries.push(args);
        const row = { id: `coverage-${events.length + 1}`, occurredAt: new Date('2026-09-29T12:00:00Z'), ...args.data };
        events.push(row);
        return row;
      },
      findFirst: async (args: Record<string, unknown>) => {
        coverageQueries.push(args);
        return events.find((row) => row.area === (args.where as { area?: string }).area) ?? null;
      },
      findMany: async (args: Record<string, unknown>) => {
        coverageQueries.push(args);
        return events;
      },
    },
  });
  try {
    const invalid = await app.inject({ method: 'POST', url: '/data-lifecycle/requests/case-1/coverage',
      headers: { authorization: token('ADMIN') }, payload: {
        area: 'BACKUPS', disposition: 'PURGED', reason: 'This is an unsupported erasure claim.',
      } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(events.length, 0);

    const missing = await app.inject({ method: 'POST', url: '/data-lifecycle/requests/foreign-case/coverage',
      headers: { authorization: token('ADMIN') }, payload: {
        area: 'BACKUPS', disposition: 'NEEDS_FOLLOW_UP', reason: 'Review backup custody and expiry.',
      } });
    assert.equal(missing.statusCode, 404);
    assert.equal(events.length, 0);

    const recorded = await app.inject({ method: 'POST', url: '/data-lifecycle/requests/case-1/coverage',
      headers: { authorization: token('ADMIN') }, payload: {
        area: 'BACKUPS', disposition: 'NEEDS_FOLLOW_UP',
        reason: 'Review backup custody and expiry.', evidenceRef: 'CASE-123',
      } });
    assert.equal(recorded.statusCode, 201, recorded.body);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.organisationId, 'org-1');
    assert.equal(events[0]?.actorUserId, 'u1');
    assert.equal(coverageQueries[0]?.data && (coverageQueries[0].data as Record<string, unknown>).requestId, 'case-1');

    const current = await app.inject({ method: 'GET', url: '/data-lifecycle/requests/case-1/coverage',
      headers: { authorization: token('ADMIN') } });
    assert.equal(current.statusCode, 200, current.body);
    assert.equal(current.json().data.length, 8);
    assert.equal(current.json().data.find((row: { area: string }) => row.area === 'BACKUPS').latest.id, 'coverage-1');
    assert.equal(current.json().data.find((row: { area: string }) => row.area === 'VAULT_FILES').latest, null);
    assert.ok(coverageQueries.slice(1).every((query) =>
      (query.where as { organisationId: string; requestId: string }).organisationId === 'org-1'
      && (query.where as { requestId: string }).requestId === 'case-1'));

    const history = await app.inject({ method: 'GET', url: '/data-lifecycle/requests/case-1/coverage-events',
      headers: { authorization: token('ADMIN') } });
    assert.equal(history.statusCode, 200, history.body);
    assert.equal(history.json().data.items.length, 1);
    assert.equal(history.json().data.items[0].evidenceRef, 'CASE-123');
  } finally { await app.close(); }
});

test('source-document job lookup is Admin-only, tenant-bound, paged and path-free', async () => {
  const createdAt = new Date('2026-09-29T10:00:00.000Z');
  const queries: Record<string, unknown>[] = [];
  const rows = Array.from({ length: 51 }, (_, index) => ({
    id: `job-${String(51 - index).padStart(3, '0')}`,
    sourceDocumentId: 'doc-1', organisationId: 'org-1', createdAt,
    provider: 'local', state: 'PROCESSED', attempts: 1,
    processedAt: createdAt, activeObjectAbsentAt: createdAt,
    terminalReason: null, storagePath: 'private/path.pdf', lastError: 'private provider error',
  }));
  const delegate = {
    findFirst: async (args: Record<string, unknown>) => {
      queries.push(args);
      return (args.where as { id: string }).id === 'job-001' ? { id: 'job-001', createdAt } : null;
    },
    findMany: async (args: Record<string, unknown>) => {
      queries.push(args);
      const selected = queries.filter((query) => 'take' in query).length === 1 ? rows : [rows[50]];
      const fields = args.select as Record<string, boolean>;
      return selected.map((row) => Object.fromEntries(
        Object.entries(row).filter(([field]) => fields[field] === true),
      ));
    },
  };
  const memberApp = await appFor('MEMBER', { documentStorageDeletion: delegate });
  try {
    const denied = await memberApp.inject({ method: 'GET',
      url: '/data-lifecycle/storage-deletions/by-source?sourceDocumentId=doc-1',
      headers: { authorization: token('MEMBER') } });
    assert.equal(denied.statusCode, 403);
    assert.equal(queries.length, 0);
  } finally { await memberApp.close(); }

  const adminApp = await appFor('ADMIN', { documentStorageDeletion: delegate });
  try {
    const invalid = await adminApp.inject({ method: 'GET',
      url: '/data-lifecycle/storage-deletions/by-source?sourceDocumentId=person%40example.org',
      headers: { authorization: token('ADMIN') } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(queries.length, 0);

    const first = await adminApp.inject({ method: 'GET',
      url: '/data-lifecycle/storage-deletions/by-source?sourceDocumentId=doc-1',
      headers: { authorization: token('ADMIN') } });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().data.items.length, 50);
    assert.equal(first.json().data.nextCursor, 'job-002');
    assert.deepEqual(queries[0].where, { organisationId: 'org-1', sourceDocumentId: 'doc-1' });
    assert.equal(queries[0].take, 51);
    assert.equal((queries[0].select as Record<string, unknown>).storagePath, undefined);
    assert.equal((queries[0].select as Record<string, unknown>).lastError, undefined);

    const foreign = await adminApp.inject({ method: 'GET',
      url: '/data-lifecycle/storage-deletions/by-source?sourceDocumentId=doc-1&before=foreign-job',
      headers: { authorization: token('ADMIN') } });
    assert.equal(foreign.statusCode, 404);
    assert.deepEqual(queries[1].where, { id: 'foreign-job', organisationId: 'org-1', sourceDocumentId: 'doc-1' });

    const next = await adminApp.inject({ method: 'GET',
      url: '/data-lifecycle/storage-deletions/by-source?sourceDocumentId=doc-1&before=job-001',
      headers: { authorization: token('ADMIN') } });
    assert.equal(next.statusCode, 200, next.body);
    assert.deepEqual(queries[3].where, { organisationId: 'org-1', sourceDocumentId: 'doc-1', OR: [
      { createdAt: { lt: createdAt } }, { createdAt, id: { lt: 'job-001' } },
    ] });
    assert.doesNotMatch(first.body + next.body, /private\/path|private provider error/);
  } finally { await adminApp.close(); }
});

test('the recent data-request audit is tenant scoped and excludes case reasons and evidence references', async () => {
  let query: Record<string, unknown> | undefined;
  const app = await appFor('ADMIN', {
    dataLifecycleReviewEvent: { findMany: async (args: Record<string, unknown>) => {
      query = args;
      return [{ id: 'event-1', requestId: 'case-1', nextState: 'ASSESSING' }];
    } },
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/data-lifecycle/audit',
      headers: { authorization: token('ADMIN') } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().data[0].requestId, 'case-1');
    assert.deepEqual(query?.where, { organisationId: 'org-1' });
    assert.equal(query?.take, 100);
    assert.equal((query?.select as Record<string, unknown>).reason, undefined);
    assert.equal((query?.select as Record<string, unknown>).evidenceRef, undefined);
  } finally { await app.close(); }
});

test('case review history pages through equal timestamps with a tenant-and-case-bound cursor', async () => {
  const at = new Date('2026-09-28T10:00:00.000Z');
  const queries: Record<string, unknown>[] = [];
  let cursorLookup: Record<string, unknown> | undefined;
  const app = await appFor('ADMIN', {
    dataLifecycleRequest: { findFirst: async () => ({ id: 'case-1', organisationId: 'org-1' }) },
    dataLifecycleReviewEvent: {
      findFirst: async (args: Record<string, unknown>) => {
        cursorLookup = args;
        return args.where && (args.where as { id: string }).id === 'event-051'
          ? { id: 'event-051', occurredAt: at }
          : null;
      },
      findMany: async (args: Record<string, unknown>) => {
        queries.push(args);
        return queries.length === 1
          ? Array.from({ length: 51 }, (_, index) => ({ id: `event-${String(100 - index).padStart(3, '0')}`, occurredAt: at }))
          : [{ id: 'event-050', occurredAt: at }];
      },
    },
  });
  try {
    const first = await app.inject({ method: 'GET', url: '/data-lifecycle/requests/case-1/events',
      headers: { authorization: token('ADMIN') } });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().data.items.length, 50);
    assert.equal(first.json().data.nextCursor, 'event-051');
    assert.deepEqual(queries[0].where, { organisationId: 'org-1', requestId: 'case-1' });
    assert.deepEqual(queries[0].orderBy, [{ occurredAt: 'desc' }, { id: 'desc' }]);
    assert.equal(queries[0].take, 51);

    const foreign = await app.inject({ method: 'GET', url: '/data-lifecycle/requests/case-1/events?before=other-event',
      headers: { authorization: token('ADMIN') } });
    assert.equal(foreign.statusCode, 404);
    assert.equal(queries.length, 1);

    const next = await app.inject({ method: 'GET', url: '/data-lifecycle/requests/case-1/events?before=event-051',
      headers: { authorization: token('ADMIN') } });
    assert.equal(next.statusCode, 200, next.body);
    assert.deepEqual(cursorLookup?.where, { id: 'event-051', organisationId: 'org-1', requestId: 'case-1' });
    assert.deepEqual(queries[1].where, { organisationId: 'org-1', requestId: 'case-1', OR: [
      { occurredAt: { lt: at } }, { occurredAt: at, id: { lt: 'event-051' } },
    ] });
    assert.equal(next.json().data.nextCursor, null);
  } finally { await app.close(); }
});

test('Admin intake is tenant scoped and creates an append-only OPEN event', async () => {
  const calls: Array<{ operation: string; args: Record<string, unknown> }> = [];
  const received = new Date('2026-09-28T09:00:00.000Z');
  const app = await appFor('ADMIN', {
    dataLifecycleRequest: {
      findMany: async (args: Record<string, unknown>) => { calls.push({ operation: 'list', args }); return []; },
      create: async (args: Record<string, unknown>) => {
        calls.push({ operation: 'create', args });
        return { id: 'request-1', ...(args.data as object), reviewState: 'OPEN', updatedAt: received };
      },
    },
    dataLifecycleReviewEvent: {
      create: async (args: Record<string, unknown>) => { calls.push({ operation: 'event', args }); return {}; },
    },
  });
  try {
    const invalid = await app.inject({ method: 'POST', url: '/data-lifecycle/requests',
      headers: { authorization: token('ADMIN') }, payload: {
        caseReference: 'person@example.org', kind: 'ERASURE', scope: 'ACCOUNT',
        receivedAt: received.toISOString(), name: 'Never store this',
      } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(calls.length, 0);

    const created = await app.inject({ method: 'POST', url: '/data-lifecycle/requests',
      headers: { authorization: token('ADMIN') }, payload: {
        caseReference: 'CASE-2026-001', kind: 'ERASURE', scope: 'ACCOUNT', receivedAt: received.toISOString(),
      } });
    assert.equal(created.statusCode, 201, created.body);
    assert.deepEqual(calls.map((call) => call.operation), ['create', 'event']);
    assert.deepEqual((calls[0].args.data as { organisationId: string; enteredById: string }),
      { organisationId: 'org-1', caseReference: 'CASE-2026-001', kind: 'ERASURE', scope: 'ACCOUNT',
        receivedAt: received, enteredById: 'u1' });
    assert.deepEqual(calls[1].args.data, {
      organisationId: 'org-1', requestId: 'request-1', actorUserId: 'u1',
      previousState: null, nextState: 'OPEN', reason: 'Request recorded for assessment.',
    });

    const listed = await app.inject({ method: 'GET', url: '/data-lifecycle/requests',
      headers: { authorization: token('ADMIN') } });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(calls[2].args, { where: { organisationId: 'org-1' },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], take: 51 });
  } finally { await app.close(); }
});

test('request queue cursor keeps older cases stable when a new intake arrives', async () => {
  const receivedAt = new Date('2026-09-28T09:00:00.000Z');
  const cases = Array.from({ length: 52 }, (_, index) => ({
    id: `case-${String(52 - index).padStart(3, '0')}`, receivedAt,
  }));
  const queries: Record<string, unknown>[] = [];
  const app = await appFor('ADMIN', {
    dataLifecycleRequest: {
      findFirst: async (args: { where: { id: string; organisationId: string } }) =>
        args.where.organisationId === 'org-1' ? cases.find((record) => record.id === args.where.id) ?? null : null,
      findMany: async (args: Record<string, unknown>) => {
        queries.push(args);
        const where = args.where as { organisationId: string; OR?: [unknown, { id: { lt: string } }] };
        assert.equal(where.organisationId, 'org-1');
        return cases.filter((record) => !where.OR || record.id < where.OR[1].id.lt).slice(0, 51);
      },
    },
  });
  try {
    const first = await app.inject({ method: 'GET', url: '/data-lifecycle/requests',
      headers: { authorization: token('ADMIN') } });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().data.items.length, 50);
    assert.equal(first.json().data.nextCursor, 'case-003');

    cases.unshift({ id: 'case-999', receivedAt });
    const second = await app.inject({ method: 'GET', url: '/data-lifecycle/requests?before=case-003',
      headers: { authorization: token('ADMIN') } });
    assert.equal(second.statusCode, 200, second.body);
    assert.deepEqual(second.json().data.items.map((record: { id: string }) => record.id), ['case-002', 'case-001']);
    assert.equal(second.json().data.nextCursor, null);
    assert.deepEqual(queries[1].where, { organisationId: 'org-1', OR: [
      { receivedAt: { lt: receivedAt } }, { receivedAt, id: { lt: 'case-003' } },
    ] });

    const foreign = await app.inject({ method: 'GET', url: '/data-lifecycle/requests?before=foreign-case',
      headers: { authorization: token('ADMIN') } });
    assert.equal(foreign.statusCode, 404);
    assert.equal(queries.length, 2);
    const invalid = await app.inject({ method: 'GET', url: '/data-lifecycle/requests?before=bad%2Fid',
      headers: { authorization: token('ADMIN') } });
    assert.equal(invalid.statusCode, 400);
  } finally { await app.close(); }
});

test('exact case-reference lookup is Admin-only, tenant scoped and rejects personal identifiers', async () => {
  const queries: Record<string, unknown>[] = [];
  const lookup = { findFirst: async (args: Record<string, unknown>) => {
    queries.push(args);
    return (args.where as { caseReference: string }).caseReference === 'CASE-2026-001'
      ? { id: 'case-1', caseReference: 'CASE-2026-001', organisationId: 'org-1' }
      : null;
  } };
  const memberApp = await appFor('MEMBER', { dataLifecycleRequest: lookup });
  try {
    const denied = await memberApp.inject({ method: 'GET',
      url: '/data-lifecycle/requests/by-reference?caseReference=CASE-2026-001',
      headers: { authorization: token('MEMBER') } });
    assert.equal(denied.statusCode, 403);
    assert.equal(queries.length, 0);
  } finally { await memberApp.close(); }

  const adminApp = await appFor('ADMIN', { dataLifecycleRequest: lookup });
  try {
    const found = await adminApp.inject({ method: 'GET',
      url: '/data-lifecycle/requests/by-reference?caseReference=CASE-2026-001',
      headers: { authorization: token('ADMIN') } });
    assert.equal(found.statusCode, 200);
    assert.equal(found.json().data.id, 'case-1');
    assert.deepEqual(queries[0], { where: { organisationId: 'org-1', caseReference: 'CASE-2026-001' } });

    const absent = await adminApp.inject({ method: 'GET',
      url: '/data-lifecycle/requests/by-reference?caseReference=CASE-OTHER',
      headers: { authorization: token('ADMIN') } });
    assert.equal(absent.statusCode, 404);
    assert.deepEqual(queries[1], { where: { organisationId: 'org-1', caseReference: 'CASE-OTHER' } });

    const personal = await adminApp.inject({ method: 'GET',
      url: '/data-lifecycle/requests/by-reference?caseReference=person%40example.org',
      headers: { authorization: token('ADMIN') } });
    assert.equal(personal.statusCode, 400);
    assert.equal(queries.length, 2);
  } finally { await adminApp.close(); }
});

test('triage records an actor and evidence reference with the guarded state change', async () => {
  const now = new Date('2026-09-28T10:00:00.000Z');
  const current = { id: 'request-1', organisationId: 'org-1', reviewState: 'OPEN', updatedAt: now };
  const writes: Array<{ operation: string; args: Record<string, unknown> }> = [];
  const app = await appFor('ADMIN', {
    dataLifecycleRequest: {
      findFirst: async () => current,
      updateMany: async (args: Record<string, unknown>) => { writes.push({ operation: 'update', args });
        current.reviewState = 'ASSESSING'; return { count: 1 }; },
    },
    dataLifecycleReviewEvent: { create: async (args: Record<string, unknown>) => {
      writes.push({ operation: 'event', args }); return {};
    } },
  });
  try {
    const stale = await app.inject({ method: 'POST', url: '/data-lifecycle/requests/request-1/triage',
      headers: { authorization: token('ADMIN') }, payload: {
        expectedUpdatedAt: '2026-09-27T10:00:00.000Z', nextState: 'ASSESSING',
        reason: 'Evidence review started.',
      } });
    assert.equal(stale.statusCode, 409);
    assert.equal(writes.length, 0);

    const invalid = await app.inject({ method: 'POST', url: '/data-lifecycle/requests/request-1/triage',
      headers: { authorization: token('ADMIN') }, payload: {
        expectedUpdatedAt: now.toISOString(), nextState: 'ERASED', reason: 'Unsupported completion claim.',
      } });
    assert.equal(invalid.statusCode, 400);

    const result = await app.inject({ method: 'POST', url: '/data-lifecycle/requests/request-1/triage',
      headers: { authorization: token('ADMIN') }, payload: {
        expectedUpdatedAt: now.toISOString(), nextState: 'ASSESSING',
        reason: 'Reviewing all linked stores.', evidenceRef: 'EVIDENCE-2026-001',
      } });
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(writes.map((write) => write.operation), ['update', 'event']);
    assert.deepEqual(writes[0].args.where, { id: 'request-1', organisationId: 'org-1', updatedAt: now });
    assert.deepEqual(writes[1].args.data, { organisationId: 'org-1', requestId: 'request-1', actorUserId: 'u1',
      previousState: 'OPEN', nextState: 'ASSESSING', reason: 'Reviewing all linked stores.',
      evidenceRef: 'EVIDENCE-2026-001' });
  } finally { await app.close(); }
});

test('past response targets page oldest first within one charity', async () => {
  const at = new Date('2026-09-20T10:00:00.000Z');
  const queries: Record<string, unknown>[] = [];
  const app = await appFor('ADMIN', {
    dataLifecycleRequest: {
      findFirst: async (args: Record<string, unknown>) =>
        (args.where as { id?: string }).id === 'case-050' ? { id: 'case-050', targetResponseAt: at } : null,
      findMany: async (args: Record<string, unknown>) => {
        queries.push(args);
        return queries.length === 1
          ? Array.from({ length: 51 }, (_, index) => ({ id: `case-${String(index + 1).padStart(3, '0')}`, targetResponseAt: at }))
          : [{ id: 'case-051', targetResponseAt: at }];
      },
    },
  });
  try {
    const first = await app.inject({ method: 'GET', url: '/data-lifecycle/requests/due-targets',
      headers: { authorization: token('ADMIN') } });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().data.items.length, 50);
    assert.equal(first.json().data.nextCursor, 'case-050');
    assert.equal((queries[0].where as { organisationId: string }).organisationId, 'org-1');
    assert.equal((queries[0].where as { responseSentAt: null }).responseSentAt, null);
    assert.deepEqual(queries[0].orderBy, [{ targetResponseAt: 'asc' }, { id: 'asc' }]);
    assert.equal((queries[0].select as Record<string, unknown>).reason, undefined);

    const next = await app.inject({ method: 'GET', url: '/data-lifecycle/requests/due-targets?before=case-050',
      headers: { authorization: token('ADMIN') } });
    assert.equal(next.statusCode, 200, next.body);
    assert.deepEqual(next.json().data.items.map((item: { id: string }) => item.id), ['case-051']);
    assert.deepEqual((queries[1].where as { OR: unknown }).OR, [
      { targetResponseAt: { gt: at } }, { targetResponseAt: at, id: { gt: 'case-050' } },
    ]);
    const foreign = await app.inject({ method: 'GET', url: '/data-lifecycle/requests/due-targets?before=foreign',
      headers: { authorization: token('ADMIN') } });
    assert.equal(foreign.statusCode, 404);
    assert.equal(queries.length, 2);
  } finally { await app.close(); }
});

test('response-sent fact requires evidence, supports reasoned correction and withdrawal, and never marks erasure complete', async () => {
  const receivedAt = new Date('2026-09-20T09:00:00.000Z');
  const revision = new Date('2026-09-21T09:00:00.000Z');
  const nextRevision = new Date('2026-09-21T10:00:00.000Z');
  const sentAt = new Date('2026-09-21T08:00:00.000Z');
  const current = { id: 'case-1', organisationId: 'org-1', receivedAt,
    responseSentAt: null as Date | null, reviewState: 'ASSESSING', updatedAt: revision };
  const writes: Array<{ operation: string; args: Record<string, unknown> }> = [];
  const app = await appFor('ADMIN', {
    dataLifecycleRequest: {
      findFirst: async () => current,
      updateMany: async (args: Record<string, unknown>) => {
        writes.push({ operation: 'update', args });
        current.responseSentAt = (args.data as { responseSentAt: Date | null }).responseSentAt;
        current.updatedAt = nextRevision;
        return { count: 1 };
      },
    },
    dataLifecycleResponseEvent: { create: async (args: Record<string, unknown>) => {
      writes.push({ operation: 'event', args }); return {};
    } },
  });
  const request = (expectedUpdatedAt: Date, responseSentAt: Date | null, evidenceRef?: string) => app.inject({
    method: 'POST', url: '/data-lifecycle/requests/case-1/response-sent',
    headers: { authorization: token('ADMIN') }, payload: {
      expectedUpdatedAt: expectedUpdatedAt.toISOString(), responseSentAt: responseSentAt?.toISOString() ?? null,
      reason: 'Checked the controlled response correspondence.', ...(evidenceRef ? { evidenceRef } : {}),
    },
  });
  try {
    assert.equal((await request(new Date('2026-09-20T09:00:00Z'), sentAt, 'CASE-REPLY-001')).statusCode, 409);
    assert.equal((await request(revision, new Date('2026-09-19T08:00:00Z'), 'CASE-REPLY-001')).statusCode, 400);
    assert.equal((await request(revision, new Date(Date.now() + 60_000), 'CASE-REPLY-001')).statusCode, 400);
    const missingEvidence = await request(revision, sentAt);
    assert.equal(missingEvidence.statusCode, 400);
    assert.equal(missingEvidence.json().code, 'DATA_LIFECYCLE_RESPONSE_EVIDENCE_REQUIRED');
    assert.equal(writes.length, 0);
    const saved = await request(revision, sentAt, 'CASE-REPLY-001');
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().data.responseSentAt, sentAt.toISOString());
    assert.equal(saved.json().data.reviewState, 'ASSESSING');
    assert.deepEqual(writes.map((entry) => entry.operation), ['update', 'event']);
    assert.deepEqual(writes[0].args.where, { id: 'case-1', organisationId: 'org-1', updatedAt: revision });
    assert.deepEqual(writes[1].args.data, {
      organisationId: 'org-1', requestId: 'case-1', actorUserId: 'u1',
      previousResponseAt: null, nextResponseAt: sentAt,
      reason: 'Checked the controlled response correspondence.', evidenceRef: 'CASE-REPLY-001',
    });
    const unchanged = await request(nextRevision, sentAt, 'CASE-REPLY-001');
    assert.equal(unchanged.statusCode, 409);
    assert.equal(unchanged.json().code, 'DATA_LIFECYCLE_RESPONSE_UNCHANGED');
    const withdrawn = await request(nextRevision, null);
    assert.equal(withdrawn.statusCode, 200, withdrawn.body);
    assert.equal(withdrawn.json().data.responseSentAt, null);
    assert.deepEqual(writes[3].args.data, {
      organisationId: 'org-1', requestId: 'case-1', actorUserId: 'u1',
      previousResponseAt: sentAt, nextResponseAt: null,
      reason: 'Checked the controlled response correspondence.', evidenceRef: null,
    });
  } finally { await app.close(); }
});

test('response-sent history pages retained events within the same charity and case', async () => {
  const at = new Date('2026-09-29T10:00:00.000Z');
  const queries: Record<string, unknown>[] = [];
  const app = await appFor('ADMIN', {
    dataLifecycleRequest: { findFirst: async () => ({ id: 'case-1', organisationId: 'org-1' }) },
    dataLifecycleResponseEvent: {
      findFirst: async (args: Record<string, unknown>) => {
        queries.push(args);
        return (args.where as { id: string }).id === 'response-051' ? { id: 'response-051', occurredAt: at } : null;
      },
      findMany: async (args: Record<string, unknown>) => {
        queries.push(args);
        return queries.length === 1
          ? Array.from({ length: 51 }, (_, index) => ({ id: `response-${String(100 - index).padStart(3, '0')}`, occurredAt: at }))
          : [{ id: 'response-050', occurredAt: at }];
      },
    },
  });
  try {
    const first = await app.inject({ method: 'GET', url: '/data-lifecycle/requests/case-1/response-events',
      headers: { authorization: token('ADMIN') } });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().data.items.length, 50);
    assert.equal(first.json().data.nextCursor, 'response-051');
    assert.deepEqual(queries[0].where, { organisationId: 'org-1', requestId: 'case-1' });
    const foreign = await app.inject({ method: 'GET', url: '/data-lifecycle/requests/case-1/response-events?before=foreign',
      headers: { authorization: token('ADMIN') } });
    assert.equal(foreign.statusCode, 404);
    const second = await app.inject({ method: 'GET', url: '/data-lifecycle/requests/case-1/response-events?before=response-051',
      headers: { authorization: token('ADMIN') } });
    assert.equal(second.statusCode, 200, second.body);
    assert.deepEqual(queries[3].where, { organisationId: 'org-1', requestId: 'case-1', OR: [
      { occurredAt: { lt: at } }, { occurredAt: at, id: { lt: 'response-051' } },
    ] });
  } finally { await app.close(); }
});

test('response target is reviewer-entered, revision guarded and audited without implying erasure', async () => {
  const receivedAt = new Date('2026-09-28T09:00:00.000Z');
  const initialRevision = new Date('2026-09-28T10:00:00.000Z');
  const nextRevision = new Date('2026-09-28T11:00:00.000Z');
  const targetAt = new Date('2026-10-03T12:00:00.000Z');
  const current = { id: 'case-1', organisationId: 'org-1', receivedAt,
    targetResponseAt: null as Date | null, updatedAt: initialRevision };
  const writes: Array<{ operation: string; args: Record<string, unknown> }> = [];
  const app = await appFor('ADMIN', {
    dataLifecycleRequest: {
      findFirst: async () => current,
      updateMany: async (args: Record<string, unknown>) => {
        writes.push({ operation: 'update', args });
        current.targetResponseAt = (args.data as { targetResponseAt: Date | null }).targetResponseAt;
        current.updatedAt = nextRevision;
        return { count: 1 };
      },
    },
    dataLifecycleTargetEvent: { create: async (args: Record<string, unknown>) => {
      writes.push({ operation: 'event', args }); return {};
    } },
  });
  try {
    const stale = await app.inject({ method: 'POST', url: '/data-lifecycle/requests/case-1/response-target',
      headers: { authorization: token('ADMIN') }, payload: {
        expectedUpdatedAt: receivedAt.toISOString(), targetResponseAt: targetAt.toISOString(),
        reason: 'Set from controlled case correspondence.',
      } });
    assert.equal(stale.statusCode, 409);
    const premature = await app.inject({ method: 'POST', url: '/data-lifecycle/requests/case-1/response-target',
      headers: { authorization: token('ADMIN') }, payload: {
        expectedUpdatedAt: initialRevision.toISOString(), targetResponseAt: '2026-09-27T12:00:00.000Z',
        reason: 'Recorded from a misdated case note.',
      } });
    assert.equal(premature.statusCode, 400);
    assert.equal(premature.json().code, 'DATA_LIFECYCLE_TARGET_BEFORE_RECEIPT');
    assert.equal(writes.length, 0);

    const saved = await app.inject({ method: 'POST', url: '/data-lifecycle/requests/case-1/response-target',
      headers: { authorization: token('ADMIN') }, payload: {
        expectedUpdatedAt: initialRevision.toISOString(), targetResponseAt: targetAt.toISOString(),
        reason: 'Set from controlled case correspondence.', evidenceRef: 'CASE-DATE-001',
      } });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().data.targetResponseAt, targetAt.toISOString());
    assert.deepEqual(writes.map((write) => write.operation), ['update', 'event']);
    assert.deepEqual(writes[0].args.where, { id: 'case-1', organisationId: 'org-1', updatedAt: initialRevision });
    assert.deepEqual(writes[1].args.data, {
      organisationId: 'org-1', requestId: 'case-1', actorUserId: 'u1',
      previousTargetAt: null, nextTargetAt: targetAt,
      reason: 'Set from controlled case correspondence.', evidenceRef: 'CASE-DATE-001',
    });

    const unchanged = await app.inject({ method: 'POST', url: '/data-lifecycle/requests/case-1/response-target',
      headers: { authorization: token('ADMIN') }, payload: {
        expectedUpdatedAt: nextRevision.toISOString(), targetResponseAt: targetAt.toISOString(),
        reason: 'Attempt to repeat the same target.',
      } });
    assert.equal(unchanged.statusCode, 409);
    assert.equal(unchanged.json().code, 'DATA_LIFECYCLE_TARGET_UNCHANGED');

    const cleared = await app.inject({ method: 'POST', url: '/data-lifecycle/requests/case-1/response-target',
      headers: { authorization: token('ADMIN') }, payload: {
        expectedUpdatedAt: nextRevision.toISOString(), targetResponseAt: null,
        reason: 'Withdrawn after checking the controlled case archive.',
      } });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.equal(cleared.json().data.targetResponseAt, null);
    assert.deepEqual(writes[3].args.data, {
      organisationId: 'org-1', requestId: 'case-1', actorUserId: 'u1',
      previousTargetAt: targetAt, nextTargetAt: null,
      reason: 'Withdrawn after checking the controlled case archive.', evidenceRef: null,
    });
  } finally { await app.close(); }
});

test('response-target history is tenant scoped and pages retained changes', async () => {
  const at = new Date('2026-09-29T10:00:00.000Z');
  const queries: Record<string, unknown>[] = [];
  const app = await appFor('ADMIN', {
    dataLifecycleRequest: { findFirst: async () => ({ id: 'case-1', organisationId: 'org-1' }) },
    dataLifecycleTargetEvent: {
      findFirst: async (args: Record<string, unknown>) => {
        queries.push(args);
        return (args.where as { id: string }).id === 'target-051' ? { id: 'target-051', occurredAt: at } : null;
      },
      findMany: async (args: Record<string, unknown>) => {
        queries.push(args);
        return queries.length === 1
          ? Array.from({ length: 51 }, (_, index) => ({ id: `target-${String(100 - index).padStart(3, '0')}`, occurredAt: at }))
          : [{ id: 'target-050', occurredAt: at }];
      },
    },
  });
  try {
    const first = await app.inject({ method: 'GET', url: '/data-lifecycle/requests/case-1/target-events',
      headers: { authorization: token('ADMIN') } });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().data.items.length, 50);
    assert.equal(first.json().data.nextCursor, 'target-051');
    assert.deepEqual(queries[0].where, { organisationId: 'org-1', requestId: 'case-1' });

    const foreign = await app.inject({ method: 'GET', url: '/data-lifecycle/requests/case-1/target-events?before=foreign',
      headers: { authorization: token('ADMIN') } });
    assert.equal(foreign.statusCode, 404);

    const next = await app.inject({ method: 'GET', url: '/data-lifecycle/requests/case-1/target-events?before=target-051',
      headers: { authorization: token('ADMIN') } });
    assert.equal(next.statusCode, 200, next.body);
    assert.deepEqual(queries[3].where, { organisationId: 'org-1', requestId: 'case-1', OR: [
      { occurredAt: { lt: at } }, { occurredAt: at, id: { lt: 'target-051' } },
    ] });
  } finally { await app.close(); }
});

test('another charity’s case is absent from detail, history and triage', async () => {
  const lookups: unknown[] = [];
  let eventReads = 0;
  let updates = 0;
  const app = await appFor('ADMIN', {
    dataLifecycleRequest: {
      findFirst: async (args: unknown) => { lookups.push(args); return null; },
      updateMany: async () => { updates += 1; return { count: 1 }; },
    },
    dataLifecycleReviewEvent: { findMany: async () => { eventReads += 1; return []; } },
  });
  try {
    for (const path of ['/data-lifecycle/requests/other-case', '/data-lifecycle/requests/other-case/events']) {
      const response = await app.inject({ method: 'GET', url: path, headers: { authorization: token('ADMIN') } });
      assert.equal(response.statusCode, 404);
    }
    const triage = await app.inject({ method: 'POST', url: '/data-lifecycle/requests/other-case/triage',
      headers: { authorization: token('ADMIN') }, payload: {
        expectedUpdatedAt: '2026-09-28T10:00:00.000Z', nextState: 'ASSESSING',
        reason: 'Review of linked records.',
      } });
    assert.equal(triage.statusCode, 404);
    assert.deepEqual(lookups, Array(3).fill(null).map(() => ({ where: { id: 'other-case', organisationId: 'org-1' } })));
    assert.equal(eventReads, 0);
    assert.equal(updates, 0);
  } finally { await app.close(); }
});

test('Vault document links require Admin, an existing same-charity case and document, and an opaque ID', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let caseExists = true;
  let documentExists = true;
  const models = {
    dataLifecycleRequest: { findFirst: async (args: Record<string, unknown>) => {
      calls.push({ name: 'case', args });
      return caseExists ? { id: 'case-1' } : null;
    } },
    document: { findFirst: async (args: Record<string, unknown>) => {
      calls.push({ name: 'document', args });
      return documentExists ? { id: 'doc-1' } : null;
    } },
    dataLifecycleDocumentLink: { create: async (args: Record<string, unknown>) => {
      calls.push({ name: 'link', args });
      return { id: 'link-1', ...(args.data as object) };
    } },
  };
  const member = await appFor('MEMBER', models);
  try {
    const denied = await member.inject({ method: 'POST', url: '/data-lifecycle/requests/case-1/document-links',
      headers: { authorization: token('MEMBER') }, payload: {
        documentId: 'doc-1', reason: 'Reviewed in controlled case archive.',
      } });
    assert.equal(denied.statusCode, 403);
    assert.equal(calls.length, 0);
  } finally { await member.close(); }

  const admin = await appFor('ADMIN', models);
  try {
    const invalid = await admin.inject({ method: 'POST', url: '/data-lifecycle/requests/case-1/document-links',
      headers: { authorization: token('ADMIN') }, payload: {
        documentId: 'person@example.org', reason: 'Reviewed in controlled case archive.',
      } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(calls.length, 0);

    caseExists = false;
    const foreignCase = await admin.inject({ method: 'POST', url: '/data-lifecycle/requests/case-1/document-links',
      headers: { authorization: token('ADMIN') }, payload: {
        documentId: 'doc-1', reason: 'Reviewed in controlled case archive.',
      } });
    assert.equal(foreignCase.statusCode, 404);
    assert.deepEqual(calls[0].args.where, { id: 'case-1', organisationId: 'org-1' });
    assert.equal(calls.length, 1);

    caseExists = true;
    documentExists = false;
    const foreignDocument = await admin.inject({ method: 'POST', url: '/data-lifecycle/requests/case-1/document-links',
      headers: { authorization: token('ADMIN') }, payload: {
        documentId: 'doc-1', reason: 'Reviewed in controlled case archive.',
      } });
    assert.equal(foreignDocument.statusCode, 404);
    assert.deepEqual(calls[2].args.where, { id: 'doc-1', organisationId: 'org-1' });
    assert.equal(calls.length, 3);

    documentExists = true;
    const linked = await admin.inject({ method: 'POST', url: '/data-lifecycle/requests/case-1/document-links',
      headers: { authorization: token('ADMIN') }, payload: {
        documentId: 'doc-1', reason: 'Reviewed in controlled case archive.',
      } });
    assert.equal(linked.statusCode, 201, linked.body);
    assert.deepEqual(calls[5], { name: 'link', args: { data: {
      documentId: 'doc-1', reason: 'Reviewed in controlled case archive.',
      organisationId: 'org-1', requestId: 'case-1', actorUserId: 'u1',
    } } });
  } finally { await admin.close(); }
});

test('Vault document links page by tenant and case, expose no document metadata, and retain reasoned withdrawal', async () => {
  const at = new Date('2026-09-29T10:00:00.000Z');
  const queries: Record<string, unknown>[] = [];
  const withdrawals: Record<string, unknown>[] = [];
  const app = await appFor('ADMIN', {
    dataLifecycleRequest: { findFirst: async () => ({ id: 'case-1' }) },
    dataLifecycleDocumentLink: {
      findFirst: async (args: Record<string, unknown>) => {
        queries.push(args);
        return (args.where as { id: string }).id === 'link-051' ? { id: 'link-051', createdAt: at } : null;
      },
      findMany: async (args: Record<string, unknown>) => {
        queries.push(args);
        return Array.from({ length: 51 }, (_, index) => ({
          id: `link-${String(101 - index).padStart(3, '0')}`, documentId: `doc-${index}`, createdAt: at,
        }));
      },
    },
    dataLifecycleDocumentLinkWithdrawal: { create: async (args: Record<string, unknown>) => {
      withdrawals.push(args);
      return { id: 'withdrawal-1', ...(args.data as object) };
    } },
  });
  try {
    const first = await app.inject({ method: 'GET', url: '/data-lifecycle/requests/case-1/document-links',
      headers: { authorization: token('ADMIN') } });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().data.items.length, 50);
    assert.equal(first.json().data.nextCursor, 'link-052');
    assert.deepEqual(queries[0].where, { organisationId: 'org-1', requestId: 'case-1' });
    assert.deepEqual(queries[0].orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
    assert.equal(queries[0].take, 51);
    assert.equal((queries[0].select as Record<string, unknown>).document, undefined);

    const foreignCursor = await app.inject({ method: 'GET',
      url: '/data-lifecycle/requests/case-1/document-links?before=foreign-link',
      headers: { authorization: token('ADMIN') } });
    assert.equal(foreignCursor.statusCode, 404);
    assert.deepEqual(queries[1].where, { id: 'foreign-link', organisationId: 'org-1', requestId: 'case-1' });

    const withdrawal = await app.inject({ method: 'POST',
      url: '/data-lifecycle/requests/case-1/document-links/link-051/withdraw',
      headers: { authorization: token('ADMIN') }, payload: { reason: 'Linked the wrong Vault record.' } });
    assert.equal(withdrawal.statusCode, 201, withdrawal.body);
    assert.deepEqual(queries[2].where, { id: 'link-051', organisationId: 'org-1', requestId: 'case-1' });
    assert.deepEqual(withdrawals[0].data, {
      organisationId: 'org-1', requestId: 'case-1', linkId: 'link-051',
      actorUserId: 'u1', reason: 'Linked the wrong Vault record.',
    });
  } finally { await app.close(); }
});

test('storage deletion association is Admin-only and requires both records in the same charity', async () => {
  const reads: Record<string, unknown>[] = [];
  const writes: Record<string, unknown>[] = [];
  const models = {
    dataLifecycleRequest: { findFirst: async (args: Record<string, unknown>) => {
      reads.push(args);
      return { id: 'case-1' };
    } },
    documentStorageDeletion: { findFirst: async (args: Record<string, unknown>) => {
      reads.push(args);
      return (args.where as { id: string }).id === 'deletion-1' ? { id: 'deletion-1' } : null;
    } },
    dataLifecycleStorageLink: { create: async (args: Record<string, unknown>) => {
      writes.push(args);
      return { id: 'link-1', ...(args.data as object) };
    } },
  };
  const memberApp = await appFor('MEMBER', models);
  try {
    for (const [method, url] of [
      ['GET', '/data-lifecycle/requests/case-1/storage-links'],
      ['POST', '/data-lifecycle/requests/case-1/storage-links'],
      ['POST', '/data-lifecycle/requests/case-1/storage-links/link-1/withdraw'],
    ]) {
      const denied = await memberApp.inject({ method: method as 'GET' | 'POST', url,
        headers: { authorization: token('MEMBER') } });
      assert.equal(denied.statusCode, 403);
    }
    assert.equal(reads.length, 0);
    assert.equal(writes.length, 0);
  } finally { await memberApp.close(); }

  const adminApp = await appFor('ADMIN', models);
  try {
    const missing = await adminApp.inject({ method: 'POST',
      url: '/data-lifecycle/requests/case-1/storage-links',
      headers: { authorization: token('ADMIN') },
      payload: { deletionId: 'other-charity-job', reason: 'Checked the controlled case archive.' } });
    assert.equal(missing.statusCode, 404);
    assert.equal(writes.length, 0);
    assert.deepEqual(reads[1], { where: { id: 'other-charity-job', organisationId: 'org-1' }, select: { id: true } });

    const linked = await adminApp.inject({ method: 'POST',
      url: '/data-lifecycle/requests/case-1/storage-links',
      headers: { authorization: token('ADMIN') },
      payload: { deletionId: 'deletion-1', reason: 'Checked the controlled case archive.' } });
    assert.equal(linked.statusCode, 201, linked.body);
    assert.deepEqual(writes[0], { data: {
      organisationId: 'org-1', requestId: 'case-1', deletionId: 'deletion-1',
      actorUserId: 'u1', reason: 'Checked the controlled case archive.',
    } });
  } finally { await adminApp.close(); }
});

test('case storage-link feed pages by tenant and case without returning storage paths', async () => {
  const at = new Date('2026-09-29T10:00:00.000Z');
  const queries: Record<string, unknown>[] = [];
  const app = await appFor('ADMIN', {
    dataLifecycleRequest: { findFirst: async () => ({ id: 'case-1' }) },
    dataLifecycleStorageLink: {
      findFirst: async (args: { where: { id: string; organisationId: string; requestId: string } }) =>
        args.where.id === 'link-050' && args.where.organisationId === 'org-1' && args.where.requestId === 'case-1'
          ? { id: 'link-050', createdAt: at } : null,
      findMany: async (args: Record<string, unknown>) => {
        queries.push(args);
        return queries.length === 1
          ? Array.from({ length: 51 }, (_, index) => ({ id: `link-${String(100 - index).padStart(3, '0')}` }))
          : [{ id: 'link-049' }];
      },
    },
  });
  try {
    const first = await app.inject({ method: 'GET', url: '/data-lifecycle/requests/case-1/storage-links',
      headers: { authorization: token('ADMIN') } });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().data.items.length, 50);
    assert.equal(first.json().data.nextCursor, 'link-051');
    const select = queries[0].select as { deletion: { select: Record<string, boolean> } };
    assert.equal(select.deletion.select.provider, true);
    assert.equal(select.deletion.select.sourceDocumentId, true);
    assert.equal(select.deletion.select.activeObjectAbsentAt, true);
    assert.equal(select.deletion.select.storagePath, undefined);
    assert.equal(select.deletion.select.lastError, undefined);
    assert.deepEqual((queries[0].select as { withdrawal: unknown }).withdrawal, {
      select: { actorUserId: true, reason: true, createdAt: true },
    });

    const foreign = await app.inject({ method: 'GET',
      url: '/data-lifecycle/requests/case-1/storage-links?before=other-charity-link',
      headers: { authorization: token('ADMIN') } });
    assert.equal(foreign.statusCode, 404);
    assert.equal(queries.length, 1);
    const next = await app.inject({ method: 'GET',
      url: '/data-lifecycle/requests/case-1/storage-links?before=link-050',
      headers: { authorization: token('ADMIN') } });
    assert.equal(next.statusCode, 200);
    assert.deepEqual(queries[1].where, { organisationId: 'org-1', requestId: 'case-1', OR: [
      { createdAt: { lt: at } }, { createdAt: at, id: { lt: 'link-050' } },
    ] });
  } finally { await app.close(); }
});

test('withdrawal is case-bound, recorded once, and preserves the original link', async () => {
  const reads: Record<string, unknown>[] = [];
  const writes: Record<string, unknown>[] = [];
  const app = await appFor('ADMIN', {
    dataLifecycleStorageLink: { findFirst: async (args: Record<string, unknown>) => {
      reads.push(args);
      return (args.where as { id: string; requestId: string }).id === 'link-1'
        && (args.where as { requestId: string }).requestId === 'case-1' ? { id: 'link-1' } : null;
    } },
    dataLifecycleStorageLinkWithdrawal: { create: async (args: Record<string, unknown>) => {
      writes.push(args);
      return { id: 'withdrawal-1', ...(args.data as object) };
    } },
  });
  try {
    const foreign = await app.inject({ method: 'POST',
      url: '/data-lifecycle/requests/other-case/storage-links/link-1/withdraw',
      headers: { authorization: token('ADMIN') },
      payload: { reason: 'The case reference was mismatched.' } });
    assert.equal(foreign.statusCode, 404);
    assert.equal(writes.length, 0);

    const withdrawn = await app.inject({ method: 'POST',
      url: '/data-lifecycle/requests/case-1/storage-links/link-1/withdraw',
      headers: { authorization: token('ADMIN') },
      payload: { reason: 'The case reference was mismatched.' } });
    assert.equal(withdrawn.statusCode, 201, withdrawn.body);
    assert.deepEqual(reads[1], { where: { id: 'link-1', organisationId: 'org-1', requestId: 'case-1' }, select: { id: true } });
    assert.deepEqual(writes[0], { data: {
      organisationId: 'org-1', requestId: 'case-1', linkId: 'link-1',
      actorUserId: 'u1', reason: 'The case reference was mismatched.',
    } });
  } finally { await app.close(); }
});
