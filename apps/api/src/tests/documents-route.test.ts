import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'documents-route-test-secret';
const deletionPayload = { reason: 'The draft was uploaded in error and is no longer required.' };

const [
  { default: Fastify },
  { default: multipart },
  { documentRoutes, DOCUMENT_UPLOAD_MULTIPART_LIMITS },
  { StorageService },
  { AppError },
  { signAccessToken },
] =
  await Promise.all([
    import('fastify'),
    import('@fastify/multipart'),
    import('../routes/documents/index.js'),
    import('../services/storage.service.js'),
    import('../utils/errors.js'),
    import('../utils/jwt.js'),
  ]);

type PrismaMock = {
  authSession?: { findFirst: () => Promise<{ id: string } | null> };
  user?: { findUnique: () => Promise<{ id: string; organisationId: string; role: 'ADMIN' | 'MEMBER'; emailVerified: boolean } | null> };
  $transaction?: (callback: (tx: PrismaMock) => Promise<unknown>) => Promise<unknown>;
  $queryRaw?: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;
  subscription: { findUnique: () => Promise<{ status: string; trialEndsAt: Date | null; plan?: string }> };
  document: {
    create?: (args: unknown) => Promise<unknown>;
    findMany?: (args: unknown) => Promise<Array<Record<string, unknown>>>;
    findFirst?: (args: unknown) => Promise<unknown>;
    update?: (args: unknown) => Promise<unknown>;
    delete?: (args: unknown) => Promise<unknown>;
    aggregate?: (args: unknown) => Promise<{ _sum: { fileSize: number | null } }>;
  };
  documentStorageDeletion?: {
    create?: (args: unknown) => Promise<{ id: string }>;
    findFirst?: (args: unknown) => Promise<unknown>;
    findMany?: (args: unknown) => Promise<unknown[]>;
    updateMany?: (args: unknown) => Promise<{ count: number }>;
  };
  documentUploadIntent?: {
    create?: (args: unknown) => Promise<{ id: string }>;
    updateMany?: (args: unknown) => Promise<{ count: number }>;
  };
  documentStorageDeletionRecovery?: { create?: (args: unknown) => Promise<{ id: string }> };
  governanceStandard?: {
    findUnique?: (args: unknown) => Promise<unknown>;
  };
  organisation?: {
    findUniqueOrThrow?: (args: unknown) => Promise<unknown>;
    findUnique?: (args: unknown) => Promise<{ documentStorageProvider: string | null; documentStorageAlphaOptIn: boolean } | null>;
  };
  documentStandardLink?: {
    create?: (args: unknown) => Promise<unknown>;
  };
  organisationIntegration?: {
    findUnique?: (args: unknown) => Promise<Record<string, unknown> | null>;
  };
  documentPublication?: {
    create?: (args: unknown) => Promise<{ id: string }>;
    findFirst?: (args: unknown) => Promise<unknown>;
    findMany?: (args: unknown) => Promise<Array<Record<string, unknown>>>;
    updateMany?: (args: unknown) => Promise<{ count: number }>;
    deleteMany?: (args: unknown) => Promise<{ count: number }>;
  };
  documentVisibilityAudit?: { create: (args: unknown) => Promise<unknown> };
  documentDownloadPreparationAudit?: {
    create?: (args: unknown) => Promise<unknown>;
    findFirst?: (args: unknown) => Promise<unknown>;
  };
  documentControlAudit?: { create: (args: unknown) => Promise<unknown> };
};

type MultipartFile = {
  filename: string;
  mimetype: string;
  content: Buffer;
};

type MultipartPart =
  | { type: 'field'; name: string; value: string }
  | { type: 'file'; name?: string; file: MultipartFile };

const baseFields = {
  name: 'Safeguarding policy',
  category: 'POLICY',
};

const authHeader = `Bearer ${signAccessToken({
  userId: 'user-1',
  organisationId: 'org-1',
  role: 'ADMIN',
  sessionId: 'session-1',
})}`;

function authModels() {
  return {
    authSession: { findFirst: async () => ({ id: 'session-1' }) },
    user: { findUnique: async () => ({ id: 'user-1', organisationId: 'org-1', role: 'ADMIN' as const, emailVerified: true }) },
  };
}

function subscription() {
  return {
    findUnique: async () => ({ status: 'TRIALING', trialEndsAt: new Date(Date.now() + 60_000), plan: 'ESSENTIALS' }),
  };
}

async function buildDocumentsApp(prisma: PrismaMock, limits = DOCUMENT_UPLOAD_MULTIPART_LIMITS) {
  const app = Fastify({ logger: false });
  const decoratedPrisma = { ...authModels(), ...prisma };
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
  // Confluence publication is opt-in and best-effort; see documents-reliability.test.ts
  // for the tests that exercise it directly. Default to "no integration at
  // all" here so every test in this file that does not care about Confluence
  // never reaches `documentPublication.create`.
  decoratedPrisma.organisationIntegration = {
    findUnique: async () => null,
    ...decoratedPrisma.organisationIntegration,
  };
  decoratedPrisma.$queryRaw ??= async (_strings, organisationId) => {
    const row = await decoratedPrisma.organisationIntegration!.findUnique?.({
      where: { organisationId_provider: { organisationId, provider: 'CONFLUENCE' } },
    });
    return row ? [row] : [];
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
  decoratedPrisma.documentControlAudit ??= { create: async () => ({ id: 'audit-upload-1' }) };
  decoratedPrisma.documentDownloadPreparationAudit = {
    create: async () => ({ id: 'download-audit-1' }),
    findFirst: async () => null,
    ...decoratedPrisma.documentDownloadPreparationAudit,
  };
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

test('Vault page cursor rejects malformed and other-charity anchors before listing files', async () => {
  let anchorWhere: unknown;
  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      findFirst: async (args) => {
        anchorWhere = (args as { where: unknown }).where;
        return null;
      },
      findMany: async () => { throw new Error('The file list must not be read after a missing anchor'); },
    },
  });
  try {
    const malformed = await app.inject({ method: 'GET', url: '/?before=bad%21', headers: { authorization: authHeader } });
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.json().code, 'DOCUMENT_CURSOR_INVALID');
    const foreign = await app.inject({ method: 'GET', url: '/?before=other-charity-file', headers: { authorization: authHeader } });
    assert.equal(foreign.statusCode, 404);
    assert.equal(foreign.json().code, 'DOCUMENT_CURSOR_NOT_FOUND');
    assert.deepEqual(anchorWhere, { organisationId: 'org-1', id: 'other-charity-file' });
  } finally {
    await app.close();
  }
});

test('Member Vault cursor cannot anchor on a restricted file', async () => {
  let anchorWhere: unknown;
  const app = await buildDocumentsApp({
    subscription: subscription(),
    user: { findUnique: async () => ({ id: 'user-1', organisationId: 'org-1', role: 'MEMBER', emailVerified: true }) },
    document: {
      findFirst: async (args) => {
        anchorWhere = (args as { where: unknown }).where;
        return null;
      },
      findMany: async () => { throw new Error('A Member must not list from a restricted anchor'); },
    },
  });
  const memberAuth = `Bearer ${signAccessToken({ userId: 'user-1', organisationId: 'org-1', role: 'MEMBER', sessionId: 'session-1' })}`;
  try {
    const response = await app.inject({ method: 'GET', url: '/?before=restricted-file', headers: { authorization: memberAuth } });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, 'DOCUMENT_CURSOR_NOT_FOUND');
    assert.deepEqual(anchorWhere, {
      organisationId: 'org-1', id: 'restricted-file', visibility: 'MEMBER_VISIBLE',
      contentAccessClass: 'MEMBER_SUITABLE', memberReviewedSha256: { not: null },
      storageProvider: { in: ['local', 'supabase'] },
      lifecycleStatus: { notIn: ['UNREVIEWED', 'DRAFT'] },
    });
  } finally {
    await app.close();
  }
});

function multipartRequest(fields: Record<string, string>, file: MultipartFile) {
  return multipartRequestFromParts([
    ...Object.entries(fields).map(([name, value]) => ({ type: 'field' as const, name, value })),
    { type: 'file' as const, file },
  ]);
}

function multipartRequestFromParts(parts: MultipartPart[]) {
  const boundary = `charitypilot-test-${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];

  for (const part of parts) {
    if (part.type === 'field') {
      chunks.push(Buffer.from(`--${boundary}\r\n`));
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`));
      chunks.push(Buffer.from(`${part.value}\r\n`));
      continue;
    }

    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name ?? 'file'}"; filename="${part.file.filename}"\r\n`));
    chunks.push(Buffer.from(`Content-Type: ${part.file.mimetype}\r\n\r\n`));
    chunks.push(part.file.content);
    chunks.push(Buffer.from('\r\n'));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    payload: Buffer.concat(chunks),
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
  };
}

function publicDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    organisationId: 'org-1',
    name: 'Safeguarding policy',
    description: null,
    category: 'POLICY',
    visibility: 'RESTRICTED',
    lifecycleStatus: 'CURRENT',
    externalPublicationApproved: false,
    fileUrl: 'org-1/policy.txt',
    fileSize: 12,
    mimeType: 'text/plain',
    owner: null,
    approvedDate: null,
    nextReviewDate: null,
    boardMinuteReference: null,
    uploadedById: 'user-1',
    createdAt: new Date('2026-06-08T00:00:00.000Z'),
    updatedAt: new Date('2026-06-08T00:00:00.000Z'),
    version: 1,
    standardLinks: [],
    uploadedBy: { id: 'user-1', name: 'Admin User' },
    ...overrides,
  };
}

test('Admin mirror route links only a page on the currently connected Confluence site', async () => {
  let connectedSiteId = 'site-1';
  let connectionStatus = 'CONNECTED';
  let selectedSpaceId: string | null = 'space-1';
  const app = await buildDocumentsApp({
    subscription: subscription(), document: { findMany: async (args) => {
      assert.deepEqual((args as { where: unknown }).where,
        { organisationId: 'org-1', id: { in: ['doc-1'] } });
      return [{ id: 'doc-1', externalPublicationApproved: true,
        externalPublicationSiteId: 'site-1', externalPublicationSpaceId: 'space-1' }];
    } },
    organisationIntegration: { findUnique: async (args) => {
      assert.deepEqual(args, {
        where: { organisationId_provider: { organisationId: 'org-1', provider: 'CONFLUENCE' } },
        select: { config: true, status: true, publishSpaceId: true, publishSpaceKey: true,
          publishSpaceName: true, publishSpaceSiteId: true, publishingModel: true },
      });
      return { status: connectionStatus, config: { siteId: connectedSiteId, siteUrl: 'https://charity.atlassian.net' },
        publishSpaceId: selectedSpaceId, publishSpaceKey: 'GOV', publishSpaceName: 'Governance',
        publishSpaceSiteId: connectedSiteId, publishingModel: null };
    } },
    documentPublication: { findMany: async (args) => {
      assert.deepEqual((args as { where: unknown }).where, {
        organisationId: 'org-1', provider: 'confluence', documentId: { in: ['doc-1'] },
      });
      return [{ documentId: 'doc-1', state: 'DEAD_LETTER', cloudId: 'site-1', spaceId: 'space-1', pageId: 'page-1',
        pageTitle: 'Safeguarding policy', remoteState: null, remoteTitle: null,
        remoteVersion: null, lastReconciledAt: null, reconcileError: null }];
    } },
  });
  try {
    const read = async () => {
      const response = await app.inject({ method: 'GET', url: '/confluence-mirrors?ids=doc-1',
        headers: { authorization: authHeader } });
      assert.equal(response.statusCode, 200);
      return response.json().mirrors['doc-1'] as Record<string, unknown>;
    };
    const sameSite = await read();
    assert.equal(sameSite.pageRecorded, true);
    assert.equal(sameSite.pageSiteMatchesConnection, true);
    assert.equal(sameSite.recordedPageMatchesDestination, true);
    assert.equal(sameSite.connectionAvailable, true);
    assert.equal(sameSite.approvalDestinationCurrent, true);
    assert.deepEqual(sameSite.publishDestination, { siteId: 'site-1',
      siteUrl: 'https://charity.atlassian.net', spaceId: 'space-1', spaceKey: 'GOV', spaceName: 'Governance' });
    assert.equal(sameSite.pageUrl, 'https://charity.atlassian.net/wiki/pages/viewpage.action?pageId=page-1');
    assert.equal('pageId' in sameSite, false);

    connectedSiteId = 'site-2';
    const changedSite = await read();
    assert.equal(changedSite.pageRecorded, true);
    assert.equal(changedSite.pageSiteMatchesConnection, false);
    assert.equal(changedSite.recordedPageMatchesDestination, false);
    assert.equal(changedSite.approvalDestinationCurrent, false);
    assert.equal(changedSite.pageUrl, null);

    selectedSpaceId = null;
    const noSpace = await read();
    assert.equal(noSpace.connectionAvailable, true);
    assert.equal(noSpace.publishDestination, null);
    assert.equal(noSpace.recordedPageMatchesDestination, null);
    assert.equal(noSpace.approvalDestinationCurrent, false);

    connectionStatus = 'DISCONNECTED';
    const disconnected = await read();
    assert.equal(disconnected.pageRecorded, true);
    assert.equal(disconnected.connectionAvailable, false);
    assert.equal(disconnected.approvalDestinationCurrent, false);
    assert.equal(disconnected.publishDestination, null);
    assert.equal(disconnected.pageSiteMatchesConnection, null);
    assert.equal(disconnected.pageUrl, null);
  } finally { await app.close(); }

  const memberApp = await buildDocumentsApp({
    subscription: subscription(), document: {},
    user: { findUnique: async () => ({ id: 'user-1', organisationId: 'org-1', role: 'MEMBER', emailVerified: true }) },
    organisationIntegration: { findUnique: async () => { throw new Error('Member mirror integration read'); } },
    documentPublication: { findMany: async () => { throw new Error('Member mirror publication read'); } },
  });
  try {
    const denied = await memberApp.inject({ method: 'GET', url: '/confluence-mirrors?ids=doc-1',
      headers: { authorization: authHeader } });
    assert.equal(denied.statusCode, 403);
  } finally { await memberApp.close(); }
});

