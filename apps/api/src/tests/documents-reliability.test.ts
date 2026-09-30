import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

// Set every env var the imported modules read at import/construction time, BEFORE imports.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'documents-reliability-test-secret';

const [
  { default: Fastify },
  { default: multipart },
  { documentRoutes, DOCUMENT_UPLOAD_MULTIPART_LIMITS },
  { healthRoutes },
  { StorageService },
  { AppError },
  { signAccessToken },
] = await Promise.all([
  import('fastify'),
  import('@fastify/multipart'),
  import('../routes/documents/index.js'),
  import('../routes/health/index.js'),
  import('../services/storage.service.js'),
  import('../utils/errors.js'),
  import('../utils/jwt.js'),
]);

type Role = 'OWNER' | 'ADMIN' | 'MEMBER';

type SubscriptionRow = { status: string; trialEndsAt: Date | null; plan?: string; currentPeriodEnd?: Date | null };

type PrismaMock = {
  authSession?: { findFirst: () => Promise<{ id: string } | null> };
  user?: { findUnique: () => Promise<{ id: string; organisationId: string; role: Role; emailVerified: boolean } | null>; findFirst?: (args: unknown) => Promise<unknown> };
  $queryRaw?: (...args: unknown[]) => Promise<unknown[]>;
  $transaction?: (callback: (tx: PrismaMock) => Promise<unknown>) => Promise<unknown>;
  subscription: { findUnique: () => Promise<SubscriptionRow | null> };
  document: {
    create?: (args: unknown) => Promise<unknown>;
    findFirst?: (args: unknown) => Promise<unknown>;
    findMany?: (args: unknown) => Promise<unknown[]>;
    count?: (args: unknown) => Promise<number>;
    delete?: (args: unknown) => Promise<unknown>;
    update?: (args: unknown) => Promise<unknown>;
    aggregate?: (args: unknown) => Promise<{ _sum: { fileSize: number | null } }>;
  };
  documentStorageDeletion?: {
    create?: (args: unknown) => Promise<{ id: string }>;
    update?: (args: unknown) => Promise<unknown>;
  };
  documentUploadIntent?: {
    create?: (args: unknown) => Promise<{ id: string }>;
    updateMany?: (args: unknown) => Promise<{ count: number }>;
  };
  governanceStandard?: {
    findUnique?: (args: unknown) => Promise<unknown>;
  };
  organisation?: {
    findUniqueOrThrow?: (args: unknown) => Promise<unknown>;
    findUnique?: (args: unknown) => Promise<{ documentStorageProvider: string | null; documentStorageAlphaOptIn: boolean } | null>;
  };
  documentStandardLink?: {
    create?: (args: unknown) => Promise<unknown>;
    deleteMany?: (args: unknown) => Promise<unknown>;
  };
  organisationIntegration?: {
    findUnique?: (args: unknown) => Promise<Record<string, unknown> | null>;
  };
  documentPublication?: {
    create?: (args: unknown) => Promise<{ id: string }>;
    findFirst?: (args: unknown) => Promise<unknown>;
    updateMany?: (args: unknown) => Promise<{ count: number }>;
    deleteMany?: (args: unknown) => Promise<{ count: number }>;
  };
  documentVisibilityAudit?: { findMany: (args: unknown) => Promise<unknown[]> };
  documentDownloadPreparationAudit?: { create: (args: unknown) => Promise<unknown> };
  documentControlAudit?: {
    findMany?: (args: unknown) => Promise<unknown[]>;
    create?: (args: unknown) => Promise<unknown>;
  };
};

type MultipartFile = {
  filename: string;
  mimetype: string;
  content: Buffer;
};

const baseFields = {
  name: 'Safeguarding policy',
  category: 'POLICY',
};

function tokenFor(role: Role) {
  return `Bearer ${signAccessToken({ userId: 'user-1', organisationId: 'org-1', role, sessionId: 'session-1' })}`;
}

const authHeader = tokenFor('ADMIN');

function authModels(role: Role = 'ADMIN') {
  return {
    authSession: { findFirst: async () => ({ id: 'session-1' }) },
    user: { findUnique: async () => ({ id: 'user-1', organisationId: 'org-1', role, emailVerified: true }) },
  };
}

function activeSubscription() {
  return {
    findUnique: async () => ({ status: 'ACTIVE', trialEndsAt: null, plan: 'ESSENTIALS', currentPeriodEnd: new Date(Date.now() + 1_000_000_000) }),
  };
}

async function buildDocumentsApp(prisma: PrismaMock, role: Role = 'ADMIN', limits = DOCUMENT_UPLOAD_MULTIPART_LIMITS) {
  const app = Fastify({ logger: false });
  const decoratedPrisma = { ...authModels(role), ...prisma };
  decoratedPrisma.$transaction ??= async (callback: (tx: PrismaMock) => Promise<unknown>) => callback(decoratedPrisma);
  decoratedPrisma.document.aggregate ??= async () => ({ _sum: { fileSize: 0 } });
  // The storage resolver looks up organisation preference on every storage
  // call now that documentRoutes wires it in. Default to "no preference
  // recorded", which keeps every test that does not care about per-tenant
  // storage on the deployment default — unless a test overrides it above.
  decoratedPrisma.organisation = {
    findUnique: async () => ({ documentStorageProvider: null, documentStorageAlphaOptIn: false }),
    ...decoratedPrisma.organisation,
  };
  // Confluence publication is opt-in and best-effort. Default to "no
  // integration at all", which keeps every test that does not care about
  // Confluence from ever reaching `documentPublication.create` — unless a
  // test overrides these above.
  decoratedPrisma.organisationIntegration = {
    findUnique: async () => null,
    ...decoratedPrisma.organisationIntegration,
  };
  decoratedPrisma.documentPublication = {
    create: async () => {
      throw new Error('documentPublication.create must not run without a chosen Confluence publish target');
    },
    findFirst: async () => null,
    updateMany: async () => ({ count: 0 }),
    deleteMany: async () => ({ count: 0 }),
    ...decoratedPrisma.documentPublication,
  };
  decoratedPrisma.documentControlAudit = {
    create: async () => ({ id: 'audit-1' }),
    ...decoratedPrisma.documentControlAudit,
  };
  decoratedPrisma.documentDownloadPreparationAudit ??= { create: async () => ({ id: 'download-audit-1' }) };
  decoratedPrisma.documentUploadIntent = {
    create: async () => ({ id: 'intent-upload-1' }),
    updateMany: async () => ({ count: 1 }),
    ...decoratedPrisma.documentUploadIntent,
  };
  app.decorate('prisma', decoratedPrisma as never);
  await app.register(multipart, { limits });
  await app.register(documentRoutes);
  return app;
}

function mockUpload(storagePath: string, provider: 'local' | 'supabase' = 'supabase') {
  return async (
    _organisationId: string,
    _filename: string,
    _file: Buffer,
    _mimeType: string,
    beforeWrite?: (prepared: { storagePath: string; provider: string }) => Promise<void>,
  ) => {
    await beforeWrite?.({ storagePath, provider });
    return { storagePath, provider };
  };
}

