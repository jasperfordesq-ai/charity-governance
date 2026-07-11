import assert from 'node:assert/strict';
import test from 'node:test';

process.env.JWT_SECRET ??= 'document-storage-recovery-route-test-secret';

const [
  { default: Fastify },
  { default: multipart },
  { documentRoutes },
  { signAccessToken },
] = await Promise.all([
  import('fastify'),
  import('@fastify/multipart'),
  import('../routes/documents/index.js'),
  import('../utils/jwt.js'),
]);

type Role = 'OWNER' | 'ADMIN' | 'MEMBER';

const DEAD_LETTER = {
  id: 'deletion-1',
  organisationId: 'org-1',
  storagePath: 'org-1/private-policy.pdf',
  state: 'DEAD_LETTER',
  attempts: 5,
  lastError: 'name=StorageApiError status=503 message=temporarily unavailable',
  lastAttemptAt: new Date('2026-07-11T11:00:00.000Z'),
  nextAttemptAt: null,
  claimedAt: null,
  deadLetteredAt: new Date('2026-07-11T11:00:00.000Z'),
  terminalReason: 'MAX_ATTEMPTS_EXHAUSTED',
  alertClaimToken: null,
  alertClaimedAt: null,
  alertedAt: new Date('2026-07-11T11:05:00.000Z'),
  processedAt: null,
  createdAt: new Date('2026-07-11T09:00:00.000Z'),
};

function recoveryQuery(row: typeof DEAD_LETTER | null = DEAD_LETTER) {
  return async (strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    if (sql.includes('FROM "Organisation"')) return [{ id: 'org-1' }];
    if (sql.includes('AS "liveDocument"')) return [{ liveDocument: false, otherDeletion: false }];
    return row ? [row] : [];
  };
}

function authorization(role: Role): string {
  return `Bearer ${signAccessToken({
    userId: 'user-1',
    organisationId: 'org-1',
    role,
    sessionId: 'session-1',
  })}`;
}

async function buildApp(role: Role, overrides: Record<string, unknown> = {}) {
  const app = Fastify({ logger: false });
  const prisma = {
    authSession: { findFirst: async () => ({ id: 'session-1' }) },
    user: {
      findUnique: async () => ({
        id: 'user-1',
        organisationId: 'org-1',
        role,
        emailVerified: true,
      }),
    },
    subscription: {
      findUnique: async () => ({
        status: 'ACTIVE',
        trialEndsAt: null,
        currentPeriodEnd: new Date('2027-01-01T00:00:00.000Z'),
        plan: 'COMPLETE',
      }),
    },
    document: { aggregate: async () => ({ _sum: { fileSize: 0 } }) },
    ...overrides,
  };
  if (!('$transaction' in prisma)) {
    Object.assign(prisma, {
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
    });
  }
  if (!('$queryRaw' in prisma)) {
    Object.assign(prisma, {
      $queryRaw: recoveryQuery(),
    });
  }
  app.decorate('prisma', prisma as never);
  await app.register(multipart);
  await app.register(documentRoutes);
  return app;
}

test('admin dead-letter listing is tenant-scoped and never exposes storage paths', async () => {
  let query: unknown;
  const app = await buildApp('ADMIN', {
    documentStorageDeletion: {
      findMany: async (args: unknown) => {
        query = args;
        return [DEAD_LETTER];
      },
    },
  });
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/storage-deletions/dead-letter?limit=25',
      headers: { authorization: authorization('ADMIN') },
    });
    assert.equal(response.statusCode, 200);
    assert.match(JSON.stringify(query), /"organisationId":"org-1"/);
    assert.match(JSON.stringify(query), /"state":"DEAD_LETTER"/);
    assert.equal(response.body.includes('private-policy.pdf'), false);
    assert.equal(response.json().data[0].id, 'deletion-1');
    assert.equal(response.json().data[0].attempts, 5);
  } finally {
    await app.close();
  }
});

test('members cannot list or requeue document storage dead letters', async () => {
  let touched = false;
  const app = await buildApp('MEMBER', {
    documentStorageDeletion: {
      findMany: async () => { touched = true; return []; },
      findFirst: async () => { touched = true; return DEAD_LETTER; },
    },
  });
  try {
    const list = await app.inject({
      method: 'GET',
      url: '/storage-deletions/dead-letter',
      headers: { authorization: authorization('MEMBER') },
    });
    const requeue = await app.inject({
      method: 'POST',
      url: '/storage-deletions/deletion-1/requeue',
      headers: { authorization: authorization('MEMBER') },
      payload: {
        reason: 'Provider access was repaired by operations.',
        confirmation: 'REQUEUE DOCUMENT STORAGE DELETION',
        disposition: 'REQUEUE_UNCHANGED',
      },
    });
    assert.equal(list.statusCode, 403);
    assert.equal(requeue.statusCode, 403);
    assert.equal(touched, false);
  } finally {
    await app.close();
  }
});

