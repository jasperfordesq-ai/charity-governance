import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { DocumentRecoveryService } from '../services/document-recovery.service.js';
import { StorageService } from '../services/storage.service.js';

const now = new Date('2026-09-30T12:00:00Z');
const input = { organisationId: 'org-a', documentId: 'doc-a', actorUserId: 'admin-a',
  expectedUpdatedAt: new Date('2026-09-29T12:00:00Z'), reason: 'Duplicate draft retained for recovery.',
  policyId: 'policy-a', evidenceRef: 'REMOVAL-001' };

function fixture() {
  let document: Record<string, any> = { id: 'doc-a', organisationId: 'org-a', name: 'Synthetic draft',
    category: 'OTHER', deletedAt: null, updatedAt: input.expectedUpdatedAt, createdAt: input.expectedUpdatedAt,
    lifecycleStatus: 'DRAFT', deletionHold: false, approvalAsserted: false, approvedByResolutionId: null,
    storageProvider: 'local', fileUrl: 'org-a/draft.txt', fileSize: 4,
    visibility: 'RESTRICTED', contentAccessClass: 'UNASSESSED' };
  let policy: Record<string, any> | null = { id: 'policy-a', retentionMode: 'REVIEW_REQUIRED',
    retentionAnchor: null, retentionDays: null, retentionYears: null, recoveryDays: 30 };
  let actor = true;
  let linked = false;
  let competingPolicy = false;
  let bound = false;
  const audits: any[] = [];
  const locks: string[] = [];
  const tx = {
    documentRecoveryEnforcement: { findUnique: async () => bound ? { id: 'binding' } : null },
    user: { findFirst: async ({ where }: any) => actor && where.organisationId === 'org-a' ? { id: 'admin-a' } : null },
    document: {
      findFirst: async ({ where }: any) => {
        if (where.supersededByDocumentId) return linked ? { id: 'predecessor' } : null;
        if (where.organisationId !== document.organisationId || where.id !== document.id) return null;
        if (where.deletedAt === null && document.deletedAt !== null) return null;
        if (where.deletedAt?.not === null && document.deletedAt === null) return null;
        return { ...document };
      },
      update: async ({ data }: any) => { document = { ...document, ...data }; return { ...document }; },
    },
    documentStandardLink: { findFirst: async () => null },
    confluenceReference: { findFirst: async () => null },
    dataRetentionPolicyRevision: { findFirst: async ({ where }: any) => {
      assert.deepEqual(where.withdrawal, { is: null });
      assert.equal(where.state, 'APPROVED');
      assert.equal(where.recordClass, 'VAULT_DRAFT');
      return where.id?.not ? (competingPolicy ? {id: 'other-policy'} : null) : policy;
    } },
    documentControlAudit: { create: async ({ data }: any) => { audits.push(data); return data; } },
    $queryRaw: async (strings: TemplateStringsArray) => {
      const query = strings.join('?');
      if (query.includes('statement_timestamp')) return [{ now }];
      assert.match(query, /FOR UPDATE/); locks.push(query); return [{ id: 'locked' }];
    },
  };
  const prisma = { ...tx, $transaction: async (callback: (tx: any) => Promise<unknown>) => {
    const saved = { ...document }; const count = audits.length;
    try { return await callback(tx); } catch (error) { document = saved; audits.length = count; throw error; }
  } } as unknown as PrismaClient;
  return { prisma, audits, locks, get doc() { return document; },
    bindRecovery: () => { bound = true; },
    setPolicy: (value: typeof policy) => { policy = value; },
    setCompetingPolicy: () => { competingPolicy = true; },
    disableActor: () => { actor = false; }, link: () => { linked = true; } };
}

test('bound document recovery refuses remove and restore before reading provider bytes', async () => {
  const f = fixture();
  f.bindRecovery();
  let reads = 0;
  const service = new DocumentRecoveryService(f.prisma, async () => { reads++; return Buffer.from('test'); });
  await assert.rejects(service.remove(input),
    (error: any) => error.statusCode === 409 && error.code === 'DOCUMENT_SOURCE_RECOVERY_REQUIRED');
  f.doc.deletedAt = now;
  await assert.rejects(service.restore(input),
    (error: any) => error.statusCode === 409 && error.code === 'DOCUMENT_SOURCE_RECOVERY_REQUIRED');
  assert.equal(reads, 0);
  assert.equal(f.audits.length, 0);
});

