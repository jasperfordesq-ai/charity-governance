import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { observeRetainedConfluenceCopySource } from '../services/confluence-retained-copy-source.js';
import { providerFixture } from './fixtures/confluence-retained-copy-provider.js';

const NOW = new Date('2026-10-15T18:00:00.000Z');
const CLOUD = '00000000-0000-4000-8000-000000000001';
const PRIMARY = Buffer.from('synthetic retained primary');
function fixture() {
  const state = {
    active: true, owner: true,
    document: { id: 'doc-a', organisationId: 'org-a', lifecycleStatus: 'RETIRED', deletionHold: false,
      deletedAt: null, externalPublicationApproved: false, fileUrl: 'org-a/source.txt', fileSize: PRIMARY.length,
      storageProvider: 'local', updatedAt: new Date('2026-10-15T17:00:00.000Z') },
    publication: { id: 'pub-a', organisationId: 'org-a', documentId: 'doc-a', provider: 'confluence',
      state: 'RETIRED', cloudId: CLOUD, spaceId: 'space-a', pageId: 'page-a', attachmentId: 'att-a',
      erasureDeletionId: null, claimedAt: null, updatedAt: new Date('2026-10-15T17:01:00.000Z') },
    connection: { id: 'integration-a', status: 'CONNECTED', connectedAt: new Date('2026-10-15T16:00:00.000Z'),
      config: { siteId: CLOUD, siteUrl: 'https://synthetic-example.atlassian.net' },
      grantedScopes: ['read:page:confluence', 'read:attachment:confluence'] },
  };
  const calls = { downloads: [] as unknown[][], collections: [] as unknown[], tokens: 0 };
  const prisma = {
    organisation: { findFirst: async ({ where }: { where: { id: string } }) =>
      state.active && where.id === 'org-a' ? { id: 'org-a' } : null },
    user: { findFirst: async ({ where }: { where: { id: string; organisationId: string } }) =>
      state.owner && where.id === 'owner-a' && where.organisationId === 'org-a' ? { id: 'owner-a' } : null },
    document: { findFirst: async ({ where }: { where: { id: string; organisationId: string } }) =>
      where.id === state.document.id && where.organisationId === state.document.organisationId ? structuredClone(state.document) : null },
    documentPublication: { findFirst: async ({ where }: { where: { id: string; organisationId: string } }) =>
      where.id === state.publication.id && where.organisationId === state.publication.organisationId ? structuredClone(state.publication) : null },
    organisationIntegration: { findUnique: async () => structuredClone(state.connection) },
    $queryRaw: async () => [{ now: NOW }],
  };
  const input = { organisationId: 'org-a', actorUserId: 'owner-a', publicationId: 'pub-a' };
  const observation = {
    cloudId: CLOUD, siteHostname: 'synthetic-example.atlassian.net', pageId: 'page-a', spaceId: 'space-a',
    inventory: { observedAt: NOW.toISOString(), status: 'CURRENT' as const, complete: true as const,
      currentPageVersion: 1, pageVersions: [1], attachments: [{ id: 'att-a', currentVersion: 1,
        versions: [{ number: 1, sizeBytes: 6, sha256: 'b'.repeat(64) }] }] },
    downloadedBytes: 12, actionAuthorized: false as const, allCopiesVerified: false as const, sourceVerified: false as const,
  };
  const deps = {
    downloadFile: async (...args: unknown[]) => { calls.downloads.push(args); return Buffer.from(PRIMARY); },
    getAccessToken: async () => { calls.tokens++; return 'synthetic-token'; },
    collectInventory: async (target: unknown) => { calls.collections.push(target); return structuredClone(observation); },
  };
  const run = (overrides: Partial<typeof deps> = {}, values = input) =>
    observeRetainedConfluenceCopySource(prisma as never, values, { ...deps, ...overrides });
  return { state, calls, prisma, input, observation, deps, run };
}

