import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'governance-audit-archive-test-secret';

const [{ default: Fastify }, { governanceAuditRoutes }, { signAccessToken }] = await Promise.all([
  import('fastify'), import('../routes/governance-audit/index.js'), import('../utils/jwt.js'),
]);

type Role = 'MEMBER' | 'ADMIN';
const token = (role: Role) => `Bearer ${signAccessToken({
  userId: 'u1', organisationId: 'org-1', role, sessionId: 's1',
})}`;

async function appFor(role: Role, delegates: Record<string, unknown>) {
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    authSession: { findFirst: async () => ({ id: 's1' }) },
    user: { findUnique: async () => ({ id: 'u1', organisationId: 'org-1', role, emailVerified: true }) },
    ...delegates,
  } as never);
  await app.register(governanceAuditRoutes, { prefix: '/governance-audit' });
  return app;
}

test('Member cannot read the application audit archive before a feed query', async () => {
  let reads = 0;
  const app = await appFor('MEMBER', {
    minuteBookChangeAudit: { findMany: async () => { reads++; return []; } },
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/governance-audit/minute-book',
      headers: { authorization: token('MEMBER') } });
    assert.equal(response.statusCode, 403);
    assert.equal(reads, 0);
  } finally { await app.close(); }
});

test('Admin connector cannot read the dashboard-only governance audit feed by direct API call', async () => {
  let reads = 0;
  const app = await appFor('ADMIN', {
    authSession: { findFirst: async () => ({
      id: 's1', clientKind: 'MCP_CONNECTOR', accessLevel: 'ADMIN', dataScope: 'FULL',
    }) },
    minuteBookChangeAudit: { findMany: async () => { reads += 1; return []; } },
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/governance-audit/minute-book',
      headers: { authorization: token('ADMIN') } });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, 'WEB_SESSION_REQUIRED');
    assert.equal(reads, 0);
  } finally { await app.close(); }
});

test('connector change attempts page outcomes without session IDs, reasons or unmatched paths', async () => {
  const occurredAt = new Date('2026-09-29T10:00:00.000Z');
  const rows = Array.from({ length: 52 }, (_, index) => ({
    id: `connector-${String(52 - index).padStart(3, '0')}`, occurredAt,
    userId: 'u1', method: 'DELETE',
    routePattern: index === 0 ? '(unmatched) /private/person/example' : '/api/v1/documents/:id',
    resourceId: 'doc-1', statusCode: index === 0 ? 404 : 403, requestId: `request-${index}`,
    sessionId: 'private-session', reason: 'private reason with personal details',
  }));
  let reads = 0;
  const delegate = {
    findFirst: async (args: { where: { id: string; organisationId: string } }) => {
      assert.equal(args.where.organisationId, 'org-1');
      return rows.find((row) => row.id === args.where.id) ?? null;
    },
    findMany: async (args: Record<string, unknown>) => {
      reads++;
      const where = args.where as { organisationId: string; OR?: [unknown, { id: { lt: string } }] };
      assert.equal(where.organisationId, 'org-1');
      const select = args.select as Record<string, boolean>;
      assert.equal(select.sessionId, undefined);
      assert.equal(select.reason, undefined);
      return rows.filter((row) => !where.OR || row.id < where.OR[1].id.lt)
        .slice(0, Number(args.take))
        .map((row) => Object.fromEntries(Object.entries(row).filter(([field]) => select[field])));
    },
  };
  const member = await appFor('MEMBER', { clientActivityEvent: delegate });
  try {
    const denied = await member.inject({ method: 'GET', url: '/governance-audit/connector-actions',
      headers: { authorization: token('MEMBER') } });
    assert.equal(denied.statusCode, 403);
    assert.equal(reads, 0);
  } finally { await member.close(); }

  const admin = await appFor('ADMIN', { clientActivityEvent: delegate });
  try {
    const first = await admin.inject({ method: 'GET', url: '/governance-audit/connector-actions',
      headers: { authorization: token('ADMIN') } });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().data.length, 50);
    assert.equal(first.json().data[0].routePattern, '(unmatched)');
    assert.equal(first.json().nextCursor, 'connector-003');
    assert.doesNotMatch(first.body, /private-session|private reason|private\/person/);
    const second = await admin.inject({ method: 'GET', url: '/governance-audit/connector-actions?before=connector-003',
      headers: { authorization: token('ADMIN') } });
    assert.deepEqual(second.json().data.map((event: { id: string }) => event.id), ['connector-002', 'connector-001']);
    const foreign = await admin.inject({ method: 'GET', url: '/governance-audit/connector-actions?before=other-charity',
      headers: { authorization: token('ADMIN') } });
    assert.equal(foreign.statusCode, 404);
  } finally { await admin.close(); }
});