test('publication retry refuses a disconnected or different-site target before queueing', async () => {
  let connectionStatus = 'DISCONNECTED';
  let connectedSiteId = 'site-1';
  let approvedSiteId = 'site-1';
  let recordedSiteId: string | null = 'site-1';
  let recordedSpaceId = 'space-1';
  let recordedPageId: string | null = 'page-1';
  let queued = 0;
  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: { findFirst: async (args) => {
      const where = (args as { where: Record<string, unknown> }).where;
      assert.equal(where.externalPublicationSpaceId, 'space-1');
      return where.externalPublicationSiteId === approvedSiteId ? { id: 'doc-1' } : null;
    } },
    organisationIntegration: { findUnique: async (args) => {
      assert.deepEqual((args as { where: unknown }).where, {
        organisationId_provider: { organisationId: 'org-1', provider: 'CONFLUENCE' },
      });
      return { status: connectionStatus, config: { siteId: connectedSiteId },
        publishSpaceId: 'space-1', publishSpaceKey: 'GOV', publishSpaceName: 'Governance',
        publishSpaceSiteId: connectedSiteId, publishingModel: null };
    } },
    documentPublication: {
      findFirst: async (args) => {
        assert.deepEqual((args as { where: unknown }).where, {
          organisationId: 'org-1', documentId: 'doc-1', provider: 'confluence', state: 'DEAD_LETTER',
        });
        return { cloudId: recordedSiteId, spaceId: recordedSpaceId, pageId: recordedPageId };
      },
      updateMany: async () => { queued += 1; return { count: 1 }; },
    },
  });
  try {
    const retry = () => app.inject({ method: 'POST', url: '/doc-1/publication/retry',
      headers: { authorization: authHeader } });
    const disconnected = await retry();
    assert.equal(disconnected.statusCode, 409);
    assert.equal(disconnected.json().code, 'CONFLUENCE_PUBLISH_TARGET_UNAVAILABLE');
    assert.equal(queued, 0);

    connectionStatus = 'CONNECTED';
    connectedSiteId = 'site-2';
    recordedSiteId = null;
    recordedPageId = null;
    const unboundApproval = await retry();
    assert.equal(unboundApproval.statusCode, 409);
    assert.equal(unboundApproval.json().code, 'DOCUMENT_PUBLICATION_NOT_APPROVED');
    assert.equal(queued, 0);

    approvedSiteId = 'site-2';
    recordedSiteId = 'site-1';
    recordedPageId = 'page-1';
    const otherSite = await retry();
    assert.equal(otherSite.statusCode, 409);
    assert.equal(otherSite.json().code, 'DOCUMENT_PUBLICATION_SITE_CHANGED');
    assert.equal(queued, 0);

    connectedSiteId = 'site-1';
    approvedSiteId = 'site-1';
    recordedSpaceId = 'old-space';
    const oldSpace = await retry();
    assert.equal(oldSpace.statusCode, 409);
    assert.equal(oldSpace.json().code, 'DOCUMENT_PUBLICATION_SPACE_CHANGED');
    assert.equal(queued, 0);

    recordedSpaceId = 'space-1';
    const sameSite = await retry();
    assert.equal(sameSite.statusCode, 200);
    assert.equal(sameSite.json().retried, true);
    assert.equal(queued, 1);
  } finally { await app.close(); }
});

test('replacement search is Admin-only and stays within the source charity and category', async () => {
  const queries: Record<string, unknown>[] = [];
  const models = { subscription: subscription(), document: {
    findFirst: async (args: { where: Record<string, unknown> }) => {
      queries.push(args.where);
      return { category: 'POLICY' };
    },
    findMany: async (args: { where: Record<string, unknown> }) => {
      queries.push(args.where);
      return [{ id: 'doc-2', name: 'Replacement policy', updatedAt: new Date('2026-09-28T12:00:00Z') }];
    },
  } };
  const member = await buildDocumentsApp({ ...models,
    user: { findUnique: async () => ({ id: 'user-1', organisationId: 'org-1', role: 'MEMBER' as const, emailVerified: true }) },
  } as never);
  try {
    const memberAuth = `Bearer ${signAccessToken({ userId: 'user-1', organisationId: 'org-1', role: 'MEMBER', sessionId: 'session-1' })}`;
    const denied = await member.inject({ method: 'GET', url: '/replacement-candidates/doc-1', headers: { authorization: memberAuth } });
    assert.equal(denied.statusCode, 403);
    assert.equal(queries.length, 0);
  } finally { await member.close(); }
  const admin = await buildDocumentsApp(models as never);
  try {
    const response = await admin.inject({ method: 'GET', url: '/replacement-candidates/doc-1?q=policy&page=2', headers: { authorization: authHeader } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.data[0].id, 'doc-2');
    assert.deepEqual(queries[0], { id: 'doc-1', organisationId: 'org-1' });
    assert.deepEqual(queries[1], { organisationId: 'org-1', id: { not: 'doc-1' }, category: 'POLICY',
      lifecycleStatus: 'CURRENT', name: { contains: 'policy', mode: 'insensitive' } });
  } finally { await admin.close(); }
});

test('storage deletion history is tenant-scoped, metadata-only and denied to Members', async () => {
  const reads: unknown[] = [];
  const deletion = { id: 'deletion-1', provider: 'LOCAL', state: 'DONE', reason: 'Retention review',
    requestedById: 'user-1', terminalReason: null, attempts: 1, createdAt: new Date(), processedAt: new Date() };
  const admin = await buildDocumentsApp({
    subscription: subscription(), document: {},
    documentStorageDeletion: { findMany: async (args) => { reads.push(args); return [deletion]; } },
  });
  try {
    const result = await admin.inject({ method: 'GET', url: '/storage-deletions/history', headers: { authorization: authHeader } });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().data[0].id, 'deletion-1');
    assert.equal(result.json().nextCursor, null);
    assert.deepEqual(reads, [{
      where: { organisationId: 'org-1' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 51,
      select: { id: true, provider: true, state: true, reason: true, requestedById: true,
        terminalReason: true, attempts: true, createdAt: true, processedAt: true,
        activeObjectAbsentAt: true },
    }]);
    assert.equal(result.body.includes('storagePath'), false);
  } finally { await admin.close(); }

  const member = await buildDocumentsApp({
    subscription: subscription(), document: {},
    user: { findUnique: async () => ({ id: 'user-1', organisationId: 'org-1', role: 'MEMBER', emailVerified: true }) },
    documentStorageDeletion: { findMany: async () => { throw new Error('Member history read'); } },
  });
  try {
    const result = await member.inject({ method: 'GET', url: '/storage-deletions/history', headers: { authorization: authHeader } });
    assert.equal(result.statusCode, 403);
  } finally { await member.close(); }
});

test('storage deletion history pages beyond the old cap with a tenant-bound stable cursor', async () => {
  const later = new Date('2026-09-29T10:00:00.000Z');
  const earlier = new Date('2026-09-28T10:00:00.000Z');
  const rows = Array.from({ length: 202 }, (_, index) => ({
    id: `deletion-${String(index + 1).padStart(3, '0')}`,
    organisationId: 'org-1', provider: 'local', state: 'DONE',
    createdAt: index < 100 ? earlier : later,
    storagePath: 'private/source-name.txt', lastError: 'private provider error',
  }));
  rows.push({ ...rows[0]!, id: 'foreign-cursor', organisationId: 'org-2' });
  const queries: Record<string, unknown>[] = [];
  const app = await buildDocumentsApp({ subscription: subscription(), document: {},
    documentStorageDeletion: {
      findFirst: async (input: unknown) => {
        const args = input as { where: { id: string; organisationId: string } };
        const row = rows.find((item) => item.id === args.where.id
          && item.organisationId === args.where.organisationId);
        return row ? { id: row.id, createdAt: row.createdAt } : null;
      },
      findMany: async (input: unknown) => {
        const args = input as { where: { organisationId: string;
          OR?: Array<Record<string, unknown>> }; select: Record<string, boolean>; take: number };
        queries.push(args as unknown as Record<string, unknown>);
        const tie = args.where.OR?.[1] as { createdAt: Date; id: { lt: string } } | undefined;
        return rows.filter((item) => item.organisationId === args.where.organisationId
          && (!tie || item.createdAt < tie.createdAt
            || (item.createdAt.getTime() === tie.createdAt.getTime() && item.id < tie.id.lt)))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
          .slice(0, args.take)
          .map((item) => Object.fromEntries(Object.keys(args.select).map((key) => [key,
            (item as unknown as Record<string, unknown>)[key] ?? null])));
      },
    },
  });
  try {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
      const response: Awaited<ReturnType<typeof app.inject>> = await app.inject({ method: 'GET',
        url: `/storage-deletions/history${cursor ? `?before=${cursor}` : ''}`,
        headers: { authorization: authHeader } });
      assert.equal(response.statusCode, 200, response.body);
      seen.push(...response.json().data.map((item: { id: string }) => item.id));
      cursor = response.json().nextCursor;
      if (pageNumber < 4) assert.ok(cursor);
      else assert.equal(cursor, null);
    }
    assert.equal(seen.length, 202);
    assert.equal(new Set(seen).size, 202);
    assert.equal(seen.at(-1), 'deletion-001');
    assert.equal(queries.length, 5);
    for (const query of queries) {
      assert.equal((query.where as { organisationId: string }).organisationId, 'org-1');
      assert.equal((query.select as Record<string, boolean>).storagePath, undefined);
      assert.equal((query.select as Record<string, boolean>).lastError, undefined);
    }
    const foreign = await app.inject({ method: 'GET', url: '/storage-deletions/history?before=foreign-cursor',
      headers: { authorization: authHeader } });
    assert.equal(foreign.statusCode, 404);
    const invalid = await app.inject({ method: 'GET', url: '/storage-deletions/history?before=bad%40cursor',
      headers: { authorization: authHeader } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(queries.length, 5);
  } finally { await app.close(); }
});

test('document upload rejects files whose signature does not match the claimed document type', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  let uploadCalled = false;

  StorageService.prototype.uploadFile = async () => {
    uploadCalled = true;
    return { storagePath: 'org-1/policy.pdf' };
  };

  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      create: async () => ({ id: 'doc-1' }),
    },
  });

  try {
    const request = multipartRequest(baseFields, {
      filename: 'policy.pdf',
      mimetype: 'application/pdf',
      content: Buffer.from('not a pdf'),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { ...request.headers, authorization: authHeader },
      payload: request.payload,
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'INVALID_FILE_SIGNATURE');
    assert.equal(uploadCalled, false);
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    await app.close();
  }
});

test('document upload rejects macro-capable legacy Office files before storage', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  let uploadCalled = false;

  StorageService.prototype.uploadFile = async () => {
    uploadCalled = true;
    return { storagePath: 'org-1/policy.doc' };
  };

  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      create: async () => ({ id: 'doc-1' }),
    },
  });

  try {
    const request = multipartRequest(baseFields, {
      filename: 'policy.doc',
      mimetype: 'application/msword',
      content: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { ...request.headers, authorization: authHeader },
      payload: request.payload,
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'INVALID_MIME_TYPE');
    assert.equal(uploadCalled, false);
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    await app.close();
  }
});

test('document upload translates multipart file size errors to 413', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  let uploadCalled = false;

  StorageService.prototype.uploadFile = async () => {
    uploadCalled = true;
    return { storagePath: 'org-1/policy.txt' };
  };

  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      create: async () => ({ id: 'doc-1' }),
    },
  }, { ...DOCUMENT_UPLOAD_MULTIPART_LIMITS, fileSize: 8 });

  try {
    const request = multipartRequest(baseFields, {
      filename: 'policy.txt',
      mimetype: 'text/plain',
      content: Buffer.from('123456789'),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { ...request.headers, authorization: authHeader },
      payload: request.payload,
    });

    assert.equal(response.statusCode, 413);
    assert.equal(response.json().code, 'FILE_TOO_LARGE');
    assert.equal(uploadCalled, false);
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    await app.close();
  }
});

test('document upload rejects requests with too many multipart fields before storage', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  let uploadCalled = false;

  StorageService.prototype.uploadFile = async () => {
    uploadCalled = true;
    return { storagePath: 'org-1/policy.txt' };
  };

  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      create: async () => publicDocument(),
    },
  });

  try {
    const request = multipartRequest({
      ...baseFields,
      description: 'A policy for safeguarding.',
      owner: 'Board',
      approvedDate: '2026-06-08',
      nextReviewDate: '2027-06-08',
      boardMinuteReference: 'BM-2026-06',
      unexpected: 'this extra field should exceed the upload request shape',
    }, {
      filename: 'policy.txt',
      mimetype: 'text/plain',
      content: Buffer.from('plain policy text'),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { ...request.headers, authorization: authHeader },
      payload: request.payload,
    });

    assert.equal(response.statusCode, 413);
    assert.equal(response.json().code, 'MULTIPART_LIMIT_EXCEEDED');
    assert.equal(uploadCalled, false);
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    await app.close();
  }
});

test('document upload rejects requests with more than one file before storage', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  let uploadCalled = false;

  StorageService.prototype.uploadFile = async () => {
    uploadCalled = true;
    return { storagePath: 'org-1/policy.txt' };
  };

  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      create: async () => publicDocument(),
    },
  });

  try {
    const request = multipartRequestFromParts([
      ...Object.entries(baseFields).map(([name, value]) => ({ type: 'field' as const, name, value })),
      {
        type: 'file',
        file: { filename: 'policy.txt', mimetype: 'text/plain', content: Buffer.from('plain policy text') },
      },
      {
        type: 'file',
        name: 'attachment',
        file: { filename: 'extra.txt', mimetype: 'text/plain', content: Buffer.from('extra file') },
      },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { ...request.headers, authorization: authHeader },
      payload: request.payload,
    });

    assert.equal(response.statusCode, 413);
    assert.equal(response.json().code, 'MULTIPART_LIMIT_EXCEEDED');
    assert.equal(uploadCalled, false);
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    await app.close();
  }
});

test('document upload rejects oversized multipart field values before storage', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  let uploadCalled = false;

  StorageService.prototype.uploadFile = async () => {
    uploadCalled = true;
    return { storagePath: 'org-1/policy.txt' };
  };

  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      create: async () => publicDocument(),
    },
  });

  try {
    const request = multipartRequest({
      ...baseFields,
      description: 'x'.repeat(DOCUMENT_UPLOAD_MULTIPART_LIMITS.fieldSize + 1),
    }, {
      filename: 'policy.txt',
      mimetype: 'text/plain',
      content: Buffer.from('plain policy text'),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { ...request.headers, authorization: authHeader },
      payload: request.payload,
    });

    assert.equal(response.statusCode, 413);
    assert.equal(response.json().code, 'MULTIPART_LIMIT_EXCEEDED');
    assert.equal(uploadCalled, false);
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    await app.close();
  }
});