test('removal and restore preserve actual local bytes, identity and holds without reviving sharing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'charitypilot-recovery-'));
  const oldRoot = process.env.LOCAL_FILE_STORAGE_DIR;
  process.env.LOCAL_FILE_STORAGE_DIR = root;
  try {
    await mkdir(join(root, 'org-a'));
    await writeFile(join(root, 'org-a/draft.txt'), Buffer.from('test'));
    const storage = new StorageService();
    const f = fixture();
    const service = new DocumentRecoveryService(f.prisma, (org, path, provider) => storage.downloadFile(org, path, provider));
    await service.remove(input);
    assert.equal(f.doc.recoveryUntil.toISOString(), '2026-10-30T12:00:00.000Z');
    assert.match(f.doc.recoverySha256, /^[a-f0-9]{64}$/);
    assert.equal((await readFile(join(root, 'org-a/draft.txt'))).toString(), 'test');
    f.doc.deletionHold = true;
    await service.restore({ ...input, expectedUpdatedAt: now });
    assert.equal(f.doc.id, 'doc-a');
    assert.equal(f.doc.deletedAt, null);
    assert.equal(f.doc.recoverySha256, null);
    assert.equal(f.doc.deletionHold, true);
    assert.equal(f.doc.visibility, 'RESTRICTED');
    assert.equal(f.doc.externalPublicationApproved, false);
    assert.equal((await readFile(join(root, 'org-a/draft.txt'))).toString(), 'test');
    assert.deepEqual(f.audits.map(a => a.kind), ['RECORD_REMOVE', 'RECORD_RESTORE']);
    assert.equal(f.locks.length, 5);
    assert.match(f.locks[0]!, /Organisation/);
    assert.match(f.locks[3]!, /Organisation/);
  } finally {
    if (oldRoot === undefined) delete process.env.LOCAL_FILE_STORAGE_DIR;
    else process.env.LOCAL_FILE_STORAGE_DIR = oldRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test('unapproved or unknown policy, held or linked record, inactive actor and stale revision refuse removal', async () => {
  for (const scenario of ['policy', 'unknown-policy', 'bad-period', 'hold', 'linked', 'actor', 'revision', 'tenant']) {
    const f = fixture();
    if (scenario === 'policy') f.setPolicy(null);
    if (scenario === 'unknown-policy') f.setPolicy({ id: 'policy-a', retentionMode: 'AFTER_CALENDAR_YEARS', recoveryDays: 30 });
    if (scenario === 'bad-period') f.setPolicy({ id: 'policy-a', retentionMode: 'AFTER_ANCHOR', retentionAnchor: 'CREATED_AT', retentionDays: null, recoveryDays: 30 });
    if (scenario === 'hold') f.doc.deletionHold = true;
    if (scenario === 'linked') f.link();
    if (scenario === 'actor') f.disableActor();
    const service = new DocumentRecoveryService(f.prisma, async () => { throw new Error('Unexpected storage read'); });
    await assert.rejects(service.remove({ ...input,
      ...(scenario === 'revision' ? { expectedUpdatedAt: now } : {}),
      ...(scenario === 'tenant' ? { organisationId: 'foreign' } : {}) }),
    (error: any) => error.statusCode === 403 || error.statusCode === 409 || error.statusCode === 404);
    assert.equal(f.doc.deletedAt, null);
    assert.equal(f.audits.length, 0);
  }
});

test('missing, replaced or expired recovery file never restores a record or writes success audit', async () => {
  for (const scenario of ['missing', 'changed', 'expired']) {
    const f = fixture();
    let read = async () => Buffer.from('test');
    const service = new DocumentRecoveryService(f.prisma, () => read());
    await service.remove(input);
    if (scenario === 'missing') read = async () => { throw new Error('File missing'); };
    if (scenario === 'changed') read = async () => Buffer.from('edit');
    if (scenario === 'expired') f.doc.recoveryUntil = now;
    await assert.rejects(service.restore({ ...input, expectedUpdatedAt: now }));
    assert.notEqual(f.doc.deletedAt, null);
    assert.deepEqual(f.audits.map(a => a.kind), ['RECORD_REMOVE']);
  }
});


test('ambiguous active policies refuse removal before reading stored bytes',async()=>{
  const f=fixture();f.setCompetingPolicy();let reads=0;
  const service=new DocumentRecoveryService(f.prisma,async()=>{reads++;return Buffer.from('test');});
  await assert.rejects(service.remove(input),{statusCode:409,code:'DOCUMENT_RECOVERY_POLICY_REQUIRED'});
  assert.equal(reads,0);assert.equal(f.doc.deletedAt,null);assert.equal(f.audits.length,0);
});

test('contradictory retention terms and invalid recovery window refuse removal before byte reads', async () => {
  const base = { id: 'policy-a', retentionMode: 'REVIEW_REQUIRED', retentionAnchor: null,
    retentionDays: null, retentionYears: null, recoveryDays: 30 };
  const policies = [
    { ...base, retentionYears: 6 },
    { ...base, recoveryDays: 0 },
    { ...base, retentionMode: 'AFTER_ANCHOR', retentionAnchor: 'CREATED_AT',
      retentionDays: 1, retentionYears: 6 },
  ];
  for (const policy of policies) {
    const f = fixture(); f.setPolicy(policy);
    let reads = 0;
    const service = new DocumentRecoveryService(f.prisma, async () => { reads += 1; return Buffer.from('test'); });
    await assert.rejects(service.remove(input),
      (error: any) => error.code === 'DOCUMENT_RECOVERY_POLICY_REQUIRED');
    assert.equal(reads, 0);
    assert.equal(f.doc.deletedAt, null);
    assert.equal(f.audits.length, 0);
  }
});

test('calendar document removal uses the UTC anniversary and refuses an early draft', async () => {
  const elapsed = fixture();
  elapsed.setPolicy({ id: 'policy-a', retentionMode: 'AFTER_CALENDAR_YEARS', retentionAnchor: 'CREATED_AT',
    retentionDays: null, retentionYears: 6, recoveryDays: 30 });
  elapsed.doc.createdAt = new Date('2020-02-29T12:00:00Z');
  const service = new DocumentRecoveryService(elapsed.prisma, async () => Buffer.from('test'));
  await service.remove(input);
  assert.notEqual(elapsed.doc.deletedAt, null);
  const early = fixture();
  early.setPolicy({ id: 'policy-a', retentionMode: 'AFTER_CALENDAR_YEARS', retentionAnchor: 'CREATED_AT',
    retentionDays: null, retentionYears: 6, recoveryDays: 30 });
  early.doc.createdAt = new Date('2024-02-29T12:00:00Z');
  await assert.rejects(new DocumentRecoveryService(early.prisma, async () => Buffer.from('test')).remove(input),
    (error: any) => error.code === 'DOCUMENT_RETENTION_NOT_REACHED');
  assert.equal(early.doc.deletedAt, null);
});