test('cross-tenant recovery returns the same not-found response without mutation', async () => {
  let updateCalled = false;
  let auditCalled = false;
  let lockValues: unknown[] = [];
  const app = await buildApp('OWNER', {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join('?').includes('FROM "Organisation"')) return [{ id: 'org-1' }];
      lockValues = values;
      return [];
    },
    documentStorageDeletion: {
      updateMany: async () => { updateCalled = true; return { count: 1 }; },
    },
    documentStorageDeletionRecovery: {
      create: async () => { auditCalled = true; return { id: 'recovery-1' }; },
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/storage-deletions/foreign-deletion/requeue',
      headers: { authorization: authorization('OWNER') },
      payload: {
        reason: 'Provider access was repaired by operations.',
        confirmation: 'REQUEUE DOCUMENT STORAGE DELETION',
        disposition: 'REQUEUE_UNCHANGED',
      },
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, 'STORAGE_DELETION_NOT_FOUND');
    assert.deepEqual(lockValues.slice(0, 2), ['foreign-deletion', 'org-1']);
    assert.equal(updateCalled, false);
    assert.equal(auditCalled, false);
  } finally {
    await app.close();
  }
});

test('tenant recovery fails closed after its organisation has been deleted', async () => {
  let deletionLockAttempted = false;
  let auditCalled = false;
  const app = await buildApp('OWNER', {
    $queryRaw: async (strings: TemplateStringsArray) => {
      if (strings.join('?').includes('FROM "Organisation"')) return [];
      deletionLockAttempted = true;
      return [DEAD_LETTER];
    },
    documentStorageDeletionRecovery: {
      create: async () => { auditCalled = true; return { id: 'recovery-1' }; },
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/storage-deletions/deletion-1/requeue',
      headers: { authorization: authorization('OWNER') },
      payload: {
        reason: 'Provider access was repaired by operations.',
        confirmation: 'REQUEUE DOCUMENT STORAGE DELETION',
        disposition: 'REQUEUE_UNCHANGED',
      },
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, 'STORAGE_DELETION_NOT_FOUND');
    assert.equal(deletionLockAttempted, false);
    assert.equal(auditCalled, false);
  } finally {
    await app.close();
  }
});

test('owner recovery writes immutable actor evidence then requeues without deleting storage inline', async () => {
  const events: string[] = [];
  let audit: unknown;
  let update: unknown;
  const app = await buildApp('OWNER', {
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      events.push(sql.includes('FROM "Organisation"') ? 'organisation-lock' : 'deletion-lock');
      assert.match(sql, /FOR UPDATE/u);
      return sql.includes('FROM "Organisation"') ? [{ id: 'org-1' }] : [DEAD_LETTER];
    },
    documentStorageDeletion: {
      updateMany: async (args: unknown) => {
        events.push('update');
        update = args;
        return { count: 1 };
      },
    },
    documentStorageDeletionRecovery: {
      create: async (args: unknown) => {
        events.push('audit');
        audit = args;
        return { id: 'recovery-1' };
      },
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/storage-deletions/deletion-1/requeue',
      headers: { authorization: authorization('OWNER') },
      payload: {
        reason: '  Provider access repaired.\r\nApproved for one safe retry.  ',
        confirmation: 'REQUEUE DOCUMENT STORAGE DELETION',
        disposition: 'REQUEUE_UNCHANGED',
      },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(events, ['organisation-lock', 'deletion-lock', 'audit', 'update']);
    assert.match(JSON.stringify(audit), /"actorUserId":"user-1"/);
    assert.match(JSON.stringify(audit), /"actorType":"TENANT_USER"/);
    assert.match(JSON.stringify(audit), /"disposition":"REQUEUE_UNCHANGED"/);
    assert.equal(
      (audit as { data: { reason: string } }).data.reason,
      'Provider access repaired.\nApproved for one safe retry.',
    );
    assert.match(JSON.stringify(update), /"organisationId":"org-1"/);
    assert.match(JSON.stringify(update), /"state":"PENDING"/);
    assert.match(JSON.stringify(update), /"attempts":0/);
    assert.equal(response.json().id, 'deletion-1');
    assert.equal(response.json().status, 'PENDING');
    assert.equal(response.json().disposition, 'REQUEUE_UNCHANGED');
    assert.equal('storagePath' in response.json(), false);
  } finally {
    await app.close();
  }
});

test('a permanently rejected path cannot be requeued unchanged', async () => {
  let auditCalled = false;
  const permanent = {
    ...DEAD_LETTER,
    attempts: 1,
    terminalReason: 'PERMANENT_STORAGE_PATH_REJECTED',
  };
  const app = await buildApp('OWNER', {
    $queryRaw: recoveryQuery(permanent),
    documentStorageDeletion: { updateMany: async () => ({ count: 1 }) },
    documentStorageDeletionRecovery: {
      create: async () => {
        auditCalled = true;
        return { id: 'recovery-1' };
      },
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/storage-deletions/deletion-1/requeue',
      headers: { authorization: authorization('OWNER') },
      payload: {
        reason: 'The path requires an explicit safe disposition.',
        confirmation: 'REQUEUE DOCUMENT STORAGE DELETION',
        disposition: 'REQUEUE_UNCHANGED',
      },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'PERMANENT_STORAGE_PATH_REQUIRES_DISPOSITION');
    assert.equal(auditCalled, false);
  } finally {
    await app.close();
  }
});

test('tenant HTTP recovery cannot choose a corrected object key', async () => {
  let audit: { data?: Record<string, unknown> } | undefined;
  let update: { data?: Record<string, unknown> } | undefined;
  const permanent = {
    ...DEAD_LETTER,
    attempts: 1,
    terminalReason: 'PERMANENT_STORAGE_PATH_REJECTED',
  };
  const app = await buildApp('ADMIN', {
    $queryRaw: async () => [permanent],
    documentStorageDeletion: {
      updateMany: async (args: { data?: Record<string, unknown> }) => {
        update = args;
        return { count: 1 };
      },
    },
    documentStorageDeletionRecovery: {
      create: async (args: { data?: Record<string, unknown> }) => {
        audit = args;
        return { id: 'recovery-corrected' };
      },
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/storage-deletions/deletion-1/requeue',
      headers: { authorization: authorization('ADMIN') },
      payload: {
        reason: 'The tenant-scoped object path was corrected after investigation.',
        confirmation: 'REQUEUE DOCUMENT STORAGE DELETION',
        disposition: 'REQUEUE_CORRECTED_PATH',
        correctedStoragePath: 'org-1/recovered-policy.pdf',
      },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'VALIDATION_ERROR');
    assert.equal(response.body.includes('private-policy.pdf'), false);
    assert.equal(response.body.includes('recovered-policy.pdf'), false);
    assert.equal(audit, undefined);
    assert.equal(update, undefined);
  } finally {
    await app.close();
  }
});

test('tenant HTTP recovery cannot claim externally remediated completion', async () => {
  let audit: { data?: Record<string, unknown> } | undefined;
  let update: { data?: Record<string, unknown> } | undefined;
  const app = await buildApp('OWNER', {
    $queryRaw: async () => [DEAD_LETTER],
    documentStorageDeletion: {
      updateMany: async (args: { data?: Record<string, unknown> }) => {
        update = args;
        return { count: 1 };
      },
    },
    documentStorageDeletionRecovery: {
      create: async (args: { data?: Record<string, unknown> }) => {
        audit = args;
        return { id: 'recovery-external' };
      },
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/storage-deletions/deletion-1/requeue',
      headers: { authorization: authorization('OWNER') },
      payload: {
        reason: 'Operations independently removed the object and retained provider evidence.',
        confirmation: 'REQUEUE DOCUMENT STORAGE DELETION',
        disposition: 'COMPLETE_EXTERNALLY_REMEDIATED',
      },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'VALIDATION_ERROR');
    assert.equal(audit, undefined);
    assert.equal(update, undefined);
  } finally {
    await app.close();
  }
});

test('tenant recovery remains unavailable without active subscription entitlement', async () => {
  let touched = false;
  const app = await buildApp('OWNER', {
    subscription: {
      findUnique: async () => ({ status: 'CANCELLED', trialEndsAt: null, currentPeriodEnd: null, plan: 'COMPLETE' }),
    },
    $queryRaw: async () => {
      touched = true;
      return [DEAD_LETTER];
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/storage-deletions/deletion-1/requeue',
      headers: { authorization: authorization('OWNER') },
      payload: {
        reason: 'Provider access was repaired by operations.',
        confirmation: 'REQUEUE DOCUMENT STORAGE DELETION',
        disposition: 'REQUEUE_UNCHANGED',
      },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, 'SUBSCRIPTION_INACTIVE');
    assert.equal(touched, false);
  } finally {
    await app.close();
  }
});

test('operator recovery requires an exact confirmation and substantive safe reason', async () => {
  let touched = false;
  const app = await buildApp('ADMIN', {
    documentStorageDeletion: { findFirst: async () => { touched = true; return DEAD_LETTER; } },
  });
  try {
    for (const payload of [
      { reason: 'too short', confirmation: 'REQUEUE DOCUMENT STORAGE DELETION', disposition: 'REQUEUE_UNCHANGED' },
      { reason: 'Provider access was repaired by operations.', confirmation: 'requeue', disposition: 'REQUEUE_UNCHANGED' },
      { reason: `Safe reason ${String.fromCharCode(0)} invalid`, confirmation: 'REQUEUE DOCUMENT STORAGE DELETION', disposition: 'REQUEUE_UNCHANGED' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/storage-deletions/deletion-1/requeue',
        headers: { authorization: authorization('ADMIN') },
        payload,
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().code, 'VALIDATION_ERROR');
    }
    assert.equal(touched, false);
  } finally {
    await app.close();
  }
});