test('document upload preserves its provider-pinned reservation when database creation fails', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  const originalDelete = StorageService.prototype.deleteFile;
  const deletedPaths: Array<{ organisationId: string; storagePath: string }> = [];
  let cleanupJob: Record<string, unknown> | undefined;
  let reservation: Record<string, unknown> | undefined;

  StorageService.prototype.uploadFile = mockUpload('org-1/policy.pdf');
  StorageService.prototype.deleteFile = async (organisationId: string, storagePath: string) => {
    deletedPaths.push({ organisationId, storagePath });
    return new Date();
  };

  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      create: async () => {
        throw new Error('database unavailable');
      },
    },
    documentStorageDeletion: {
      create: async (args: unknown) => {
        cleanupJob = (args as { data: Record<string, unknown> }).data;
        return { id: 'cleanup-1' };
      },
    },
    documentUploadIntent: { create: async (args: unknown) => {
      reservation = (args as { data: Record<string, unknown> }).data;
      return { id: 'intent-upload-1' };
    } },
  });

  try {
    const request = multipartRequest(baseFields, {
      filename: 'policy.pdf',
      mimetype: 'application/pdf',
      content: Buffer.from('%PDF-1.7\n%%EOF'),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { ...request.headers, authorization: authHeader },
      payload: request.payload,
    });

    assert.equal(response.statusCode, 500);
    assert.deepEqual(deletedPaths, [], 'the failed database result could follow a committed document');
    assert.equal(reservation?.storagePath, 'org-1/policy.pdf');
    assert.equal(reservation?.provider, 'supabase');
    assert.equal(reservation?.state, 'RESERVED');
    assert.equal(cleanupJob, undefined);
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    StorageService.prototype.deleteFile = originalDelete;
    await app.close();
  }
});

test('document upload stops before bytes when its reservation cannot be saved', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  let wroteBytes = false;
  let createdDocument = false;
  StorageService.prototype.uploadFile = async (_organisationId, _filename, _buffer, _mimeType, beforeWrite) => {
    await beforeWrite?.({ storagePath: 'org-1/policy.pdf', provider: 'supabase' });
    wroteBytes = true;
    return { storagePath: 'org-1/policy.pdf', provider: 'supabase' };
  };
  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: { create: async () => { createdDocument = true; return publicDocument(); } },
    documentUploadIntent: { create: async () => { throw new Error('reservation database unavailable'); } },
  });
  try {
    const request = multipartRequest(baseFields, {
      filename: 'policy.pdf', mimetype: 'application/pdf', content: Buffer.from('%PDF-1.7\n%%EOF'),
    });
    const response = await app.inject({
      method: 'POST', url: '/', headers: { ...request.headers, authorization: authHeader }, payload: request.payload,
    });
    assert.equal(response.statusCode, 500);
    assert.equal(wroteBytes, false);
    assert.equal(createdDocument, false);
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    await app.close();
  }
});

test('document upload records actor and restricted draft state; audit failure leaves reserved cleanup', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  const originalDelete = StorageService.prototype.deleteFile;
  const audits: Record<string, unknown>[] = [];
  const deletedPaths: string[] = [];
  const queuedPaths: string[] = [];
  let createdDocument: Record<string, unknown> | undefined;
  let attachedIntent: Record<string, unknown> | undefined;
  StorageService.prototype.uploadFile = mockUpload('org-1/policy.pdf');
  StorageService.prototype.deleteFile = async (_organisationId: string, storagePath: string) => { deletedPaths.push(storagePath); return new Date(); };
  let failAudit = false;
  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: { create: async (args: unknown) => {
      createdDocument = (args as { data: Record<string, unknown> }).data;
      return publicDocument({ lifecycleStatus: 'DRAFT' });
    } },
    documentUploadIntent: { updateMany: async (args: unknown) => {
      attachedIntent = (args as { where: Record<string, unknown> }).where;
      return { count: 1 };
    } },
    documentControlAudit: { create: async (args: unknown) => {
      audits.push((args as { data: Record<string, unknown> }).data);
      if (failAudit) throw new Error('audit unavailable');
      return { id: 'upload-audit-1' };
    } },
    documentStorageDeletion: { create: async (args: unknown) => {
      queuedPaths.push((args as { data: { storagePath: string } }).data.storagePath);
      return { id: 'cleanup-1' };
    } },
  });
  try {
    const sendUpload = async () => {
      const request = multipartRequest(baseFields, {
        filename: 'policy.pdf', mimetype: 'application/pdf', content: Buffer.from('%PDF-1.7\n%%EOF'),
      });
      return app.inject({ method: 'POST', url: '/', headers: { ...request.headers, authorization: authHeader }, payload: request.payload });
    };
    assert.equal((await sendUpload()).statusCode, 201);
    assert.equal(createdDocument?.storageProvider, 'supabase');
    assert.equal(attachedIntent?.provider, 'supabase');
    assert.deepEqual(audits[0], {
      organisationId: 'org-1', documentId: 'doc-1', actorUserId: 'user-1', kind: 'UPLOAD',
      previous: 'NONE', next: 'RESTRICTED/DRAFT', reason: 'Document uploaded into restricted draft state.',
    });
    assert.deepEqual(deletedPaths, []);
    failAudit = true;
    assert.equal((await sendUpload()).statusCode, 500);
    assert.deepEqual(deletedPaths, []);
    assert.deepEqual(queuedPaths, []);
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    StorageService.prototype.deleteFile = originalDelete;
    await app.close();
  }
});

test('ordinary Vault deletion refuses a legacy document with unverified storage custody', async () => {
  let queued = false;
  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: { findFirst: async () => ({
      id: 'doc-legacy', organisationId: 'org-1', fileUrl: 'org-1/legacy.pdf',
      storageProvider: null, lifecycleStatus: 'DRAFT', deletionHold: false,
    }) },
    documentStorageDeletion: { create: async () => { queued = true; return { id: 'unused' }; } },
  });
  try {
    const response = await app.inject({ method: 'DELETE', url: '/doc-legacy', headers: { authorization: authHeader }, payload: deletionPayload });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'DOCUMENT_STORAGE_PROVIDER_UNVERIFIED');
    assert.equal(queued, false);
  } finally {
    await app.close();
  }
});

test('Admin storage review pins a unique matching object and records the actor without its path', { concurrency: false }, async () => {
  const originalInspect = StorageService.prototype.inspectActiveObject;
  const observations: string[] = [];
  let update: Record<string, unknown> | undefined;
  let audit: Record<string, unknown> | undefined;
  const updatedAt = new Date('2026-09-29T10:00:00.000Z');
  StorageService.prototype.inspectActiveObject = async (_organisationId, _path, provider) => {
    observations.push(provider);
    return provider === 'local' ? { present: true, size: 12 } : { present: false, size: null };
  };
  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      findFirst: async () => ({ id: 'doc-legacy', fileUrl: 'org-1/legacy.pdf', fileSize: 12, storageProvider: null }),
      update: async (args: unknown) => {
        update = args as Record<string, unknown>;
        return { id: 'doc-legacy', updatedAt: new Date('2026-09-29T10:01:00.000Z') };
      },
    },
    documentControlAudit: { create: async (args: unknown) => {
      audit = (args as { data: Record<string, unknown> }).data;
      return { id: 'audit-1' };
    } },
  });
  try {
    const response = await app.inject({ method: 'POST', url: '/doc-legacy/verify-storage-provider',
      headers: { authorization: authHeader }, payload: { expectedUpdatedAt: updatedAt.toISOString() } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().data.storageProviderVerified, true);
    assert.deepEqual(observations.sort(), ['local', 'supabase']);
    assert.deepEqual((update?.where as Record<string, unknown>).storageProvider, null);
    assert.equal((update?.data as Record<string, unknown>).storageProvider, 'local');
    assert.equal(audit?.kind, 'STORAGE_PROVIDER');
    assert.equal(audit?.actorUserId, 'user-1');
    assert.doesNotMatch(JSON.stringify(audit), /legacy\.pdf/);
  } finally {
    StorageService.prototype.inspectActiveObject = originalInspect;
    await app.close();
  }
});

test('storage review refuses ambiguity and failed inspection before a database write', { concurrency: false }, async () => {
  const originalInspect = StorageService.prototype.inspectActiveObject;
  let updates = 0;
  let audits = 0;
  let stale = false;
  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      findFirst: async () => ({ id: 'doc-legacy', fileUrl: 'org-1/legacy.pdf', fileSize: 12, storageProvider: null }),
      update: async () => {
        updates += 1;
        if (stale) throw Object.assign(new Error('stale record'), { code: 'P2025' });
        return { id: 'doc-legacy', updatedAt: new Date() };
      },
    },
    documentControlAudit: { create: async () => { audits += 1; return { id: 'audit-1' }; } },
  });
  const request = () => app.inject({ method: 'POST', url: '/doc-legacy/verify-storage-provider',
    headers: { authorization: authHeader }, payload: { expectedUpdatedAt: '2026-09-29T10:00:00.000Z' } });
  try {
    StorageService.prototype.inspectActiveObject = async () => ({ present: true, size: 12 });
    const ambiguous = await request();
    assert.equal(ambiguous.statusCode, 409);
    assert.equal(ambiguous.json().code, 'DOCUMENT_STORAGE_PROVIDER_AMBIGUOUS');
    StorageService.prototype.inspectActiveObject = async (_organisationId, _path, provider) => provider === 'local'
      ? { present: true, size: 11 } : { present: false, size: null };
    const wrongSize = await request();
    assert.equal(wrongSize.statusCode, 409);
    assert.equal(wrongSize.json().code, 'DOCUMENT_STORAGE_PROVIDER_AMBIGUOUS');
    StorageService.prototype.inspectActiveObject = async (_organisationId, _path, provider) => {
      if (provider === 'supabase') throw new AppError(503, 'STORAGE_CUSTODY_CHECK_UNAVAILABLE', 'Unavailable');
      return { present: true, size: 12 };
    };
    const unavailable = await request();
    assert.equal(unavailable.statusCode, 503);
    assert.equal(updates, 0);
    StorageService.prototype.inspectActiveObject = async (_organisationId, _path, provider) => provider === 'local'
      ? { present: true, size: 12 } : { present: false, size: null };
    stale = true;
    const changed = await request();
    assert.equal(changed.statusCode, 409);
    assert.equal(changed.json().code, 'DOCUMENT_UPDATE_CONFLICT');
    assert.equal(audits, 0);
  } finally {
    StorageService.prototype.inspectActiveObject = originalInspect;
    await app.close();
  }
});

test('a Member cannot inspect provider custody or pin a Vault file', { concurrency: false }, async () => {
  const originalInspect = StorageService.prototype.inspectActiveObject;
  let inspections = 0;
  StorageService.prototype.inspectActiveObject = async () => {
    inspections += 1;
    return { present: true, size: 12 };
  };
  const app = await buildDocumentsApp({
    subscription: subscription(),
    user: { findUnique: async () => ({ id: 'member-1', organisationId: 'org-1', role: 'MEMBER', emailVerified: true }) },
    document: { findFirst: async () => { throw new Error('Member must not read custody record'); } },
  });
  const memberToken = signAccessToken({ userId: 'member-1', organisationId: 'org-1', role: 'MEMBER', sessionId: 'session-1' });
  try {
    const response = await app.inject({ method: 'POST', url: '/doc-legacy/verify-storage-provider',
      headers: { authorization: `Bearer ${memberToken}` }, payload: { expectedUpdatedAt: '2026-09-29T10:00:00.000Z' } });
    assert.equal(response.statusCode, 403);
    assert.equal(inspections, 0);
  } finally {
    StorageService.prototype.inspectActiveObject = originalInspect;
    await app.close();
  }
});

test('document upload rejects files that would exceed the plan storage quota and leaves reserved cleanup', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  const originalDelete = StorageService.prototype.deleteFile;
  const deletedPaths: Array<{ organisationId: string; storagePath: string }> = [];
  let queuedPath: string | undefined;
  let createCalled = false;

  StorageService.prototype.uploadFile = mockUpload('org-1/policy.pdf');
  StorageService.prototype.deleteFile = async (organisationId: string, storagePath: string) => {
    deletedPaths.push({ organisationId, storagePath });
    return new Date();
  };

  const app = await buildDocumentsApp({
    subscription: {
      findUnique: async () => ({ status: 'ACTIVE', trialEndsAt: null, plan: 'ESSENTIALS' }),
    },
    document: {
      aggregate: async () => ({ _sum: { fileSize: 2 * 1024 * 1024 * 1024 - 10 } }),
      create: async () => {
        createCalled = true;
        return publicDocument({ fileUrl: 'org-1/policy.pdf', mimeType: 'application/pdf' });
      },
    },
    documentStorageDeletion: { create: async (args: unknown) => {
      queuedPath = (args as { data: { storagePath: string } }).data.storagePath;
      return { id: 'cleanup-1' };
    } },
  });

  try {
    const request = multipartRequest(baseFields, {
      filename: 'policy.pdf',
      mimetype: 'application/pdf',
      content: Buffer.from('%PDF-1.7\n%%EOF'),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { ...request.headers, authorization: authHeader },
      payload: request.payload,
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, 'DOCUMENT_STORAGE_QUOTA_EXCEEDED');
    assert.equal(createCalled, false);
    assert.deepEqual(deletedPaths, []);
    assert.equal(queuedPath, undefined);
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    StorageService.prototype.deleteFile = originalDelete;
    await app.close();
  }
});

test('document upload preserves the database error when cleanup cannot be queued', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  const originalDelete = StorageService.prototype.deleteFile;

  StorageService.prototype.uploadFile = mockUpload('org-1/policy.pdf');
  StorageService.prototype.deleteFile = async () => {
    throw new Error('storage cleanup unavailable');
  };

  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      create: async () => {
        throw new AppError(400, 'DOCUMENT_CREATE_FAILED', 'Document creation failed');
      },
    },
    documentStorageDeletion: { create: async () => { throw new Error('cleanup queue unavailable'); } },
  });

  try {
    const request = multipartRequest(baseFields, {
      filename: 'policy.pdf',
      mimetype: 'application/pdf',
      content: Buffer.from('%PDF-1.7\n%%EOF'),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { ...request.headers, authorization: authHeader },
      payload: request.payload,
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'DOCUMENT_CREATE_FAILED');
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    StorageService.prototype.deleteFile = originalDelete;
    await app.close();
  }
});

