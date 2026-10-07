import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { prepareDocumentRecoveryFacts } from '../services/document-recovery-preparation.js';
import { prepareDocumentOutcomeFacts, readCommittedDocumentOutcome } from '../services/document-recovery-outcome.js';

function fixture() {
  const policy = { id: 'policy', organisationId: 'charity', recordClass: 'VAULT_DRAFT',
    revision: 1, state: 'APPROVED', retentionMode: 'REVIEW_REQUIRED', retentionAnchor: null,
    retentionDays: null, recoveryDays: 30, createdById: 'owner',
    createdAt: '2026-09-01T00:00:00.000Z', approvedById: 'owner',
    approvedAt: '2026-09-02T00:00:00.000Z', approvalEvidenceRef: 'POLICY-001' };
  const disposition = { disposition: 'RETAIN_APPROVED', evidenceRef: 'COPY-001' };
  const document = { id: 'doc', organisationId: 'charity',
    updatedAt: '2026-09-03T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z',
    lifecycleStatus: 'DRAFT', deletedAt: '2026-09-03T00:00:00.000Z',
    deletionHold: false, approvalAsserted: false, approvedByResolutionId: null,
    deletedById: 'owner', removedFromRevision: '2026-09-02T00:00:00.000Z',
    removalEvidenceRef: 'REMOVAL-001', recoveryPolicyId: 'policy',
    recoveryUntil: '2026-10-03T00:00:00.000Z', recoverySha256: 'a'.repeat(64),
    fileUrl: 'vault/synthetic-object', storageProvider: 'local', fileSize: 123 };
  const authorization = { id: 'auth', organisationId: 'charity', documentId: 'doc',
    documentRevision: document.updatedAt, policyId: 'policy', actorUserId: 'owner',
    evidenceRef: 'PURGE-001', reason: 'Synthetic individual disposal review',
    storagePath: document.fileUrl, provider: document.storageProvider,
    sha256: document.recoverySha256, fileSize: document.fileSize,
    recoveryUntil: document.recoveryUntil,
    dispositionPlan: { PRIMARY: { disposition: 'DISPOSE', evidenceRef: 'COPY-001' },
      VERSIONS: disposition, CONFLUENCE: disposition, EXPORTS: disposition,
      AUDIT: disposition, BACKUPS: disposition }, authorizedAt: '2026-10-04T00:00:00.000Z' };
  const facts = { format: 1, action: 'DOCUMENT_PURGE_PREPARATION',
    installationId: 'installation', organisationId: 'charity', operationId: 'operation',
    writerEpoch: 1, actorUserId: 'owner', preparedAt: '2026-10-04T00:01:00.000Z',
    sourceRevision: 'b'.repeat(40), document, authorization, policy,
    removalPolicy: { ...policy }, removalPolicyWithdrawal: null };
  const prepared = prepareDocumentRecoveryFacts(facts);
  const request = { organisationId: 'charity', installationId: 'installation', operationId: 'operation' };
  const transactionId = 9007199254740993n;
  const row = { id: 'outcome', transactionId,
    recordedAt: new Date('2026-10-04T00:02:01.000Z'),
    preparation: { id: 'preparation', ...request, writerEpoch: 1,
      authorizationId: 'auth', actorUserId: 'owner',
      facts: prepared.body, factsDigest: prepared.digest,
      execution: { writerId: 'writer', generation: 1,
        entryDigest: 'c'.repeat(64), envelopeDigest: 'd'.repeat(64),
        controlRevision: 'revision-1', transactionId } },
    claim: { id: 'claim', organisationId: 'charity', authorizationId: 'auth',
      documentId: 'doc', deletionId: 'job', actorUserId: 'owner', transactionId,
      claimedAt: new Date('2026-10-04T00:02:00.000Z'),
      deletion: { id: 'job', organisationId: 'charity', sourceDocumentId: 'doc',
        storagePath: 'vault/synthetic-object', provider: 'local' } } };
  let missing = false;
  const prisma = { documentRecoveryOutcome: { async findFirst(input: { where: unknown }) {
    assert.deepEqual(input.where, { preparation: request });
    return missing ? null : row;
  } } } as unknown as PrismaClient;
  return { row, read: () => readCommittedDocumentOutcome(prisma, request),
    missing: () => { missing = true; } };
}

test('committed document result binds claim, execution and queued-job identity without claiming byte erasure', async () => {
  const f = fixture(), result = await f.read();
  assert.deepEqual(await f.read(), result);
  const facts = JSON.parse(result.body);
  assert.equal(facts.action, 'DOCUMENT_PRIMARY_PURGE_CLAIM_COMMITTED');
  assert.equal(facts.transactionId, '9007199254740993');
  assert.equal(facts.deletionId, 'job');
  assert.equal(facts.preparationEntryDigest, 'c'.repeat(64));
  assert.equal(facts.preparationEnvelopeDigest, 'd'.repeat(64));
  assert.equal(facts.byteErasure, undefined);
  assert.equal(facts.storagePath, undefined);
  assert.equal(result.body.includes('Synthetic individual disposal review'), false);
  assert.equal(result.actionAuthorized, false);
});

test('committed document result refuses missing or mismatched claim, execution, job and preparation', async () => {
  const changes = [
    (f: ReturnType<typeof fixture>) => f.missing(),
    (f: ReturnType<typeof fixture>) => { f.row.claim.transactionId++; },
    (f: ReturnType<typeof fixture>) => { f.row.preparation.execution.transactionId++; },
    (f: ReturnType<typeof fixture>) => { f.row.claim.organisationId = 'foreign'; },
    (f: ReturnType<typeof fixture>) => { f.row.claim.documentId = 'other'; },
    (f: ReturnType<typeof fixture>) => { f.row.claim.deletionId = 'other'; },
    (f: ReturnType<typeof fixture>) => { f.row.claim.deletion.provider = 'supabase'; },
    (f: ReturnType<typeof fixture>) => { f.row.claim.deletion.storagePath = 'other'; },
    (f: ReturnType<typeof fixture>) => { f.row.preparation.factsDigest = '0'.repeat(64); },
    (f: ReturnType<typeof fixture>) => { f.row.recordedAt = new Date('2000-01-01'); },
  ];
  for (const change of changes) { const f = fixture(); change(f); await assert.rejects(f.read); }
});

test('document result accepts only bounded claim evidence', () => {
  const valid = { format: 1, action: 'DOCUMENT_PRIMARY_PURGE_CLAIM_COMMITTED',
    organisationId: 'charity', installationId: 'installation', operationId: 'operation',
    writerId: 'writer', writerEpoch: 1, preparationSourceRevision: 'b'.repeat(40),
    preparationId: 'preparation', preparationDigest: 'a'.repeat(64),
    preparationGeneration: 1, preparationEntryDigest: 'c'.repeat(64),
    preparationEnvelopeDigest: 'd'.repeat(64), controlRevision: 'revision-1',
    outcomeId: 'outcome', claimId: 'claim', deletionId: 'job', authorizationId: 'auth',
    documentId: 'doc', actorUserId: 'owner', transactionId: '1',
    claimedAt: '2026-10-04T00:02:00.000Z', recordedAt: '2026-10-04T00:02:01.000Z' };
  assert.equal(prepareDocumentOutcomeFacts(valid).actionAuthorized, false);
  for (const bad of [{ ...valid, bytesDeleted: true }, { ...valid, transactionId: '0' },
    { ...valid, recordedAt: '2026-10-04T00:01:59.000Z' },
    { ...valid, preparationEntryDigest: 'invalid' }]) {
    assert.throws(() => prepareDocumentOutcomeFacts(bad));
  }
});