function multipartRequest(fields: Record<string, string>, file: MultipartFile) {
  const boundary = `charitypilot-test-${Date.now().toString(16)}`;
  const chunks: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
    chunks.push(Buffer.from(`${value}\r\n`));
  }

  chunks.push(Buffer.from(`--${boundary}\r\n`));
  chunks.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="${file.filename}"\r\n`));
  chunks.push(Buffer.from(`Content-Type: ${file.mimetype}\r\n\r\n`));
  chunks.push(file.content);
  chunks.push(Buffer.from('\r\n'));
  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    payload: Buffer.concat(chunks),
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
  };
}

function validPdfFile(): MultipartFile {
  return { filename: 'policy.pdf', mimetype: 'application/pdf', content: Buffer.from('%PDF-1.7\n%%EOF') };
}

function createdDocumentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    organisationId: 'org-1',
    name: 'Safeguarding policy',
    description: null,
    category: 'POLICY',
    visibility: 'RESTRICTED',
    contentAccessClass: 'UNASSESSED',
    memberReviewedSha256: null,
    lifecycleStatus: 'DRAFT',
    externalPublicationApproved: false,
    fileUrl: 'org-1/policy.pdf',
    storageProvider: 'local',
    fileSize: 14,
    mimeType: 'application/pdf',
    version: 1,
    owner: null,
    approvedDate: null,
    nextReviewDate: null,
    boardMinuteReference: null,
    uploadedById: 'user-1',
    createdAt: new Date('2026-06-08T00:00:00.000Z'),
    updatedAt: new Date('2026-06-08T00:00:00.000Z'),
    standardLinks: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

test('Member document list, detail and download exclude restricted records at the query boundary', { concurrency: false }, async () => {
  const originalDownloadFile = StorageService.prototype.downloadFile;
  let servedBytes = Buffer.from('member-visible evidence');
  let storageCalls = 0;
  let downloadProvider: string | undefined;
  StorageService.prototype.downloadFile = async (_organisationId, _storagePath, provider) => {
    storageCalls += 1;
    downloadProvider = provider;
    return servedBytes;
  };
  const documents = [
    createdDocumentRow({ id: 'restricted', name: 'Statutory register', visibility: 'RESTRICTED' }),
    createdDocumentRow({ id: 'legacy-visible', name: 'Unreviewed legacy register',
      visibility: 'MEMBER_VISIBLE', lifecycleStatus: 'UNREVIEWED' }),
    createdDocumentRow({ id: 'draft-visible', name: 'Working draft',
      visibility: 'MEMBER_VISIBLE', lifecycleStatus: 'DRAFT' }),
    createdDocumentRow({ id: 'unassessed-visible', name: 'Legacy visible but unassessed',
      visibility: 'MEMBER_VISIBLE', lifecycleStatus: 'CURRENT' }),
    createdDocumentRow({ id: 'unknown-provider-visible', name: 'Unverified custody policy',
      visibility: 'MEMBER_VISIBLE', contentAccessClass: 'MEMBER_SUITABLE', lifecycleStatus: 'CURRENT', storageProvider: null }),
    createdDocumentRow({ id: 'unhashed-visible', name: 'Old approval without byte review',
      visibility: 'MEMBER_VISIBLE', contentAccessClass: 'MEMBER_SUITABLE', lifecycleStatus: 'CURRENT' }),
    createdDocumentRow({ id: 'available', name: 'Board policy', visibility: 'MEMBER_VISIBLE',
      contentAccessClass: 'MEMBER_SUITABLE',
      memberReviewedSha256: createHash('sha256').update('member-visible evidence').digest('hex'),
      fileSize: Buffer.byteLength('member-visible evidence'),
      description: 'Private document description', owner: 'Private document owner',
      boardMinuteReference: 'PRIVATE-MINUTE-27', uploadedById: 'private-uploader-id',
      lifecycleStatus: 'SUPERSEDED', supersededByDocumentId: 'restricted' }),
  ];
  const observedWhere: unknown[] = [];
  const memberCardSelections: Array<Record<string, unknown>> = [];
  const downloadAudits: unknown[] = [];
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    row.organisationId === where.organisationId &&
    (where.id === undefined || row.id === where.id) &&
    (where.visibility === undefined || row.visibility === where.visibility) &&
    (where.contentAccessClass === undefined || row.contentAccessClass === where.contentAccessClass) &&
    (where.memberReviewedSha256 === undefined || row.memberReviewedSha256 !== null) &&
    (where.storageProvider === undefined || (where.storageProvider as { in: string[] }).in.includes(String(row.storageProvider))) &&
    (where.lifecycleStatus === undefined || !(where.lifecycleStatus as { notIn: string[] }).notIn.includes(String(row.lifecycleStatus)));
  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    documentDownloadPreparationAudit: { create: async (args: unknown) => { downloadAudits.push(args); return { id: 'download-audit-1' }; } },
    organisation: { findUniqueOrThrow: async () => ({ complexity: 'SIMPLE' }) },
    document: {
      findMany: async (args: unknown) => {
        const { where, select } = args as { where: Record<string, unknown>; select?: Record<string, unknown> };
        observedWhere.push(where);
        if (select) memberCardSelections.push(select);
        return documents.filter((row) => matches(row, where));
      },
      count: async (args: unknown) => documents.filter((row) => matches(row, (args as { where: Record<string, unknown> }).where)).length,
      findFirst: async (args: unknown) => {
        const { where, select } = args as { where: Record<string, unknown>; select?: Record<string, unknown> };
        if (select && 'standardLinks' in select) memberCardSelections.push(select);
        return documents.find((row) => matches(row, where)) ?? null;
      },
    },
  }, 'MEMBER');

  try {
    const headers = { authorization: tokenFor('MEMBER') };
    const list = await app.inject({ method: 'GET', url: '/', headers });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().total, 1);
    assert.deepEqual(list.json().data.map((row: { id: string }) => row.id), ['available']);
    assert.equal('supersededByDocumentId' in list.json().data[0], false);
    for (const field of ['description', 'owner', 'boardMinuteReference', 'uploadedById']) {
      assert.equal(list.json().data[0][field], null, `${field} must be withheld from the Member card`);
    }
    assert.deepEqual(observedWhere, [{ organisationId: 'org-1', deletedAt: null, visibility: 'MEMBER_VISIBLE', contentAccessClass: 'MEMBER_SUITABLE',
      memberReviewedSha256: { not: null }, storageProvider: { in: ['local', 'supabase'] }, lifecycleStatus: { notIn: ['UNREVIEWED', 'DRAFT'] } }]);
    assert.equal(memberCardSelections.length, 1, 'Member list must use a field selection');

    const restrictedDetail = await app.inject({ method: 'GET', url: '/restricted', headers });
    assert.equal(restrictedDetail.statusCode, 404);
    const restrictedDownload = await app.inject({ method: 'GET', url: '/restricted/download', headers });
    assert.equal(restrictedDownload.statusCode, 404);
    assert.equal(storageCalls, 0);
    assert.equal(downloadAudits.length, 0, 'a denied download must not claim preparation');

    const legacyDetail = await app.inject({ method: 'GET', url: '/legacy-visible', headers });
    assert.equal(legacyDetail.statusCode, 404);
    const legacyDownload = await app.inject({ method: 'GET', url: '/legacy-visible/download', headers });
    assert.equal(legacyDownload.statusCode, 404);
    assert.equal(storageCalls, 0);
    assert.equal(downloadAudits.length, 0);

    const unassessedDetail = await app.inject({ method: 'GET', url: '/unassessed-visible', headers });
    assert.equal(unassessedDetail.statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/unknown-provider-visible', headers })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/unknown-provider-visible/download', headers })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/unhashed-visible', headers })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/unhashed-visible/download', headers })).statusCode, 404);
    const unassessedDownload = await app.inject({ method: 'GET', url: '/unassessed-visible/download', headers });
    assert.equal(unassessedDownload.statusCode, 404);
    assert.equal(storageCalls, 0);

    const draftDetail = await app.inject({ method: 'GET', url: '/draft-visible', headers });
    assert.equal(draftDetail.statusCode, 404);
    const draftDownload = await app.inject({ method: 'GET', url: '/draft-visible/download', headers });
    assert.equal(draftDownload.statusCode, 404);
    assert.equal(storageCalls, 0);
    assert.equal(downloadAudits.length, 0);

    const visibleDetail = await app.inject({ method: 'GET', url: '/available', headers });
    assert.equal(visibleDetail.statusCode, 200);
    assert.equal(visibleDetail.json().id, 'available');
    assert.equal('supersededByDocumentId' in visibleDetail.json(), false);
    assert.equal(memberCardSelections.length, 8, 'Member list and all details must use field selections');
    for (const select of memberCardSelections) {
      for (const field of ['description', 'owner', 'boardMinuteReference', 'uploadedById', 'supersededByDocumentId', 'fileUrl']) {
        assert.equal(field in select, false, `${field} must not be selected for a Member card`);
      }
    }
    for (const field of ['description', 'owner', 'boardMinuteReference', 'uploadedById']) {
      assert.equal(visibleDetail.json()[field], null, `${field} must be withheld from Member detail`);
    }
    assert.doesNotMatch(`${list.body}${visibleDetail.body}`, /Private document description|Private document owner|PRIVATE-MINUTE-27|private-uploader-id/);
    const visibleDownload = await app.inject({ method: 'GET', url: '/available/download', headers });
    assert.equal(visibleDownload.statusCode, 200);
    assert.equal(visibleDownload.body, 'member-visible evidence');
    assert.equal(storageCalls, 1);
    assert.equal(downloadProvider, 'local', 'the authenticated proxy uses the document written provider');
    assert.deepEqual(downloadAudits, [{ data: {
      organisationId: 'org-1', documentId: 'available', actorUserId: 'user-1', visibility: 'MEMBER_VISIBLE',
    } }]);
    servedBytes = Buffer.alloc(servedBytes.length, 0x78);
    const changedBytes = await app.inject({ method: 'GET', url: '/available/download', headers });
    assert.equal(changedBytes.statusCode, 404, 'same-path, same-size replacement bytes must be withheld');
    assert.equal(downloadAudits.length, 1, 'a byte mismatch must not record a prepared download');
  } finally {
    StorageService.prototype.downloadFile = originalDownloadFile;
    await app.close();
  }
});

test('Admin document detail retains governance metadata withheld from the Member card', async () => {
  const row = createdDocumentRow({
    visibility: 'MEMBER_VISIBLE', description: 'Reviewed description',
    owner: 'Governance owner', boardMinuteReference: 'BM-2026-09', uploadedById: 'admin-1',
  });
  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    organisation: { findUniqueOrThrow: async () => ({ complexity: 'SIMPLE' }) },
    document: { findFirst: async () => row },
  }, 'ADMIN');
  try {
    const response = await app.inject({ method: 'GET', url: '/doc-1', headers: { authorization: tokenFor('ADMIN') } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().description, 'Reviewed description');
    assert.equal(response.json().owner, 'Governance owner');
    assert.equal(response.json().boardMinuteReference, 'BM-2026-09');
    assert.equal(response.json().uploadedById, 'admin-1');
  } finally {
    await app.close();
  }
});

test('Members cannot read the document control audit, while Admin reads only the organisation scope', async () => {
  const scopes: unknown[] = [];
  const prisma = {
    subscription: activeSubscription(),
    document: {},
    documentVisibilityAudit: { findMany: async (args: unknown) => {
      scopes.push((args as { where: unknown }).where);
      return [{ id: 'visibility-1', documentId: 'doc-1', actorUserId: 'admin-1', previous: 'RESTRICTED', next: 'MEMBER_VISIBLE', reason: 'Reviewed access for members.', occurredAt: new Date('2026-09-28T12:00:00.000Z') }];
    } },
    documentControlAudit: { findMany: async (args: unknown) => {
      scopes.push((args as { where: unknown }).where);
      return [{ id: 'control-1', documentId: 'doc-1', actorUserId: 'admin-1', kind: 'LIFECYCLE', previous: 'DRAFT', next: 'CURRENT', reason: 'Approved for current use.', occurredAt: new Date('2026-09-28T13:00:00.000Z') }];
    } },
  };
  const member = await buildDocumentsApp(prisma, 'MEMBER');
  const admin = await buildDocumentsApp(prisma, 'ADMIN');
  try {
    const denied = await member.inject({ method: 'GET', url: '/control-audit', headers: { authorization: tokenFor('MEMBER') } });
    assert.equal(denied.statusCode, 403);
    assert.equal(scopes.length, 0);
    const allowed = await admin.inject({ method: 'GET', url: '/control-audit', headers: { authorization: tokenFor('ADMIN') } });
    assert.equal(allowed.statusCode, 200);
    assert.deepEqual(allowed.json().data.map((event: { kind: string }) => event.kind), ['LIFECYCLE', 'VISIBILITY']);
    assert.equal(allowed.json().nextCursor, null);
    assert.deepEqual(scopes, [{ organisationId: 'org-1' }, { organisationId: 'org-1' }]);
  } finally {
    await member.close();
    await admin.close();
  }
});

test('detailed document control history pages across both audit tables without losing tied events', async () => {
  const occurredAt = new Date('2026-09-29T12:00:00.000Z');
  const makeRows = (source: 'control' | 'visibility') => Array.from({ length: 101 }, (_, index) => ({
    id: `${source}-${String(index + 1).padStart(3, '0')}`,
    organisationId: 'org-1', documentId: 'doc-1', actorUserId: 'admin-1',
    kind: 'METADATA', previous: 'old', next: 'new', reason: 'Reviewed change', occurredAt,
  }));
  const controls = makeRows('control');
  const visibility = makeRows('visibility');
  controls.push({ ...controls[0]!, id: 'control-foreign', organisationId: 'org-2' });
  const calls: Array<{ source: string; args: unknown }> = [];
  const delegate = (source: 'control' | 'visibility', rows: typeof controls) => ({
    findFirst: async (input: unknown) => {
      const args = input as { where: { organisationId: string; id: string } };
      return rows.find((row) => row.organisationId === args.where.organisationId
        && row.id === args.where.id) ?? null;
    },
    findMany: async (input: unknown) => {
      calls.push({ source, args: input });
      const args = input as { where: { organisationId: string; OR?: Array<{ occurredAt: Date | { lt: Date };
        id?: { lt: string } }> }; take: number };
      return rows.filter((row) => row.organisationId === args.where.organisationId
        && (!args.where.OR || args.where.OR.some((condition) => {
          if (typeof condition.occurredAt === 'object' && 'lt' in condition.occurredAt) {
            return row.occurredAt < condition.occurredAt.lt;
          }
          return row.occurredAt.getTime() === condition.occurredAt.getTime()
            && (!condition.id || row.id < condition.id.lt);
        })))
        .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || b.id.localeCompare(a.id))
        .slice(0, args.take);
    },
  });
  const app = await buildDocumentsApp({ subscription: activeSubscription(), document: {},
    documentControlAudit: delegate('control', controls),
    documentVisibilityAudit: delegate('visibility', visibility),
  }, 'ADMIN');
  try {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
      const response: Awaited<ReturnType<typeof app.inject>> = await app.inject({ method: 'GET',
        url: `/control-audit${cursor ? `?before=${cursor}` : ''}`,
        headers: { authorization: tokenFor('ADMIN') } });
      assert.equal(response.statusCode, 200, response.body);
      seen.push(...response.json().data.map((row: { id: string; source: string }) => `${row.source}:${row.id}`));
      cursor = response.json().nextCursor;
      if (pageIndex < 4) assert.ok(cursor);
      else assert.equal(cursor, null);
    }
    assert.equal(seen.length, 202);
    assert.equal(new Set(seen).size, 202);
    assert.deepEqual(seen.slice(0, 2), ['control:control-101', 'control:control-100']);
    assert.deepEqual(seen.slice(100, 103), ['control:control-001',
      'visibility:visibility-101', 'visibility:visibility-100']);
    assert.equal(seen.at(-1), 'visibility:visibility-001');
    assert.equal(calls.length, 10);
    assert.ok(calls.every(({ args }) => (args as { where: { organisationId: string } }).where.organisationId === 'org-1'));

    const foreign = await app.inject({ method: 'GET', url: '/control-audit?before=control:control-foreign',
      headers: { authorization: tokenFor('ADMIN') } });
    assert.equal(foreign.statusCode, 404);
    const invalid = await app.inject({ method: 'GET', url: '/control-audit?before=control%3Abad%40id',
      headers: { authorization: tokenFor('ADMIN') } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(calls.length, 10);
  } finally { await app.close(); }
});

test('Member download withholds bytes when visibility changes during storage I/O', { concurrency: false }, async () => {
  const originalDownloadFile = StorageService.prototype.downloadFile;
  let visibility: 'RESTRICTED' | 'MEMBER_VISIBLE' = 'MEMBER_VISIBLE';
  StorageService.prototype.downloadFile = async () => {
    visibility = 'RESTRICTED';
    return Buffer.from('must not escape');
  };
  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: {
      findFirst: async (args: unknown) => {
        const where = (args as { where: { visibility?: string } }).where;
        return !where.visibility || where.visibility === visibility
          ? createdDocumentRow({ visibility, contentAccessClass: 'MEMBER_SUITABLE' })
          : null;
      },
    },
  }, 'MEMBER');
  try {
    const response = await app.inject({ method: 'GET', url: '/doc-1/download', headers: { authorization: tokenFor('MEMBER') } });
    assert.equal(response.statusCode, 404);
    assert.equal(response.body.includes('must not escape'), false);
  } finally {
    StorageService.prototype.downloadFile = originalDownloadFile;
    await app.close();
  }
});

test('Member download withholds bytes when content assessment is withdrawn during storage I/O', { concurrency: false }, async () => {
  const originalDownloadFile = StorageService.prototype.downloadFile;
  let contentAccessClass: 'MEMBER_SUITABLE' | 'RESTRICTED_SENSITIVE' = 'MEMBER_SUITABLE';
  let auditWrites = 0;
  let storageCalls = 0;
  StorageService.prototype.downloadFile = async () => {
    storageCalls += 1;
    contentAccessClass = 'RESTRICTED_SENSITIVE';
    return Buffer.from('withdrawn content must not escape');
  };
  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: { findFirst: async (args: unknown) => {
      const where = (args as { where: { contentAccessClass?: string } }).where;
      return where.contentAccessClass && where.contentAccessClass !== contentAccessClass ? null
        : createdDocumentRow({ visibility: 'MEMBER_VISIBLE', contentAccessClass, lifecycleStatus: 'CURRENT' });
    } },
    documentDownloadPreparationAudit: { create: async () => { auditWrites += 1; return { id: 'download-audit-1' }; } },
  }, 'MEMBER');
  try {
    const response = await app.inject({ method: 'GET', url: '/doc-1/download',
      headers: { authorization: tokenFor('MEMBER') } });
    assert.equal(storageCalls, 1);
    assert.equal(response.statusCode, 404);
    assert.equal(response.body.includes('withdrawn content must not escape'), false);
    assert.equal(auditWrites, 0);
  } finally {
    StorageService.prototype.downloadFile = originalDownloadFile;
    await app.close();
  }
});

test('download withholds bytes when the recorded storage source changes during I/O', { concurrency: false }, async () => {
  const originalDownloadFile = StorageService.prototype.downloadFile;
  let storagePath = 'org-1/policy.pdf';
  let storageProvider: 'local' | 'supabase' | null = 'local';
  let auditWrites = 0;
  let change: 'path' | 'provider' = 'path';
  StorageService.prototype.downloadFile = async () => {
    if (change === 'path') storagePath = 'org-1/replacement.pdf';
    else storageProvider = 'supabase';
    return Buffer.from('stale storage bytes must stay withheld');
  };
  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: { findFirst: async () => createdDocumentRow({ fileUrl: storagePath, storageProvider }) },
    documentDownloadPreparationAudit: { create: async () => { auditWrites += 1; return { id: 'download-audit-1' }; } },
  });
  try {
    for (change of ['path', 'provider'] as const) {
      storagePath = 'org-1/policy.pdf';
      // The provider case models a legacy unverified row being pinned to its
      // verified store while an earlier preference-based read is in flight.
      storageProvider = change === 'provider' ? null : 'local';
      const response = await app.inject({ method: 'GET', url: '/doc-1/download', headers: { authorization: authHeader } });
      assert.equal(response.statusCode, 409, change);
      assert.equal(response.json().code, 'DOCUMENT_DOWNLOAD_SOURCE_CHANGED');
      assert.equal(response.body.includes('stale storage bytes must stay withheld'), false);
    }
    assert.equal(auditWrites, 0);
  } finally {
    StorageService.prototype.downloadFile = originalDownloadFile;
    await app.close();
  }
});

for (const withdrawnStatus of ['UNREVIEWED', 'DRAFT'] as const) {
test(`Member download withholds bytes when a legacy-visible file becomes ${withdrawnStatus} during storage I/O`, { concurrency: false }, async () => {
  const originalDownloadFile = StorageService.prototype.downloadFile;
  let lifecycleStatus: 'CURRENT' | 'UNREVIEWED' | 'DRAFT' = 'CURRENT';
  let auditWrites = 0;
  StorageService.prototype.downloadFile = async () => {
    lifecycleStatus = withdrawnStatus;
    return Buffer.from('withdrawn bytes must stay withheld');
  };
  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: { findFirst: async (args: unknown) => {
      const where = (args as { where: { lifecycleStatus?: { notIn: string[] } } }).where;
      return where.lifecycleStatus?.notIn.includes(lifecycleStatus)
        ? null
        : createdDocumentRow({ visibility: 'MEMBER_VISIBLE', contentAccessClass: 'MEMBER_SUITABLE', lifecycleStatus });
    } },
    documentDownloadPreparationAudit: { create: async () => { auditWrites++; return { id: 'download-audit-1' }; } },
  }, 'MEMBER');
  try {
    const response = await app.inject({ method: 'GET', url: '/doc-1/download',
      headers: { authorization: tokenFor('MEMBER') } });
    assert.equal(response.statusCode, 404);
    assert.equal(response.body.includes('withdrawn bytes must stay withheld'), false);
    assert.equal(auditWrites, 0);
  } finally {
    StorageService.prototype.downloadFile = originalDownloadFile;
    await app.close();
  }
});
}

test('Admin download withholds bytes and writes no audit when the draft is removed during storage I/O', { concurrency: false }, async () => {
  const originalDownloadFile = StorageService.prototype.downloadFile;
  let present = true;
  let auditWrites = 0;
  StorageService.prototype.downloadFile = async () => {
    present = false;
    return Buffer.from('removed draft bytes must stay withheld');
  };
  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: { findFirst: async () => present ? createdDocumentRow({ lifecycleStatus: 'DRAFT' }) : null },
    documentDownloadPreparationAudit: { create: async () => { auditWrites++; return { id: 'download-audit-1' }; } },
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/doc-1/download',
      headers: { authorization: authHeader } });
    assert.equal(response.statusCode, 404);
    assert.equal(response.body.includes('removed draft bytes must stay withheld'), false);
    assert.equal(auditWrites, 0);
  } finally {
    StorageService.prototype.downloadFile = originalDownloadFile;
    await app.close();
  }
});

test('Admin demotion plus visibility restriction during storage I/O withholds the file', { concurrency: false }, async () => {
  const originalDownloadFile = StorageService.prototype.downloadFile;
  let currentRole: Role = 'ADMIN';
  let currentVisibility: 'MEMBER_VISIBLE' | 'RESTRICTED' = 'MEMBER_VISIBLE';
  let auditWrites = 0;
  StorageService.prototype.downloadFile = async () => {
    currentRole = 'MEMBER';
    currentVisibility = 'RESTRICTED';
    return Buffer.from('restricted bytes must stay withheld');
  };
  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    user: { findUnique: async () => ({ id: 'user-1', organisationId: 'org-1', role: currentRole, emailVerified: true }) },
    authSession: { findFirst: async (args?: unknown) => {
      const required = (args as { where?: { user?: { is?: { role?: { in?: Role[] } } } } })?.where?.user?.is?.role?.in;
      return required && !required.includes(currentRole) ? null : { id: 'session-1' };
    } },
    document: { findFirst: async () => createdDocumentRow({ visibility: currentVisibility }) },
    documentDownloadPreparationAudit: { create: async () => { auditWrites++; return { id: 'download-audit-1' }; } },
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/doc-1/download',
      headers: { authorization: authHeader } });
    assert.equal(response.statusCode, 401);
    assert.equal(response.body.includes('restricted bytes must stay withheld'), false);
    assert.equal(auditWrites, 0);
  } finally {
    StorageService.prototype.downloadFile = originalDownloadFile;
    await app.close();
  }
});

test('GET /:id returns 404 for a document belonging to another organisation', async () => {
  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: {
      // org-scoped where {id, organisationId} excludes the foreign row
      findFirst: async () => null,
    },
    organisation: {
      findUniqueOrThrow: async () => ({ complexity: 'SIMPLE' }),
    },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/foreign-doc',
      headers: { authorization: authHeader },
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, 'DOCUMENT_NOT_FOUND');
  } finally {
    await app.close();
  }
});

test('GET /:id/download returns 404 and never reads storage for a foreign-org document', { concurrency: false }, async () => {
  const originalDownloadFile = StorageService.prototype.downloadFile;
  let storageCalled = false;
  StorageService.prototype.downloadFile = async () => {
    storageCalled = true;
    return Buffer.from('foreign');
  };

  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: {
      findFirst: async () => null,
    },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/foreign-doc/download',
      headers: { authorization: authHeader },
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, 'DOCUMENT_NOT_FOUND');
    assert.equal(storageCalled, false);
  } finally {
    StorageService.prototype.downloadFile = originalDownloadFile;
    await app.close();
  }
});

test('GET /:id/download streams private bytes without returning a reusable storage URL', { concurrency: false }, async () => {
  const originalDownloadFile = StorageService.prototype.downloadFile;
  StorageService.prototype.downloadFile = async () => Buffer.from('%PDF-1.7\nprivate evidence');
  const audits: unknown[] = [];
  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    documentDownloadPreparationAudit: { create: async (args: unknown) => { audits.push(args); return { id: 'download-audit-1' }; } },
    document: {
      findFirst: async () => createdDocumentRow({
        fileUrl: 'org-1/private-policy.pdf',
        mimeType: 'application/pdf',
        name: 'Private policy',
        fileSize: Buffer.byteLength('%PDF-1.7\nprivate evidence'),
      }),
    },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/doc-1/download',
      headers: { authorization: authHeader },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'application/pdf');
    assert.equal(response.headers['cache-control'], 'private, no-store, max-age=0');
    assert.match(response.headers['content-disposition'] ?? '', /attachment; filename="Private policy\.pdf"/);
    assert.equal(response.body, '%PDF-1.7\nprivate evidence');
    assert.equal(response.body.includes('signedUrl'), false);
    assert.deepEqual((audits[0] as { data: Record<string, unknown> }).data, {
      organisationId: 'org-1', documentId: 'doc-1', actorUserId: 'user-1', visibility: 'RESTRICTED',
      reviewSha256: createHash('sha256').update('%PDF-1.7\nprivate evidence').digest('hex'),
      documentUpdatedAt: new Date('2026-06-08T00:00:00.000Z'),
    });
  } finally {
    StorageService.prototype.downloadFile = originalDownloadFile;
    await app.close();
  }
});

test('closed-scope connector cannot read or download raw document bytes', { concurrency: false }, async () => {
  const originalDownloadFile = StorageService.prototype.downloadFile;
  let storageReads = 0;
  let documentReads = 0;
  StorageService.prototype.downloadFile = async () => { storageReads += 1; return Buffer.from('private'); };
  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    authSession: { findFirst: async () => ({
      id: 'session-1', clientKind: 'MCP_CONNECTOR', accessLevel: 'ADMIN', dataScope: 'WITHHELD',
    }) },
    document: { findFirst: async () => { documentReads += 1; return null; } },
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/doc-1/download',
      headers: { authorization: authHeader } });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, 'PERSONAL_DATA_SCOPE_REQUIRED');
    assert.equal(documentReads, 0);
    assert.equal(storageReads, 0);
  } finally { StorageService.prototype.downloadFile = originalDownloadFile; await app.close(); }
});

test('read-only connector cannot download a document through the API', { concurrency: false }, async () => {
  let documentReads = 0;
  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    authSession: { findFirst: async () => ({
      id: 'session-1', clientKind: 'MCP_CONNECTOR', accessLevel: 'READ', dataScope: 'FULL',
    }) },
    document: { findFirst: async () => { documentReads += 1; return null; } },
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/doc-1/download',
      headers: { authorization: authHeader } });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, 'SESSION_LEVEL_TOO_LOW');
    assert.equal(documentReads, 0);
  } finally { await app.close(); }
});

test('connector download withholds bytes if personal-data scope closes during storage I/O', { concurrency: false }, async () => {
  const originalDownloadFile = StorageService.prototype.downloadFile;
  StorageService.prototype.downloadFile = async () => Buffer.from('must not escape');
  let sessionReads = 0;
  let finalWhere: unknown;
  let auditWrites = 0;
  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    authSession: { findFirst: async (args?: { where: unknown }) => {
      sessionReads += 1;
      if (sessionReads === 2) { finalWhere = args?.where; return null; }
      return { id: 'session-1', clientKind: 'MCP_CONNECTOR', accessLevel: 'ADMIN', dataScope: 'FULL' };
    } },
    document: { findFirst: async () => createdDocumentRow({
      id: 'doc-1', fileUrl: 'org-1/private-policy.pdf', mimeType: 'application/pdf',
      name: 'Private policy', visibility: 'RESTRICTED', fileSize: Buffer.byteLength('must not escape'),
    }) },
    documentDownloadPreparationAudit: { create: async () => { auditWrites += 1; return {}; } },
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/doc-1/download',
      headers: { authorization: authHeader } });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().code, 'UNAUTHORIZED');
    assert.equal(sessionReads, 2);
    assert.equal((finalWhere as { dataScope?: string }).dataScope, 'FULL');
    assert.equal(auditWrites, 0);
    assert.doesNotMatch(response.body, /must not escape/);
  } finally { StorageService.prototype.downloadFile = originalDownloadFile; await app.close(); }
});

test('download preparation audit failure withholds the document bytes', { concurrency: false }, async () => {
  const originalDownloadFile = StorageService.prototype.downloadFile;
  StorageService.prototype.downloadFile = async () => Buffer.from('private bytes must stay withheld');
  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: { findFirst: async () => createdDocumentRow({
      fileUrl: 'org-1/private-policy.pdf', mimeType: 'application/pdf', name: 'Private policy', visibility: 'RESTRICTED',
      fileSize: Buffer.byteLength('private bytes must stay withheld'),
    }) },
    documentDownloadPreparationAudit: { create: async () => { throw new Error('audit storage unavailable'); } },
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/doc-1/download',
      headers: { authorization: authHeader } });
    assert.equal(response.statusCode, 500);
    assert.equal(response.body.includes('private bytes must stay withheld'), false);
  } finally {
    StorageService.prototype.downloadFile = originalDownloadFile;
    await app.close();
  }
});

test('a session revoked during storage I/O receives no document bytes', { concurrency: false }, async () => {
  const originalDownloadFile = StorageService.prototype.downloadFile;
  StorageService.prototype.downloadFile = async () => Buffer.from('must not escape');
  let sessionRead = 0;
  const app = await buildDocumentsApp({
    authSession: {
      findFirst: async () => {
        sessionRead += 1;
        return sessionRead === 1 ? { id: 'session-1' } : null;
      },
    },
    subscription: activeSubscription(),
    document: {
      findFirst: async () => createdDocumentRow({
        fileUrl: 'org-1/private-policy.pdf',
        mimeType: 'application/pdf',
        name: 'Private policy',
        fileSize: Buffer.byteLength('must not escape'),
      }),
    },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/doc-1/download',
      headers: { authorization: authHeader },
    });

    assert.equal(response.statusCode, 401);
    assert.equal(response.json().code, 'UNAUTHORIZED');
    assert.equal(response.body.includes('must not escape'), false);
    assert.equal(sessionRead, 2);
  } finally {
    StorageService.prototype.downloadFile = originalDownloadFile;
    await app.close();
  }
});

test('readLocalFile rejects storage paths outside the organisation prefix before reading', { concurrency: false }, async () => {
  const originalDriver = process.env.DOCUMENT_STORAGE_DRIVER;
  process.env.DOCUMENT_STORAGE_DRIVER = 'local';

  async function assertForbidden(action: () => Promise<unknown>) {
    await assert.rejects(action, (err) => {
      assert.equal(err instanceof AppError, true);
      const appError = err as InstanceType<typeof AppError>;
      assert.equal(appError.statusCode, 403);
      assert.equal(appError.code, 'STORAGE_PATH_FORBIDDEN');
      return true;
    });
  }

  try {
    const service = new StorageService();
    await assertForbidden(() => service.readLocalFile('org-a', 'org-b/policy.pdf'));
    await assertForbidden(() => service.readLocalFile('org-a', '../org-a/policy.pdf'));
    await assertForbidden(() => service.readLocalFile('org-a', 'org-a'));
  } finally {
    if (originalDriver === undefined) {
      delete process.env.DOCUMENT_STORAGE_DRIVER;
    } else {
      process.env.DOCUMENT_STORAGE_DRIVER = originalDriver;
    }
  }
});

test('POST /:id/standards rejects linking when the document belongs to another organisation', async () => {
  let linkCreated = false;
  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: {
      findFirst: async () => null,
    },
    governanceStandard: {
      findUnique: async () => ({ id: 's1', isCore: true }),
    },
    organisation: {
      findUniqueOrThrow: async () => ({ complexity: 'COMPLEX' }),
    },
    documentStandardLink: {
      create: async () => {
        linkCreated = true;
        return { documentId: 'foreign-doc', standardId: 's1' };
      },
    },
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/foreign-doc/standards',
      headers: { authorization: authHeader },
      payload: { standardId: 's1' },
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, 'DOCUMENT_NOT_FOUND');
    assert.equal(linkCreated, false);
  } finally {
    await app.close();
  }
});

test('DELETE /:id/standards/:standardId rejects unlinking when the document belongs to another organisation', async () => {
  let deleteCalled = false;
  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: {
      findFirst: async () => null,
    },
    documentStandardLink: {
      deleteMany: async () => {
        deleteCalled = true;
        return { count: 1 };
      },
    },
  });

  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/foreign-doc/standards/s1',
      headers: { authorization: authHeader },
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, 'DOCUMENT_NOT_FOUND');
    assert.equal(deleteCalled, false);
  } finally {
    await app.close();
  }
});

test('DELETE /:id rejects and performs no side effects for a document belonging to another organisation', { concurrency: false }, async () => {
  const originalDeleteFile = StorageService.prototype.deleteFile;
  let storageCalled = false;
  StorageService.prototype.deleteFile = async () => {
    storageCalled = true;
    return new Date();
  };

  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    user: { ...authModels().user, findFirst: async () => ({ id: 'user-1' }) },
    $queryRaw: async (...args) => {
      const query = (args[0] as TemplateStringsArray).join('');
      if (query.includes('FROM "Organisation"')) {
        assert.deepEqual(args.slice(1), ['org-1']);
      } else {
        assert.match(query, /FROM "Document"/);
        assert.deepEqual(args.slice(1), ['foreign-doc', 'org-1']);
      }
      return [];
    },
    document: {
      findFirst: async (args) => {
        assert.deepEqual(args, { where: { id: 'foreign-doc', organisationId: 'org-1', deletedAt: null } });
        return null;
      },
      update: async () => { throw new Error('foreign-org document must not enter recoverable state'); },
      delete: async () => {
        throw new Error('document.delete must not be called for a foreign-org document');
      },
    },
    documentStorageDeletion: {
      create: async () => {
        throw new Error('documentStorageDeletion.create must not be called for a foreign-org document');
      },
    },
  });

  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/foreign-doc',
      headers: { authorization: authHeader },
      payload: { reason: 'The draft was uploaded in error and is no longer required.',
        expectedUpdatedAt: '2026-09-30T00:00:00.000Z', policyId: 'policy-1', evidenceRef: 'TEST-REMOVAL-1' },
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, 'DOCUMENT_NOT_FOUND');
    assert.equal(storageCalled, false);
  } finally {
    StorageService.prototype.deleteFile = originalDeleteFile;
    await app.close();
  }
});

test('document upload stores the object under the caller\'s organisation prefix', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  let capturedOrganisationId: string | null = null;
  StorageService.prototype.uploadFile = async (organisationId: string, _file, _filename, _mimeType, beforeWrite) => {
    capturedOrganisationId = organisationId;
    await beforeWrite?.({ storagePath: `${organisationId}/policy.pdf`, provider: 'supabase' });
    return { storagePath: `${organisationId}/policy.pdf`, provider: 'supabase' };
  };

  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: {
      create: async () => createdDocumentRow(),
    },
  });

  try {
    const request = multipartRequest(baseFields, validPdfFile());
    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { ...request.headers, authorization: authHeader },
      payload: request.payload,
    });

    assert.equal(response.statusCode, 201);
    // The storage prefix is derived from request.user.organisationId, never from client input.
    assert.equal(capturedOrganisationId, 'org-1');
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Task 7: enqueueing a Confluence publication on upload — gated on Task 3's
// `confluencePublishTargetForOrganisation`, and never allowed to fail the
// upload itself.
// ---------------------------------------------------------------------------

function connectedIntegrationRow(overrides: Record<string, unknown> = {}) {
  return {
    status: 'CONNECTED',
    config: { siteId: 'site-abc' },
    publishSpaceId: 'space-1',
    publishSpaceKey: 'SPACE1',
    publishSpaceName: 'Governance',
    publishSpaceSiteId: 'site-abc',
    ...overrides,
  };
}

async function uploadOnce(app: Awaited<ReturnType<typeof buildDocumentsApp>>) {
  const request = multipartRequest(baseFields, validPdfFile());
  return app.inject({
    method: 'POST',
    url: '/',
    headers: { ...request.headers, authorization: authHeader },
    payload: request.payload,
  });
}

test('a new draft does not enqueue Confluence publication even when a destination is selected', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  StorageService.prototype.uploadFile = mockUpload('org-1/policy.pdf');

  const created: unknown[] = [];
  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: { create: async () => createdDocumentRow() },
    organisationIntegration: { findUnique: async () => connectedIntegrationRow() },
    documentPublication: {
      create: async (args: unknown) => {
        created.push(args);
        return { id: 'publication-1' };
      },
    },
  });

  try {
    const response = await uploadOnce(app);

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().data.lifecycleStatus, 'DRAFT');
    assert.equal(response.json().data.externalPublicationApproved, false);
    assert.deepEqual(created, []);
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    await app.close();
  }
});

test('an organisation with no Confluence integration enqueues no publication on upload', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  StorageService.prototype.uploadFile = mockUpload('org-1/policy.pdf');

  let createCalled = false;
  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: { create: async () => createdDocumentRow() },
    organisationIntegration: { findUnique: async () => null },
    documentPublication: {
      create: async () => {
        createCalled = true;
        return { id: 'publication-1' };
      },
    },
  });

  try {
    const response = await uploadOnce(app);

    assert.equal(response.statusCode, 201);
    assert.equal(createCalled, false);
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    await app.close();
  }
});

test('a DISCONNECTED Confluence integration enqueues no publication on upload', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  StorageService.prototype.uploadFile = mockUpload('org-1/policy.pdf');

  let createCalled = false;
  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: { create: async () => createdDocumentRow() },
    organisationIntegration: {
      findUnique: async () => connectedIntegrationRow({ status: 'DISCONNECTED' }),
    },
    documentPublication: {
      create: async () => {
        createCalled = true;
        return { id: 'publication-1' };
      },
    },
  });

  try {
    const response = await uploadOnce(app);

    assert.equal(response.statusCode, 201);
    assert.equal(createCalled, false);
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// AuthZ boundary (requireAdmin)
// ---------------------------------------------------------------------------

test('a MEMBER cannot upload a document (requireAdmin)', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  let uploadCalled = false;
  StorageService.prototype.uploadFile = async () => {
    uploadCalled = true;
    return { storagePath: 'org-1/policy.pdf' };
  };

  let createCalled = false;
  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: {
      create: async () => {
        createCalled = true;
        return { id: 'doc-1' };
      },
    },
  }, 'MEMBER');

  try {
    const request = multipartRequest(baseFields, validPdfFile());
    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { ...request.headers, authorization: tokenFor('MEMBER') },
      payload: request.payload,
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, 'FORBIDDEN');
    assert.equal(uploadCalled, false);
    assert.equal(createCalled, false);
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    await app.close();
  }
});

test('a MEMBER cannot delete a document (requireAdmin)', { concurrency: false }, async () => {
  const originalDeleteFile = StorageService.prototype.deleteFile;
  let storageCalled = false;
  StorageService.prototype.deleteFile = async () => {
    storageCalled = true;
    return new Date();
  };

  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: {
      findFirst: async () => {
        throw new Error('service.remove must not run for a MEMBER');
      },
      delete: async () => {
        throw new Error('document.delete must not run for a MEMBER');
      },
    },
  }, 'MEMBER');

  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/doc-1',
      headers: { authorization: tokenFor('MEMBER') },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, 'FORBIDDEN');
    assert.equal(storageCalled, false);
  } finally {
    StorageService.prototype.deleteFile = originalDeleteFile;
    await app.close();
  }
});

test('a MEMBER cannot link or unlink a document to a governance standard (requireAdmin)', async () => {
  let linkCreated = false;
  let unlinkCalled = false;
  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: {
      findFirst: async () => {
        throw new Error('document lookup must not run for a MEMBER');
      },
    },
    documentStandardLink: {
      create: async () => {
        linkCreated = true;
        return {};
      },
      deleteMany: async () => {
        unlinkCalled = true;
        return { count: 0 };
      },
    },
  }, 'MEMBER');

  try {
    const linkResponse = await app.inject({
      method: 'POST',
      url: '/doc-1/standards',
      headers: { authorization: tokenFor('MEMBER') },
      payload: { standardId: 's1' },
    });
    assert.equal(linkResponse.statusCode, 403);
    assert.equal(linkResponse.json().code, 'FORBIDDEN');

    const unlinkResponse = await app.inject({
      method: 'DELETE',
      url: '/doc-1/standards/s1',
      headers: { authorization: tokenFor('MEMBER') },
    });
    assert.equal(unlinkResponse.statusCode, 403);
    assert.equal(unlinkResponse.json().code, 'FORBIDDEN');

    assert.equal(linkCreated, false);
    assert.equal(unlinkCalled, false);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Plan gating (subscriptionGuard / quota)
// ---------------------------------------------------------------------------

test('document upload is blocked when the organisation has no subscription record', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  let uploadCalled = false;
  StorageService.prototype.uploadFile = async () => {
    uploadCalled = true;
    return { storagePath: 'org-1/policy.pdf' };
  };

  let createCalled = false;
  const app = await buildDocumentsApp({
    subscription: { findUnique: async () => null },
    document: {
      create: async () => {
        createCalled = true;
        return { id: 'doc-1' };
      },
    },
  });

  try {
    const request = multipartRequest(baseFields, validPdfFile());
    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { ...request.headers, authorization: authHeader },
      payload: request.payload,
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, 'NO_SUBSCRIPTION');
    assert.equal(uploadCalled, false);
    assert.equal(createCalled, false);
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    await app.close();
  }
});

test('documents endpoints are blocked when the subscription trial has expired', async () => {
  const app = await buildDocumentsApp({
    subscription: {
      findUnique: async () => ({ status: 'TRIALING', trialEndsAt: new Date(Date.now() - 60_000), plan: 'ESSENTIALS', currentPeriodEnd: null }),
    },
    document: {
      findFirst: async () => {
        throw new Error('document query must not run once the trial has expired');
      },
    },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/',
      headers: { authorization: authHeader },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, 'TRIAL_EXPIRED');
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test('document upload rejects malformed metadata with VALIDATION_ERROR before storage', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  let uploadCalled = false;
  StorageService.prototype.uploadFile = async () => {
    uploadCalled = true;
    return { storagePath: 'org-1/policy.pdf' };
  };

  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: {
      create: async () => ({ id: 'doc-1' }),
    },
  });

  try {
    // Violates exactly the category enum rule; name is present, everything else valid.
    const request = multipartRequest({ name: 'Safeguarding policy', category: 'NOT_A_CATEGORY' }, validPdfFile());
    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { ...request.headers, authorization: authHeader },
      payload: request.payload,
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'VALIDATION_ERROR');
    assert.equal(Array.isArray(response.json().details), true);
    assert.equal(uploadCalled, false);
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    await app.close();
  }
});

test('POST /:id/standards rejects a missing standardId with VALIDATION_ERROR', async () => {
  let linkCreated = false;
  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: {
      findFirst: async () => ({ id: 'doc-1', organisationId: 'org-1' }),
    },
    documentStandardLink: {
      create: async () => {
        linkCreated = true;
        return {};
      },
    },
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/doc-1/standards',
      headers: { authorization: authHeader },
      payload: { standardId: '' },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'VALIDATION_ERROR');
    assert.equal(linkCreated, false);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Graceful degradation
// ---------------------------------------------------------------------------

test('GET /:id/download returns 503 STORAGE_NOT_CONFIGURED when Supabase is unconfigured', { concurrency: false }, async () => {
  const originalDriver = process.env.DOCUMENT_STORAGE_DRIVER;
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.DOCUMENT_STORAGE_DRIVER;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: {
      findFirst: async () => ({ fileUrl: 'org-1/policy.pdf' }),
    },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/doc-1/download',
      headers: { authorization: authHeader },
    });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, 'STORAGE_NOT_CONFIGURED');
  } finally {
    if (originalDriver === undefined) delete process.env.DOCUMENT_STORAGE_DRIVER;
    else process.env.DOCUMENT_STORAGE_DRIVER = originalDriver;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Observability (readiness)
// ---------------------------------------------------------------------------

test('readiness reports not_ready when the document storage bucket is unreachable', { concurrency: false }, async () => {
  const originalReadinessKey = process.env.READINESS_API_KEY;
  const originalIsConfigured = StorageService.prototype.isConfigured;
  const originalVerifyBucket = StorageService.prototype.verifyBucket;

  process.env.READINESS_API_KEY = 'readiness-test-secret';
  StorageService.prototype.isConfigured = function isConfigured() {
    return true;
  };
  StorageService.prototype.verifyBucket = async function verifyBucket() {
    return false;
  };

  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    $queryRaw: async () => [{ result: 1 }],
    $transaction: async () => ({ id: 1 }),
  } as never);
  await app.register(healthRoutes, { prefix: '/api/v1/health' });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health/readiness',
      headers: { 'x-charitypilot-readiness-key': 'readiness-test-secret' },
    });

    assert.equal(response.statusCode, 503);
    const body = response.json();
    assert.equal(body.status, 'not_ready');
    assert.equal(body.checks.storageBucketReachable, false);
  } finally {
    StorageService.prototype.isConfigured = originalIsConfigured;
    StorageService.prototype.verifyBucket = originalVerifyBucket;
    if (originalReadinessKey === undefined) delete process.env.READINESS_API_KEY;
    else process.env.READINESS_API_KEY = originalReadinessKey;
    await app.close();
  }
});