test('reminder audit pages retained transitions without recipient or provider details', async () => {
  const occurredAt = new Date('2026-09-29T10:00:00.000Z');
  const rows = Array.from({ length: 52 }, (_, index) => ({
    id: `reminder-${String(52 - index).padStart(3, '0')}`, occurredAt,
    reminderId: 'log-1', deadlineId: 'deadline-1', previousStatus: 'SENDING', nextStatus: 'SENT',
    reconciliationOutcome: null, email: 'private@example.test', error: 'private provider error',
  }));
  let reads = 0;
  const delegate = {
    findFirst: async (args: { where: { id: string; organisationId: string } }) => {
      assert.equal(args.where.organisationId, 'org-1');
      return rows.find((row) => row.id === args.where.id) ?? null;
    },
    findMany: async (args: Record<string, unknown>) => {
      reads++;
      const where = args.where as { organisationId: string; OR?: [unknown, { id: { lt: string } }] };
      assert.equal(where.organisationId, 'org-1');
      const select = args.select as Record<string, boolean>;
      assert.equal(select.email, undefined);
      assert.equal(select.error, undefined);
      assert.equal(select.deadlineTitle, undefined);
      assert.equal(select.providerMessageId, undefined);
      return rows.filter((row) => !where.OR || row.id < where.OR[1].id.lt)
        .slice(0, Number(args.take))
        .map((row) => Object.fromEntries(Object.entries(row).filter(([field]) => select[field])));
    },
  };
  const member = await appFor('MEMBER', { deadlineReminderAudit: delegate });
  try {
    const denied = await member.inject({ method: 'GET', url: '/governance-audit/reminders',
      headers: { authorization: token('MEMBER') } });
    assert.equal(denied.statusCode, 403);
    assert.equal(reads, 0);
  } finally { await member.close(); }

  const admin = await appFor('ADMIN', { deadlineReminderAudit: delegate });
  try {
    const first = await admin.inject({ method: 'GET', url: '/governance-audit/reminders',
      headers: { authorization: token('ADMIN') } });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().data.length, 50);
    assert.equal(first.json().nextCursor, 'reminder-003');
    assert.doesNotMatch(first.body, /private@example|private provider/);
    const second = await admin.inject({ method: 'GET', url: '/governance-audit/reminders?before=reminder-003',
      headers: { authorization: token('ADMIN') } });
    assert.deepEqual(second.json().data.map((event: { id: string }) => event.id), ['reminder-002', 'reminder-001']);
    const foreign = await admin.inject({ method: 'GET', url: '/governance-audit/reminders?before=foreign',
      headers: { authorization: token('ADMIN') } });
    assert.equal(foreign.statusCode, 404);
  } finally { await admin.close(); }
});

test('Minute Book archive pages equal-time events with a tenant-bound cursor', async () => {
  const occurredAt = new Date('2026-09-29T10:00:00.000Z');
  const events = Array.from({ length: 52 }, (_, index) => ({
    id: `event-${String(52 - index).padStart(3, '0')}`, occurredAt, recordId: 'act-1',
  }));
  const queries: Record<string, unknown>[] = [];
  const app = await appFor('ADMIN', {
    minuteBookChangeAudit: {
      findFirst: async (args: { where: { id: string; organisationId: string } }) =>
        args.where.organisationId === 'org-1' ? events.find((event) => event.id === args.where.id) ?? null : null,
      findMany: async (args: Record<string, unknown>) => {
        queries.push(args);
        const where = args.where as { organisationId: string; OR?: [unknown, { id: { lt: string } }] };
        assert.equal(where.organisationId, 'org-1');
        return events.filter((event) => !where.OR || event.id < where.OR[1].id.lt).slice(0, 51);
      },
    },
  });
  try {
    const first = await app.inject({ method: 'GET', url: '/governance-audit/minute-book',
      headers: { authorization: token('ADMIN') } });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().data.length, 50);
    assert.equal(first.json().nextCursor, 'event-003');
    const second = await app.inject({ method: 'GET', url: '/governance-audit/minute-book?before=event-003',
      headers: { authorization: token('ADMIN') } });
    assert.equal(second.statusCode, 200);
    assert.deepEqual(second.json().data.map((event: { id: string }) => event.id), ['event-002', 'event-001']);
    assert.equal(second.json().nextCursor, null);
    assert.deepEqual((queries[1].where as { OR: unknown }).OR, [
      { occurredAt: { lt: occurredAt } }, { occurredAt, id: { lt: 'event-003' } },
    ]);
    const missing = await app.inject({ method: 'GET', url: '/governance-audit/minute-book?before=other-tenant',
      headers: { authorization: token('ADMIN') } });
    assert.equal(missing.statusCode, 404);
    assert.equal(queries.length, 2);
    const invalid = await app.inject({ method: 'GET', url: '/governance-audit/minute-book?before=bad%2Fid',
      headers: { authorization: token('ADMIN') } });
    assert.equal(invalid.statusCode, 400);
  } finally { await app.close(); }
});

