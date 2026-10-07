import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { prepareDocumentRecoveryFacts } from '../services/document-recovery-preparation.js';
import { readCurrentDocumentByteAuthority } from '../services/document-byte-authority-projection.js';

function fixture() {
  const policy = { id: 'policy', organisationId: 'charity', recordClass: 'VAULT_DRAFT' as const,
    revision: 1, state: 'APPROVED' as const, retentionMode: 'REVIEW_REQUIRED' as const,
    retentionAnchor: null, retentionDays: null, recoveryDays: 30,
    createdById: 'owner', createdAt: '2026-09-01T00:00:00.000Z', approvedById: 'owner',
    approvedAt: '2026-09-02T00:00:00.000Z', approvalEvidenceRef: 'POLICY-001' };
  const disposition = { disposition: 'RETAIN_APPROVED' as const, evidenceRef: 'COPY-001' };
  const document = { id: 'doc', organisationId: 'charity',
    updatedAt: '2026-09-03T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z',
    lifecycleStatus: 'DRAFT' as const, deletedAt: '2026-09-03T00:00:00.000Z',
    deletionHold: false as const, approvalAsserted: false as const, approvedByResolutionId: null,
    deletedById: 'owner', removedFromRevision: '2026-09-02T00:00:00.000Z',
    removalEvidenceRef: 'REMOVAL-001', recoveryPolicyId: 'policy',
    recoveryUntil: '2026-10-03T00:00:00.000Z', recoverySha256: 'a'.repeat(64),
    fileUrl: 'vault/synthetic-object', storageProvider: 'local' as const, fileSize: 123 };
  const authorization = { id: 'auth', organisationId: 'charity', documentId: 'doc',
    documentRevision: document.updatedAt, policyId: 'policy', actorUserId: 'owner',
    evidenceRef: 'PURGE-001', reason: 'SYNTHETIC_DISPOSAL_REASON',
    storagePath: document.fileUrl, provider: document.storageProvider,
    sha256: document.recoverySha256, fileSize: document.fileSize,
    recoveryUntil: document.recoveryUntil,
    dispositionPlan: { PRIMARY: { disposition: 'DISPOSE' as const, evidenceRef: 'COPY-001' },
      VERSIONS: disposition, CONFLUENCE: disposition, EXPORTS: disposition,
      AUDIT: disposition, BACKUPS: disposition },
    authorizedAt: '2026-10-04T00:00:00.000Z' };
  const facts = prepareDocumentRecoveryFacts({ format: 1,
    action: 'DOCUMENT_PURGE_PREPARATION', installationId: 'synthetic-install',
    organisationId: 'charity', operationId: 'operation', writerEpoch: 1,
    actorUserId: 'owner', preparedAt: '2026-10-04T00:01:00.000Z',
    sourceRevision: 'b'.repeat(40), document, authorization,
    policy, removalPolicy: { ...policy }, removalPolicyWithdrawal: null });
  const transactionId = 9007199254740993n;
  const row = { id: 'outcome', transactionId,
    recordedAt: new Date('2026-10-04T00:02:01.000Z'),
    preparation: { id: 'preparation', installationId: 'synthetic-install',
      organisationId: 'charity', operationId: 'operation', writerEpoch: 1,
      authorizationId: 'auth', actorUserId: 'owner', facts: facts.body, factsDigest: facts.digest,
      execution: { writerId: 'host', generation: 1,
        entryDigest: 'c'.repeat(64), envelopeDigest: 'd'.repeat(64),
        controlRevision: 'revision', transactionId } },
    claim: { id: 'claim', organisationId: 'charity', authorizationId: 'auth',
      documentId: 'doc', deletionId: 'job', actorUserId: 'owner', transactionId,
      claimedAt: new Date('2026-10-04T00:02:00.000Z'),
      deletion: { id: 'job', organisationId: 'charity', sourceDocumentId: 'doc',
        storagePath: document.fileUrl, provider: 'local' } } };
  const state = { organisation: { id: 'charity', lifecycleStatus: 'ACTIVE',
    documentStorageProvider: 'local' }, enforcement: { id: 'enforcement',
    installationId: 'synthetic-install', writerId: 'host', writerEpoch: 1 },
  actor: { id: 'owner', role: 'OWNER', lifecycleStatus: 'ACTIVE' },
  authorization: { ...authorization, claim: { id: 'claim', deletionId: 'job' }, withdrawal: null },
  policies: [{ ...policy }],
  job: { id: 'job', organisationId: 'charity', sourceDocumentId: 'doc',
    storagePath: document.fileUrl, provider: 'local', targetRef: null,
    state: 'PENDING', attempts: 0, claimedAt: null as Date | null, processedAt: null,
    nextAttemptAt: new Date('2026-10-04T00:03:00.000Z'), lastRecoveryId: null,
    lastRecoveryNonce: null, lastRecoveryDisposition: null },
  copyAuthorities: [] as unknown[], copyHolds: [] as unknown[],
  dispositions: [] as unknown[], publications: [] as unknown[],
  uploadIntents: [] as unknown[], confluenceUploadIntents: [] as unknown[],
  pageCreateIntents: [] as unknown[], liveReferences: 0,
  matchingCleanupJobs: [{ id: 'job' }],
  standardLinks: 0, confluenceReferences: 0 };
  const tx = {
    $queryRaw: async () => [{ id: 'charity' }],
    documentRecoveryOutcome: { findFirst: async () => row },
    documentRecoveryPreparation: { findFirst: async () => ({ id: 'preparation',
      facts: facts.body, factsDigest: facts.digest }) },
    organisation: { findFirst: async () => state.organisation },
    documentRecoveryEnforcement: { findFirst: async () => state.enforcement },
    user: { findFirst: async () => state.actor },
    documentPurgeAuthorization: { findFirst: async () => state.authorization },
    dataRetentionPolicyRevision: { findMany: async () => state.policies },
    documentStorageDeletion: { findFirst: async () => state.job,
      findMany: async () => state.matchingCleanupJobs },
    documentCopyDispositionAuthority: { findMany: async () => state.copyAuthorities },
    documentCopyHoldEvent: { findMany: async () => state.copyHolds },
    documentPurgeDispositionEvent: { findMany: async () => state.dispositions },
    documentPublication: { findMany: async () => state.publications },
    documentUploadIntent: { findMany: async () => state.uploadIntents },
    documentPublicationUploadIntent: { findMany: async (args: unknown) => {
      assert.deepEqual(args, { where: { organisationId: 'charity', documentId: 'doc' },
        orderBy: { id: 'asc' }, take: 1001 });
      return state.confluenceUploadIntents;
    } },
    documentPublicationPageCreateIntent: { findMany: async (args: unknown) => {
      assert.deepEqual(args, { where: { organisationId: 'charity', documentId: 'doc' },
        orderBy: { id: 'asc' }, take: 1001 });
      return state.pageCreateIntents;
    } },
    document: { count: async () => state.liveReferences },
    documentStandardLink: { count: async () => state.standardLinks },
    confluenceReference: { count: async () => state.confluenceReferences },
  };
  const prisma = { $transaction: async (callback: (value: typeof tx) => Promise<unknown>, options: unknown) => {
    assert.deepEqual(options, { isolationLevel: 'Serializable', timeout: 30000 });
    return callback(tx);
  } } as unknown as PrismaClient;
  const request = { installationId: 'synthetic-install', organisationId: 'charity',
    operationId: 'operation' };
  return { prisma, state, request };
}