test('failed document create keeps its reserved uploaded bytes for delayed reconciliation', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  const originalDelete = StorageService.prototype.deleteFile;
  StorageService.prototype.uploadFile = mockUpload('org-1/orphan.pdf');
  StorageService.prototype.deleteFile = async () => { throw new Error('storage cleanup unavailable'); };
  let queued: Record<string, unknown> | undefined;
  let failure: Record<string, unknown> | undefined;
  let reservation: Record<string, unknown> | undefined;
  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: { create: async () => { throw new AppError(400, 'DOCUMENT_CREATE_FAILED', 'Document creation failed'); } },
    documentStorageDeletion: {
      create: async (args: unknown) => { queued = (args as { data: Record<string, unknown> }).data; return { id: 'cleanup-1' }; },
      findFirst: async () => ({ id: 'cleanup-1', attempts: 0, claimedAt: null }),
      updateMany: async (args: unknown) => { failure = (args as { data: Record<string, unknown> }).data; return { count: 1 }; },
    },
    documentUploadIntent: { create: async (args: unknown) => {
      reservation = (args as { data: Record<string, unknown> }).data;
      return { id: 'intent-upload-1' };
    } },
  });
  try {
    const request = multipartRequest(baseFields, {
      filename: 'policy.pdf', mimetype: 'application/pdf', content: Buffer.from('%PDF-1.7\n%%EOF'),
    });
    const response = await app.inject({
      method: 'POST', url: '/', headers: { ...request.headers, authorization: authHeader }, payload: request.payload,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'DOCUMENT_CREATE_FAILED');
    assert.equal(reservation?.organisationId, 'org-1');
    assert.equal(reservation?.storagePath, 'org-1/orphan.pdf');
    assert.equal(reservation?.provider, 'supabase');
    assert.equal(reservation?.state, 'RESERVED');
    assert.equal(queued, undefined);
    assert.equal(failure, undefined);
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    StorageService.prototype.deleteFile = originalDelete;
    await app.close();
  }
});

test('failed document create does not claim byte removal before the worker checks it', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  const originalDelete = StorageService.prototype.deleteFile;
  let deleteCalled = false;
  StorageService.prototype.uploadFile = mockUpload('org-1/orphan.pdf', 'local');
  StorageService.prototype.deleteFile = async () => { deleteCalled = true; return new Date(); };
  let completed: Record<string, unknown> | undefined;
  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: { create: async () => { throw new Error('database create failed'); } },
    documentStorageDeletion: {
      create: async () => ({ id: 'cleanup-1' }),
      updateMany: async (args: unknown) => { completed = (args as { data: Record<string, unknown> }).data; return { count: 1 }; },
    },
  });
  try {
    const request = multipartRequest(baseFields, {
      filename: 'policy.pdf', mimetype: 'application/pdf', content: Buffer.from('%PDF-1.7\n%%EOF'),
    });
    const response = await app.inject({
      method: 'POST', url: '/', headers: { ...request.headers, authorization: authHeader }, payload: request.payload,
    });
    assert.equal(response.statusCode, 500);
    assert.equal(deleteCalled, false);
    assert.equal(completed, undefined);
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    StorageService.prototype.deleteFile = originalDelete;
    await app.close();
  }
});

test('Essentials organisations cannot link documents to additional governance standards', async () => {
  let linkCreated = false;
  const app = await buildDocumentsApp({
    subscription: {
      findUnique: async () => ({ status: 'ACTIVE', trialEndsAt: null, plan: 'ESSENTIALS' }),
    },
    document: {
      findFirst: async () => ({ id: 'doc-1', organisationId: 'org-1', lifecycleStatus: 'CURRENT' }),
    },
    organisation: {
      findUniqueOrThrow: async () => ({ complexity: 'COMPLEX' }),
    },
    governanceStandard: {
      findUnique: async () => ({ id: 'additional-standard', isCore: false }),
    },
    documentStandardLink: {
      create: async () => {
        linkCreated = true;
        return { documentId: 'doc-1', standardId: 'additional-standard' };
      },
    },
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/doc-1/standards',
      headers: { authorization: authHeader },
      payload: { standardId: 'additional-standard' },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, 'COMPLIANCE_STANDARD_NOT_INCLUDED_IN_PLAN');
    assert.equal(linkCreated, false);
  } finally {
    await app.close();
  }
});

test('draft and historical documents cannot be linked as current standard evidence', async () => {
  let linked = false;
  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: { findFirst: async () => ({ id: 'doc-1', organisationId: 'org-1', lifecycleStatus: 'DRAFT' }) },
    organisation: { findUniqueOrThrow: async () => ({ complexity: 'SIMPLE' }) },
    governanceStandard: { findUnique: async () => ({ id: 'standard-1', isCore: true }) },
    documentStandardLink: { create: async () => { linked = true; return {}; } },
  });
  try {
    const response = await app.inject({ method: 'POST', url: '/doc-1/standards', headers: { authorization: authHeader }, payload: { standardId: 'standard-1' } });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'DOCUMENT_NOT_CURRENT');
    assert.equal(linked, false);
  } finally {
    await app.close();
  }
});

test('a lifecycle change during standard linking is reported as a conflict without an audit event', async () => {
  let auditCreated = false;
  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: { findFirst: async () => ({ id: 'doc-1', organisationId: 'org-1', lifecycleStatus: 'CURRENT' }) },
    organisation: { findUniqueOrThrow: async () => ({ complexity: 'SIMPLE' }) },
    governanceStandard: { findUnique: async () => ({ id: 'standard-1', isCore: true }) },
    documentStandardLink: { create: async () => {
      throw { code: 'P2004', meta: { database_error: 'Document standard link requires current document' } };
    } },
    documentControlAudit: { create: async () => { auditCreated = true; return {}; } },
  });
  try {
    const response = await app.inject({ method: 'POST', url: '/doc-1/standards', headers: { authorization: authHeader }, payload: { standardId: 'standard-1' } });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'DOCUMENT_NOT_CURRENT');
    assert.equal(auditCreated, false);
  } finally {
    await app.close();
  }
});

test('standard link and unlink events record the actor beside the database change', async () => {
  const audits: Record<string, unknown>[] = [];
  let linked = false;
  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: { findFirst: async () => ({ id: 'doc-1', organisationId: 'org-1', lifecycleStatus: 'CURRENT' }) },
    organisation: { findUniqueOrThrow: async () => ({ complexity: 'SIMPLE' }) },
    governanceStandard: { findUnique: async () => ({ id: 'standard-1', isCore: true }) },
    documentStandardLink: {
      create: async () => { linked = true; return { documentId: 'doc-1', standardId: 'standard-1' }; },
      deleteMany: async () => { const count = linked ? 1 : 0; linked = false; return { count }; },
    } as never,
    documentControlAudit: { create: async (args: unknown) => {
      audits.push((args as { data: Record<string, unknown> }).data);
      return { id: `audit-${audits.length}` };
    } },
  });
  try {
    const add = await app.inject({ method: 'POST', url: '/doc-1/standards', headers: { authorization: authHeader }, payload: { standardId: 'standard-1' } });
    assert.equal(add.statusCode, 201);
    assert.deepEqual(audits[0], {
      organisationId: 'org-1', documentId: 'doc-1', actorUserId: 'user-1', kind: 'STANDARD_LINK',
      previous: 'UNLINKED', next: 'standard-1', reason: 'Governance standard linked to document.',
    });
    const remove = await app.inject({ method: 'DELETE', url: '/doc-1/standards/standard-1', headers: { authorization: authHeader } });
    assert.equal(remove.statusCode, 204);
    assert.deepEqual(audits[1], {
      organisationId: 'org-1', documentId: 'doc-1', actorUserId: 'user-1', kind: 'STANDARD_UNLINK',
      previous: 'standard-1', next: 'UNLINKED', reason: 'Governance standard unlinked from document.',
    });
    const repeated = await app.inject({ method: 'DELETE', url: '/doc-1/standards/standard-1', headers: { authorization: authHeader } });
    assert.equal(repeated.statusCode, 204);
    assert.equal(audits.length, 2, 'an idempotent no-op must not invent a change event');
  } finally {
    await app.close();
  }
});

test('document deletion requires a bounded reason before reading or changing a record', async () => {
  let reads = 0;
  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: { findFirst: async () => { reads += 1; return null; } },
  });
  try {
    for (const payload of [undefined, { reason: 'short' }, { reason: 'x'.repeat(501) },
      { reason: 'Unsupported\u0085control in reason' }]) {
      const response = await app.inject({
        method: 'DELETE', url: '/doc-1', headers: { authorization: authHeader }, payload,
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().code, 'VALIDATION_ERROR');
    }
    assert.equal(reads, 0);
  } finally { await app.close(); }
});

test('document delete removes storage after deleting the database record', { concurrency: false }, async () => {
  const originalDeleteFile = StorageService.prototype.deleteFile;
  let order = 0;
  let storageDeleteOrder = 0;
  let databaseDeleteOrder = 0;
  let outboxCreateOrder = 0;
  let outboxSource: Record<string, unknown> | null = null;
  let outboxProcessedOrder = 0;
  const outboxProcessedData: Array<Record<string, unknown>> = [];
  let storageDeleteArgs: string[] = [];
  let removalAudit: Record<string, unknown> | null = null;

  StorageService.prototype.deleteFile = async (organisationId: string, storagePath: string, _signal?: AbortSignal, provider?: string) => {
    storageDeleteArgs = [organisationId, storagePath, provider ?? ''];
    storageDeleteOrder = ++order;
    return new Date();
  };

  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      findFirst: async () => ({ id: 'doc-1', organisationId: 'org-1', fileUrl: 'org-1/policy.pdf', storageProvider: 'supabase', lifecycleStatus: 'DRAFT' }),
      delete: async (args: unknown) => {
        assert.deepEqual((args as { where: unknown }).where, { id: 'doc-1', organisationId: 'org-1', deletionHold: false,
          lifecycleStatus: 'DRAFT', standardLinks: { none: {} }, confluenceReferences: { none: {} } });
        databaseDeleteOrder = ++order;
        return { id: 'doc-1' };
      },
    },
    documentStorageDeletion: {
      create: async (args: unknown) => {
        outboxCreateOrder = ++order;
        outboxSource = (args as { data: Record<string, unknown> }).data;
        return { id: 'deletion-1' };
      },
      updateMany: async (args: unknown) => {
        outboxProcessedOrder = ++order;
        outboxProcessedData.push((args as { data: Record<string, unknown> }).data);
        return { count: 1 };
      },
    },
    documentControlAudit: { create: async (args: unknown) => {
      assert.equal(databaseDeleteOrder, 2);
      assert.equal(storageDeleteOrder, 0, 'the record-removal audit precedes provider cleanup');
      removalAudit = (args as { data: Record<string, unknown> }).data;
      return { id: 'delete-audit-1' };
    } },
  });

  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/doc-1',
      headers: { authorization: authHeader },
      payload: deletionPayload,
    });

    assert.equal(response.statusCode, 204);
    assert.deepEqual(storageDeleteArgs, ['org-1', 'org-1/policy.pdf', 'supabase']);
    assert.equal(outboxCreateOrder, 1);
    assert.deepEqual(outboxSource, {
      organisationId: 'org-1', storagePath: 'org-1/policy.pdf', sourceDocumentId: 'doc-1', provider: 'supabase',
    });
    assert.equal(databaseDeleteOrder, 2);
    assert.equal(storageDeleteOrder, 3);
    assert.equal(outboxProcessedOrder, 4);
    assert.equal(outboxProcessedData[0]?.activeObjectAbsentAt instanceof Date, true);
    assert.deepEqual(removalAudit, {
      organisationId: 'org-1', documentId: 'doc-1', actorUserId: 'user-1', kind: 'RECORD_DELETE',
      previous: 'DOCUMENT_PRESENT', next: 'DATABASE_RECORD_REMOVED',
      reason: deletionPayload.reason,
    });
  } finally {
    StorageService.prototype.deleteFile = originalDeleteFile;
    await app.close();
  }
});

test('only an Admin can place or release a document deletion hold with an audited reason', async () => {
  const originalUpdatedAt = new Date('2026-09-29T10:00:00.000Z');
  const nextUpdatedAt = new Date('2026-09-29T10:01:00.000Z');
  let held = false;
  let updatedAt = originalUpdatedAt;
  let role: 'ADMIN' | 'MEMBER' = 'MEMBER';
  const audits: Record<string, unknown>[] = [];
  const app = await buildDocumentsApp({
    user: { findUnique: async () => ({ id: 'user-1', organisationId: 'org-1', role, emailVerified: true }) },
    subscription: subscription(),
    document: {
      findFirst: async () => ({ id: 'doc-1', organisationId: 'org-1', deletionHold: held, updatedAt }),
      update: async (args: unknown) => {
        const { where, data } = args as { where: { organisationId: string; updatedAt: Date; deletionHold: boolean }; data: { deletionHold: boolean } };
        assert.equal(where.organisationId, 'org-1');
        if (where.updatedAt.getTime() !== updatedAt.getTime() || where.deletionHold !== held) {
          throw Object.assign(new Error('stale revision'), { code: 'P2025' });
        }
        held = data.deletionHold;
        updatedAt = nextUpdatedAt;
        return { id: 'doc-1', deletionHold: held, updatedAt };
      },
    },
    documentControlAudit: { create: async (args: unknown) => {
      audits.push((args as { data: Record<string, unknown> }).data);
      return { id: `audit-${audits.length}` };
    } },
  });
  const memberAuth = `Bearer ${signAccessToken({ userId: 'user-1', organisationId: 'org-1', role: 'MEMBER', sessionId: 'session-1' })}`;
  const payload = { expectedUpdatedAt: originalUpdatedAt.toISOString(), held: true, reason: 'Retain this document pending administrative review.' };
  try {
    const member = await app.inject({ method: 'POST', url: '/doc-1/deletion-hold', headers: { authorization: memberAuth }, payload });
    assert.equal(member.statusCode, 403);
    assert.equal(held, false);

    role = 'ADMIN';

    const invalid = await app.inject({ method: 'POST', url: '/doc-1/deletion-hold', headers: { authorization: authHeader }, payload: { ...payload, reason: 'short' } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(held, false);

    const placed = await app.inject({ method: 'POST', url: '/doc-1/deletion-hold', headers: { authorization: authHeader }, payload });
    assert.equal(placed.statusCode, 200);
    assert.equal(placed.json().data.deletionHold, true);
    assert.deepEqual(audits[0], {
      organisationId: 'org-1', documentId: 'doc-1', actorUserId: 'user-1', kind: 'DELETION_HOLD',
      previous: 'false', next: 'true', reason: payload.reason,
    });

    const stale = await app.inject({ method: 'POST', url: '/doc-1/deletion-hold', headers: { authorization: authHeader }, payload: { ...payload, held: false } });
    assert.equal(stale.statusCode, 409);
    assert.equal(audits.length, 1);

    const released = await app.inject({ method: 'POST', url: '/doc-1/deletion-hold', headers: { authorization: authHeader }, payload: {
      expectedUpdatedAt: nextUpdatedAt.toISOString(), held: false, reason: 'Review completed and the administrative hold is released.',
    } });
    assert.equal(released.statusCode, 200);
    assert.equal(released.json().data.deletionHold, false);
    assert.equal(audits[1]?.previous, 'true');
    assert.equal(audits[1]?.next, 'false');
  } finally { await app.close(); }
});

test('connector sessions cannot change deletion holds or verify a written file provider', async () => {
  let documentReads = 0;
  const app = await buildDocumentsApp({
    ...patchPrisma(),
    authSession: { findFirst: async () => ({
      id: 'session-1', clientKind: 'MCP_CONNECTOR', accessLevel: 'ADMIN', dataScope: 'FULL',
    }) },
    document: { findFirst: async () => { documentReads += 1; throw new Error('Document should not be read'); } },
  } as never);
  try {
    const hold = await app.inject({
      method: 'POST', url: '/doc-1/deletion-hold', headers: { authorization: authHeader },
      payload: { expectedUpdatedAt: '2026-06-08T00:00:00.000Z', held: false,
        reason: 'Release after controlled review.' },
    });
    assert.equal(hold.statusCode, 403);
    assert.equal(hold.json().code, 'WEB_SESSION_REQUIRED');

    const provider = await app.inject({
      method: 'POST', url: '/doc-1/verify-storage-provider', headers: { authorization: authHeader },
      payload: { expectedUpdatedAt: '2026-06-08T00:00:00.000Z' },
    });
    assert.equal(provider.statusCode, 403);
    assert.equal(provider.json().code, 'WEB_SESSION_REQUIRED');
    assert.equal(documentReads, 0);
  } finally { await app.close(); }
});

test('a held document cannot create a storage deletion job or reach provider cleanup', { concurrency: false }, async () => {
  const originalDeleteFile = StorageService.prototype.deleteFile;
  let storageDeleteCalled = false;
  let outboxCreated = false;
  let recordDeleted = false;
  StorageService.prototype.deleteFile = async () => { storageDeleteCalled = true; return new Date(); };
  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      findFirst: async () => ({ id: 'doc-1', organisationId: 'org-1', fileUrl: 'org-1/policy.pdf', lifecycleStatus: 'DRAFT', deletionHold: true }),
      delete: async () => { recordDeleted = true; return { id: 'doc-1' }; },
    },
    documentStorageDeletion: { create: async () => { outboxCreated = true; return { id: 'deletion-1' }; } },
  });
  try {
    const response = await app.inject({ method: 'DELETE', url: '/doc-1', headers: { authorization: authHeader }, payload: deletionPayload });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'DOCUMENT_DELETION_HOLD');
    assert.equal(outboxCreated, false);
    assert.equal(recordDeleted, false);
    assert.equal(storageDeleteCalled, false);
  } finally { StorageService.prototype.deleteFile = originalDeleteFile; await app.close(); }
});