test('source-area decisions reach Governance Audit without case reasons or foreign-tenant cursors', async () => {
  const occurredAt = new Date('2026-09-29T12:00:00.000Z');
  const rows = Array.from({ length: 52 }, (_, index) => ({
    id: `coverage-${String(52 - index).padStart(3, '0')}`, organisationId: 'org-1',
    requestId: 'case-1', area: 'BACKUPS', disposition: 'NEEDS_FOLLOW_UP',
    actorUserId: 'admin-1', occurredAt,
    reason: 'Private case reason with personal details', evidenceRef: 'PRIVATE-ARCHIVE-1',
  }));
  let reads = 0;
  const delegate = {
    findFirst: async (args: { where: { id: string; organisationId: string } }) => {
      reads += 1;
      assert.equal(args.where.organisationId, 'org-1');
      return rows.find((row) => row.id === args.where.id) ?? null;
    },
    findMany: async (args: Record<string, unknown>) => {
      reads += 1;
      const where = args.where as { organisationId: string; OR?: [unknown, { id: { lt: string } }] };
      assert.equal(where.organisationId, 'org-1');
      const select = args.select as Record<string, boolean>;
      assert.equal(select.reason, undefined);
      assert.equal(select.evidenceRef, undefined);
      return rows.filter((row) => !where.OR || row.id < where.OR[1].id.lt)
        .slice(0, Number(args.take))
        .map((row) => Object.fromEntries(Object.entries(row).filter(([field]) => select[field])));
    },
  };
  const member = await appFor('MEMBER', { dataLifecycleCoverageEvent: delegate });
  try {
    const denied = await member.inject({ method: 'GET', url: '/governance-audit/data-request-coverage',
      headers: { authorization: token('MEMBER') } });
    assert.equal(denied.statusCode, 403);
    assert.equal(reads, 0);
  } finally { await member.close(); }

  const admin = await appFor('ADMIN', { dataLifecycleCoverageEvent: delegate });
  try {
    const first = await admin.inject({ method: 'GET', url: '/governance-audit/data-request-coverage',
      headers: { authorization: token('ADMIN') } });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().data.length, 50);
    assert.equal(first.json().nextCursor, 'coverage-003');
    assert.doesNotMatch(first.body, /Private case reason|PRIVATE-ARCHIVE/);
    const next = await admin.inject({ method: 'GET',
      url: '/governance-audit/data-request-coverage?before=coverage-003',
      headers: { authorization: token('ADMIN') } });
    assert.deepEqual(next.json().data.map((row: { id: string }) => row.id), ['coverage-002', 'coverage-001']);
    assert.equal(next.json().nextCursor, null);
    const foreign = await admin.inject({ method: 'GET',
      url: '/governance-audit/data-request-coverage?before=foreign-event',
      headers: { authorization: token('ADMIN') } });
    assert.equal(foreign.statusCode, 404);
  } finally { await admin.close(); }
});

test('audit archive keeps deletion paths and free-text reasons out of overview queries', async () => {
  const selections: Record<string, unknown>[] = [];
  const app = await appFor('ADMIN', {
    documentStorageDeletion: { findMany: async (args: Record<string, unknown>) => { selections.push(args); return []; } },
    dataLifecycleReviewEvent: { findMany: async (args: Record<string, unknown>) => { selections.push(args); return []; } },
  });
  try {
    for (const feed of ['deletions', 'data-requests']) {
      const response = await app.inject({ method: 'GET', url: `/governance-audit/${feed}`,
        headers: { authorization: token('ADMIN') } });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { data: [], nextCursor: null });
    }
    assert.equal((selections[0].select as Record<string, unknown>).storagePath, undefined);
    assert.equal((selections[0].select as Record<string, unknown>).reason, undefined);
    assert.equal((selections[0].select as Record<string, unknown>).lastError, undefined);
    assert.equal((selections[0].select as Record<string, unknown>).activeObjectAbsentAt, true);
    assert.equal((selections[1].select as Record<string, unknown>).reason, undefined);
    assert.deepEqual(selections.map((query) => query.where), [
      { organisationId: 'org-1' }, { organisationId: 'org-1' },
    ]);
  } finally { await app.close(); }
});