test('target and primary hash come from scoped stored identities and pinned provider reads', async () => {
  const h = fixture(); const result = await h.run();
  assert.equal(result.snapshot.sourceSha256, createHash('sha256').update(PRIMARY).digest('hex'));
  assert.equal(result.snapshot.organisationId, 'org-a');
  assert.equal(result.snapshot.pageId, 'page-a');
  assert.equal(result.snapshot.siteOrigin, 'https://synthetic-example.atlassian.net');
  assert.equal(result.sourceBytesObserved, true);
  assert.equal(result.actionAuthorized, false);
  assert.equal(result.syntheticVerified, false);
  assert.equal(result.allCopiesVerified, false);
  assert.equal(h.calls.downloads.length, 2);
  assert.deepEqual(h.calls.downloads[0], ['org-a', 'org-a/source.txt', 'local']);
  assert.deepEqual(h.calls.downloads[1], h.calls.downloads[0]);
  assert.equal(h.calls.collections.length, 1);
});

for (const [label, mutate] of Object.entries({
  nonOwner: (h: ReturnType<typeof fixture>) => { h.state.owner = false; },
  inactiveCharity: (h: ReturnType<typeof fixture>) => { h.state.active = false; },
  heldSource: (h: ReturnType<typeof fixture>) => { h.state.document.deletionHold = true; },
  activeSource: (h: ReturnType<typeof fixture>) => { h.state.document.lifecycleStatus = 'CURRENT'; },
  publicationApproved: (h: ReturnType<typeof fixture>) => { h.state.document.externalPublicationApproved = true; },
  missingProvider: (h: ReturnType<typeof fixture>) => { h.state.document.storageProvider = ''; },
  unsupportedProvider: (h: ReturnType<typeof fixture>) => { h.state.document.storageProvider = 'confluence'; },
  disconnected: (h: ReturnType<typeof fixture>) => { h.state.connection.status = 'DISCONNECTED'; },
  differentCloud: (h: ReturnType<typeof fixture>) => { h.state.connection.config.siteId = '00000000-0000-4000-8000-000000000002'; },
  credentialOrigin: (h: ReturnType<typeof fixture>) => { h.state.connection.config.siteUrl = 'https://user:pass@synthetic-example.atlassian.net'; },
  pathOrigin: (h: ReturnType<typeof fixture>) => { h.state.connection.config.siteUrl += '/wiki'; },
  missingScope: (h: ReturnType<typeof fixture>) => { h.state.connection.grantedScopes = ['read:page:confluence']; },
  pendingErasure: (h: ReturnType<typeof fixture>) => { Object.assign(h.state.publication, { erasureDeletionId: 'deletion-a' }); },
})) {
  test(`source wrapper refuses ${label} before primary or provider I/O`, async () => {
    const h = fixture(); mutate(h);
    await assert.rejects(h.run());
    assert.equal(h.calls.downloads.length + h.calls.collections.length + h.calls.tokens, 0);
  });
}
test('cross-charity publication identifier cannot select a source or target', async () => {
  const h = fixture(); h.state.publication.organisationId = 'org-b';
  await assert.rejects(h.run());
  assert.equal(h.calls.downloads.length + h.calls.collections.length, 0);
});
test('caller cannot override target, provider or hash with extra input fields', async () => {
  const h = fixture();
  await assert.rejects(h.run({}, { ...h.input, ...{ cloudId: CLOUD, sourceSha256: 'c'.repeat(64) } }));
  assert.equal(h.calls.downloads.length + h.calls.collections.length, 0);
});
test('a byte-size mismatch refuses before calling Confluence', async () => {
  const h = fixture();
  await assert.rejects(h.run({ downloadFile: async () => Buffer.from('different size') }));
  assert.equal(h.calls.collections.length, 0);
});
test('primary bytes changing without a metadata revision invalidate the result', async () => {
  const h = fixture(); let reads = 0;
  await assert.rejects(h.run({ downloadFile: async () => ++reads === 1 ? Buffer.from(PRIMARY) : Buffer.alloc(PRIMARY.length, 1) }));
});
for (const label of ['owner', 'source', 'connection', 'sameSiteReconnection', 'publication']) {
  test(`wrapper refuses ${label} changes during provider collection`, async () => {
    const h = fixture();
    await assert.rejects(h.run({ collectInventory: async () => {
      if (label === 'owner') h.state.owner = false;
      if (label === 'source') h.state.document.updatedAt = NOW;
      if (label === 'connection') h.state.connection.config.siteUrl = 'https://other-example.atlassian.net';
      if (label === 'sameSiteReconnection') h.state.connection.connectedAt = NOW;
      if (label === 'publication') h.state.publication.updatedAt = NOW;
      return h.observation;
    } }));
  });
}
test('a recorded attachment missing from the visible page inventory is unresolved', async () => {
  const h = fixture(); h.observation.inventory.attachments = [];
  await assert.rejects(h.run());
});
test('reconnection while obtaining a token refuses its use', async () => {
  const h = fixture(); let acquired = 0;
  await assert.rejects(observeRetainedConfluenceCopySource(h.prisma as never, h.input, { ...h.deps,
    getAccessToken: async () => { acquired++; h.state.connection.connectedAt = NOW; return 'synthetic-token'; },
    collectInventory: async (_target, deps) => { await deps.getAccessToken(); return h.observation; },
  }));
  assert.equal(acquired, 1);
});
test('ordinary refresh metadata changes do not impersonate a new grant', async () => {
  const h = fixture();
  const result = await observeRetainedConfluenceCopySource(h.prisma as never, h.input, { ...h.deps,
    getAccessToken: async () => { Object.assign(h.state.connection, { updatedAt: NOW, lastRefreshedAt: NOW }); return 'synthetic-token'; },
    collectInventory: async (_target, deps) => { await deps.getAccessToken(); return h.observation; },
  });
  assert.equal(result.actionAuthorized, false);
});
test('Owner revocation while acquiring the completion timestamp is refused', async () => {
  const h = fixture();
  h.prisma.$queryRaw = async () => { h.state.owner = false; return [{ now: NOW }]; };
  await assert.rejects(h.run());
});
test('default StorageService hashes a real synthetic retained file through its tenant path', async () => {
  const h = fixture();
  const directory = await mkdtemp(join(tmpdir(), 'charitypilot-retained-copy-'));
  const previous = process.env.LOCAL_FILE_STORAGE_DIR;
  try {
    await mkdir(join(directory, 'org-a'));
    await writeFile(join(directory, 'org-a/source.txt'), PRIMARY);
    process.env.LOCAL_FILE_STORAGE_DIR = directory;
    const provider = providerFixture();
    h.state.publication.pageId = 'page-1'; h.state.publication.spaceId = 'space-1';
    // Both production adapters run: real tenant-pinned local primary read and
    // real HTTP inventory/version/redirect/stream hashing against synthetic fetch.
    const result = await observeRetainedConfluenceCopySource(h.prisma as never, h.input,
      { fetch: provider.deps.fetch, getAccessToken: provider.deps.getAccessToken });
    assert.equal(result.snapshot.sourceSha256, createHash('sha256').update(PRIMARY).digest('hex'));
    assert.equal(result.sourceBytesObserved, true);
    assert.equal(result.snapshot.inventory.attachments[0]?.versions[1]?.sha256,
      createHash('sha256').update('newest').digest('hex'));
  } finally {
    if (previous === undefined) delete process.env.LOCAL_FILE_STORAGE_DIR;
    else process.env.LOCAL_FILE_STORAGE_DIR = previous;
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    assert.ok(directory.includes('charitypilot-retained-copy-'));
    await rm(directory, { recursive: true, force: true });
  }
});