test('ordinary draft deletion refuses linked standards and cited pages before queueing cleanup', async () => {
  let linked: 'standard' | 'citation' = 'standard';
  let queued = false;
  let deleted = false;
  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      findFirst: async () => ({
        id: 'doc-1', organisationId: 'org-1', fileUrl: 'org-1/draft.pdf',
        storageProvider: 'supabase', lifecycleStatus: 'DRAFT', deletionHold: false,
        standardLinks: linked === 'standard' ? [{ id: 'link-1' }] : [],
        confluenceReferences: linked === 'citation' ? [{ id: 'citation-1' }] : [],
      }),
      delete: async () => { deleted = true; return { id: 'doc-1' }; },
    },
    documentStorageDeletion: { create: async () => { queued = true; return { id: 'deletion-1' }; } },
  });
  try {
    for (linked of ['standard', 'citation'] as const) {
      const response = await app.inject({ method: 'DELETE', url: '/doc-1',
        headers: { authorization: authHeader }, payload: deletionPayload });
      assert.equal(response.statusCode, 409, linked);
      assert.equal(response.json().code, 'DOCUMENT_LINKED_EVIDENCE_REVIEW_REQUIRED', linked);
    }
    assert.equal(queued, false);
    assert.equal(deleted, false);
  } finally { await app.close(); }
});

test('a link added during draft deletion returns review conflict without provider cleanup', { concurrency: false }, async () => {
  const originalDeleteFile = StorageService.prototype.deleteFile;
  let storageDeleted = false;
  StorageService.prototype.deleteFile = async () => { storageDeleted = true; return new Date(); };
  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      findFirst: async () => ({ id: 'doc-1', organisationId: 'org-1', fileUrl: 'org-1/draft.pdf',
        storageProvider: 'supabase', lifecycleStatus: 'DRAFT', deletionHold: false,
        standardLinks: [], confluenceReferences: [] }),
      delete: async () => { throw Object.assign(new Error('Linked document evidence requires separate review'),
        { code: 'P2004', meta: { constraint: 'Document_linked_evidence_delete_guard' } }); },
    },
    documentStorageDeletion: { create: async () => ({ id: 'deletion-1' }) },
  });
  try {
    const response = await app.inject({ method: 'DELETE', url: '/doc-1',
      headers: { authorization: authHeader }, payload: deletionPayload });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'DOCUMENT_LINKED_EVIDENCE_REVIEW_REQUIRED');
    assert.equal(storageDeleted, false);
  } finally { StorageService.prototype.deleteFile = originalDeleteFile; await app.close(); }
});

test('ordinary deletion retains every non-draft lifecycle state without provider cleanup', { concurrency: false }, async () => {
  const originalDeleteFile = StorageService.prototype.deleteFile;
  let status = 'UNREVIEWED';
  let outboxCreated = false;
  let recordDeleted = false;
  let storageDeleteCalled = false;
  StorageService.prototype.deleteFile = async () => { storageDeleteCalled = true; return new Date(); };
  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      findFirst: async () => ({ id: 'doc-1', organisationId: 'org-1', fileUrl: 'org-1/policy.pdf', lifecycleStatus: status, deletionHold: false }),
      delete: async () => { recordDeleted = true; return { id: 'doc-1' }; },
    },
    documentStorageDeletion: { create: async () => { outboxCreated = true; return { id: 'deletion-1' }; } },
  });
  try {
    for (status of ['UNREVIEWED', 'CURRENT', 'SUPERSEDED', 'RETIRED', 'HISTORICAL']) {
      const response = await app.inject({ method: 'DELETE', url: '/doc-1', headers: { authorization: authHeader }, payload: deletionPayload });
      assert.equal(response.statusCode, 409, status);
      assert.equal(response.json().code, 'DOCUMENT_RETENTION_REVIEW_REQUIRED', status);
    }
    assert.equal(outboxCreated, false);
    assert.equal(recordDeleted, false);
    assert.equal(storageDeleteCalled, false);
  } finally { StorageService.prototype.deleteFile = originalDeleteFile; await app.close(); }
});

test('a deletion hold placed during delete prevents cleanup and the transaction fails closed', { concurrency: false }, async () => {
  const originalDeleteFile = StorageService.prototype.deleteFile;
  let storageDeleteCalled = false;
  let auditCalled = false;
  StorageService.prototype.deleteFile = async () => { storageDeleteCalled = true; return new Date(); };
  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      findFirst: async () => ({ id: 'doc-1', organisationId: 'org-1', fileUrl: 'org-1/policy.pdf', storageProvider: 'supabase', lifecycleStatus: 'DRAFT', deletionHold: false }),
      delete: async (args: unknown) => {
        assert.deepEqual((args as { where: unknown }).where, { id: 'doc-1', organisationId: 'org-1', deletionHold: false,
          lifecycleStatus: 'DRAFT', standardLinks: { none: {} }, confluenceReferences: { none: {} } });
        throw Object.assign(new Error('hold changed concurrently'), { code: 'P2025' });
      },
    },
    documentStorageDeletion: { create: async () => ({ id: 'deletion-1' }) },
    documentControlAudit: { create: async () => { auditCalled = true; return { id: 'audit-1' }; } },
  });
  try {
    const response = await app.inject({ method: 'DELETE', url: '/doc-1', headers: { authorization: authHeader }, payload: deletionPayload });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'DOCUMENT_DELETE_CONFLICT');
    assert.equal(auditCalled, false);
    assert.equal(storageDeleteCalled, false);
  } finally { StorageService.prototype.deleteFile = originalDeleteFile; await app.close(); }
});

test('a referenced replacement cannot be deleted or sent to provider cleanup', { concurrency: false }, async () => {
  const originalDeleteFile = StorageService.prototype.deleteFile;
  let storageDeleteCalled = false;
  let removalAudited = false;
  StorageService.prototype.deleteFile = async () => { storageDeleteCalled = true; return new Date(); };
  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      findFirst: async () => ({ id: 'doc-2', organisationId: 'org-1', fileUrl: 'org-1/replacement.pdf', storageProvider: 'supabase', lifecycleStatus: 'DRAFT' }),
      delete: async () => { throw Object.assign(new Error('foreign key restrict'), { code: 'P2003' }); },
    },
    documentStorageDeletion: { create: async () => ({ id: 'deletion-1' }) },
    documentControlAudit: { create: async () => { removalAudited = true; return { id: 'audit-1' }; } },
  });
  try {
    const response = await app.inject({ method: 'DELETE', url: '/doc-2', headers: { authorization: authHeader }, payload: deletionPayload });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'DOCUMENT_REPLACEMENT_IN_USE');
    assert.equal(storageDeleteCalled, false);
    assert.equal(removalAudited, false);
  } finally { StorageService.prototype.deleteFile = originalDeleteFile; await app.close(); }
});

test('document delete does not remove storage when database deletion fails', { concurrency: false }, async () => {
  const originalDeleteFile = StorageService.prototype.deleteFile;
  let storageDeleteCalled = false;

  StorageService.prototype.deleteFile = async () => {
    storageDeleteCalled = true;
    return new Date();
  };

  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      findFirst: async () => ({ id: 'doc-1', organisationId: 'org-1', fileUrl: 'org-1/policy.pdf', storageProvider: 'supabase', lifecycleStatus: 'DRAFT' }),
      delete: async () => {
        throw new Error('database unavailable');
      },
    },
    documentStorageDeletion: {
      create: async () => ({ id: 'deletion-1' }),
      updateMany: async () => {
        throw new Error('outbox should not be processed');
      },
    },
  });

  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/doc-1',
      headers: { authorization: authHeader },
      payload: deletionPayload,
    });

    assert.equal(response.statusCode, 500);
    assert.equal(storageDeleteCalled, false);
  } finally {
    StorageService.prototype.deleteFile = originalDeleteFile;
    await app.close();
  }
});

test('document record deletion refuses provider cleanup when its audit write fails', { concurrency: false }, async () => {
  const originalDeleteFile = StorageService.prototype.deleteFile;
  let storageDeleteCalled = false;
  StorageService.prototype.deleteFile = async () => { storageDeleteCalled = true; return new Date(); };
  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      findFirst: async () => ({ id: 'doc-1', organisationId: 'org-1', fileUrl: 'org-1/policy.pdf', storageProvider: 'supabase', lifecycleStatus: 'DRAFT' }),
      delete: async () => ({ id: 'doc-1' }),
    },
    documentStorageDeletion: { create: async () => ({ id: 'deletion-1' }) },
    documentControlAudit: { create: async () => { throw new Error('audit unavailable'); } },
  });
  try {
    const response = await app.inject({ method: 'DELETE', url: '/doc-1', headers: { authorization: authHeader }, payload: deletionPayload });
    assert.equal(response.statusCode, 500);
    assert.equal(storageDeleteCalled, false);
  } finally {
    StorageService.prototype.deleteFile = originalDeleteFile;
    await app.close();
  }
});

test('document delete reports success when post-delete storage cleanup fails', { concurrency: false }, async () => {
  const originalDeleteFile = StorageService.prototype.deleteFile;
  let databaseDeleteCalled = false;
  const outboxUpdates: unknown[] = [];

  StorageService.prototype.deleteFile = async () => {
    throw Object.assign(
      new Error('storage unavailable for ops@example.org at org-1/policy.pdf?token=secret-token'),
      { code: 'StorageApiError', status: 503 },
    );
  };

  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      findFirst: async () => ({ id: 'doc-1', organisationId: 'org-1', fileUrl: 'org-1/policy.pdf', storageProvider: 'supabase', lifecycleStatus: 'DRAFT' }),
      delete: async () => {
        databaseDeleteCalled = true;
        return { id: 'doc-1' };
      },
    },
    documentStorageDeletion: {
      create: async () => ({ id: 'deletion-1' }),
      findFirst: async () => ({
        id: 'deletion-1',
        state: 'PENDING',
        attempts: 0,
        claimedAt: null,
      }),
      updateMany: async (args: unknown) => {
        outboxUpdates.push(args);
        return { count: 1 };
      },
    },
  });

  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/doc-1',
      headers: { authorization: authHeader },
      payload: deletionPayload,
    });

    assert.equal(response.statusCode, 204);
    assert.equal(databaseDeleteCalled, true);
    const lastError = (outboxUpdates[0] as { data: { lastError: string } }).data.lastError;
    assert.match(lastError, /name=Error/);
    assert.match(lastError, /code=StorageApiError/);
    assert.match(lastError, /status=503/);
    assert.match(lastError, /\[email\]/);
    assert.match(lastError, /\[storage-path\]/);
    assert.doesNotMatch(lastError, /ops@example\.org/);
    assert.doesNotMatch(lastError, /secret-token/);
    assert.equal((outboxUpdates[0] as { where: { state: string } }).where.state, 'PENDING');
    assert.deepEqual((outboxUpdates[0] as { data: Record<string, unknown> }).data, {
      state: 'PENDING',
      attempts: 1,
      lastError,
      lastAttemptAt: (outboxUpdates[0] as { data: { lastAttemptAt: Date } }).data.lastAttemptAt,
      nextAttemptAt: (outboxUpdates[0] as { data: { nextAttemptAt: Date } }).data.nextAttemptAt,
      claimedAt: null,
      deadLetteredAt: null,
      terminalReason: null,
      alertClaimToken: null,
      alertClaimedAt: null,
      alertedAt: null,
    });
    assert.ok((outboxUpdates[0] as { data: { lastAttemptAt: Date } }).data.lastAttemptAt instanceof Date);
    assert.ok((outboxUpdates[0] as { data: { nextAttemptAt: Date } }).data.nextAttemptAt instanceof Date);
  } finally {
    StorageService.prototype.deleteFile = originalDeleteFile;
    await app.close();
  }
});