test('case evidence changes are Admin-only, tenant-bound, paged across four sources and reason-free', async () => {
  const at = new Date('2026-09-29T10:00:00.000Z');
  const sourceNames = [
    'dataLifecycleDocumentLink', 'dataLifecycleDocumentLinkWithdrawal',
    'dataLifecycleStorageLink', 'dataLifecycleStorageLinkWithdrawal',
  ] as const;
  type Fixture = { id: string; requestId: string; actorUserId: string; createdAt: Date;
    documentId?: string; deletionId?: string; linkId?: string; reason: string; storagePath: string };
  const rows = new Map(sourceNames.map((name) => [name, Array.from({ length: 20 }, (_, index): Fixture => ({
    id: `event-${String(20 - index).padStart(3, '0')}`, requestId: 'case-1',
    actorUserId: 'admin-1', createdAt: at,
    ...(name === 'dataLifecycleDocumentLink' ? { documentId: 'doc-1' }
      : name === 'dataLifecycleStorageLink' ? { deletionId: 'job-1' } : { linkId: 'link-1' }),
    reason: 'Private case reason that must not leave the case view.', storagePath: 'private/path.pdf',
  }))]));
  const queries: Array<{ name: string; args: Record<string, unknown> }> = [];
  let reads = 0;
  const delegates = Object.fromEntries(sourceNames.map((name) => [name, {
    findFirst: async (args: { where: { id: string; organisationId: string } }) => {
      assert.equal(args.where.organisationId, 'org-1');
      return rows.get(name)?.find((row) => row.id === args.where.id) ?? null;
    },
    findMany: async (args: Record<string, unknown>) => {
      reads++;
      queries.push({ name, args });
      const where = args.where as { organisationId: string; OR?: Array<{ createdAt: Date | { lt: Date }; id?: { lt: string } }> };
      assert.equal(where.organisationId, 'org-1');
      const select = args.select as Record<string, unknown>;
      assert.equal(select.reason, undefined);
      assert.equal(select.storagePath, undefined);
      return (rows.get(name) ?? []).filter((row) => !where.OR || where.OR.some((condition) =>
        typeof condition.createdAt === 'object' && 'lt' in condition.createdAt
          ? row.createdAt < condition.createdAt.lt
          : row.createdAt.getTime() === (condition.createdAt as Date).getTime()
            && (!condition.id || row.id < condition.id.lt)))
        .slice(0, Number(args.take));
    },
  }]));
  const member = await appFor('MEMBER', delegates);
  try {
    const denied = await member.inject({ method: 'GET', url: '/governance-audit/data-request-links',
      headers: { authorization: token('MEMBER') } });
    assert.equal(denied.statusCode, 403);
    assert.equal(reads, 0);
  } finally { await member.close(); }

  const admin = await appFor('ADMIN', delegates);
  try {
    const first = await admin.inject({ method: 'GET', url: '/governance-audit/data-request-links',
      headers: { authorization: token('ADMIN') } });
    assert.equal(first.statusCode, 200, first.body);
    const firstPage = first.json() as { data: Array<{ id: string }>; nextCursor: string | null };
    assert.equal(firstPage.data.length, 50);
    assert.equal(firstPage.nextCursor, firstPage.data[49].id);
    assert.equal(queries.length, 4);
    assert.ok(queries.every(({ args }) => args.take === 51));
    assert.doesNotMatch(first.body, /Private case reason|private\/path/);

    const second = await admin.inject({ method: 'GET',
      url: `/governance-audit/data-request-links?before=${firstPage.nextCursor}`,
      headers: { authorization: token('ADMIN') } });
    assert.equal(second.statusCode, 200, second.body);
    const secondPage = second.json() as { data: Array<{ id: string }>; nextCursor: string | null };
    assert.equal(secondPage.data.length, 30);
    assert.equal(secondPage.nextCursor, null);
    assert.equal(new Set([...firstPage.data, ...secondPage.data].map((row) => row.id)).size, 80);
    assert.doesNotMatch(second.body, /Private case reason|private\/path/);

    const beforeForeign = reads;
    const foreign = await admin.inject({ method: 'GET',
      url: '/governance-audit/data-request-links?before=doc-link_foreign',
      headers: { authorization: token('ADMIN') } });
    assert.equal(foreign.statusCode, 404);
    assert.equal(reads, beforeForeign);
    const invalid = await admin.inject({ method: 'GET',
      url: '/governance-audit/data-request-links?before=bad%2Fid',
      headers: { authorization: token('ADMIN') } });
    assert.equal(invalid.statusCode, 400);
  } finally { await admin.close(); }
});

