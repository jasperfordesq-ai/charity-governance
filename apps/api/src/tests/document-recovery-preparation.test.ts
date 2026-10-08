import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareDocumentRecoveryFacts } from '../services/document-recovery-preparation.js';
import { DocumentRecoveryPreparationStore } from '../services/document-recovery-preparation-store.js';
import type { PrismaClient } from '@prisma/client';

function fixture() {
  const policy = { id: 'policy', organisationId: 'charity', recordClass: 'VAULT_DRAFT' as const,
    revision: 1, state: 'APPROVED' as const, retentionMode: 'REVIEW_REQUIRED' as const,
    retentionAnchor: null, retentionDays: null, recoveryDays: 30,
    createdById: 'owner', createdAt: '2026-09-01T00:00:00.000Z',
    approvedById: 'owner', approvedAt: '2026-09-02T00:00:00.000Z',
    approvalEvidenceRef: 'POLICY-001' };
  const area = { disposition: 'RETAIN_APPROVED' as const, evidenceRef: 'COPY-001' };
  const document = { id: 'doc', organisationId: 'charity',
    updatedAt: '2026-09-03T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z',
    lifecycleStatus: 'DRAFT' as const, deletedAt: '2026-09-03T00:00:00.000Z',
    deletionHold: false as const, approvalAsserted: false as const,
    approvedByResolutionId: null, deletedById: 'owner',
    removedFromRevision: '2026-09-02T00:00:00.000Z', removalEvidenceRef: 'REMOVAL-001',
    recoveryPolicyId: 'policy',
    recoveryUntil: '2026-10-03T00:00:00.000Z', recoverySha256: 'a'.repeat(64),
    fileUrl: 'vault/synthetic-object', storageProvider: 'local' as const, fileSize: 123 };
  const authorization = { id: 'auth', organisationId: 'charity', documentId: 'doc',
    documentRevision: document.updatedAt, policyId: 'policy', actorUserId: 'owner',
    evidenceRef: 'PURGE-001', reason: 'Synthetic individual disposal review',
    storagePath: document.fileUrl, provider: document.storageProvider,
    sha256: document.recoverySha256, fileSize: document.fileSize,
    recoveryUntil: document.recoveryUntil,
    dispositionPlan: { PRIMARY: { disposition: 'DISPOSE' as const, evidenceRef: 'COPY-001' },
      VERSIONS: area, CONFLUENCE: area, EXPORTS: area, AUDIT: area, BACKUPS: area },
    authorizedAt: '2026-10-04T00:00:00.000Z' };
  return { format: 1 as const, action: 'DOCUMENT_PURGE_PREPARATION' as const,
    installationId: 'synthetic-install', organisationId: 'charity', operationId: 'operation',
    writerEpoch: 1, actorUserId: 'owner', preparedAt: '2026-10-04T00:01:00.000Z',
    sourceRevision: 'b'.repeat(40), document, authorization, policy,
    removalPolicy: { ...policy }, removalPolicyWithdrawal: null };
}

test('document preparation binds exact policy, object and Owner decision without authorizing a claim', () => {
  const source = fixture();
  const first = prepareDocumentRecoveryFacts(source);
  assert.equal(first.actionAuthorized, false);
  assert.deepEqual(JSON.parse(first.body), source);
  assert.deepEqual(prepareDocumentRecoveryFacts(Object.fromEntries(Object.entries(source).reverse())), first);
  source.authorization.storagePath = 'vault/another-object';
  assert.throws(() => prepareDocumentRecoveryFacts(source), /Invalid document recovery preparation/);
});

test('document preparation excludes subject fields and refuses foreign or changed dependencies', () => {
  for (const key of ['', 'document', 'authorization', 'policy']) {
    const source = fixture();
    const target = key ? (source as unknown as Record<string, object>)[key]! : source;
    Object.assign(target, { narrative: 'sensitive-example' });
    assert.throws(() => prepareDocumentRecoveryFacts(source), { message: 'Invalid document recovery preparation' });
  }
  const mutations = [
    (v: ReturnType<typeof fixture>) => { v.document.organisationId = 'foreign'; },
    (v: ReturnType<typeof fixture>) => { v.authorization.policyId = 'other'; },
    (v: ReturnType<typeof fixture>) => { v.document.recoverySha256 = 'c'.repeat(64); },
    (v: ReturnType<typeof fixture>) => { v.document.deletionHold = true as false; },
    (v: ReturnType<typeof fixture>) => { v.document.approvalAsserted = true as false; },
    (v: ReturnType<typeof fixture>) => { v.writerEpoch = 0; },
  ];
  for (const change of mutations) {
    const source = fixture(); change(source);
    assert.throws(() => prepareDocumentRecoveryFacts(source));
  }
});

test('document preparation preserves distinct removal and current policy while refusing conflicting same identity', () => {
  const source = fixture();
  source.policy.id = 'new-policy'; source.policy.revision = 2;
  source.authorization.policyId = 'new-policy';
  assert.equal(JSON.parse(prepareDocumentRecoveryFacts(source).body).removalPolicy.id, 'policy');
  Object.assign(source, { removalPolicyWithdrawal: { id: 'withdrawal', organisationId: 'charity', policyId: 'policy',
    actorUserId: 'owner', reason: 'Synthetic replacement of old policy',
    evidenceRef: 'WITHDRAW-001', occurredAt: '2026-10-01T00:00:00.000Z' } });
  assert.equal(JSON.parse(prepareDocumentRecoveryFacts(source).body).removalPolicyWithdrawal.id, 'withdrawal');
  source.policy.id = 'policy'; source.authorization.policyId = 'policy';
  source.policy.recoveryDays = 31;
  assert.throws(() => prepareDocumentRecoveryFacts(source));
});