// The regression test for the per-organisation wiring itself. Every other
// fixture in this file resolves to `documentStorageProvider: null`, which is
// behaviourally identical to passing no resolver at all — so deleting
// `createPrismaOrganisationStorageResolver(app.prisma)` from
// routes/documents/index.ts leaves them all green. This one does not: the
// deployment default is Supabase (DOCUMENT_STORAGE_DRIVER unset) and only the
// organisation row says `local`, so the bytes can only land on disk if the
// resolver is wired, its answer reaches StorageService's storage branch, and
// the provider it names is the one that writes.
test('an organisation pinned to local storage has its uploaded bytes written to the local root', { concurrency: false }, async () => {
  const previousDriver = process.env.DOCUMENT_STORAGE_DRIVER;
  const previousRoot = process.env.LOCAL_FILE_STORAGE_DIR;
  const root = await mkdtemp(join(tmpdir(), 'charitypilot-documents-route-'));

  delete process.env.DOCUMENT_STORAGE_DRIVER;
  process.env.LOCAL_FILE_STORAGE_DIR = root;

  let createdFileUrl: string | null = null;

  const app = await buildDocumentsApp({
    subscription: subscription(),
    organisation: {
      findUnique: async () => ({ documentStorageProvider: 'local', documentStorageAlphaOptIn: false }),
    },
    document: {
      create: async (args: unknown) => {
        createdFileUrl = (args as { data: { fileUrl: string } }).data.fileUrl;
        return publicDocument({ fileUrl: createdFileUrl, mimeType: 'text/plain' });
      },
    },
  });

  try {
    const request = multipartRequest(baseFields, {
      filename: 'policy.txt',
      mimetype: 'text/plain',
      content: Buffer.from('pinned to local storage'),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { ...request.headers, authorization: authHeader },
      payload: request.payload,
    });

    assert.equal(response.statusCode, 201);
    assert.equal(typeof createdFileUrl, 'string');
    assert.equal((createdFileUrl as unknown as string).startsWith('org-1/'), true);

    const written = await readFile(join(root, createdFileUrl as unknown as string));
    assert.equal(written.toString(), 'pinned to local storage');
  } finally {
    await rm(root, { recursive: true, force: true });
    if (previousDriver === undefined) delete process.env.DOCUMENT_STORAGE_DRIVER;
    else process.env.DOCUMENT_STORAGE_DRIVER = previousDriver;
    if (previousRoot === undefined) delete process.env.LOCAL_FILE_STORAGE_DIR;
    else process.env.LOCAL_FILE_STORAGE_DIR = previousRoot;
    await app.close();
  }
});

// ── changing a document's card (PATCH /:id) ─────────────────────────────────

function patchPrisma(overrides: {
  existing?: { id: string; updatedAt: Date; category?: string; visibility: string; lifecycleStatus: string;
    contentAccessClass?: string; storageProvider?: string | null; memberReviewedSha256?: string | null;
    supersededByDocumentId?: string | null; externalPublicationApproved: boolean;
    externalPublicationSiteId?: string | null; externalPublicationSpaceId?: string | null } | null;
  referencingDocument?: { id: string } | null;
  onUpdate?: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => void;
  onVisibilityAudit?: (args: { data: Record<string, unknown> }) => void;
  onControlAudit?: (args: { data: Record<string, unknown> }) => void;
  reviewReceipt?: boolean;
  onReviewReceipt?: (args: { where: Record<string, unknown> }) => void;
} = {}) {
  const existing = overrides.existing === undefined
    ? { id: 'doc-1', updatedAt: new Date('2026-06-08T00:00:00.000Z'), visibility: 'RESTRICTED', contentAccessClass: 'UNASSESSED', lifecycleStatus: 'CURRENT', externalPublicationApproved: false, storageProvider: 'local', fileUrl: 'org-1/policy.pdf', fileSize: 8, memberReviewedSha256: null }
    : overrides.existing === null ? null : { storageProvider: 'local', fileUrl: 'org-1/policy.pdf', fileSize: 8, memberReviewedSha256: null, ...overrides.existing };

  return {
    subscription: subscription(),
    organisation: {
      findUnique: async () => ({ documentStorageProvider: null, documentStorageAlphaOptIn: false }),
      findUniqueOrThrow: async () => ({ complexity: 'SIMPLE' }),
    },
    document: {
      findFirst: async (args: { where?: { supersededByDocumentId?: string } }) =>
        args.where?.supersededByDocumentId ? overrides.referencingDocument ?? null : existing,
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        overrides.onUpdate?.(args);
        return publicDocument({ ...args.data, id: args.where.id, updatedAt: new Date('2026-06-09T00:00:00.000Z') });
      },
    },
    documentVisibilityAudit: {
      create: async (args: { data: Record<string, unknown> }) => { overrides.onVisibilityAudit?.(args); return { id: 'audit-1' }; },
    },
    documentControlAudit: {
      create: async (args: { data: Record<string, unknown> }) => { overrides.onControlAudit?.(args); return { id: 'audit-2' }; },
    },
    documentDownloadPreparationAudit: {
      findFirst: async (args: { where: Record<string, unknown> }) => {
        overrides.onReviewReceipt?.(args);
        return overrides.reviewReceipt ? { id: 'review-download-1' } : null;
      },
    },
  };
}

test('connector document edits cannot set access, lifecycle or publication decisions through the API', async () => {
  let writes = 0;
  const app = await buildDocumentsApp({
    ...patchPrisma({ onUpdate: () => { writes += 1; } }),
    authSession: { findFirst: async () => ({
      id: 'session-1', clientKind: 'MCP_CONNECTOR', accessLevel: 'WRITE', dataScope: 'FULL',
    }) },
  } as never);
  try {
    const decisions = [
      { visibility: 'MEMBER_VISIBLE', visibilityReason: 'Reviewed for Member access.' },
      { contentAccessClass: 'MEMBER_SUITABLE', contentAccessReason: 'Reviewed full document content.' },
      { lifecycleStatus: 'RETIRED', lifecycleReason: 'Retired after governance review.' },
      { externalPublicationApproved: false, publicationApprovalReason: 'Withdrawing external approval.' },
    ];
    for (const decision of decisions) {
      const response = await app.inject({
        method: 'PATCH', url: '/doc-1', headers: { authorization: authHeader },
        payload: { ...decision, expectedUpdatedAt: '2026-06-08T00:00:00.000Z' },
      });
      assert.equal(response.statusCode, 403, JSON.stringify(decision));
      assert.equal(response.json().code, 'WEB_SESSION_REQUIRED');
    }
    assert.equal(writes, 0);

    const metadata = await app.inject({
      method: 'PATCH', url: '/doc-1', headers: { authorization: authHeader },
      payload: { name: 'Revised safeguarding policy', expectedUpdatedAt: '2026-06-08T00:00:00.000Z' },
    });
    assert.equal(metadata.statusCode, 200);
    assert.equal(writes, 1);
  } finally {
    await app.close();
  }
});

test('Admin connector cannot read dashboard-only Vault control and deletion histories by direct API call', async () => {
  const app = await buildDocumentsApp({
    ...patchPrisma(),
    authSession: { findFirst: async () => ({
      id: 'session-1', clientKind: 'MCP_CONNECTOR', accessLevel: 'ADMIN', dataScope: 'FULL',
    }) },
  } as never);
  try {
    for (const path of [
      '/replacement-candidates/doc-1', '/confluence-mirrors?ids=doc-1',
      '/control-audit', '/storage-deletions/history', '/storage-deletions/dead-letter',
    ]) {
      const response = await app.inject({ method: 'GET', url: path, headers: { authorization: authHeader } });
      assert.equal(response.statusCode, 403, path);
      assert.equal(response.json().code, 'WEB_SESSION_REQUIRED');
    }
  } finally { await app.close(); }
});

test('Admin connector cannot directly retry a publication or requeue a storage deletion', async () => {
  const app = await buildDocumentsApp({
    ...patchPrisma(),
    authSession: { findFirst: async () => ({
      id: 'session-1', clientKind: 'MCP_CONNECTOR', accessLevel: 'ADMIN', dataScope: 'FULL',
    }) },
  } as never);
  try {
    for (const path of ['/doc-1/publication/retry', '/storage-deletions/deletion-1/requeue']) {
      const response = await app.inject({ method: 'POST', url: path, headers: { authorization: authHeader } });
      assert.equal(response.statusCode, 403, path);
      assert.equal(response.json().code, 'WEB_SESSION_REQUIRED');
    }
  } finally { await app.close(); }
});