test('audit overview selects event metadata without narrative reasons or before/after snapshots', async () => {
  const feeds = [
    ['minute-book', 'minuteBookChangeAudit'],
    ['document-controls', 'documentControlAudit'],
    ['document-visibility', 'documentVisibilityAudit'],
    ['risks', 'riskChangeAudit'],
    ['controls', 'riskControlVerification'],
    ['compliance', 'complianceAuditEvent'],
    ['data-requests', 'dataLifecycleReviewEvent'],
    ['data-request-targets', 'dataLifecycleTargetEvent'],
    ['data-request-responses', 'dataLifecycleResponseEvent'],
    ['data-request-coverage', 'dataLifecycleCoverageEvent'],
  ] as const;
  const selections = new Map<string, Record<string, boolean>>();
  const delegates = Object.fromEntries(feeds.map(([feed, name]) => [name, {
    findMany: async (args: { select: Record<string, boolean> }) => {
      selections.set(feed, args.select);
      return [];
    },
  }]));
  const app = await appFor('ADMIN', delegates);
  try {
    for (const [feed] of feeds) {
      const response = await app.inject({ method: 'GET', url: `/governance-audit/${feed}`,
        headers: { authorization: token('ADMIN') } });
      assert.equal(response.statusCode, 200);
      const select = selections.get(feed);
      assert.equal(select?.id, true);
      assert.equal(select?.beforeState, undefined);
      assert.equal(select?.afterState, undefined);
      assert.equal(select?.reason, undefined);
    }
    assert.equal(selections.get('controls')?.evidenceReference, undefined);
    assert.equal(selections.get('document-controls')?.previous, undefined);
    assert.equal(selections.get('document-controls')?.next, undefined);
    assert.equal(selections.get('compliance')?.actorName, undefined);
    assert.equal(selections.get('data-request-coverage')?.evidenceRef, undefined);
    assert.equal(selections.get('data-requests')?.evidenceRef, undefined);
    assert.equal(selections.get('data-request-targets')?.evidenceRef, undefined);
    assert.equal(selections.get('data-request-responses')?.evidenceRef, undefined);
  } finally { await app.close(); }
});