test('document preparation preserves legacy facts and validates both calendar policy identities', () => {
  const source = fixture();
  assert.equal('retentionYears' in JSON.parse(prepareDocumentRecoveryFacts(source).body).policy, false);
  for (const policy of [source.policy, source.removalPolicy]) {
    Object.assign(policy, { retentionMode: 'AFTER_CALENDAR_YEARS', retentionAnchor: 'CREATED_AT',
      retentionDays: null, retentionYears: 6 });
  }
  const body = JSON.parse(prepareDocumentRecoveryFacts(source).body);
  assert.equal(body.policy.retentionYears, 6);
  assert.equal(body.removalPolicy.retentionYears, 6);
  for (const change of [
    { retentionYears: null }, { retentionDays: 10 }, { retentionAnchor: null },
    { retentionYears: 0 }, { retentionYears: 101 },
  ]) {
    const invalid = structuredClone(source);
    Object.assign(invalid.policy, change);
    Object.assign(invalid.removalPolicy, change);
    assert.throws(() => prepareDocumentRecoveryFacts(invalid));
  }
});

test('document preparation captures only selected facts and retries the same immutable operation', async () => {
  const source = fixture(); let saved: Record<string, unknown> | null = null;
  let writes = 0, authReads = 0, activeOwner = true;
  const tx = {
    $queryRaw: async () => [{ now: new Date(source.preparedAt) }],
    user: { findFirst: async () => activeOwner ? { id: 'owner' } : null },
    documentRecoveryPreparation: { findUnique: async () => saved,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        writes++; saved = { ...data, id: 'captured' }; return saved;
      } },
    documentPurgeAuthorization: { findFirst: async () => {
      authReads++; return { ...source.authorization, claim: null, withdrawal: null };
    } },
    document: { findFirst: async (args: { select: Record<string, boolean> }) => {
      assert.deepEqual(Object.keys(args.select).sort(), Object.keys(source.document).sort());
      assert.equal(args.select.name, undefined); assert.equal(args.select.description, undefined);
      return source.document;
    }, count: async () => 0 },
    dataRetentionPolicyRevision: { findMany: async () => [source.policy],
      findFirst: async () => source.removalPolicy },
    dataRetentionPolicyWithdrawal: { findFirst: async () => source.removalPolicyWithdrawal },
    documentStandardLink: { count: async () => 0 },
    confluenceReference: { count: async () => 0 },
  };
  const client = { $transaction: async (work: (value: typeof tx) => unknown,
    options: { isolationLevel: string }) => {
    assert.equal(options.isolationLevel, 'ReadCommitted'); return work(tx);
  } } as unknown as PrismaClient;
  const store = new DocumentRecoveryPreparationStore(client);
  const request = { installationId: source.installationId, operationId: source.operationId,
    writerEpoch: source.writerEpoch, sourceRevision: source.sourceRevision,
    authorizationId: source.authorization.id };
  const first = await store.capture('charity', 'owner', request);
  assert.equal(first.actionAuthorized, false); assert.equal(first.replayed, false);
  assert.equal(writes, 1); assert.deepEqual(JSON.parse(String(saved!.facts)), source);
  source.authorization.reason = 'A later changed decision';
  const retry = await store.capture('charity', 'owner', request);
  assert.equal(retry.replayed, true); assert.equal(retry.digest, first.digest);
  assert.equal(authReads, 1); assert.equal(writes, 1);
  await assert.rejects(() => store.capture('charity', 'owner', { ...request, writerEpoch: 2 }), /identity changed/);
  activeOwner = false;
  await assert.rejects(() => store.capture('charity', 'owner', request), /active charity Owner/);
});

test('document capture refuses ambiguous policy and linked evidence before writing', async () => {
  const source = fixture(); let writes = 0, links = 0;
  const tx = { $queryRaw: async () => [{ now: new Date(source.preparedAt) }],
    user: { findFirst: async () => ({ id: 'owner' }) },
    documentRecoveryPreparation: { findUnique: async () => null,
      create: async () => { writes++; } },
    documentPurgeAuthorization: { findFirst: async () => ({ ...source.authorization,
      claim: null, withdrawal: null }) },
    document: { findFirst: async () => source.document, count: async () => 0 },
    dataRetentionPolicyRevision: { findMany: async () => [source.policy, { ...source.policy, id: 'other' }],
      findFirst: async () => source.removalPolicy },
    dataRetentionPolicyWithdrawal: { findFirst: async () => source.removalPolicyWithdrawal },
    documentStandardLink: { count: async () => links },
    confluenceReference: { count: async () => 0 },
  };
  const client = { $transaction: async (work: (value: typeof tx) => unknown) => work(tx) } as unknown as PrismaClient;
  const store = new DocumentRecoveryPreparationStore(client);
  const request = { installationId: source.installationId, operationId: source.operationId,
    writerEpoch: 1, sourceRevision: source.sourceRevision, authorizationId: 'auth' };
  await assert.rejects(() => store.capture('charity', 'owner', request), /policy changed/);
  tx.dataRetentionPolicyRevision.findMany = async () => [source.policy];
  links = 1;
  await assert.rejects(() => store.capture('charity', 'owner', request), /linked evidence review/);
  assert.equal(writes, 0);
});