test('document metadata edit records actor, fields and revisions without retaining field values', async () => {
  const audits: Record<string, unknown>[] = [];
  const app = await buildDocumentsApp(patchPrisma({ onControlAudit: ({ data }) => { audits.push(data); } }) as never);
  try {
    const response = await app.inject({
      method: 'PATCH', url: '/doc-1', headers: { authorization: authHeader },
      payload: { name: 'Updated safeguarding policy', nextReviewDate: null, expectedUpdatedAt: '2026-06-08T00:00:00.000Z' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(audits.length, 1);
    assert.deepEqual(audits[0], {
      organisationId: 'org-1', documentId: 'doc-1', actorUserId: 'user-1', kind: 'METADATA',
      previous: '2026-06-08T00:00:00.000Z', next: '2026-06-09T00:00:00.000Z',
      reason: 'Metadata edit applied to fields: name, nextReviewDate.',
    });
    assert.equal(JSON.stringify(audits).includes('Updated safeguarding policy'), false);
  } finally {
    await app.close();
  }
});

test('editing assessed document metadata withdraws Member access and resets the assessment', async () => {
  const writes: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const visibilityAudits: Record<string, unknown>[] = [];
  const controlAudits: Record<string, unknown>[] = [];
  const app = await buildDocumentsApp(patchPrisma({
    existing: { id: 'doc-1', updatedAt: new Date('2026-06-08T00:00:00.000Z'),
      visibility: 'MEMBER_VISIBLE', contentAccessClass: 'MEMBER_SUITABLE', lifecycleStatus: 'CURRENT',
      externalPublicationApproved: false },
    onUpdate: (args) => { writes.push(args); },
    onVisibilityAudit: ({ data }) => { visibilityAudits.push(data); },
    onControlAudit: ({ data }) => { controlAudits.push(data); },
  }) as never);
  try {
    const response = await app.inject({ method: 'PATCH', url: '/doc-1', headers: { authorization: authHeader },
      payload: { name: 'Updated reviewed policy', expectedUpdatedAt: '2026-06-08T00:00:00.000Z' } });
    assert.equal(response.statusCode, 200);
    assert.equal(writes[0]?.where.contentAccessClass, 'MEMBER_SUITABLE');
    assert.equal(writes[0]?.data.visibility, 'RESTRICTED');
    assert.equal(writes[0]?.data.contentAccessClass, 'UNASSESSED');
    assert.equal(visibilityAudits.length, 1);
    assert.equal(visibilityAudits[0]?.next, 'RESTRICTED');
    assert.equal(controlAudits.map((event) => event.kind).join(','), 'METADATA,CONTENT_ACCESS');
    assert.equal(controlAudits[1]?.next, 'UNASSESSED');
    assert.equal(JSON.stringify([...visibilityAudits, ...controlAudits]).includes('Updated reviewed policy'), false,
      'audit metadata must not retain the new title');
  } finally { await app.close(); }
});

test('a replacement category cannot drift from the historical documents that point to it', async () => {
  let writes = 0;
  const app = await buildDocumentsApp(patchPrisma({
    existing: { id: 'doc-1', updatedAt: new Date('2026-06-08T00:00:00.000Z'),
      category: 'POLICY', visibility: 'RESTRICTED', lifecycleStatus: 'CURRENT',
      externalPublicationApproved: false },
    referencingDocument: { id: 'older-policy' },
    onUpdate: () => { writes += 1; },
  }) as never);
  try {
    const response = await app.inject({ method: 'PATCH', url: '/doc-1',
      headers: { authorization: authHeader },
      payload: { category: 'OTHER', expectedUpdatedAt: '2026-06-08T00:00:00.000Z' },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'DOCUMENT_REPLACEMENT_CATEGORY_CONFLICT');
    assert.equal(writes, 0);
  } finally { await app.close(); }
});

test('a superseded document cannot change category while it names a replacement', async () => {
  let writes = 0;
  const app = await buildDocumentsApp(patchPrisma({
    existing: { id: 'doc-1', updatedAt: new Date('2026-06-08T00:00:00.000Z'),
      category: 'POLICY', visibility: 'RESTRICTED', lifecycleStatus: 'SUPERSEDED',
      supersededByDocumentId: 'doc-2', externalPublicationApproved: false },
    onUpdate: () => { writes += 1; },
  }) as never);
  try {
    const response = await app.inject({ method: 'PATCH', url: '/doc-1',
      headers: { authorization: authHeader },
      payload: { category: 'OTHER', expectedUpdatedAt: '2026-06-08T00:00:00.000Z' },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'DOCUMENT_REPLACEMENT_CATEGORY_CONFLICT');
    assert.equal(writes, 0);
  } finally { await app.close(); }
});

test('a concurrent replacement-category constraint refusal is returned as a reviewable conflict', async () => {
  const app = await buildDocumentsApp(patchPrisma({
    existing: { id: 'doc-1', updatedAt: new Date('2026-06-08T00:00:00.000Z'),
      category: 'POLICY', visibility: 'RESTRICTED', lifecycleStatus: 'CURRENT',
      externalPublicationApproved: false },
    onUpdate: () => { throw Object.assign(new Error('constraint failed'), {
      code: 'P2004', meta: { database_error: 'Referenced replacement category cannot change' },
    }); },
  }) as never);
  try {
    const response = await app.inject({ method: 'PATCH', url: '/doc-1',
      headers: { authorization: authHeader },
      payload: { category: 'OTHER', expectedUpdatedAt: '2026-06-08T00:00:00.000Z' },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'DOCUMENT_REPLACEMENT_CATEGORY_CONFLICT');
  } finally { await app.close(); }
});

test('concurrent metadata edit is rejected without an audit event', async () => {
  const audits: Record<string, unknown>[] = [];
  const app = await buildDocumentsApp(patchPrisma({
    onUpdate: () => { throw Object.assign(new Error('row changed'), { code: 'P2025' }); },
    onControlAudit: ({ data }) => { audits.push(data); },
  }) as never);
  try {
    const response = await app.inject({ method: 'PATCH', url: '/doc-1', headers: { authorization: authHeader }, payload: {
      name: 'Concurrent edit', expectedUpdatedAt: '2026-06-08T00:00:00.000Z',
    } });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'DOCUMENT_UPDATE_CONFLICT');
    assert.equal(audits.length, 0);
  } finally {
    await app.close();
  }
});

test('Member visibility requires a content assessment and reason, retaining both decisions atomically', async () => {
  const originalDownloadFile = StorageService.prototype.downloadFile;
  StorageService.prototype.downloadFile = async () => Buffer.from('reviewed');
  const writes: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  let audit: Record<string, unknown> | undefined;
  let reviewWhere: Record<string, unknown> | undefined;
  const controlAudits: Record<string, unknown>[] = [];
  const app = await buildDocumentsApp(patchPrisma({
    reviewReceipt: true,
    onReviewReceipt: ({ where }) => { reviewWhere = where; },
    onUpdate: (args) => { writes.push(args); },
    onVisibilityAudit: (args) => { audit = args.data; },
    onControlAudit: (args) => { controlAudits.push(args.data); },
  }) as never);
  try {
    const missingReason = await app.inject({ method: 'PATCH', url: '/doc-1', headers: { authorization: authHeader }, payload: { visibility: 'MEMBER_VISIBLE' } });
    assert.equal(missingReason.statusCode, 400);
    assert.equal(writes.length, 0);
    assert.equal(audit, undefined);

    const unassessed = await app.inject({ method: 'PATCH', url: '/doc-1', headers: { authorization: authHeader },
      payload: { visibility: 'MEMBER_VISIBLE', visibilityReason: 'Reviewed the file and approved Member access.' } });
    assert.equal(unassessed.statusCode, 409);
    assert.equal(unassessed.json().code, 'DOCUMENT_CONTENT_ACCESS_NOT_MEMBER_SUITABLE');
    assert.equal(writes.length, 0);

    const response = await app.inject({
      method: 'PATCH', url: '/doc-1', headers: { authorization: authHeader },
      payload: { visibility: 'MEMBER_VISIBLE', visibilityReason: 'Reviewed the file and approved Member access.',
        contentAccessClass: 'MEMBER_SUITABLE', contentAccessReason: 'Reviewed full file and metadata for all Members.',
        expectedUpdatedAt: '2026-06-08T00:00:00.000Z' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(writes[0]?.where.organisationId, 'org-1');
    assert.equal(writes[0]?.where.visibility, 'RESTRICTED');
    assert.equal(writes[0]?.data.visibility, 'MEMBER_VISIBLE');
    assert.equal(writes[0]?.data.contentAccessClass, 'MEMBER_SUITABLE');
    assert.equal(writes[0]?.data.memberReviewedSha256,
      createHash('sha256').update('reviewed').digest('hex'));
    assert.deepEqual(reviewWhere, { organisationId: 'org-1', documentId: 'doc-1', actorUserId: 'user-1',
      documentUpdatedAt: new Date('2026-06-08T00:00:00.000Z'),
      reviewSha256: createHash('sha256').update('reviewed').digest('hex') });
    assert.equal(writes[0]?.where.contentAccessClass, 'UNASSESSED');
    assert.deepEqual(audit, {
      organisationId: 'org-1', documentId: 'doc-1', actorUserId: 'user-1',
      previous: 'RESTRICTED', next: 'MEMBER_VISIBLE', reason: 'Reviewed the file and approved Member access.',
    });
    assert.deepEqual(controlAudits, [{ organisationId: 'org-1', documentId: 'doc-1', actorUserId: 'user-1',
      kind: 'CONTENT_ACCESS', previous: 'UNASSESSED', next: 'MEMBER_SUITABLE',
      reason: 'Reviewed full file and metadata for all Members.' }]);
  } finally {
    StorageService.prototype.downloadFile = originalDownloadFile;
    await app.close();
  }
});

test('Member-suitable assessment waits for verified written storage custody', async () => {
  let writes = 0;
  const app = await buildDocumentsApp(patchPrisma({
    existing: { id: 'doc-1', updatedAt: new Date('2026-06-08T00:00:00.000Z'),
      visibility: 'RESTRICTED', contentAccessClass: 'UNASSESSED', lifecycleStatus: 'CURRENT',
      externalPublicationApproved: false, storageProvider: null },
    onUpdate: () => { writes++; },
  }) as never);
  try {
    const response = await app.inject({ method: 'PATCH', url: '/doc-1', headers: { authorization: authHeader },
      payload: { contentAccessClass: 'MEMBER_SUITABLE',
        contentAccessReason: 'Reviewed full file and metadata for all Members.' } });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'DOCUMENT_STORAGE_PROVIDER_UNVERIFIED');
    assert.equal(writes, 0);
  } finally { await app.close(); }
});

test('legacy Member approval without a byte fingerprint requires a fresh reasoned file review', async () => {
  const originalDownloadFile = StorageService.prototype.downloadFile;
  StorageService.prototype.downloadFile = async () => Buffer.from('reviewed');
  const writes: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const controls: Record<string, unknown>[] = [];
  const app = await buildDocumentsApp(patchPrisma({
    reviewReceipt: true,
    existing: { id: 'doc-1', updatedAt: new Date('2026-06-08T00:00:00.000Z'),
      visibility: 'MEMBER_VISIBLE', contentAccessClass: 'MEMBER_SUITABLE',
      memberReviewedSha256: null, lifecycleStatus: 'CURRENT', externalPublicationApproved: false },
    onUpdate: (args) => { writes.push(args); },
    onControlAudit: ({ data }) => { controls.push(data); },
  }) as never);
  try {
    const response = await app.inject({ method: 'PATCH', url: '/doc-1', headers: { authorization: authHeader },
      payload: { contentAccessClass: 'MEMBER_SUITABLE',
        contentAccessReason: 'Reviewed the full current file again for all Members.',
        expectedUpdatedAt: '2026-06-08T00:00:00.000Z' } });
    assert.equal(response.statusCode, 200);
    assert.equal(writes[0]?.where.memberReviewedSha256, null);
    assert.equal(writes[0]?.data.memberReviewedSha256,
      createHash('sha256').update('reviewed').digest('hex'));
    assert.equal(controls.length, 1);
    assert.equal(controls[0]?.kind, 'CONTENT_ACCESS');
  } finally {
    StorageService.prototype.downloadFile = originalDownloadFile;
    await app.close();
  }
});

test('Member-suitable assessment refuses approval without this actor\'s matching download receipt', async () => {
  const originalDownloadFile = StorageService.prototype.downloadFile;
  StorageService.prototype.downloadFile = async () => Buffer.from('reviewed');
  let writes = 0;
  const app = await buildDocumentsApp(patchPrisma({ onUpdate: () => { writes += 1; } }) as never);
  try {
    const response = await app.inject({ method: 'PATCH', url: '/doc-1', headers: { authorization: authHeader },
      payload: { contentAccessClass: 'MEMBER_SUITABLE',
        contentAccessReason: 'Reviewed the full file and metadata for all Members.',
        expectedUpdatedAt: '2026-06-08T00:00:00.000Z' } });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'DOCUMENT_REVIEW_DOWNLOAD_REQUIRED');
    assert.equal(writes, 0);
  } finally {
    StorageService.prototype.downloadFile = originalDownloadFile;
    await app.close();
  }
});

test('an unreviewed legacy file cannot be released to Members before lifecycle classification', async () => {
  let writes = 0;
  let visibilityAudits = 0;
  const app = await buildDocumentsApp(patchPrisma({
    existing: { id: 'doc-1', updatedAt: new Date('2026-06-08T00:00:00.000Z'),
      visibility: 'RESTRICTED', lifecycleStatus: 'UNREVIEWED', externalPublicationApproved: false },
    onUpdate: () => { writes += 1; },
    onVisibilityAudit: () => { visibilityAudits += 1; },
  }) as never);
  try {
    const response = await app.inject({ method: 'PATCH', url: '/doc-1', headers: { authorization: authHeader },
      payload: { visibility: 'MEMBER_VISIBLE', visibilityReason: 'Reviewed access to this legacy document.' } });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'DOCUMENT_LIFECYCLE_UNREVIEWED');
    assert.equal(writes, 0);
    assert.equal(visibilityAudits, 0);
  } finally { await app.close(); }
});

test('sensitive content assessment stays restricted and cannot be downgraded while Members can read', async () => {
  let writes = 0;
  const audits: Record<string, unknown>[] = [];
  const app = await buildDocumentsApp(patchPrisma({
    existing: { id: 'doc-1', updatedAt: new Date('2026-06-08T00:00:00.000Z'),
      visibility: 'MEMBER_VISIBLE', contentAccessClass: 'MEMBER_SUITABLE', lifecycleStatus: 'CURRENT', externalPublicationApproved: false },
    onUpdate: () => { writes += 1; },
    onControlAudit: ({ data }) => { audits.push(data); },
  }) as never);
  try {
    const unsafe = await app.inject({ method: 'PATCH', url: '/doc-1', headers: { authorization: authHeader },
      payload: { contentAccessClass: 'RESTRICTED_SENSITIVE', contentAccessReason: 'The full file contains restricted trustee particulars.' } });
    assert.equal(unsafe.statusCode, 409);
    assert.equal(unsafe.json().code, 'DOCUMENT_CONTENT_ACCESS_NOT_MEMBER_SUITABLE');
    assert.equal(writes, 0);
    assert.equal(audits.length, 0);

    const restricted = await app.inject({ method: 'PATCH', url: '/doc-1', headers: { authorization: authHeader },
      payload: { visibility: 'RESTRICTED', visibilityReason: 'Withdraw Member access after reviewing sensitive trustee particulars.',
        contentAccessClass: 'RESTRICTED_SENSITIVE', contentAccessReason: 'The full file contains restricted trustee particulars.' } });
    assert.equal(restricted.statusCode, 200);
    assert.equal(writes, 1);
    assert.equal(audits[0]?.kind, 'CONTENT_ACCESS');
    assert.equal(audits[0]?.next, 'RESTRICTED_SENSITIVE');
  } finally { await app.close(); }
});

test('a working draft cannot be released to Members before lifecycle review', async () => {
  let writes = 0;
  let visibilityAudits = 0;
  const app = await buildDocumentsApp(patchPrisma({
    existing: { id: 'doc-1', updatedAt: new Date('2026-06-08T00:00:00.000Z'),
      visibility: 'RESTRICTED', lifecycleStatus: 'DRAFT', externalPublicationApproved: false },
    onUpdate: () => { writes += 1; },
    onVisibilityAudit: () => { visibilityAudits += 1; },
  }) as never);
  try {
    const response = await app.inject({ method: 'PATCH', url: '/doc-1', headers: { authorization: authHeader },
      payload: { visibility: 'MEMBER_VISIBLE', visibilityReason: 'Reviewed access to this working draft.' } });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'DOCUMENT_LIFECYCLE_DRAFT');
    assert.equal(writes, 0);
    assert.equal(visibilityAudits, 0);
  } finally { await app.close(); }
});

test('a concurrent visibility change returns a conflict and writes no decision audit', async () => {
  const originalDownloadFile = StorageService.prototype.downloadFile;
  StorageService.prototype.downloadFile = async () => Buffer.from('reviewed');
  let audited = false;
  const app = await buildDocumentsApp(patchPrisma({
    reviewReceipt: true,
    onUpdate: () => { throw Object.assign(new Error('row changed'), { code: 'P2025' }); },
    onVisibilityAudit: () => { audited = true; },
  }) as never);
  try {
    const response = await app.inject({
      method: 'PATCH', url: '/doc-1', headers: { authorization: authHeader },
      payload: { visibility: 'MEMBER_VISIBLE', visibilityReason: 'Reviewed the file and approved Member access.',
        contentAccessClass: 'MEMBER_SUITABLE', contentAccessReason: 'Reviewed full file and metadata for all Members.' },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'DOCUMENT_UPDATE_CONFLICT');
    assert.equal(audited, false);
  } finally {
    StorageService.prototype.downloadFile = originalDownloadFile;
    await app.close();
  }
});

test('document lifecycle and external publication are separately reviewed and audited', async () => {
  const audits: Record<string, unknown>[] = [];
  let written: Record<string, unknown> = {};
  const prisma = patchPrisma({
    existing: { id: 'doc-1', updatedAt: new Date('2026-06-08T00:00:00.000Z'), visibility: 'RESTRICTED', lifecycleStatus: 'DRAFT', externalPublicationApproved: false },
    onUpdate: (args) => { written = args.data; },
    onControlAudit: (args) => { audits.push(args.data); },
  });
  const app = await buildDocumentsApp({
    ...prisma,
    organisationIntegration: { findUnique: async () => ({
      status: 'CONNECTED', config: { siteId: 'site-abc' },
      publishSpaceId: 'space-1', publishSpaceKey: 'SPACE1', publishSpaceName: 'Governance', publishSpaceSiteId: 'site-abc',
    }) },
    documentPublication: { findFirst: async () => null, create: async () => ({ id: 'publication-1' }) },
  } as never);
  try {
    const headers = { authorization: authHeader };
    const premature = await app.inject({ method: 'PATCH', url: '/doc-1', headers, payload: {
      externalPublicationApproved: true, publicationApprovalReason: 'Reviewed the selected publication audience.',
      reviewedPublicationSiteId: 'site-abc', reviewedPublicationSpaceId: 'space-1',
    } });
    assert.equal(premature.statusCode, 409);
    assert.equal(premature.json().code, 'DOCUMENT_NOT_CURRENT');
    assert.equal(audits.length, 0);

    const response = await app.inject({ method: 'PATCH', url: '/doc-1', headers, payload: {
      lifecycleStatus: 'CURRENT', lifecycleReason: 'Board approved this document for current use.',
      externalPublicationApproved: true, publicationApprovalReason: 'Reviewed the Confluence destination and audience.',
      reviewedPublicationSiteId: 'site-abc', reviewedPublicationSpaceId: 'space-1',
    } });
    assert.equal(response.statusCode, 200);
    assert.equal(written.lifecycleStatus, 'CURRENT');
    assert.equal(written.externalPublicationApproved, true);
    assert.equal(written.externalPublicationSiteId, 'site-abc');
    assert.equal(written.externalPublicationSpaceId, 'space-1');
    assert.deepEqual(audits.map((entry) => [entry.kind, entry.previous, entry.next]), [
      ['LIFECYCLE', 'DRAFT', 'CURRENT'], ['PUBLICATION', 'false', 'true'],
      ['PUBLICATION_TARGET', '{"siteId":null,"spaceId":null}', '{"siteId":"site-abc","spaceId":"space-1"}'],
    ]);
  } finally {
    await app.close();
  }
});

test('a changed Confluence space needs a reasoned destination reapproval even while the old boolean is true', async () => {
  const audits: Record<string, unknown>[] = [];
  let written: Record<string, unknown> = {};
  let writes = 0;
  let recordedPageId: string | null = null;
  const app = await buildDocumentsApp({
    ...patchPrisma({
      existing: { id: 'doc-1', updatedAt: new Date('2026-06-08T00:00:00.000Z'),
        visibility: 'RESTRICTED', lifecycleStatus: 'CURRENT', externalPublicationApproved: true,
        externalPublicationSiteId: 'site-1', externalPublicationSpaceId: 'space-1' },
      onUpdate: ({ data }) => { written = data; writes += 1; },
      onControlAudit: ({ data }) => { audits.push(data); },
    }),
    organisationIntegration: { findUnique: async () => ({ status: 'CONNECTED', config: { siteId: 'site-1' },
      publishSpaceId: 'space-2', publishSpaceKey: 'NEW', publishSpaceName: 'New audience',
      publishSpaceSiteId: 'site-1' }) },
    documentPublication: { findFirst: async () => ({ id: 'publication-1', state: 'PENDING',
      cloudId: 'site-1', spaceId: 'space-1', pageId: recordedPageId }) },
  } as never);
  try {
    const missingReview = await app.inject({ method: 'PATCH', url: '/doc-1', headers: { authorization: authHeader },
      payload: { externalPublicationApproved: true,
        publicationApprovalReason: 'Reviewed the new Confluence space audience and approved it.' } });
    assert.equal(missingReview.statusCode, 400);
    assert.equal(writes, 0);

    const staleReview = await app.inject({ method: 'PATCH', url: '/doc-1', headers: { authorization: authHeader },
      payload: { externalPublicationApproved: true,
        publicationApprovalReason: 'Reviewed the former Confluence space audience and approved it.',
        reviewedPublicationSiteId: 'site-1', reviewedPublicationSpaceId: 'space-1' } });
    assert.equal(staleReview.statusCode, 409);
    assert.equal(staleReview.json().code, 'DOCUMENT_PUBLICATION_TARGET_CHANGED');
    assert.equal(writes, 0);
    assert.equal(audits.length, 0);

    const wrongSite = await app.inject({ method: 'PATCH', url: '/doc-1', headers: { authorization: authHeader },
      payload: { externalPublicationApproved: true,
        publicationApprovalReason: 'Reviewed a different Confluence site for this document.',
        reviewedPublicationSiteId: 'site-2', reviewedPublicationSpaceId: 'space-2' } });
    assert.equal(wrongSite.statusCode, 409);
    assert.equal(wrongSite.json().code, 'DOCUMENT_PUBLICATION_TARGET_CHANGED');
    assert.equal(writes, 0);

    const response = await app.inject({ method: 'PATCH', url: '/doc-1', headers: { authorization: authHeader },
      payload: { externalPublicationApproved: true,
        publicationApprovalReason: 'Reviewed the new Confluence space audience and approved it.',
        reviewedPublicationSiteId: 'site-1', reviewedPublicationSpaceId: 'space-2' } });
    assert.equal(response.statusCode, 200);
    assert.equal(written.externalPublicationSiteId, 'site-1');
    assert.equal(written.externalPublicationSpaceId, 'space-2');
    assert.deepEqual(audits.map(({ kind }) => kind), ['PUBLICATION_TARGET']);
    assert.deepEqual(JSON.parse(String(audits[0].previous)), { siteId: 'site-1', spaceId: 'space-1' });
    assert.deepEqual(JSON.parse(String(audits[0].next)), { siteId: 'site-1', spaceId: 'space-2' });

    recordedPageId = 'page-1';
    const blocked = await app.inject({ method: 'PATCH', url: '/doc-1', headers: { authorization: authHeader },
      payload: { externalPublicationApproved: true,
        publicationApprovalReason: 'Reviewed the new Confluence space audience and approved it.',
        reviewedPublicationSiteId: 'site-1', reviewedPublicationSpaceId: 'space-2' } });
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().code, 'DOCUMENT_PUBLICATION_DESTINATION_CHANGED');
    assert.equal(writes, 1);
    assert.equal(audits.length, 1);
  } finally { await app.close(); }
});

test('superseding requires a current same-charity, same-category replacement and audits the link', async () => {
  const audits: Record<string, unknown>[] = [];
  const reads: Record<string, unknown>[] = [];
  let written: Record<string, unknown> = {};
  const source = { id: 'doc-1', updatedAt: new Date('2026-06-08T00:00:00.000Z'),
    category: 'POLICY', visibility: 'RESTRICTED', lifecycleStatus: 'CURRENT',
    supersededByDocumentId: null, externalPublicationApproved: false };
  const base = patchPrisma({ existing: source, onUpdate: ({ data }) => { written = data; },
    onControlAudit: ({ data }) => { audits.push(data); } });
  let candidate: Record<string, unknown> | null = { id: 'doc-2', category: 'POLICY', lifecycleStatus: 'CURRENT' };
  const app = await buildDocumentsApp({ ...base, document: { ...base.document,
    findFirst: async (args: { where: Record<string, unknown> }) => {
      reads.push(args.where);
      return args.where.id === 'doc-1' ? source : candidate;
    },
  } } as never);
  const payload = { lifecycleStatus: 'SUPERSEDED', replacementDocumentId: 'doc-2',
    lifecycleReason: 'Replaced by the reviewed current policy.' };
  try {
    const missing = await app.inject({ method: 'PATCH', url: '/doc-1', headers: { authorization: authHeader },
      payload: { lifecycleStatus: 'SUPERSEDED', lifecycleReason: payload.lifecycleReason } });
    assert.equal(missing.statusCode, 400);
    const self = await app.inject({ method: 'PATCH', url: '/doc-1', headers: { authorization: authHeader },
      payload: { ...payload, replacementDocumentId: 'doc-1' } });
    assert.equal(self.statusCode, 400);
    for (const invalid of [null, { id: 'doc-2', category: 'POLICY', lifecycleStatus: 'DRAFT' },
      { id: 'doc-2', category: 'OTHER', lifecycleStatus: 'CURRENT' }]) {
      candidate = invalid;
      const result = await app.inject({ method: 'PATCH', url: '/doc-1', headers: { authorization: authHeader }, payload });
      assert.equal(result.statusCode, 409);
      assert.equal(result.json().code, 'DOCUMENT_REPLACEMENT_INVALID');
    }
    assert.equal(audits.length, 0);
    assert.deepEqual(written, {});
    assert.deepEqual(reads.filter((where) => where.id === 'doc-2'), Array(3).fill(null).map(() => ({ id: 'doc-2', organisationId: 'org-1' })));

    candidate = { id: 'doc-2', category: 'POLICY', lifecycleStatus: 'CURRENT' };
    const good = await app.inject({ method: 'PATCH', url: '/doc-1', headers: { authorization: authHeader }, payload });
    assert.equal(good.statusCode, 200);
    assert.equal(written.supersededByDocumentId, 'doc-2');
    assert.equal(good.json().data.supersededByDocumentId, 'doc-2');
    assert.deepEqual(audits.map((event) => [event.kind, event.previous, event.next]), [
      ['LIFECYCLE', 'CURRENT', 'SUPERSEDED'], ['REPLACEMENT', '', 'doc-2'],
    ]);
  } finally { await app.close(); }
});

test('moving a superseded document to historical keeps its replacement lineage', async () => {
  const audits: Record<string, unknown>[] = [];
  let written: Record<string, unknown> = {};
  const app = await buildDocumentsApp(patchPrisma({
    existing: { id: 'doc-1', updatedAt: new Date('2026-06-08T00:00:00.000Z'), category: 'POLICY',
      visibility: 'RESTRICTED', lifecycleStatus: 'SUPERSEDED', supersededByDocumentId: 'doc-2', externalPublicationApproved: false },
    onUpdate: ({ data }) => { written = data; }, onControlAudit: ({ data }) => { audits.push(data); },
  }) as never);
  try {
    const response = await app.inject({ method: 'PATCH', url: '/doc-1', headers: { authorization: authHeader },
      payload: { lifecycleStatus: 'HISTORICAL', lifecycleReason: 'Retaining the superseded policy as historical evidence.' } });
    assert.equal(response.statusCode, 200);
    assert.equal(written.supersededByDocumentId, 'doc-2');
    assert.deepEqual(audits.map((event) => event.kind), ['LIFECYCLE']);
  } finally { await app.close(); }
});

test('explicit approval queues one Confluence publication only after a current classification', async () => {
  const queued: unknown[] = [];
  const prisma = patchPrisma({
    existing: { id: 'doc-1', updatedAt: new Date('2026-06-08T00:00:00.000Z'), visibility: 'RESTRICTED', lifecycleStatus: 'DRAFT', externalPublicationApproved: false },
  });
  const app = await buildDocumentsApp({
    ...prisma,
    organisationIntegration: { findUnique: async () => ({
      status: 'CONNECTED', config: { siteId: 'site-abc' },
      publishSpaceId: 'space-1', publishSpaceKey: 'SPACE1', publishSpaceName: 'Governance', publishSpaceSiteId: 'site-abc',
    }) },
    documentPublication: {
      findFirst: async () => null,
      updateMany: async () => ({ count: 0 }),
      create: async (args: unknown) => { queued.push(args); return { id: 'publication-1' }; },
    },
  } as never);
  try {
    const response = await app.inject({ method: 'PATCH', url: '/doc-1', headers: { authorization: authHeader }, payload: {
      lifecycleStatus: 'CURRENT', lifecycleReason: 'Reviewed and classified as the current file.',
      externalPublicationApproved: true, publicationApprovalReason: 'Reviewed the Confluence space audience.',
      reviewedPublicationSiteId: 'site-abc', reviewedPublicationSpaceId: 'space-1',
    } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(queued, [{ data: { organisationId: 'org-1', documentId: 'doc-1', provider: 'confluence' } }]);
  } finally {
    await app.close();
  }
});

test('a Confluence queue failure refuses publication approval', async () => {
  const prisma = patchPrisma({
    existing: { id: 'doc-1', updatedAt: new Date('2026-06-08T00:00:00.000Z'), visibility: 'RESTRICTED', lifecycleStatus: 'DRAFT', externalPublicationApproved: false },
  });
  const app = await buildDocumentsApp({
    ...prisma,
    organisationIntegration: { findUnique: async () => ({
      status: 'CONNECTED', config: { siteId: 'site-abc' },
      publishSpaceId: 'space-1', publishSpaceKey: 'SPACE1', publishSpaceName: 'Governance', publishSpaceSiteId: 'site-abc',
    }) },
    documentPublication: {
      findFirst: async () => null,
      updateMany: async () => ({ count: 0 }),
      create: async () => { throw new Error('publication insert failed'); },
    },
  } as never);
  try {
    const response = await app.inject({ method: 'PATCH', url: '/doc-1', headers: { authorization: authHeader }, payload: {
      lifecycleStatus: 'CURRENT', lifecycleReason: 'Reviewed and classified as the current file.',
      externalPublicationApproved: true, publicationApprovalReason: 'Reviewed the Confluence space audience.',
      reviewedPublicationSiteId: 'site-abc', reviewedPublicationSpaceId: 'space-1',
    } });
    assert.equal(response.statusCode, 500);
    assert.equal(response.json().code, 'INTERNAL_ERROR');
  } finally {
    await app.close();
  }
});

test('a current document cannot return to draft', async () => {
  let updated = false;
  const app = await buildDocumentsApp(patchPrisma({ onUpdate: () => { updated = true; } }) as never);
  try {
    const response = await app.inject({ method: 'PATCH', url: '/doc-1', headers: { authorization: authHeader }, payload: {
      lifecycleStatus: 'DRAFT', lifecycleReason: 'Attempt to reverse a current record.',
    } });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'DOCUMENT_LIFECYCLE_TRANSITION_INVALID');
    assert.equal(updated, false);
  } finally {
    await app.close();
  }
});

test('a document edit carrying a stale updatedAt is refused and never reaches the update', async () => {
  let updateCalled = false;
  const app = await buildDocumentsApp(patchPrisma({ onUpdate: () => { updateCalled = true; } }) as never);

  const response = await app.inject({
    method: 'PATCH',
    url: '/doc-1',
    headers: { authorization: authHeader },
    payload: { name: 'Renamed', expectedUpdatedAt: '2026-06-07T00:00:00.000Z' },
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, 'DOCUMENT_UPDATE_CONFLICT');
  assert.equal(updateCalled, false, 'a refused edit must not be written');
  await app.close();
});

test('a document edit naming no field to change is refused rather than silently doing nothing', async () => {
  const app = await buildDocumentsApp(patchPrisma() as never);

  const response = await app.inject({
    method: 'PATCH',
    url: '/doc-1',
    headers: { authorization: authHeader },
    payload: { expectedUpdatedAt: '2026-06-08T00:00:00.000Z' },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, 'VALIDATION_ERROR');
  await app.close();
});

test('a document edit naming only the stored file is refused, because the file is not editable here', async () => {
  const app = await buildDocumentsApp(patchPrisma() as never);

  const response = await app.inject({
    method: 'PATCH',
    url: '/doc-1',
    headers: { authorization: authHeader },
    payload: {
      expectedUpdatedAt: '2026-06-08T00:00:00.000Z',
      fileUrl: 'org-1/somewhere-else.pdf',
      version: 9,
      approvalAsserted: true,
    },
  });

  assert.equal(response.statusCode, 400, 'an edit that would change nothing it is allowed to change is not a success');
  assert.equal(response.json().code, 'VALIDATION_ERROR');
  await app.close();
});

test('an explicit null clears a review date, and an absent field is left alone', async () => {
  let written: Record<string, unknown> = {};
  const app = await buildDocumentsApp(
    patchPrisma({ onUpdate: (args) => { written = args.data; } }) as never,
  );

  const response = await app.inject({
    method: 'PATCH',
    url: '/doc-1',
    headers: { authorization: authHeader },
    payload: { expectedUpdatedAt: '2026-06-08T00:00:00.000Z', nextReviewDate: null },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(written.nextReviewDate, null, 'null must clear the column');
  assert.equal(written.approvedDate, undefined, 'an absent field must not be written');
  assert.equal(written.name, undefined);
  await app.close();
});

test('a member cannot change a document', async () => {
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    authSession: { findFirst: async () => ({ id: 'session-1' }) },
    user: { findUnique: async () => ({ id: 'user-1', organisationId: 'org-1', role: 'MEMBER' as const, emailVerified: true }) },
    subscription: subscription(),
    document: {
      update: async () => {
        throw new Error('a member must never reach the update');
      },
    },
  } as never);
  await app.register(multipart, { limits: DOCUMENT_UPLOAD_MULTIPART_LIMITS });
  await app.register(documentRoutes);

  const memberHeader = `Bearer ${signAccessToken({
    userId: 'user-1',
    organisationId: 'org-1',
    role: 'MEMBER',
    sessionId: 'session-1',
  })}`;

  const response = await app.inject({
    method: 'PATCH',
    url: '/doc-1',
    headers: { authorization: memberHeader },
    payload: { name: 'Renamed', expectedUpdatedAt: '2026-06-08T00:00:00.000Z' },
  });

  assert.equal(response.statusCode, 403);
  await app.close();
});