test('local byte-authority projection changes with policy, copy and mirror state without authorizing action', async () => {
  const f = fixture();
  const initial = await readCurrentDocumentByteAuthority(f.prisma, f.request);
  assert.equal(initial.actionAuthorized, false);
  assert.match(initial.digest, /^[a-f0-9]{64}$/);
  assert.match(initial.localCopyObservationDigest, /^[a-f0-9]{64}$/);
  assert.match(initial.localHoldObservationDigest, /^[a-f0-9]{64}$/);
  assert.equal((await readCurrentDocumentByteAuthority(f.prisma, f.request)).digest, initial.digest);
  f.state.policies[0]!.revision = 2;
  await assert.rejects(readCurrentDocumentByteAuthority(f.prisma, f.request), /changed or cannot be bounded/);
  f.state.policies[0]!.revision = 1;
  f.state.copyHolds.push({ id: 'hold', held: true, scopeRef: 'BACKUP-1' });
  const held = await readCurrentDocumentByteAuthority(f.prisma, f.request);
  assert.notEqual(held.digest, initial.digest);
  assert.notEqual(held.localHoldObservationDigest, initial.localHoldObservationDigest);
  assert.equal(held.localCopyObservationDigest, initial.localCopyObservationDigest);
  f.state.copyHolds.pop();
  f.state.publications.push({ id: 'mirror', state: 'PENDING' });
  const copied = await readCurrentDocumentByteAuthority(f.prisma, f.request);
  assert.notEqual(copied.digest, initial.digest);
  assert.notEqual(copied.localCopyObservationDigest, initial.localCopyObservationDigest);
  assert.equal(copied.localHoldObservationDigest, initial.localHoldObservationDigest);
  f.state.publications.pop();
  f.state.confluenceUploadIntents.push({ id: 'upload-operation',
    publicationId: 'mirror', documentId: 'doc', cloudId: 'test-site',
    pageId: 'test-page', sha256: 'c'.repeat(64) });
  const possibleRemoteCopy = await readCurrentDocumentByteAuthority(f.prisma, f.request);
  assert.notEqual(possibleRemoteCopy.digest, initial.digest);
  assert.notEqual(possibleRemoteCopy.localCopyObservationDigest, initial.localCopyObservationDigest);
  assert.equal(possibleRemoteCopy.localHoldObservationDigest, initial.localHoldObservationDigest);
  f.state.confluenceUploadIntents.pop();
  f.state.pageCreateIntents.push({ id: 'possible-page', documentId: 'doc',
    cloudId: 'test-site', spaceId: 'test-space', bodySha256: 'd'.repeat(64) });
  const possiblePage = await readCurrentDocumentByteAuthority(f.prisma, f.request);
  assert.notEqual(possiblePage.digest, initial.digest);
  assert.notEqual(possiblePage.localCopyObservationDigest, initial.localCopyObservationDigest);
  assert.equal(possiblePage.localHoldObservationDigest, initial.localHoldObservationDigest);
  f.state.pageCreateIntents.pop();
  Object.assign(f.state.job, { lastError: 'changed worker observation' });
  const jobChanged = await readCurrentDocumentByteAuthority(f.prisma, f.request);
  assert.notEqual(jobChanged.digest, initial.digest);
  assert.equal(jobChanged.localCopyObservationDigest, initial.localCopyObservationDigest);
  assert.equal(jobChanged.localHoldObservationDigest, initial.localHoldObservationDigest);
});