test('approval event archive is Admin-only, tenant-bound, and omits sensitive approval fields', async () => {
  let reads = 0;
  let pageQuery: Record<string, unknown> | undefined;
  const occurredAt = new Date('2026-09-29T10:00:00.000Z');
  const delegate = {
    findFirst: async (args: { where: { id: string; organisationId: string } }) =>
      args.where.id === 'approval-1' && args.where.organisationId === 'org-1'
        ? { id: 'approval-1', occurredAt } : null,
    findMany: async (args: Record<string, unknown>) => { reads++; pageQuery = args; return []; },
  };
  const memberApp = await appFor('MEMBER', { authActionApprovalAudit: delegate });
  try {
    const denied = await memberApp.inject({ method: 'GET', url: '/governance-audit/action-approvals',
      headers: { authorization: token('MEMBER') } });
    assert.equal(denied.statusCode, 403);
    assert.equal(reads, 0);
  } finally { await memberApp.close(); }

  const adminApp = await appFor('ADMIN', { authActionApprovalAudit: delegate });
  try {
    const response = await adminApp.inject({ method: 'GET',
      url: '/governance-audit/action-approvals?before=approval-1',
      headers: { authorization: token('ADMIN') } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(pageQuery?.where, { organisationId: 'org-1', OR: [
      { occurredAt: { lt: occurredAt } }, { occurredAt, id: { lt: 'approval-1' } },
    ] });
    assert.deepEqual(pageQuery?.select, {
      id: true, approvalId: true, kind: true, actorUserId: true,
      method: true, routePattern: true, resourceId: true, expiresAt: true, occurredAt: true,
      backfilled: true,
    });
    const foreign = await adminApp.inject({ method: 'GET',
      url: '/governance-audit/action-approvals?before=foreign',
      headers: { authorization: token('ADMIN') } });
    assert.equal(foreign.statusCode, 404);
    assert.equal(reads, 1);
  } finally { await adminApp.close(); }
});

test('response-target overview rejects Member and foreign cursors and omits case narrative', async () => {
  const occurredAt = new Date('2026-09-29T10:00:00.000Z');
  let reads = 0;
  let pageQuery: Record<string, unknown> | undefined;
  const delegate = {
    findFirst: async (args: { where: { id: string; organisationId: string } }) => {
      reads++;
      assert.equal(args.where.organisationId, 'org-1');
      return args.where.id === 'target-1' ? { id: 'target-1', occurredAt } : null;
    },
    findMany: async (args: Record<string, unknown>) => { reads++; pageQuery = args; return []; },
  };
  const member = await appFor('MEMBER', { dataLifecycleTargetEvent: delegate });
  try {
    const denied = await member.inject({ method: 'GET', url: '/governance-audit/data-request-targets',
      headers: { authorization: token('MEMBER') } });
    assert.equal(denied.statusCode, 403);
    assert.equal(reads, 0);
  } finally { await member.close(); }
  const admin = await appFor('ADMIN', { dataLifecycleTargetEvent: delegate });
  try {
    const response = await admin.inject({ method: 'GET',
      url: '/governance-audit/data-request-targets?before=target-1',
      headers: { authorization: token('ADMIN') } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(pageQuery?.where, { organisationId: 'org-1', OR: [
      { occurredAt: { lt: occurredAt } }, { occurredAt, id: { lt: 'target-1' } },
    ] });
    assert.deepEqual(pageQuery?.select, { id: true, requestId: true, actorUserId: true,
      previousTargetAt: true, nextTargetAt: true, occurredAt: true });
    const foreign = await admin.inject({ method: 'GET',
      url: '/governance-audit/data-request-targets?before=foreign',
      headers: { authorization: token('ADMIN') } });
    assert.equal(foreign.statusCode, 404);
    assert.equal(reads, 3);
  } finally { await admin.close(); }
});

test('actual-response overview is Admin-only, tenant-bound and omits case evidence', async () => {
  const occurredAt = new Date('2026-09-29T10:00:00.000Z');
  let reads = 0;
  let pageQuery: Record<string, unknown> | undefined;
  const delegate = {
    findFirst: async (args: { where: { id: string; organisationId: string } }) => {
      reads++;
      assert.equal(args.where.organisationId, 'org-1');
      return args.where.id === 'response-1' ? { id: 'response-1', occurredAt } : null;
    },
    findMany: async (args: Record<string, unknown>) => { reads++; pageQuery = args; return []; },
  };
  const member = await appFor('MEMBER', { dataLifecycleResponseEvent: delegate });
  try {
    const denied = await member.inject({ method: 'GET', url: '/governance-audit/data-request-responses',
      headers: { authorization: token('MEMBER') } });
    assert.equal(denied.statusCode, 403);
    assert.equal(reads, 0);
  } finally { await member.close(); }
  const admin = await appFor('ADMIN', { dataLifecycleResponseEvent: delegate });
  try {
    const response = await admin.inject({ method: 'GET',
      url: '/governance-audit/data-request-responses?before=response-1',
      headers: { authorization: token('ADMIN') } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(pageQuery?.where, { organisationId: 'org-1', OR: [
      { occurredAt: { lt: occurredAt } }, { occurredAt, id: { lt: 'response-1' } },
    ] });
    assert.deepEqual(pageQuery?.select, { id: true, requestId: true, actorUserId: true,
      previousResponseAt: true, nextResponseAt: true, occurredAt: true });
    const foreign = await admin.inject({ method: 'GET',
      url: '/governance-audit/data-request-responses?before=foreign',
      headers: { authorization: token('ADMIN') } });
    assert.equal(foreign.statusCode, 404);
    assert.equal(reads, 3);
  } finally { await admin.close(); }
});

test('storage recovery decisions are Admin-only, tenant-bound and omit paths, reasons and operator identity', async () => {
  let reads = 0;
  let pageQuery: Record<string, unknown> | undefined;
  const createdAt = new Date('2026-09-29T10:00:00.000Z');
  const delegate = {
    findFirst: async (args: { where: { id: string; organisationId: string } }) =>
      args.where.id === 'recovery-1' && args.where.organisationId === 'org-1'
        ? { id: 'recovery-1', createdAt } : null,
    findMany: async (args: Record<string, unknown>) => { reads++; pageQuery = args; return []; },
  };
  const memberApp = await appFor('MEMBER', { documentStorageDeletionRecovery: delegate });
  try {
    const denied = await memberApp.inject({ method: 'GET', url: '/governance-audit/deletion-recoveries',
      headers: { authorization: token('MEMBER') } });
    assert.equal(denied.statusCode, 403);
    assert.equal(reads, 0);
  } finally { await memberApp.close(); }

  const adminApp = await appFor('ADMIN', { documentStorageDeletionRecovery: delegate });
  try {
    const response = await adminApp.inject({ method: 'GET',
      url: '/governance-audit/deletion-recoveries?before=recovery-1',
      headers: { authorization: token('ADMIN') } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(pageQuery?.where, { organisationId: 'org-1', OR: [
      { createdAt: { lt: createdAt } }, { createdAt, id: { lt: 'recovery-1' } },
    ] });
    assert.deepEqual(pageQuery?.select, {
      id: true, deletionId: true, actorType: true, actorUserId: true,
      disposition: true, previousAttempts: true, previousTerminalReason: true,
      createdAt: true,
    });
    const foreign = await adminApp.inject({ method: 'GET',
      url: '/governance-audit/deletion-recoveries?before=foreign',
      headers: { authorization: token('ADMIN') } });
    assert.equal(foreign.statusCode, 404);
    assert.equal(reads, 1);
  } finally { await adminApp.close(); }
});

test('storage attempt outcomes are Admin-only and expose metadata without provider errors or paths', async () => {
  let reads = 0;
  let pageQuery: Record<string, unknown> | undefined;
  const delegate = {
    findMany: async (args: Record<string, unknown>) => { reads++; pageQuery = args; return []; },
  };
  const memberApp = await appFor('MEMBER', { documentStorageDeletionAttempt: delegate });
  try {
    const denied = await memberApp.inject({ method: 'GET', url: '/governance-audit/deletion-attempts',
      headers: { authorization: token('MEMBER') } });
    assert.equal(denied.statusCode, 403);
    assert.equal(reads, 0);
  } finally { await memberApp.close(); }

  const adminApp = await appFor('ADMIN', { documentStorageDeletionAttempt: delegate });
  try {
    const response = await adminApp.inject({ method: 'GET', url: '/governance-audit/deletion-attempts',
      headers: { authorization: token('ADMIN') } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(pageQuery?.where, { organisationId: 'org-1' });
    assert.deepEqual(pageQuery?.select, {
      id: true, deletionId: true, provider: true, attemptNumber: true,
      outcome: true, terminalReason: true, activeObjectAbsentAt: true, occurredAt: true,
    });
  } finally { await adminApp.close(); }
});

test('Vault download preparation archive is Admin-only and returns metadata without a storage path', async () => {
  let pageQuery: Record<string, unknown> | undefined;
  let reads = 0;
  const delegate = {
    findMany: async (args: Record<string, unknown>) => { reads++; pageQuery = args; return []; },
  };
  const memberApp = await appFor('MEMBER', { documentDownloadPreparationAudit: delegate });
  try {
    const denied = await memberApp.inject({ method: 'GET', url: '/governance-audit/document-downloads',
      headers: { authorization: token('MEMBER') } });
    assert.equal(denied.statusCode, 403);
    assert.equal(reads, 0);
  } finally { await memberApp.close(); }

  const adminApp = await appFor('ADMIN', { documentDownloadPreparationAudit: delegate });
  try {
    const response = await adminApp.inject({ method: 'GET', url: '/governance-audit/document-downloads',
      headers: { authorization: token('ADMIN') } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(pageQuery?.where, { organisationId: 'org-1' });
    assert.deepEqual(pageQuery?.select, {
      id: true, documentId: true, actorUserId: true, visibility: true, occurredAt: true,
    });
  } finally { await adminApp.close(); }
});

test('control verification archive uses the database sequence for paging', async () => {
  let pageQuery: Record<string, unknown> | undefined;
  const app = await appFor('ADMIN', {
    riskControlVerification: {
      findFirst: async () => ({ id: 'verification-7', sequence: 7 }),
      findMany: async (args: Record<string, unknown>) => { pageQuery = args; return []; },
    },
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/governance-audit/controls?before=verification-7',
      headers: { authorization: token('ADMIN') } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(pageQuery?.where, { organisationId: 'org-1', sequence: { lt: 7 } });
    assert.deepEqual(pageQuery?.orderBy, [{ sequence: 'desc' }]);
  } finally { await app.close(); }
});

test('Confluence governance feed is Admin-only, filtered, paged and omits private security context', async () => {
  const occurredAt = new Date('2026-09-29T10:00:00.000Z');
  const events = Array.from({ length: 52 }, (_, index) => ({
    id: `integration-${String(52 - index).padStart(3, '0')}`,
    type: 'INTEGRATION_CONNECTED', actorKind: 'USER', actorUserId: 'u1', occurredAt,
    actorLabel: 'Private person', subjectLabel: 'Private site', reason: 'Private reason',
    context: { siteUrl: 'https://private.example' },
  }));
  let reads = 0;
  const allowedTypes = [
    'INTEGRATION_CONNECTED', 'INTEGRATION_SITE_SELECTED', 'INTEGRATION_DISCONNECTED',
    'INTEGRATION_PUBLISH_TARGET_CHANGED', 'INTEGRATION_ENVIRONMENT_DECLARED',
    'INTEGRATION_REAUTHORISATION_REQUIRED',
    'DOCUMENT_PUBLICATION_DEAD_LETTERED', 'CONFLUENCE_ERASURE_REQUESTED',
  ];
  const delegate = {
    findFirst: async (args: { where: { id: string; organisationId: string; type: { in: string[] } } }) => {
      reads++;
      assert.equal(args.where.organisationId, 'org-1');
      assert.deepEqual(args.where.type.in, allowedTypes);
      return events.find((event) => event.id === args.where.id) ?? null;
    },
    findMany: async (args: { where: { organisationId: string; type: { in: string[] }; OR?: unknown }; select: Record<string, boolean>; take: number }) => {
      reads++;
      assert.equal(args.where.organisationId, 'org-1');
      assert.deepEqual(args.where.type.in, allowedTypes);
      assert.deepEqual(args.select, { id: true, type: true, actorKind: true, actorUserId: true, occurredAt: true });
      assert.equal(args.take, 51);
      const candidates = args.where.OR ? events.filter((event) => event.id < 'integration-003') : events;
      return candidates.slice(0, args.take).map(({ id, type, actorKind, actorUserId, occurredAt }) =>
        ({ id, type, actorKind, actorUserId, occurredAt }));
    },
  };
  const member = await appFor('MEMBER', { securityAuditEvent: delegate });
  try {
    const denied = await member.inject({ method: 'GET', url: '/governance-audit/integrations',
      headers: { authorization: token('MEMBER') } });
    assert.equal(denied.statusCode, 403);
    assert.equal(reads, 0);
  } finally { await member.close(); }

  const admin = await appFor('ADMIN', { securityAuditEvent: delegate });
  try {
    const first = await admin.inject({ method: 'GET', url: '/governance-audit/integrations',
      headers: { authorization: token('ADMIN') } });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().data.length, 50);
    assert.equal(first.json().nextCursor, 'integration-003');
    assert.doesNotMatch(first.body, /Private person|Private site|Private reason|siteUrl/);
    const second = await admin.inject({ method: 'GET',
      url: '/governance-audit/integrations?before=integration-003',
      headers: { authorization: token('ADMIN') } });
    assert.equal(second.statusCode, 200, second.body);
    assert.deepEqual(second.json().data.map((row: { id: string }) => row.id), ['integration-002', 'integration-001']);
    assert.equal(second.json().nextCursor, null);
    const unrelated = await admin.inject({ method: 'GET',
      url: '/governance-audit/integrations?before=security-event-1',
      headers: { authorization: token('ADMIN') } });
    assert.equal(unrelated.statusCode, 404);
  } finally { await admin.close(); }
});

test('every advertised archive feed has a tenant-scoped source', async () => {
  const mapping = {
    organisation: 'organisationChangeAudit', deadlines: 'deadlineChangeAudit',
    'minute-book': 'minuteBookChangeAudit', 'document-controls': 'documentControlAudit',
    'document-visibility': 'documentVisibilityAudit', 'document-downloads': 'documentDownloadPreparationAudit', risks: 'riskChangeAudit',
    registers: 'governanceRegisterChangeAudit', controls: 'riskControlVerification',
    compliance: 'complianceAuditEvent', reports: 'complianceReportPreparationAudit',
    deletions: 'documentStorageDeletion',
    'deletion-attempts': 'documentStorageDeletionAttempt',
    'deletion-recoveries': 'documentStorageDeletionRecovery',
    'data-requests': 'dataLifecycleReviewEvent', 'data-request-targets': 'dataLifecycleTargetEvent',
    'data-request-responses': 'dataLifecycleResponseEvent',
    'action-approvals': 'authActionApprovalAudit',
    integrations: 'securityAuditEvent',
  } as const;
  const calls: string[] = [];
  const delegates = Object.fromEntries(Object.entries(mapping).map(([feed, model]) => [model, {
    findMany: async (args: { where: { organisationId: string }; select?: Record<string, boolean> }) => {
      assert.equal(args.where.organisationId, 'org-1');
      assert.equal(args.select?.id, true, `${feed} must use an explicit response projection`);
      calls.push(feed);
      return [];
    },
  }]));
  const app = await appFor('ADMIN', delegates);
  try {
    for (const feed of Object.keys(mapping)) {
      const response = await app.inject({ method: 'GET', url: `/governance-audit/${feed}`,
        headers: { authorization: token('ADMIN') } });
      assert.equal(response.statusCode, 200, feed);
      assert.deepEqual(response.json(), { data: [], nextCursor: null });
    }
    assert.deepEqual(calls, Object.keys(mapping));
  } finally { await app.close(); }
});

test('complaint resolution overview keeps controlled case details out of the audit feed', async () => {
  const app = await appFor('ADMIN', { complaintResolutionEvidence: { findMany: async (args: Record<string, unknown>) => {
    assert.deepEqual(args.where, { organisationId: 'org-1' });
    const select = args.select as Record<string, boolean>;
    assert.equal(select.evidenceRef, undefined);
    assert.equal(select.reason, undefined);
    assert.equal(select.resolvedAt, undefined);
    assert.equal(select.complaintId, true);
    assert.equal(select.recordRevision, true);
    assert.equal(select.state, true);
    return [{ id: 'resolution-1', complaintId: 'complaint-1', revision: 2, recordRevision: 4,
      state: 'WITHDRAWN', occurredAt: new Date('2026-01-03') }];
  } } });
  try {
    const response = await app.inject({ method: 'GET', url: '/governance-audit/complaint-resolution',
      headers: { authorization: token('ADMIN') } });
    assert.equal(response.statusCode, 200);
    assert.doesNotMatch(response.body, /evidenceRef|reason|resolvedAt/);
    assert.match(response.body, /WITHDRAWN/);
  } finally { await app.close(); }
});

test('complaint hold audit exposes transitions without case evidence or reasons', async () => {
  const app = await appFor('ADMIN', { complaintHoldEvent: { findMany: async (args: any) => {
    assert.deepEqual(args.where, { organisationId: 'org-1' });
    assert.equal(args.select.reason, undefined);
    assert.equal(args.select.evidenceRef, undefined);
    assert.equal(args.select.held, true);
    assert.equal(args.select.actorUserId, true);
    return [{ id: 'hold-1', complaintId: 'complaint-1', revision: 1, recordRevision: 2,
      actorUserId: 'u1', held: true, occurredAt: new Date('2026-01-03') }];
  } } });
  try {
    const response = await app.inject({ method: 'GET', url: '/governance-audit/complaint-holds',
      headers: { authorization: token('ADMIN') } });
    assert.equal(response.statusCode, 200);
    assert.doesNotMatch(response.body, /evidenceRef|reason/);
    assert.equal(response.json().data[0].held, true);
  } finally { await app.close(); }
});