test('local byte-authority projection refuses stale owner, claim, target and unbounded history', async () => {
  for (const change of [
    (s: ReturnType<typeof fixture>['state']) => { s.actor.role = 'ADMIN'; },
    (s: ReturnType<typeof fixture>['state']) => { s.authorization.claim.deletionId = 'other'; },
    (s: ReturnType<typeof fixture>['state']) => { s.job.claimedAt = new Date(); },
    (s: ReturnType<typeof fixture>['state']) => { s.job.storagePath = 'other'; },
    (s: ReturnType<typeof fixture>['state']) => { Object.assign(s.job, { targetRef: { bucket: 'other' } }); },
    (s: ReturnType<typeof fixture>['state']) => { s.authorization.reason = 'CHANGED_DISPOSAL_REASON'; },
    (s: ReturnType<typeof fixture>['state']) => { s.liveReferences = 1; },
    (s: ReturnType<typeof fixture>['state']) => { s.matchingCleanupJobs.push({ id: 'alias' }); },
    (s: ReturnType<typeof fixture>['state']) => { s.copyAuthorities = Array(1001).fill({ id: 'copy' }); },
    (s: ReturnType<typeof fixture>['state']) => {
      s.confluenceUploadIntents = Array(1001).fill({ id: 'possible-remote-copy' });
    },
    (s: ReturnType<typeof fixture>['state']) => {
      s.pageCreateIntents = Array(1001).fill({ id: 'possible-page' });
    },
  ]) {
    const f = fixture(); change(f.state);
    await assert.rejects(readCurrentDocumentByteAuthority(f.prisma, f.request), /changed or cannot be bounded/);
  }
});
