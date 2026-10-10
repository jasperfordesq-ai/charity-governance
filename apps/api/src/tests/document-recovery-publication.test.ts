import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { PrismaClient } from '@prisma/client';
import { prepareDocumentRecoveryFacts } from '../services/document-recovery-preparation.js';
import { openDocumentRecoveryPreparation, preserveDocumentRecoveryPreparation,
  readVerifiedDocumentRecoveryPreparation } from '../services/document-recovery-envelope.js';
import { publishVerifiedDocumentPreparation,
  readPublishedDocumentPreparation } from '../services/published-document-preparation.js';
import { S3AuthorityObjectStore } from '../services/recovery-authority-s3.js';
import { RecoveryAuthorityJournal } from '../services/recovery-authority-journal.js';
import { reserveRecoveryOperation, validateRecoveryControlValue } from '../services/recovery-operation-reservation.js';
import { readCommittedDocumentOutcome } from '../services/document-recovery-outcome.js';
import { preserveDocumentOutcome, readVerifiedDocumentOutcome } from '../services/document-outcome-envelope.js';
import { publishVerifiedDocumentOutcome, readPublishedDocumentOutcome } from '../services/published-document-outcome.js';
import { prepareDocumentBytePermitFacts } from '../services/document-byte-permit-facts.js';
import { openDocumentBytePermit, preserveDocumentBytePermit,
  readVerifiedDocumentBytePermit } from '../services/document-byte-permit-envelope.js';
import { prepareDocumentByteExecutionDecisionFacts } from '../services/document-byte-execution-decision-facts.js';
import { openDocumentByteExecutionDecision, preserveDocumentByteExecutionDecision,
  readVerifiedDocumentByteExecutionDecision } from '../services/document-byte-execution-decision-envelope.js';
import { readPublishedDocumentByteExecutionDecision } from '../services/published-document-byte-execution-decision.js';
import { readMatchedClaimedDocumentByteDecision,
  readMatchedStartedDocumentByteDecision } from '../services/matched-claimed-document-byte-decision.js';
import { claimVerifiedDocumentByteExecutionLease } from '../services/claimed-document-byte-execution-lease.js';
import { startVerifiedDocumentByteProviderAttempt } from '../services/verified-document-byte-provider-start.js';
import { executeVerifiedDocumentBytePrimaryDeletion as executeWithDispatcher } from '../services/verified-document-byte-primary-execution.js';
import type { Eraser } from '../services/document-erasure.js';
import { recordVerifiedDocumentBytePrimaryAbsence,
  recordReconciledDocumentBytePrimaryAbsence } from '../services/verified-document-byte-provider-observation.js';
import { publishVerifiedDocumentByteProviderUnknown,
  readPublishedDocumentByteProviderUnknown } from '../services/published-document-byte-provider-unknown.js';
import { readCommittedDocumentByteProviderUnknown } from '../services/document-byte-provider-unknown.js';
import { finalizeVerifiedDocumentBytePrimaryCompletion, publishVerifiedDocumentBytePrimaryCompletion,
  readPublishedDocumentBytePrimaryCompletion } from '../services/published-document-byte-primary-completion.js';
import { prepareDocumentByteProviderUnknownFacts } from '../services/document-byte-provider-unknown.js';
import { preserveDocumentByteProviderUnknown } from '../services/document-byte-provider-unknown-envelope.js';
import { prepareDocumentBytePrimaryCompletionFacts,
  readRecordedDocumentBytePrimaryObservation } from '../services/document-byte-primary-completion.js';
import { preserveDocumentBytePrimaryCompletion } from '../services/document-byte-primary-completion-envelope.js';
import { bindVerifiedDocumentBytePermitCandidate, compareDocumentBytePermitAuthority,
  publishVerifiedDocumentBytePermitCandidate,
  readPublishedDocumentBytePermit } from '../services/published-document-byte-permit.js';
import { readClaimedDocumentByteAuthority,
  readCurrentDocumentByteAuthority } from '../services/document-byte-authority-projection.js';

function documentFacts(storageProvider: 'local' | 'supabase' = 'local') {
  const policy = { id: 'policy', organisationId: 'charity', recordClass: 'VAULT_DRAFT' as const,
    revision: 1, state: 'APPROVED' as const, retentionMode: 'REVIEW_REQUIRED' as const,
    retentionAnchor: null, retentionDays: null, recoveryDays: 30, createdById: 'owner',
    createdAt: '2026-09-01T00:00:00.000Z', approvedById: 'owner',
    approvedAt: '2026-09-02T00:00:00.000Z', approvalEvidenceRef: 'POLICY-001' };
  const copy = { disposition: 'RETAIN_APPROVED' as const, evidenceRef: 'COPY-001' };
  const document = { id: 'doc', organisationId: 'charity',
    updatedAt: '2026-09-03T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z',
    lifecycleStatus: 'DRAFT' as const, deletedAt: '2026-09-03T00:00:00.000Z',
    deletionHold: false as const, approvalAsserted: false as const, approvedByResolutionId: null,
    deletedById: 'owner', removedFromRevision: '2026-09-02T00:00:00.000Z',
    removalEvidenceRef: 'REMOVAL-001', recoveryPolicyId: 'policy',
    recoveryUntil: '2026-10-03T00:00:00.000Z', recoverySha256: 'a'.repeat(64),
    fileUrl: 'vault/synthetic-object', storageProvider, fileSize: 123 };
  const authorization = { id: 'auth', organisationId: 'charity', documentId: 'doc',
    documentRevision: document.updatedAt, policyId: 'policy', actorUserId: 'owner',
    evidenceRef: 'PURGE-001', reason: 'SENSITIVE_SYNTHETIC_DISPOSAL_REASON',
    storagePath: document.fileUrl, provider: document.storageProvider,
    sha256: document.recoverySha256, fileSize: document.fileSize,
    recoveryUntil: document.recoveryUntil,
    dispositionPlan: { PRIMARY: { disposition: 'DISPOSE' as const, evidenceRef: 'COPY-001' },
      VERSIONS: copy, CONFLUENCE: copy, EXPORTS: copy, AUDIT: copy, BACKUPS: copy },
    authorizedAt: '2026-10-04T00:00:00.000Z' };
  return { format: 1 as const, action: 'DOCUMENT_PURGE_PREPARATION' as const,
    installationId: 'synthetic-install', organisationId: 'charity', operationId: 'document-operation',
    writerEpoch: 1, actorUserId: 'owner', preparedAt: '2026-10-04T00:01:00.000Z',
    sourceRevision: 'b'.repeat(40), document, authorization, policy,
    removalPolicy: { ...policy }, removalPolicyWithdrawal: null };
}

async function fixture(storageProvider: 'local' | 'supabase' = 'local') {
  const facts = documentFacts(storageProvider), prepared = prepareDocumentRecoveryFacts(facts);
  const binding = { installationId: facts.installationId, organisationId: facts.organisationId };
  const context = { ...binding, operationId: facts.operationId, writerEpoch: 1,
    sourceRevision: facts.sourceRevision,
    keyId: 'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-4111-8111-111111111111' };
  const keys = { async generate() { return { key: Buffer.alloc(32, 7), keyId: context.keyId,
    wrappedKey: Buffer.alloc(48, 1).toString('base64') }; },
  async unwrap() { return { key: Buffer.alloc(32, 7), keyId: context.keyId }; } };
  const config = { ...binding, accountId: '123456789012', bucket: 'synthetic-document-proof',
    kmsKeyArn: context.keyId.replaceAll('1111', '2222'), replayKeyArn: context.keyId };
  const headKey = `authority/${binding.installationId}/${binding.organisationId}/head.json`;
  const initial = { ...binding, generation: 0, digest: null };
  const control = validateRecoveryControlValue({ format: 2, ...initial, writerId: 'host',
    writerEpoch: 1, activeOperation: null });
  const objects = new Map<string, { body: string; version: number }>([[headKey,
    { body: JSON.stringify({ ...control, publicationId: '11111111-1111-4111-8111-111111111111' }), version: 1 }]]);
  let version = 1, loseAck: 'any' | 'head' | null = null;
  const metadata = { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: config.kmsKeyArn };
  const etag = (body: string) => `"${createHash('sha256').update(body).digest('hex')}"`;
  const credentials = { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' };
  const client = new S3Client({ region: 'eu-west-1', credentials });
  client.send = (async (command: GetObjectCommand | PutObjectCommand) => {
    assert.equal(command.input.ExpectedBucketOwner, config.accountId);
    const old = objects.get(command.input.Key!);
    if (command instanceof GetObjectCommand) {
      if (!old) throw { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } };
      return { ...metadata, VersionId: `v${old.version}`, ETag: etag(old.body),
        ContentLength: Buffer.byteLength(old.body), Body: Readable.from([Buffer.from(old.body)]) };
    }
    if ((command.input.IfNoneMatch === '*' && old)
      || (command.input.IfMatch && command.input.IfMatch !== etag(old!.body))) {
      throw { $metadata: { httpStatusCode: 412 } };
    }
    objects.set(command.input.Key!, { body: String(command.input.Body), version: ++version });
    if (loseAck === 'any' || (loseAck === 'head' && command.input.Key === headKey)) {
      loseAck = null; throw new Error('synthetic lost acknowledgement');
    }
    return { ...metadata, VersionId: `v${version}` };
  }) as typeof client.send;
  const store = new S3AuthorityObjectStore(config, credentials, client);
  const journal = new RecoveryAuthorityJournal(store, binding, initial);
  const request = { writerId: 'host', preparationDigest: prepared.digest,
    expectedGeneration: 0, expectedDigest: null };
  await reserveRecoveryOperation({ ...binding, ...request, writerEpoch: 1,
    operationId: context.operationId }, store);
  return { context, facts, prepared, keys, store, journal, objects, request, headKey,
    loseAck: (headOnly = false) => { loseAck = headOnly ? 'head' : 'any'; } };
}

test('document preparation publishes original encrypted bytes under a reserved independent history', async () => {
  const f = await fixture();
  f.loseAck();
  await assert.rejects(preserveDocumentRecoveryPreparation(f.prepared.body, f.context, f.keys, f.store), /unresolved/);
  const preserved = await preserveDocumentRecoveryPreparation(f.prepared.body, f.context, f.keys, f.store);
  assert.equal(preserved.replayed, true);
  const envelope = await f.store.readDocumentPreparation(f.context.operationId);
  assert.doesNotMatch(envelope!, /SENSITIVE_SYNTHETIC_DISPOSAL_REASON|vault\/synthetic-object/);
  f.loseAck();
  const publish = () => publishVerifiedDocumentPreparation(f.journal, f.store,
    f.request, f.context, f.keys, f.store);
  await assert.rejects(publish);
  f.loseAck(true);
  await assert.rejects(publish, /unknown/);
  assert.equal((await publish()).headPublished, true);
  assert.equal(await f.store.readDocumentPreparation(f.context.operationId), envelope);
  const read = await readPublishedDocumentPreparation(f.journal, f.store, f.context, f.keys, f.store);
  assert.equal(read.body, f.prepared.body); assert.equal(read.actionAuthorized, false);
  assert.equal((await f.store.readControl()).activeOperation!.operationId, f.context.operationId);
  await assert.rejects(f.store.createReplay(f.context.operationId, envelope!), /envelope/);
  await assert.rejects(openDocumentRecoveryPreparation(JSON.stringify({ ...JSON.parse(envelope!),
    kind: 'COMPLAINT_RECOVERY_PREPARATION' }), f.context, f.keys), /decrypted/);
  await assert.rejects(openDocumentRecoveryPreparation(envelope!,
    { ...f.context, writerEpoch: 2 }, f.keys), /decrypted/);
  const unwrap = f.keys.unwrap;
  f.keys.unwrap = async () => {
    const head = f.objects.get(f.headKey)!, value = JSON.parse(head.body);
    value.publicationId = '33333333-3333-4333-8333-333333333333';
    f.objects.set(f.headKey, { body: JSON.stringify(value), version: head.version + 1 });
    return unwrap();
  };
  await assert.rejects(readPublishedDocumentPreparation(f.journal, f.store,
    f.context, f.keys, f.store), /changed while reading/);
  f.keys.unwrap = unwrap;
  await assert.rejects(readVerifiedDocumentRecoveryPreparation('0'.repeat(64),
    f.context, f.keys, f.store), /unresolved/);
  for (const key of f.objects.keys()) if (key.startsWith('document-preparations/')) f.objects.delete(key);
  await assert.rejects(readPublishedDocumentPreparation(f.journal, f.store,
    f.context, f.keys, f.store), /unresolved/);
});

async function readyBytePermitPublisher(storageProvider: 'local' | 'supabase' = 'local') {
  const f = await fixture(storageProvider);
  await preserveDocumentRecoveryPreparation(f.prepared.body, f.context, f.keys, f.store);
  const prepReceipt = await publishVerifiedDocumentPreparation(f.journal, f.store,
    f.request, f.context, f.keys, f.store);
  const preparationEnvelope = await f.store.readDocumentPreparation(f.context.operationId);
  const preparationEnvelopeDigest = createHash('sha256').update(preparationEnvelope!).digest('hex');
  const control = await f.store.readControl();
  const transactionId = 9007199254740993n;
  const row = { id: 'outcome', transactionId,
    recordedAt: new Date('2026-10-04T00:02:01.000Z'),
    preparation: { id: 'preparation', installationId: f.context.installationId,
      organisationId: f.context.organisationId, operationId: f.context.operationId,
      writerEpoch: f.context.writerEpoch, authorizationId: f.facts.authorization.id,
      actorUserId: f.facts.actorUserId, facts: f.prepared.body, factsDigest: f.prepared.digest,
      execution: { writerId: f.request.writerId, generation: prepReceipt.generation,
        entryDigest: prepReceipt.digest, envelopeDigest: preparationEnvelopeDigest,
        controlRevision: control.revision, transactionId } },
    claim: { id: 'claim', organisationId: f.context.organisationId,
      authorizationId: f.facts.authorization.id, documentId: f.facts.document.id,
      deletionId: 'job', actorUserId: f.facts.actorUserId, transactionId,
      claimedAt: new Date('2026-10-04T00:02:00.000Z'),
      deletion: { id: 'job', organisationId: f.context.organisationId,
        sourceDocumentId: f.facts.document.id,
        storagePath: f.facts.authorization.storagePath,
        provider: f.facts.authorization.provider } } };
  const state = { copyHolds: [] as unknown[], reads: 0, changeAfterFirstRead: false,
    mutateAtRead: 0, candidateBinding: null as Record<string, unknown> | null,
    bindingCreates: 0, leaseCreates: 0, startCalls: 0, claimedAt: null as Date | null,
    lease: null as Record<string, unknown> | null,
    attempt: null as Record<string, unknown> | null,
    observation: null as Record<string, unknown> | null, observeCalls: 0,
    boundAttempt: undefined as unknown, observationNotRecorded: false,
    expectedAttempt: undefined as unknown, duringObserve: null as (() => void) | null,
    duringStart: null as (() => void) | null, refuseStartBeforeMarker: false,
    observationView: null as ((row: Record<string, unknown>) => Record<string, unknown>) | null,
    completion: null as Record<string, unknown> | null, completionCalls: 0,
    completionNotRecorded: false, duringCompletion: null as (() => void) | null,
    beforeCompletion: null as (() => void) | null,
    completionView: null as ((row: Record<string, unknown>) => Record<string, unknown>) | null,
    job: { state: 'PENDING', processedAt: null as Date | null, activeObjectAbsentAt: null as Date | null } };
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join('').includes('DocumentBytePrimaryCompletion_record')) {
        state.completionCalls += 1;
        state.beforeCompletion?.();
        if (state.expectedAttempt !== undefined && values[1] !== state.expectedAttempt) {
          throw new Error('Synthetic attempt capability does not match');
        }
        if (!state.observation || state.completion || state.job.state !== 'PENDING') {
          throw new Error('Synthetic completion refused');
        }
        if (state.completionNotRecorded) return [{ recorded: false }];
        state.completion = { id: 'lease', leaseId: 'lease', observationId: 'lease',
          organisationId: f.context.organisationId, deletionId: row.claim.deletionId,
          decisionEntryDigest: state.observation.decisionEntryDigest,
          completionEntryDigest: values[2], completionEnvelopeDigest: values[3],
          completionBodyDigest: values[4], scope: 'PRIMARY_ACTIVE_OBJECT_ONLY',
          completedTransactionId: 126n, recordedAt: new Date('2026-10-07T09:29:59.000Z') };
        state.job = { state: 'PROCESSED', processedAt: new Date('2026-10-07T09:30:00.000Z'),
          activeObjectAbsentAt: state.observation.providerObservedAt as Date };
        state.duringCompletion?.();
        return [{ recorded: true }];
      }
      if (strings.join('').includes('DocumentByteProviderObservation_recordAbsent')) {
        state.observeCalls += 1;
        state.boundAttempt = values[1];
        if (!state.lease || !state.attempt || state.observation) {
          throw new Error('Synthetic provider observation refused');
        }
        if (state.expectedAttempt !== undefined && values[1] !== state.expectedAttempt) {
          throw new Error('Synthetic attempt capability does not match');
        }
        if (state.observationNotRecorded) return [{ recorded: false }];
        state.observation = { id: 'lease', leaseId: 'lease', attemptId: 'lease',
          organisationId: f.context.organisationId, deletionId: row.claim.deletionId,
          decisionEntryDigest: state.lease.decisionEntryDigest,
          outcome: 'PRIMARY_ACTIVE_OBJECT_ABSENT',
          providerObservedAt: new Date(String(values[2])),
          observedTransactionId: 125n, recordedAt: new Date('2026-10-07T08:03:03.000Z') };
        state.duringObserve?.();
        return [{ recorded: true }];
      }
      if (strings.join('').includes('DocumentByteExecutionLease_claim')) {
        if (!state.lease) throw new Error('Synthetic lease missing');
        state.claimedAt = new Date('2026-10-07T08:03:00.000Z');
        state.lease.state = 'CLAIMED';
        state.lease.claimedAt = state.claimedAt;
        state.lease.claimTransactionId = 123n;
        return [{ claimed: true }];
      }
      if (strings.join('').includes('DocumentByteProviderAttempt_start')) {
        state.startCalls += 1;
        if (!state.lease || !state.claimedAt || state.attempt || state.refuseStartBeforeMarker) {
          throw new Error('Synthetic provider start refused');
        }
        state.attempt = { id: 'lease', leaseId: 'lease',
          organisationId: f.context.organisationId, deletionId: row.claim.deletionId,
          decisionEntryDigest: state.lease.decisionEntryDigest,
          startedTransactionId: 124n,
          startedAt: new Date('2026-10-07T08:03:01.000Z') };
        state.duringStart?.();
        return [{ started: true }];
      }
      return [{ id: f.context.organisationId }];
    },
    documentRecoveryOutcome: { findFirst: async () => row },
    documentRecoveryPreparation: { findFirst: async () => ({ id: 'preparation',
      facts: f.prepared.body, factsDigest: f.prepared.digest }) },
    organisation: { findFirst: async () => ({ id: f.context.organisationId,
      lifecycleStatus: 'ACTIVE', documentStorageProvider: 'local' }) },
    documentRecoveryEnforcement: { findFirst: async () => ({ id: 'enforcement',
      installationId: f.context.installationId, writerId: f.request.writerId,
      writerEpoch: f.context.writerEpoch }) },
    user: { findFirst: async () => ({ id: f.facts.actorUserId,
      role: 'OWNER', lifecycleStatus: 'ACTIVE' }) },
    documentPurgeAuthorization: { findFirst: async () => ({ ...f.facts.authorization,
      withdrawal: null, claim: { id: row.claim.id, deletionId: row.claim.deletionId } }) },
    // Signed pre-migration facts omitted retentionYears; a current Prisma row
    // includes the nullable field after migration.
    dataRetentionPolicyRevision: { findMany: async () => [{ ...f.facts.policy, retentionYears: null }] },
    documentStorageDeletion: { findFirst: async () => ({ id: row.claim.deletionId,
      organisationId: f.context.organisationId, sourceDocumentId: f.facts.document.id,
      storagePath: f.facts.authorization.storagePath, provider: f.facts.authorization.provider,
      state: 'PENDING', claimedAt: state.claimedAt, processedAt: null,
      attempts: 0, deadLetteredAt: null, targetRef: null }),
    findMany: async () => [{ id: row.claim.deletionId }] },
    documentByteExecutionLease: { findUnique: async () => state.lease,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.leaseCreates += 1;
        state.lease = { id: 'lease', ...data, state: 'READY',
          insertTransactionId: 123n, claimTransactionId: null,
          claimedAt: null, candidateBinding: state.candidateBinding };
        return { id: 'lease' };
      } },
    documentByteProviderAttempt: { findUnique: async () => state.attempt },
    documentCopyDispositionAuthority: { findMany: async () => [] },
    documentCopyHoldEvent: { findMany: async () => state.copyHolds },
    documentPurgeDispositionEvent: { findMany: async () => [] },
    documentPublication: { findMany: async () => [] },
    documentUploadIntent: { findMany: async () => [] },
    documentPublicationUploadIntent: { findMany: async () => [] },
    documentPublicationPageCreateIntent: { findMany: async () => [] },
    document: { count: async () => 0 },
    documentStandardLink: { count: async () => 0 },
    confluenceReference: { count: async () => 0 },
    documentBytePermitCandidateBinding: {
      findUnique: async () => state.candidateBinding,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.bindingCreates += 1;
        state.candidateBinding = { id: 'binding', ...data };
        return state.candidateBinding;
      },
    },
  };
  const prisma = { documentRecoveryOutcome: { findFirst: async () => row },
    documentByteExecutionLease: { findUnique: async () => state.lease && ({ ...state.lease,
      candidateBinding: { ...state.candidateBinding, preparation: {
        id: 'preparation', installationId: f.context.installationId,
        organisationId: f.context.organisationId, operationId: f.context.operationId,
        writerEpoch: f.context.writerEpoch, facts: f.prepared.body,
        factsDigest: f.prepared.digest } }, providerAttempt: state.attempt }) },
    documentByteProviderAttempt: { findUnique: async () => state.attempt },
    documentByteProviderObservation: { findUnique: async () => state.observation
      && (state.observationView ? state.observationView(state.observation) : state.observation) },
    documentBytePrimaryCompletion: { findUnique: async () => state.completion
      && (state.completionView ? state.completionView(state.completion) : state.completion) },
    documentStorageDeletion: { findUnique: async () => ({
      organisationId: f.context.organisationId, ...state.job }) },
    $queryRaw: tx.$queryRaw,
    $transaction: async (callback: (value: typeof tx) => Promise<unknown>) => {
      state.reads += 1;
      if ((state.changeAfterFirstRead && state.reads === 2)
        || state.reads === state.mutateAtRead) {
        state.copyHolds.push({ id: 'new-hold', held: true });
      }
      return callback(tx);
    } } as unknown as PrismaClient;
  const committed = await readCommittedDocumentOutcome(prisma, {
    organisationId: f.context.organisationId, installationId: f.context.installationId,
    operationId: f.context.operationId });
  await preserveDocumentOutcome(committed.body, f.context, f.keys, f.store);
  await publishVerifiedDocumentOutcome(f.journal, f.store, prisma,
    { writerId: f.request.writerId, preparationDigest: f.prepared.digest,
      preparationGeneration: prepReceipt.generation,
      preparationEntryDigest: prepReceipt.digest, preparationEnvelopeDigest },
    f.context, f.keys, f.store);
  return { f, prisma, state };
}

test('post-claim local byte observation requires the consumed exact lease and unchanged copy and hold facts', async () => {
  const { f, prisma, state } = await readyBytePermitPublisher();
  const scope = { installationId: f.context.installationId,
    organisationId: f.context.organisationId, operationId: f.context.operationId };
  const before = await readCurrentDocumentByteAuthority(prisma, scope);
  const oneUseAttemptId = '12345678-1234-4234-8234-123456789abc';
  const claimedAt = new Date('2026-10-04T00:03:00.000Z');
  state.claimedAt = claimedAt;
  state.lease = { id: 'lease', organisationId: scope.organisationId,
    deletionId: 'job', candidateBindingId: 'binding', state: 'CLAIMED',
    claimedAt, insertTransactionId: 123n, claimTransactionId: 123n,
    attemptHash: createHash('sha256').update(oneUseAttemptId).digest('hex'),
    localCopyObservationDigest: before.localCopyObservationDigest,
    localHoldObservationDigest: before.localHoldObservationDigest,
    candidateBinding: { id: 'binding', organisationId: scope.organisationId,
      installationId: scope.installationId, operationId: scope.operationId,
      claimId: 'claim', deletionId: 'job', writerId: f.request.writerId,
      writerEpoch: f.context.writerEpoch, provider: f.facts.authorization.provider,
      storagePath: f.facts.authorization.storagePath } };
  const request = { ...scope, leaseId: 'lease', oneUseAttemptId };
  const observed = await readClaimedDocumentByteAuthority(prisma, request);
  assert.equal(observed.actionAuthorized, false);
  assert.equal(observed.localCopyObservationDigest, before.localCopyObservationDigest);
  assert.equal(observed.localHoldObservationDigest, before.localHoldObservationDigest);
  assert.notEqual(observed.digest, before.digest);
  await assert.rejects(readClaimedDocumentByteAuthority(prisma,
    { ...request, oneUseAttemptId: '12345678-1234-4234-8234-123456789abd' }),
  /changed or cannot be bounded/);
  state.copyHolds.push({ id: 'new-hold', held: true });
  await assert.rejects(readClaimedDocumentByteAuthority(prisma, request),
    /copy or hold authority changed/);
  state.copyHolds.length = 0;
  state.lease = null;
  await assert.rejects(readClaimedDocumentByteAuthority(prisma, request),
    /changed or cannot be bounded/);
});

test('verified document byte candidate publisher derives current facts and recovers a lost head acknowledgement', async () => {
  const { f, prisma } = await readyBytePermitPublisher();
  const publish = () => publishVerifiedDocumentBytePermitCandidate(prisma,
    f.journal, f.store, f.context, f.keys, f.store);
  f.loseAck(true);
  await assert.rejects(publish(), /unknown/);
  const replay = await publish();
  assert.equal(replay.replayed, true);
  assert.equal(replay.actionAuthorized, false);
  assert.equal((await f.store.readControl()).activeOperation?.operationId, f.context.operationId);
  const read = await readPublishedDocumentBytePermit(f.journal, f.store,
    f.context, f.keys, f.store);
  assert.equal(JSON.parse(read.body).currentAuthorityDigest, replay.currentAuthorityDigest);
});

test('verified document byte candidate publisher binds the exact outcome and stays non-authorizing', async () => {
  const { f, prisma } = await readyBytePermitPublisher();
  const receipt = await publishVerifiedDocumentBytePermitCandidate(prisma,
    f.journal, f.store, f.context, f.keys, f.store);
  assert.equal(receipt.replayed, false);
  assert.equal(receipt.actionAuthorized, false);
  const outcome = await readPublishedDocumentOutcome(f.journal, f.store,
    f.context, f.keys, f.store);
  const candidate = await readPublishedDocumentBytePermit(f.journal, f.store,
    f.context, f.keys, f.store);
  const facts = JSON.parse(candidate.body);
  assert.equal(facts.outcomeEntryDigest, outcome.entryDigest);
  assert.equal(facts.outcomeGeneration, outcome.generation);
  assert.equal(facts.currentAuthorityDigest, receipt.currentAuthorityDigest);
  assert.equal((await f.store.readControl()).activeOperation?.operationId, f.context.operationId);
});

test('fourth-stage document byte decision stays distinct, encrypted, immutable and non-executable', async () => {
  const { f, prisma, state } = await readyBytePermitPublisher();
  await publishVerifiedDocumentBytePermitCandidate(prisma,
    f.journal, f.store, f.context, f.keys, f.store);
  const candidate = await readPublishedDocumentBytePermit(f.journal, f.store,
    f.context, f.keys, f.store);
  await bindVerifiedDocumentBytePermitCandidate(prisma,
    f.journal, f.store, f.context, f.keys, f.store);
  const localBeforeClaim = await readCurrentDocumentByteAuthority(prisma, {
    installationId: f.context.installationId, organisationId: f.context.organisationId,
    operationId: f.context.operationId });
  const candidateFacts = JSON.parse(candidate.body);
  const control = await f.store.readControl();
  const decision = prepareDocumentByteExecutionDecisionFacts({ format: 1,
    action: 'DOCUMENT_PRIMARY_BYTE_EXECUTION_DECISION',
    installationId: f.context.installationId, organisationId: f.context.organisationId,
    operationId: f.context.operationId, writerId: candidateFacts.writerId,
    writerEpoch: f.context.writerEpoch, sourceRevision: f.context.sourceRevision,
    preparationDigest: candidateFacts.preparationDigest,
    candidateBodyDigest: createHash('sha256').update(candidate.body).digest('hex'),
    candidateEntryDigest: candidate.entryDigest, candidateEnvelopeDigest: candidate.envelopeDigest,
    candidateGeneration: control.generation, candidateAuthorityDigest: candidateFacts.currentAuthorityDigest,
    controlRevision: control.revision, outcomeId: candidateFacts.outcomeId,
    claimId: candidateFacts.claimId, deletionId: candidateFacts.deletionId,
    authorizationId: candidateFacts.authorizationId, documentId: candidateFacts.documentId,
    actorUserId: candidateFacts.actorUserId, provider: candidateFacts.provider,
    storagePath: candidateFacts.storagePath, objectSha256: candidateFacts.objectSha256,
    fileSize: candidateFacts.fileSize,
    copyDispositionDigest: localBeforeClaim.localCopyObservationDigest,
    holdStateDigest: localBeforeClaim.localHoldObservationDigest,
    providerInventoryDigest: 'c'.repeat(64),
    decisionEvidenceRef: 'SYNTHETIC-DECISION-001',
    oneUseAttemptId: '11111111-1111-4111-8111-111111111111',
    issuedAt: '2026-10-07T08:00:00.000Z' });
  f.loseAck();
  await assert.rejects(preserveDocumentByteExecutionDecision(decision.body,
    f.context, f.keys, f.store), /unresolved/);
  const preserved = await preserveDocumentByteExecutionDecision(decision.body,
    f.context, f.keys, f.store);
  assert.equal(preserved.replayed, true);
  assert.equal(preserved.actionAuthorized, false);
  const envelope = await f.store.readDocumentByteExecutionDecision(f.context.operationId);
  assert.ok(envelope);
  assert.doesNotMatch(envelope, /DOCUMENT_PRIMARY_BYTE_EXECUTION_DECISION|vault\/synthetic-object/);
  assert.equal((await readVerifiedDocumentByteExecutionDecision(preserved.digest,
    f.context, f.keys, f.store)).body, decision.body);
  await assert.rejects(f.store.createDocumentByteExecutionDecision('other-operation', envelope), /scope mismatch/);
  await assert.rejects(f.store.createDocumentByteExecutionDecision(f.context.operationId,
    (await f.store.readDocumentBytePermit(f.context.operationId))!), /envelope/);
  await assert.rejects(openDocumentByteExecutionDecision(JSON.stringify({ ...JSON.parse(envelope),
    kind: 'DOCUMENT_BYTE_PERMIT_CANDIDATE' }), f.context, f.keys), /decrypted/);
  await assert.rejects(readVerifiedDocumentByteExecutionDecision('0'.repeat(64),
    f.context, f.keys, f.store), /unresolved/);
  await assert.rejects(preserveDocumentByteExecutionDecision(decision.body.replace(
    '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'),
    f.context, f.keys, f.store), /unresolved/);

  const publish = () => f.journal.appendReservedDocumentByteExecutionDecision({
    operationId: f.context.operationId, writerId: candidateFacts.writerId,
    writerEpoch: f.context.writerEpoch, preparationDigest: candidateFacts.preparationDigest,
    candidateGeneration: control.generation, candidateEntryDigest: candidate.entryDigest,
    candidateEnvelopeDigest: candidate.envelopeDigest, decisionEnvelopeDigest: preserved.digest,
  }, f.store);
  await assert.rejects(f.journal.appendReservedDocumentByteExecutionDecision({
    operationId: f.context.operationId, writerId: candidateFacts.writerId,
    writerEpoch: f.context.writerEpoch, preparationDigest: candidateFacts.preparationDigest,
    candidateGeneration: control.generation, candidateEntryDigest: '0'.repeat(64),
    candidateEnvelopeDigest: candidate.envelopeDigest, decisionEnvelopeDigest: preserved.digest,
  }, f.store), /exact published candidate/);
  f.loseAck(true);
  await assert.rejects(publish(), /unknown/);
  const receipt = await publish();
  assert.equal(receipt.replayed, true);
  assert.equal(receipt.actionAuthorized, false);
  const source = { async readHead() { const value = await f.store.readControl();
    return { installationId: value.installationId, organisationId: value.organisationId,
      generation: value.generation, digest: value.digest, revision: value.revision }; } };
  const published = await f.journal.readPublishedEntry(f.context.operationId,
    'DOCUMENT_BYTE_EXECUTION_DECISION_V1', source);
  assert.equal(published.entry.factsDigest, preserved.digest);
  assert.equal(published.actionAuthorized, false);
  const verified = await readPublishedDocumentByteExecutionDecision(f.journal,
    f.store, f.context, f.keys, f.store);
  assert.equal(verified.body, decision.body);
  assert.equal(verified.generation, control.generation + 1);
  assert.equal(verified.actionAuthorized, false);
  assert.equal((await f.store.readControl()).activeOperation?.operationId, f.context.operationId);
  assert.equal((await publish()).replayed, true);
  state.copyHolds.push({ id: 'new-hold-before-claim', held: true });
  await assert.rejects(claimVerifiedDocumentByteExecutionLease(prisma,
    f.journal, f.store, f.context, f.keys, f.store), /copy or hold facts/);
  state.copyHolds.length = 0;
  assert.ok(state.candidateBinding);
  state.candidateBinding.writerEpoch = 2;
  await assert.rejects(claimVerifiedDocumentByteExecutionLease(prisma,
    f.journal, f.store, f.context, f.keys, f.store), /candidate binding differs/);
  state.candidateBinding.writerEpoch = f.context.writerEpoch;
  assert.equal(state.leaseCreates, 0);
  const claimed = await claimVerifiedDocumentByteExecutionLease(prisma,
    f.journal, f.store, f.context, f.keys, f.store);
  assert.equal(claimed.leaseId, 'lease');
  assert.equal(claimed.actionAuthorized, false);
  assert.equal(state.leaseCreates, 1);
  assert.ok(state.claimedAt);
  const lease = state.lease!;
  await assert.rejects(claimVerifiedDocumentByteExecutionLease(prisma,
    f.journal, f.store, f.context, f.keys, f.store), /changed or cannot be bounded/);
  const matched = () => readMatchedClaimedDocumentByteDecision(prisma, f.journal,
    f.store, f.context, f.keys, f.store, 'lease', JSON.parse(decision.body).oneUseAttemptId);
  assert.equal((await matched()).actionAuthorized, false);
  const started = () => readMatchedStartedDocumentByteDecision(prisma, f.journal,
    f.store, f.context, f.keys, f.store, 'lease', JSON.parse(decision.body).oneUseAttemptId);
  await assert.rejects(started(), /provider start differs/);
  const start = () => startVerifiedDocumentByteProviderAttempt(prisma, f.journal,
    f.store, f.context, f.keys, f.store, 'lease');
  state.copyHolds.push({ id: 'new-hold-before-start', held: true });
  await assert.rejects(start(), /copy or hold authority changed/);
  assert.equal(state.startCalls, 0);
  state.copyHolds.length = 0;
  const head = f.objects.get(f.headKey);
  assert.ok(head);
  f.objects.delete(f.headKey);
  await assert.rejects(start(), /current head is unavailable/);
  assert.equal(state.startCalls, 0);
  f.objects.set(f.headKey, head);
  const marker = await start();
  assert.equal(marker.actionAuthorized, false);
  assert.equal(marker.decisionEntryDigest, verified.entryDigest);
  assert.equal(marker.startedAttempt.startedTransactionId, '124');
  await assert.rejects(start(), /Synthetic provider start refused/);
  assert.equal(state.startCalls, 2);
  assert.equal((await started()).actionAuthorized, false);
  const attempt = state.attempt;
  assert.ok(attempt);
  attempt.startedTransactionId = 123n;
  await assert.rejects(started(), /provider start differs/);
  attempt.startedTransactionId = 124n;
  attempt.decisionEntryDigest = '0'.repeat(64);
  await assert.rejects(started(), /provider start differs/);
  attempt.decisionEntryDigest = verified.entryDigest;
  attempt.startedAt = new Date('2026-10-07T08:02:59.000Z');
  await assert.rejects(started(), /provider start differs/);
  attempt.startedAt = new Date('2026-10-07T08:03:01.000Z');
  attempt.deletionId = 'other-job';
  await assert.rejects(started(), /provider start differs/);
  attempt.deletionId = candidateFacts.deletionId;
  lease.decisionBodyDigest = '0'.repeat(64);
  await assert.rejects(matched(), /differs from current independent decision/);
  lease.decisionBodyDigest = createHash('sha256').update(decision.body).digest('hex');
  lease.providerInventoryDigest = '0'.repeat(64);
  await assert.rejects(matched(), /differs from current independent decision/);
  lease.providerInventoryDigest = 'c'.repeat(64);
  state.copyHolds.push({ id: 'later-hold', held: true });
  await assert.rejects(matched(), /copy or hold authority changed/);
  state.copyHolds.length = 0;
  await assert.rejects(readMatchedClaimedDocumentByteDecision(prisma, f.journal,
    f.store, f.context, f.keys, f.store, 'lease',
    '22222222-2222-4222-8222-222222222222'), /attempt differs/);
  const candidateKey = [...f.objects.keys()].find(key => key.startsWith('document-byte-permits/'));
  assert.ok(candidateKey);
  const candidateObject = f.objects.get(candidateKey)!;
  f.objects.delete(candidateKey);
  await assert.rejects(readPublishedDocumentByteExecutionDecision(f.journal,
    f.store, f.context, f.keys, f.store), /unresolved/);
  f.objects.set(candidateKey, candidateObject);
  const decisionKey = [...f.objects.keys()].find(key => key.startsWith('document-byte-execution-decisions/'));
  assert.ok(decisionKey);
  const decisionObject = f.objects.get(decisionKey)!;
  f.objects.delete(decisionKey);
  await assert.rejects(readPublishedDocumentByteExecutionDecision(f.journal,
    f.store, f.context, f.keys, f.store), /unresolved/);
  f.objects.set(decisionKey, decisionObject);
  f.objects.delete(f.headKey);
  await assert.rejects(matched());
  await assert.rejects(started());
});

test('primary absence observation needs a durable start, never authorizes completion, and stops once UNKNOWN is the head', async () => {
  const { f, prisma, state } = await readyBytePermitPublisher();
  const scope = { installationId: f.context.installationId,
    organisationId: f.context.organisationId, operationId: f.context.operationId };
  await publishVerifiedDocumentBytePermitCandidate(prisma,
    f.journal, f.store, f.context, f.keys, f.store);
  const candidate = await readPublishedDocumentBytePermit(f.journal, f.store,
    f.context, f.keys, f.store);
  await bindVerifiedDocumentBytePermitCandidate(prisma,
    f.journal, f.store, f.context, f.keys, f.store);
  const local = await readCurrentDocumentByteAuthority(prisma, scope);
  const prior = JSON.parse(candidate.body);
  const control = await f.store.readControl();
  const decision = prepareDocumentByteExecutionDecisionFacts({ format: 1,
    action: 'DOCUMENT_PRIMARY_BYTE_EXECUTION_DECISION',
    ...scope, writerId: prior.writerId, writerEpoch: f.context.writerEpoch,
    sourceRevision: f.context.sourceRevision, preparationDigest: prior.preparationDigest,
    candidateBodyDigest: createHash('sha256').update(candidate.body).digest('hex'),
    candidateEntryDigest: candidate.entryDigest, candidateEnvelopeDigest: candidate.envelopeDigest,
    candidateGeneration: candidate.generation, candidateAuthorityDigest: prior.currentAuthorityDigest,
    controlRevision: control.revision, outcomeId: prior.outcomeId, claimId: prior.claimId,
    deletionId: prior.deletionId, authorizationId: prior.authorizationId,
    documentId: prior.documentId, actorUserId: prior.actorUserId, provider: prior.provider,
    storagePath: prior.storagePath, objectSha256: prior.objectSha256, fileSize: prior.fileSize,
    copyDispositionDigest: local.localCopyObservationDigest,
    holdStateDigest: local.localHoldObservationDigest,
    providerInventoryDigest: 'c'.repeat(64), decisionEvidenceRef: 'SYNTHETIC-UNKNOWN-001',
    oneUseAttemptId: '11111111-1111-4111-8111-111111111111',
    issuedAt: '2026-10-07T08:00:00.000Z' });
  const preserved = await preserveDocumentByteExecutionDecision(decision.body,
    f.context, f.keys, f.store);
  await f.journal.appendReservedDocumentByteExecutionDecision({
    operationId: f.context.operationId, writerId: prior.writerId,
    writerEpoch: f.context.writerEpoch, preparationDigest: prior.preparationDigest,
    candidateGeneration: candidate.generation, candidateEntryDigest: candidate.entryDigest,
    candidateEnvelopeDigest: candidate.envelopeDigest, decisionEnvelopeDigest: preserved.digest,
  }, f.store);
  await claimVerifiedDocumentByteExecutionLease(prisma,
    f.journal, f.store, f.context, f.keys, f.store);
  const observe = (at: Date) => recordVerifiedDocumentBytePrimaryAbsence(prisma,
    f.journal, f.store, f.context, f.keys, f.store, 'lease', at);
  const at = new Date('2026-10-07T08:03:02.000Z');
  await assert.rejects(observe(new Date(Number.NaN)), /observation time is invalid/);
  await assert.rejects(observe(at), /provider start differs|start observation is unavailable/);
  assert.equal(state.observeCalls, 0);
  await startVerifiedDocumentByteProviderAttempt(prisma,
    f.journal, f.store, f.context, f.keys, f.store, 'lease');
  state.copyHolds.push({ id: 'hold-before-observation', held: true });
  await assert.rejects(observe(at), /copy or hold authority changed/);
  assert.equal(state.observeCalls, 0);
  state.copyHolds.length = 0;
  state.observationNotRecorded = true;
  await assert.rejects(observe(at), /did not commit/);
  state.observationNotRecorded = false;
  const observed = await observe(at);
  assert.equal(observed.actionAuthorized, false);
  assert.equal(observed.outcome, 'PRIMARY_ACTIVE_OBJECT_ABSENT');
  assert.equal(observed.providerObservedAt.getTime(), at.getTime());
  assert.equal(state.observeCalls, 2);
  assert.equal(state.boundAttempt, JSON.parse(decision.body).oneUseAttemptId);
  await assert.rejects(observe(at), /Synthetic provider observation refused/);
  // A stored row that differs from the requested observation is refused
  // rather than reported back as if it were this observation.
  for (const change of [
    { providerObservedAt: new Date('2026-10-07T08:03:02.500Z') },
    { providerObservedAt: new Date('2026-10-07T08:03:00.500Z') },
    { attemptId: 'other-lease' }, { id: 'other-lease' },
    { decisionEntryDigest: '0'.repeat(64) }, { outcome: 'COMPLETED' },
  ]) {
    state.observation = null;
    state.observationView = row => ({ ...row, ...change });
    await assert.rejects(observe(at), /unavailable or mismatched/);
  }
  state.observationView = null;
  // A provider time before the durable start cannot be reported, even if the
  // database row echoes it.
  state.observation = null;
  await assert.rejects(observe(new Date('2026-10-07T08:03:00.500Z')), /unavailable or mismatched/);
  // Once the independent UNKNOWN entry is the head, this immediate path is
  // closed; a later observation must go through a reconciliation reader.
  state.observation = null;
  await publishVerifiedDocumentByteProviderUnknown(prisma,
    f.journal, f.store, f.context, f.keys, f.store, 'lease');
  const callsBefore = state.observeCalls;
  await assert.rejects(observe(at), /current independent head/);
  assert.equal(state.observeCalls, callsBefore);
  // Reconciliation path: the published UNKNOWN must remain the head and equal
  // the committed local marker; the SQL capability check stays authoritative.
  const capability = JSON.parse(decision.body).oneUseAttemptId as string;
  state.expectedAttempt = capability;
  const reconcile = (attemptId: string, when: Date) =>
    recordReconciledDocumentBytePrimaryAbsence(prisma, f.journal, f.store,
      f.context, f.keys, f.store, 'lease', attemptId, when);
  const later = new Date('2026-10-07T09:00:00.000Z');
  await assert.rejects(reconcile(capability, new Date(Number.NaN)), /observation time is invalid/);
  await assert.rejects(reconcile('22222222-2222-4222-8222-222222222222', later),
    /capability does not match/);
  assert.equal(state.observation, null);
  const attemptRow = state.attempt!;
  attemptRow.startedTransactionId = 999n;
  const callsBeforeMismatch = state.observeCalls;
  await assert.rejects(reconcile(capability, later), /differs from local marker/);
  assert.equal(state.observeCalls, callsBeforeMismatch);
  attemptRow.startedTransactionId = 124n;
  const unknownHeadKey = f.headKey;
  const savedHead = f.objects.get(unknownHeadKey)!;
  f.objects.delete(unknownHeadKey);
  await assert.rejects(reconcile(capability, later));
  assert.equal(state.observeCalls, callsBeforeMismatch);
  f.objects.set(unknownHeadKey, savedHead);
  for (const change of [
    { providerObservedAt: new Date('2026-10-07T09:00:00.500Z') },
    { attemptId: 'other-lease' }, { id: 'other-lease' }, { deletionId: 'other-job' },
    { decisionEntryDigest: '0'.repeat(64) }, { outcome: 'COMPLETED' },
  ]) {
    state.observation = null;
    state.observationView = row => ({ ...row, ...change });
    await assert.rejects(reconcile(capability, later), /unavailable or mismatched/);
  }
  state.observationView = null;
  state.observation = null;
  await assert.rejects(reconcile(capability, new Date('2026-10-07T08:03:00.500Z')),
    /unavailable or mismatched/);
  // The head is re-authenticated after the SQL call: losing it there refuses
  // the result even though the database accepted the row.
  state.observation = null;
  state.duringObserve = () => { f.objects.delete(unknownHeadKey); };
  await assert.rejects(reconcile(capability, later));
  assert.ok(state.observation);
  state.duringObserve = null;
  f.objects.set(unknownHeadKey, savedHead);
  state.observation = null;
  state.observationNotRecorded = true;
  await assert.rejects(reconcile(capability, later), /did not commit/);
  state.observationNotRecorded = false;
  const reconciled = await reconcile(capability, later);
  assert.equal(reconciled.actionAuthorized, false);
  assert.equal(reconciled.outcome, 'PRIMARY_ACTIVE_OBJECT_ABSENT');
  assert.equal(reconciled.providerObservedAt.getTime(), later.getTime());
  assert.equal(reconciled.decisionEntryDigest, observed.decisionEntryDigest);
  const head = await readPublishedDocumentByteProviderUnknown(f.journal,
    f.store, f.context, f.keys, f.store);
  assert.equal(reconciled.unknownEntryDigest, head.entryDigest);
  await assert.rejects(reconcile(capability, later), /Synthetic provider observation refused/);
});

// Adapter for the cases below: wraps one eraser in a dispatcher that records
// which provider the executor asked for.
const dispatchedProviders: string[] = [];
type ExecuteArgs = Parameters<typeof executeWithDispatcher>;
function executeVerifiedDocumentBytePrimaryDeletion(prisma: ExecuteArgs[0], journal: ExecuteArgs[1],
  control: ExecuteArgs[2], context: ExecuteArgs[3], keys: ExecuteArgs[4], objects: ExecuteArgs[5],
  erase: Eraser, timeoutMs?: number) {
  return executeWithDispatcher(prisma, journal, control, context, keys, objects,
    (provider) => { dispatchedProviders.push(provider); return erase; }, timeoutMs);
}

async function decidedBytePermit(storageProvider: 'local' | 'supabase' = 'local') {
  const { f, prisma, state } = await readyBytePermitPublisher(storageProvider);
  const scope = { installationId: f.context.installationId,
    organisationId: f.context.organisationId, operationId: f.context.operationId };
  await publishVerifiedDocumentBytePermitCandidate(prisma,
    f.journal, f.store, f.context, f.keys, f.store);
  const candidate = await readPublishedDocumentBytePermit(f.journal, f.store,
    f.context, f.keys, f.store);
  await bindVerifiedDocumentBytePermitCandidate(prisma,
    f.journal, f.store, f.context, f.keys, f.store);
  const local = await readCurrentDocumentByteAuthority(prisma, scope);
  const prior = JSON.parse(candidate.body);
  const control = await f.store.readControl();
  const decision = prepareDocumentByteExecutionDecisionFacts({ format: 1,
    action: 'DOCUMENT_PRIMARY_BYTE_EXECUTION_DECISION',
    ...scope, writerId: prior.writerId, writerEpoch: f.context.writerEpoch,
    sourceRevision: f.context.sourceRevision, preparationDigest: prior.preparationDigest,
    candidateBodyDigest: createHash('sha256').update(candidate.body).digest('hex'),
    candidateEntryDigest: candidate.entryDigest, candidateEnvelopeDigest: candidate.envelopeDigest,
    candidateGeneration: candidate.generation, candidateAuthorityDigest: prior.currentAuthorityDigest,
    controlRevision: control.revision, outcomeId: prior.outcomeId, claimId: prior.claimId,
    deletionId: prior.deletionId, authorizationId: prior.authorizationId,
    documentId: prior.documentId, actorUserId: prior.actorUserId, provider: prior.provider,
    storagePath: prior.storagePath, objectSha256: prior.objectSha256, fileSize: prior.fileSize,
    copyDispositionDigest: local.localCopyObservationDigest,
    holdStateDigest: local.localHoldObservationDigest,
    providerInventoryDigest: 'c'.repeat(64), decisionEvidenceRef: 'SYNTHETIC-UNKNOWN-001',
    oneUseAttemptId: '11111111-1111-4111-8111-111111111111',
    issuedAt: '2026-10-07T08:00:00.000Z' });
  const preserved = await preserveDocumentByteExecutionDecision(decision.body,
    f.context, f.keys, f.store);
  await f.journal.appendReservedDocumentByteExecutionDecision({
    operationId: f.context.operationId, writerId: prior.writerId,
    writerEpoch: f.context.writerEpoch, preparationDigest: prior.preparationDigest,
    candidateGeneration: candidate.generation, candidateEntryDigest: candidate.entryDigest,
    candidateEnvelopeDigest: candidate.envelopeDigest, decisionEnvelopeDigest: preserved.digest,
  }, f.store);
  return { f, prisma, state, decision };
}

test('protected primary deletion calls the eraser once for the exact decided target and records absence without authorizing completion', async () => {
  const { f, prisma, state, decision } = await decidedBytePermit();
  const facts = JSON.parse(decision.body);
  const calls: unknown[] = [];
  const result = await executeVerifiedDocumentBytePrimaryDeletion(prisma, f.journal,
    f.store, f.context, f.keys, f.store, async (target) => {
      calls.push(target);
      return new Date('2026-10-07T08:03:02.000Z');
    });
  assert.equal(result.outcome, 'PRIMARY_ABSENCE_OBSERVED');
  assert.equal(result.actionAuthorized, false);
  assert.equal(result.providerCalled, true);
  assert.deepEqual(calls, [{ organisationId: facts.organisationId,
    storagePath: facts.storagePath, targetRef: null }]);
  assert.equal(state.startCalls, 1);
  assert.equal(state.observeCalls, 1);
  assert.equal(state.observation?.outcome, 'PRIMARY_ACTIVE_OBJECT_ABSENT');
  assert.equal(state.boundAttempt, facts.oneUseAttemptId);
});

test('protected primary deletion selects the eraser by the decided provider and refuses an unregistered one before any claim', async () => {
  for (const storageProvider of ['local', 'supabase'] as const) {
    const { f, prisma, decision } = await decidedBytePermit(storageProvider);
    const decided = JSON.parse(decision.body).provider;
    assert.equal(decided, storageProvider);
    const asked: string[] = [];
    let localCalls = 0; let supabaseCalls = 0;
    const result = await executeWithDispatcher(prisma, f.journal, f.store, f.context, f.keys, f.store,
      (provider) => {
        asked.push(provider);
        if (provider === 'local') return async () => { localCalls += 1; return new Date('2026-10-07T08:03:02.000Z'); };
        if (provider === 'supabase') return async () => { supabaseCalls += 1; return new Date('2026-10-07T08:03:02.000Z'); };
        return undefined;
      });
    assert.equal(result.outcome, 'PRIMARY_ABSENCE_OBSERVED');
    assert.deepEqual(asked, [decided]);
    assert.equal(localCalls + supabaseCalls, 1);
    assert.equal(decided === 'local' ? localCalls : supabaseCalls, 1);
  }
  {
    const { f, prisma, state } = await decidedBytePermit();
    await assert.rejects(executeWithDispatcher(prisma, f.journal, f.store, f.context, f.keys, f.store,
      () => undefined), /No eraser is registered for decided provider/);
    assert.equal(state.leaseCreates, 0);
    assert.equal(state.startCalls, 0);
  }
});

test('protected primary deletion keeps the lease as UNKNOWN when the start marker cannot be read back', async () => {
  const { f, prisma, state } = await decidedBytePermit();
  state.refuseStartBeforeMarker = true;
  (prisma as unknown as { documentByteProviderAttempt: { findUnique: () => Promise<unknown> } })
    .documentByteProviderAttempt.findUnique = async () => { throw new Error('database unavailable'); };
  let eraseCalls = 0;
  const result = await executeVerifiedDocumentBytePrimaryDeletion(prisma, f.journal,
    f.store, f.context, f.keys, f.store, async () => { eraseCalls += 1; return new Date(); });
  assert.equal(result.outcome, 'UNKNOWN');
  assert.equal(result.outcome === 'UNKNOWN' && result.reason, 'START_OUTCOME_UNREADABLE');
  assert.equal(result.leaseId, 'lease');
  assert.equal(result.providerCalled, false);
  assert.equal(eraseCalls, 0);
});

test('protected primary deletion leaves every post-start failure UNKNOWN, publishes it and never retries the provider', async () => {
  const cases: Array<{ name: string; erase: (target: unknown, signal?: AbortSignal) => Promise<Date | void>;
    arrange?: (state: Record<string, unknown>) => void; reason: string; timeoutMs?: number }> = [
    { name: 'error', reason: 'PROVIDER_ERROR', erase: async () => { throw new Error('provider refused'); } },
    { name: 'void', reason: 'NO_ABSENCE_OBSERVATION', erase: async () => undefined },
    { name: 'invalid date', reason: 'NO_ABSENCE_OBSERVATION', erase: async () => new Date(Number.NaN) },
    { name: 'timeout', reason: 'PROVIDER_TIMEOUT', timeoutMs: 10,
      erase: (_target, signal) => new Promise((_resolve, reject) => {
        // A late rejection after the abort must be absorbed, not crash the process.
        signal?.addEventListener('abort', () => setTimeout(() => reject(new Error('late failure')), 5));
      }) },
    { name: 'observation not recorded', reason: 'OBSERVATION_NOT_RECORDED',
      arrange: (state) => { state.observationNotRecorded = true; },
      erase: async () => new Date('2026-10-07T08:03:02.000Z') },
  ];
  for (const c of cases) {
    const { f, prisma, state } = await decidedBytePermit();
    c.arrange?.(state as unknown as Record<string, unknown>);
    let eraseCalls = 0;
    const result = await executeVerifiedDocumentBytePrimaryDeletion(prisma, f.journal,
      f.store, f.context, f.keys, f.store, (target, signal) => { eraseCalls += 1; return c.erase(target, signal); },
      c.timeoutMs);
    assert.equal(result.outcome, 'UNKNOWN', c.name);
    assert.equal(result.outcome === 'UNKNOWN' && result.reason, c.reason, c.name);
    assert.equal(result.providerCalled, true, c.name);
    assert.equal(result.outcome === 'UNKNOWN' && result.unknownPublished, true, c.name);
    assert.equal(result.actionAuthorized, false, c.name);
    assert.equal(eraseCalls, 1, c.name);
    const published = await readPublishedDocumentByteProviderUnknown(f.journal,
      f.store, f.context, f.keys, f.store);
    assert.equal(published.actionAuthorized, false, c.name);
    if (c.name !== 'observation not recorded') assert.equal(state.observeCalls, 0, c.name);
  }
  await new Promise(resolve => setTimeout(resolve, 30));
});

test('protected primary deletion never calls the provider when authority changes after the start marker or the claim is refused', async () => {
  {
    const { f, prisma, state } = await decidedBytePermit();
    state.duringStart = () => { state.copyHolds.push({ id: 'hold-after-start', held: true }); };
    let eraseCalls = 0;
    const result = await executeVerifiedDocumentBytePrimaryDeletion(prisma, f.journal,
      f.store, f.context, f.keys, f.store, async () => { eraseCalls += 1; return new Date(); });
    assert.equal(result.outcome, 'UNKNOWN');
    assert.equal(result.outcome === 'UNKNOWN' && result.reason, 'PRE_IO_RECHECK_FAILED');
    assert.equal(result.providerCalled, false);
    assert.equal(eraseCalls, 0);
    assert.equal(state.startCalls, 1);
  }
  {
    // The start service's own post-marker read passes; the hold appears at the
    // executor's separate immediate pre-provider read (two reads later).
    const { f, prisma, state } = await decidedBytePermit();
    state.duringStart = () => { state.mutateAtRead = state.reads + 3; };
    let eraseCalls = 0;
    const result = await executeVerifiedDocumentBytePrimaryDeletion(prisma, f.journal,
      f.store, f.context, f.keys, f.store, async () => { eraseCalls += 1; return new Date(); });
    assert.equal(result.outcome, 'UNKNOWN');
    assert.equal(result.outcome === 'UNKNOWN' && result.reason, 'PRE_IO_RECHECK_FAILED');
    assert.equal(result.providerCalled, false);
    assert.equal(eraseCalls, 0);
  }
  {
    // A start refused before any marker commits is an error, not UNKNOWN.
    const { f, prisma, state } = await decidedBytePermit();
    state.refuseStartBeforeMarker = true;
    let eraseCalls = 0;
    await assert.rejects(executeVerifiedDocumentBytePrimaryDeletion(prisma, f.journal,
      f.store, f.context, f.keys, f.store, async () => { eraseCalls += 1; return new Date(); }),
    /Synthetic provider start refused/);
    assert.equal(eraseCalls, 0);
    assert.equal(state.attempt, null);
  }
  {
    const { f, prisma, state } = await decidedBytePermit();
    state.copyHolds.push({ id: 'hold-before-claim', held: true });
    let eraseCalls = 0;
    await assert.rejects(executeVerifiedDocumentBytePrimaryDeletion(prisma, f.journal,
      f.store, f.context, f.keys, f.store, async () => { eraseCalls += 1; return new Date(); }),
    /copy or hold facts/);
    assert.equal(eraseCalls, 0);
    assert.equal(state.startCalls, 0);
    assert.equal(state.leaseCreates, 0);
  }
  {
    const { f, prisma } = await decidedBytePermit();
    for (const timeoutMs of [0, 9, 10_001, 1.5]) {
      await assert.rejects(executeVerifiedDocumentBytePrimaryDeletion(prisma, f.journal,
        f.store, f.context, f.keys, f.store, async () => new Date(), timeoutMs), TypeError);
    }
  }
});

// Executes the attempt (absence observed while the decision is the head) and
// publishes its UNKNOWN, which every completion must follow.
async function observedAndUnknown() {
  const { f, prisma, state, decision } = await decidedBytePermit();
  const capability = JSON.parse(decision.body).oneUseAttemptId as string;
  const publish = () => publishVerifiedDocumentBytePrimaryCompletion(prisma,
    f.journal, f.store, f.context, f.keys, f.store, 'lease');
  const finalize = (attempt = capability) => finalizeVerifiedDocumentBytePrimaryCompletion(prisma,
    f.journal, f.store, f.context, f.keys, f.store, 'lease', attempt);
  // Nothing to reconcile before an attempt has started.
  await assert.rejects(publish(), /unavailable or mismatched/);
  const result = await executeVerifiedDocumentBytePrimaryDeletion(prisma, f.journal,
    f.store, f.context, f.keys, f.store, async () => new Date('2026-10-07T08:03:02.000Z'));
  assert.equal(result.outcome, 'PRIMARY_ABSENCE_OBSERVED');
  // An observation alone cannot complete: the UNKNOWN must be published first.
  const before = await f.store.readControl();
  await assert.rejects(publish(), /not published/);
  await assert.rejects(finalize(), /not published/);
  assert.equal((await f.store.readControl()).generation, before.generation);
  const unknown = await publishVerifiedDocumentByteProviderUnknown(prisma,
    f.journal, f.store, f.context, f.keys, f.store, 'lease');
  return { f, prisma, state, capability, publish, finalize, unknown, before };
}

test('a primary completion reconciles the published UNKNOWN with the recorded observation, and nothing else', async () => {
  const { f, state, publish, finalize, unknown, before } = await observedAndUnknown();
  const marker = JSON.parse(unknown.body);
  // The journal refuses a completion that does not follow the exact UNKNOWN.
  await assert.rejects(f.journal.appendReservedDocumentBytePrimaryCompletion({
    operationId: f.context.operationId, writerId: marker.writerId, writerEpoch: marker.writerEpoch,
    preparationDigest: marker.preparationDigest, unknownGeneration: unknown.generation,
    unknownEntryDigest: '0'.repeat(64), unknownEnvelopeDigest: unknown.envelopeDigest,
    completionEnvelopeDigest: '1'.repeat(64),
  }, f.store), /exact published UNKNOWN/);
  // A local observation that disagrees with the committed marker is refused
  // before anything is written.
  for (const change of [
    { deletionId: 'other-job' }, { decisionEntryDigest: '0'.repeat(64) }, { outcome: 'COMPLETED' },
    { observedTransactionId: 124n }, { attemptId: 'other-lease' }, { id: 'other-lease' },
    { providerObservedAt: new Date('2026-10-07T08:03:00.500Z') },
    { recordedAt: new Date('2026-10-07T08:03:01.500Z') },
  ]) {
    state.observationView = row => ({ ...row, ...change });
    await assert.rejects(publish(), /unavailable or mismatched/, JSON.stringify(Object.keys(change)));
  }
  state.observationView = null;
  assert.equal((await f.store.readControl()).generation, before.generation + 1);
  // A lost head acknowledgement is recovered from the published entry.
  f.loseAck(true);
  await assert.rejects(publish(), /unknown/);
  const published = await publish();
  assert.equal(published.replayed, true);
  assert.equal(published.actionAuthorized, false);
  const facts = JSON.parse(published.body);
  assert.deepEqual([facts.scope, facts.outcome, facts.leaseId, facts.deletionId,
    facts.unknownEntryDigest, facts.decisionEntryDigest, facts.providerObservedAt],
  ['PRIMARY_ACTIVE_OBJECT_ONLY', 'PRIMARY_ACTIVE_OBJECT_ABSENT', 'lease', 'job',
    unknown.entryDigest, marker.decisionEntryDigest, '2026-10-07T08:03:02.000Z']);
  assert.equal((await f.store.readControl()).generation, before.generation + 2);
  assert.equal((await publish()).entryDigest, published.entryDigest, 'a replay changes nothing');
  assert.equal((await f.store.readControl()).generation, before.generation + 2);
  // A published completion that no longer matches the local observation is
  // refused, on replay and before any local change.
  state.observationView = row => ({ ...row, providerObservedAt: new Date('2026-10-07T08:03:02.500Z') });
  await assert.rejects(publish(), /differs from local observation/);
  await assert.rejects(finalize(), /differs from local observation/);
  state.observationView = null;
  assert.equal(state.completionCalls, 0);
  // Encrypted, immutable and scoped to this operation.
  const envelope = await f.store.readDocumentBytePrimaryCompletion(f.context.operationId);
  assert.ok(envelope);
  assert.doesNotMatch(envelope, /DOCUMENT_PRIMARY_BYTE_COMPLETION|PRIMARY_ACTIVE_OBJECT_ONLY|vault\/synthetic-object/);
  await assert.rejects(f.store.createDocumentBytePrimaryCompletion('other-operation', envelope), /scope mismatch/);
  const key = [...f.objects.keys()].find(k => k.startsWith('document-byte-primary-completions/'));
  assert.ok(key);
  const saved = f.objects.get(key)!;
  f.objects.delete(key);
  await assert.rejects(readPublishedDocumentBytePrimaryCompletion(f.journal,
    f.store, f.context, f.keys, f.store), /unresolved/);
  await assert.rejects(finalize(), /unresolved/);
  f.objects.set(key, saved);
  // The UNKNOWN is no longer the head, so it cannot be published again and
  // no later attempt stage can start.
  await assert.rejects(readPublishedDocumentByteProviderUnknown(f.journal,
    f.store, f.context, f.keys, f.store), /current exact decision/);
  assert.equal(state.completionCalls, 0);
});

test('finalizing a primary completion processes only its job, needs the capability, and keeps the operation reserved', async () => {
  const { f, state, capability, publish, finalize } = await observedAndUnknown();
  const published = await publish();
  assert.equal(published.replayed, false);
  state.expectedAttempt = capability;
  await assert.rejects(finalize('not-a-capability'), /Invalid document byte attempt capability/);
  assert.equal(state.completionCalls, 0, 'a malformed capability never reaches SQL');
  await assert.rejects(finalize('22222222-2222-4222-8222-222222222222'), /capability does not match/);
  assert.equal(state.job.state, 'PENDING');
  state.completionNotRecorded = true;
  await assert.rejects(finalize(), /did not commit/);
  state.completionNotRecorded = false;
  assert.equal(state.job.state, 'PENDING');
  const done = await finalize();
  assert.deepEqual([done.scope, done.replayed, done.operationReservationReleased, done.actionAuthorized,
    done.deletionId, done.completionEntryDigest],
  ['PRIMARY_ACTIVE_OBJECT_ONLY', false, false, false, 'job', published.entryDigest]);
  assert.equal(state.job.state, 'PROCESSED');
  assert.equal(state.job.activeObjectAbsentAt?.toISOString(), '2026-10-07T08:03:02.000Z');
  assert.equal(state.completion?.completionBodyDigest, createHash('sha256').update(published.body).digest('hex'));
  const calls = state.completionCalls;
  const again = await finalize();
  assert.equal(again.replayed, true);
  assert.equal(state.completionCalls, calls, 'a completed lease is reported again, never re-applied');
  // A stored row or job that differs is refused rather than reported.
  for (const change of [
    { completionEntryDigest: '0'.repeat(64) }, { completionEnvelopeDigest: '0'.repeat(64) },
    { completionBodyDigest: '0'.repeat(64) }, { scope: 'ALL_COPIES' }, { deletionId: 'other-job' },
    { observationId: 'other-lease' }, { decisionEntryDigest: '0'.repeat(64) },
    { recordedAt: new Date('2026-10-07T09:30:01.000Z') },
  ]) {
    state.completionView = row => ({ ...row, ...change });
    await assert.rejects(finalize(), /unavailable or mismatched/, JSON.stringify(Object.keys(change)));
  }
  state.completionView = null;
  for (const job of [{ state: 'PENDING' }, { activeObjectAbsentAt: new Date('2026-10-07T08:03:03.000Z') },
    { processedAt: null }]) {
    const saved = { ...state.job };
    Object.assign(state.job, job);
    await assert.rejects(finalize(), /unavailable or mismatched/, JSON.stringify(job));
    state.job = saved;
  }
  // Other copies are not covered: the recovery operation stays reserved.
  const reservation = await f.store.readControl();
  assert.equal(reservation.activeOperation?.operationId, f.context.operationId);
});

test('a finalize that loses an overlapping race reports the winning completion instead of failing', async () => {
  const { state, publish, finalize } = await observedAndUnknown();
  const published = await publish();
  // The other call commits first; this call's SQL then refuses the lease.
  state.beforeCompletion = () => {
    state.beforeCompletion = null;
    state.completion = { id: 'lease', leaseId: 'lease', observationId: 'lease',
      organisationId: 'charity', deletionId: 'job',
      decisionEntryDigest: state.observation!.decisionEntryDigest,
      completionEntryDigest: published.entryDigest, completionEnvelopeDigest: published.envelopeDigest,
      completionBodyDigest: createHash('sha256').update(published.body).digest('hex'),
      scope: 'PRIMARY_ACTIVE_OBJECT_ONLY', completedTransactionId: 127n,
      recordedAt: new Date('2026-10-07T09:29:59.000Z') };
    state.job = { state: 'PROCESSED', processedAt: new Date('2026-10-07T09:30:00.000Z'),
      activeObjectAbsentAt: state.observation!.providerObservedAt as Date };
  };
  const result = await finalize();
  assert.deepEqual([result.replayed, result.completionEntryDigest, result.deletionId],
    [true, published.entryDigest, 'job']);
  assert.equal(state.completionCalls, 1);
});

test('a primary completion whose head is lost after the local commit is refused, then reported on replay', async () => {
  const { f, state, publish, finalize } = await observedAndUnknown();
  await publish();
  const head = f.objects.get(f.headKey)!;
  state.duringCompletion = () => { f.objects.delete(f.headKey); };
  await assert.rejects(finalize());
  state.duringCompletion = null;
  assert.equal(state.job.state, 'PROCESSED');
  f.objects.set(f.headKey, head);
  const calls = state.completionCalls;
  const recovered = await finalize();
  assert.equal(recovered.replayed, true);
  assert.equal(state.completionCalls, calls);
});

// Publishes an UNKNOWN and a completion that are validly encrypted and
// correctly chained in the journal, but whose facts were altered: what a
// writer holding the keys could forge. Readers must still refuse them.
async function forgedChain(unknownChange: Record<string, unknown>) {
  const { f, prisma } = await decidedBytePermit();
  await executeVerifiedDocumentBytePrimaryDeletion(prisma, f.journal, f.store, f.context,
    f.keys, f.store, async () => new Date('2026-10-07T08:03:02.000Z'));
  const request = { installationId: f.context.installationId,
    organisationId: f.context.organisationId, operationId: f.context.operationId, leaseId: 'lease' };
  const local = await readCommittedDocumentByteProviderUnknown(prisma, request);
  const marker = { ...JSON.parse(local.body), ...unknownChange };
  const unknownBody = prepareDocumentByteProviderUnknownFacts(marker).body;
  const preservedUnknown = await preserveDocumentByteProviderUnknown(unknownBody, f.context, f.keys, f.store);
  const decision = await readPublishedDocumentByteExecutionDecision(f.journal, f.store,
    f.context, f.keys, f.store);
  const unknown = await f.journal.appendReservedDocumentByteProviderUnknown({
    operationId: f.context.operationId, writerId: marker.writerId, writerEpoch: marker.writerEpoch,
    preparationDigest: marker.preparationDigest, decisionGeneration: decision.generation,
    decisionEntryDigest: decision.entryDigest, decisionEnvelopeDigest: decision.envelopeDigest,
    unknownEnvelopeDigest: preservedUnknown.digest,
  }, f.store);
  const observed = await readRecordedDocumentBytePrimaryObservation(prisma, request);
  const complete = async (completionChange: Record<string, unknown>) => {
    const body = prepareDocumentBytePrimaryCompletionFacts({ format: 1,
      action: 'DOCUMENT_PRIMARY_BYTE_COMPLETION', scope: 'PRIMARY_ACTIVE_OBJECT_ONLY',
      outcome: 'PRIMARY_ACTIVE_OBJECT_ABSENT', installationId: request.installationId,
      organisationId: request.organisationId, operationId: request.operationId,
      writerId: marker.writerId, writerEpoch: marker.writerEpoch, sourceRevision: marker.sourceRevision,
      preparationDigest: marker.preparationDigest, leaseId: 'lease', deletionId: observed.deletionId,
      decisionEntryDigest: marker.decisionEntryDigest, unknownEntryDigest: unknown.digest,
      unknownEnvelopeDigest: preservedUnknown.digest,
      unknownBodyDigest: createHash('sha256').update(unknownBody).digest('hex'),
      providerObservedAt: observed.providerObservedAt.toISOString(),
      observedTransactionId: observed.observedTransactionId,
      observationRecordedAt: observed.observationRecordedAt.toISOString(), ...completionChange }).body;
    const preserved = await preserveDocumentBytePrimaryCompletion(body, f.context, f.keys, f.store);
    await f.journal.appendReservedDocumentBytePrimaryCompletion({
      operationId: f.context.operationId, writerId: marker.writerId, writerEpoch: marker.writerEpoch,
      preparationDigest: marker.preparationDigest, unknownGeneration: unknown.generation,
      unknownEntryDigest: unknown.digest, unknownEnvelopeDigest: preservedUnknown.digest,
      completionEnvelopeDigest: preserved.digest,
    }, f.store);
    return readPublishedDocumentBytePrimaryCompletion(f.journal, f.store, f.context, f.keys, f.store);
  };
  return { f, prisma, complete };
}

test('a validly encrypted completion is refused unless every fact agrees with its UNKNOWN', async () => {
  const sane = await forgedChain({});
  assert.equal((await sane.complete({})).actionAuthorized, false, 'the unaltered chain reads');
  for (const change of [
    { unknownEntryDigest: '0'.repeat(64) }, { unknownEnvelopeDigest: '0'.repeat(64) },
    { unknownBodyDigest: '0'.repeat(64) }, { decisionEntryDigest: '0'.repeat(64) },
    { preparationDigest: '0'.repeat(64) }, { leaseId: 'other-lease' }, { deletionId: 'other-job' },
    { writerId: 'other-writer' }, { observedTransactionId: '124' },
    { providerObservedAt: '2026-10-07T08:03:00.000Z' },
    { observationRecordedAt: '2026-10-07T08:03:01.500Z' },
  ]) {
    const { complete } = await forgedChain({});
    await assert.rejects(complete(change), /does not match its authenticated UNKNOWN|reservation changed/,
      JSON.stringify(change));
  }
  // An UNKNOWN that names another decision is refused even when the
  // completion repeats its claim.
  for (const change of [{ decisionEntryDigest: '0'.repeat(64) }, { decisionEnvelopeDigest: '0'.repeat(64) }]) {
    const { complete } = await forgedChain(change);
    await assert.rejects(complete(change.decisionEntryDigest ? change : {}),
      /does not match its authenticated UNKNOWN/, JSON.stringify(change));
  }
});

test('the completion publisher refuses a published UNKNOWN that differs from the local marker', async () => {
  const { f, prisma } = await forgedChain({ startedAt: '2026-10-07T08:03:01.500Z' });
  const before = await f.store.readControl();
  await assert.rejects(publishVerifiedDocumentBytePrimaryCompletion(prisma,
    f.journal, f.store, f.context, f.keys, f.store, 'lease'), /differs from local marker/);
  assert.equal((await f.store.readControl()).generation, before.generation);
});

test('a completion that is no longer the head is not reported', async () => {
  const { f, complete } = await forgedChain({});
  const published = await complete({});
  const publisher = {
    async readHead() {
      const value = await f.store.readControl();
      return { installationId: value.installationId, organisationId: value.organisationId,
        generation: value.generation, digest: value.digest, revision: value.revision };
    },
    async compareAndSwap(expectedRevision: string, next: { generation: number; digest: string | null }) {
      const { revision, ...value } = await f.store.readControl();
      if (revision !== expectedRevision) return false;
      return f.store.compareAndSwapControl(revision, { ...value, ...next });
    },
  };
  await f.journal.appendPublished({ operationId: 'later-standalone', kind: 'PRESERVATION_CHANGE',
    factsDigest: 'e'.repeat(64), expectedGeneration: published.generation,
    expectedDigest: published.entryDigest }, publisher);
  await assert.rejects(readPublishedDocumentBytePrimaryCompletion(f.journal,
    f.store, f.context, f.keys, f.store), /does not follow the current exact UNKNOWN/);
});

test('committed provider start publishes one encrypted independent UNKNOWN and recovers a lost head acknowledgement', async () => {
  const { f, prisma, state } = await readyBytePermitPublisher();
  const scope = { installationId: f.context.installationId,
    organisationId: f.context.organisationId, operationId: f.context.operationId };
  await publishVerifiedDocumentBytePermitCandidate(prisma,
    f.journal, f.store, f.context, f.keys, f.store);
  const candidate = await readPublishedDocumentBytePermit(f.journal, f.store,
    f.context, f.keys, f.store);
  await bindVerifiedDocumentBytePermitCandidate(prisma,
    f.journal, f.store, f.context, f.keys, f.store);
  const local = await readCurrentDocumentByteAuthority(prisma, scope);
  const prior = JSON.parse(candidate.body);
  const control = await f.store.readControl();
  const decision = prepareDocumentByteExecutionDecisionFacts({ format: 1,
    action: 'DOCUMENT_PRIMARY_BYTE_EXECUTION_DECISION',
    ...scope, writerId: prior.writerId, writerEpoch: f.context.writerEpoch,
    sourceRevision: f.context.sourceRevision, preparationDigest: prior.preparationDigest,
    candidateBodyDigest: createHash('sha256').update(candidate.body).digest('hex'),
    candidateEntryDigest: candidate.entryDigest, candidateEnvelopeDigest: candidate.envelopeDigest,
    candidateGeneration: candidate.generation, candidateAuthorityDigest: prior.currentAuthorityDigest,
    controlRevision: control.revision, outcomeId: prior.outcomeId, claimId: prior.claimId,
    deletionId: prior.deletionId, authorizationId: prior.authorizationId,
    documentId: prior.documentId, actorUserId: prior.actorUserId, provider: prior.provider,
    storagePath: prior.storagePath, objectSha256: prior.objectSha256, fileSize: prior.fileSize,
    copyDispositionDigest: local.localCopyObservationDigest,
    holdStateDigest: local.localHoldObservationDigest,
    providerInventoryDigest: 'c'.repeat(64), decisionEvidenceRef: 'SYNTHETIC-UNKNOWN-001',
    oneUseAttemptId: '11111111-1111-4111-8111-111111111111',
    issuedAt: '2026-10-07T08:00:00.000Z' });
  const preserved = await preserveDocumentByteExecutionDecision(decision.body,
    f.context, f.keys, f.store);
  await f.journal.appendReservedDocumentByteExecutionDecision({
    operationId: f.context.operationId, writerId: prior.writerId,
    writerEpoch: f.context.writerEpoch, preparationDigest: prior.preparationDigest,
    candidateGeneration: candidate.generation, candidateEntryDigest: candidate.entryDigest,
    candidateEnvelopeDigest: candidate.envelopeDigest, decisionEnvelopeDigest: preserved.digest,
  }, f.store);
  await claimVerifiedDocumentByteExecutionLease(prisma,
    f.journal, f.store, f.context, f.keys, f.store);
  const request = { ...scope, leaseId: 'lease' };
  await assert.rejects(readCommittedDocumentByteProviderUnknown(prisma, request),
    /unavailable or mismatched/);
  const before = await f.store.readControl();
  await assert.rejects(publishVerifiedDocumentByteProviderUnknown(prisma,
    f.journal, f.store, f.context, f.keys, f.store, 'lease'), /unavailable or mismatched/);
  assert.equal((await f.store.readControl()).generation, before.generation);
  await startVerifiedDocumentByteProviderAttempt(prisma,
    f.journal, f.store, f.context, f.keys, f.store, 'lease');
  const bounded = await readCommittedDocumentByteProviderUnknown(prisma, request);
  assert.equal(JSON.parse(bounded.body).decisionBodyDigest,
    createHash('sha256').update(decision.body).digest('hex'));
  assert.doesNotMatch(bounded.body, /vault\/synthetic-object/);
  const exactDecision = await readPublishedDocumentByteExecutionDecision(f.journal,
    f.store, f.context, f.keys, f.store);
  await assert.rejects(f.journal.appendReservedDocumentByteProviderUnknown({
    operationId: f.context.operationId, writerId: prior.writerId,
    writerEpoch: f.context.writerEpoch, preparationDigest: prior.preparationDigest,
    decisionGeneration: exactDecision.generation, decisionEntryDigest: '0'.repeat(64),
    decisionEnvelopeDigest: exactDecision.envelopeDigest,
    unknownEnvelopeDigest: '1'.repeat(64),
  }, f.store), /exact published decision/);
  assert.equal((await f.store.readControl()).generation, before.generation);
  f.loseAck(true);
  await assert.rejects(publishVerifiedDocumentByteProviderUnknown(prisma,
    f.journal, f.store, f.context, f.keys, f.store, 'lease'), /unknown/);
  const replay = await publishVerifiedDocumentByteProviderUnknown(prisma,
    f.journal, f.store, f.context, f.keys, f.store, 'lease');
  assert.equal(replay.replayed, true);
  assert.equal(replay.actionAuthorized, false);
  const read = await readPublishedDocumentByteProviderUnknown(f.journal,
    f.store, f.context, f.keys, f.store);
  assert.equal(read.body, bounded.body);
  assert.equal(read.actionAuthorized, false);
  assert.equal((await f.store.readControl()).generation, before.generation + 1);
  const envelope = await f.store.readDocumentByteProviderUnknown(f.context.operationId);
  assert.ok(envelope);
  assert.doesNotMatch(envelope, /DOCUMENT_PRIMARY_BYTE_PROVIDER_OUTCOME_UNKNOWN|vault\/synthetic-object/);
  await assert.rejects(f.store.createDocumentByteProviderUnknown('other-operation', envelope), /scope mismatch/);
  const unknownKey = [...f.objects.keys()].find(key => key.startsWith('document-byte-provider-unknown/'));
  assert.ok(unknownKey);
  const unknownObject = f.objects.get(unknownKey)!;
  f.objects.delete(unknownKey);
  await assert.rejects(readPublishedDocumentByteProviderUnknown(f.journal,
    f.store, f.context, f.keys, f.store), /unresolved/);
  f.objects.set(unknownKey, unknownObject);
  await assert.rejects(startVerifiedDocumentByteProviderAttempt(prisma,
    f.journal, f.store, f.context, f.keys, f.store, 'lease'), /current independent head/);
  assert.equal(state.startCalls, 1);
});

test('verified document byte candidate publisher refuses changed local facts before journal append', async () => {
  const { f, prisma, state } = await readyBytePermitPublisher();
  state.changeAfterFirstRead = true;
  await assert.rejects(publishVerifiedDocumentBytePermitCandidate(prisma,
    f.journal, f.store, f.context, f.keys, f.store), /authority changed before publication/);
  assert.equal((await f.store.readControl()).generation, 2);
  assert.ok(await f.store.readDocumentBytePermit(f.context.operationId));
});

test('authenticated candidate binding is exact, replayable and never authorizes bytes', async () => {
  const { f, prisma, state } = await readyBytePermitPublisher();
  await publishVerifiedDocumentBytePermitCandidate(prisma,
    f.journal, f.store, f.context, f.keys, f.store);
  const bind = () => bindVerifiedDocumentBytePermitCandidate(prisma,
    f.journal, f.store, f.context, f.keys, f.store);
  const first = await bind();
  assert.deepEqual(first, { bindingId: 'binding', replayed: false, actionAuthorized: false });
  const published = await readPublishedDocumentBytePermit(f.journal, f.store,
    f.context, f.keys, f.store);
  assert.equal(state.candidateBinding?.permitEntryDigest, published.entryDigest);
  assert.equal(state.candidateBinding?.permitEnvelopeDigest, published.envelopeDigest);
  assert.equal(state.candidateBinding?.controlRevision, published.revision);
  assert.equal(state.candidateBinding?.outcomeId, 'outcome');
  assert.equal(state.candidateBinding?.claimId, 'claim');
  assert.equal(state.candidateBinding?.deletionId, 'job');
  assert.equal(state.candidateBinding?.currentAuthorityDigest,
    JSON.parse(published.body).currentAuthorityDigest);
  assert.deepEqual(await bind(),
    { bindingId: 'binding', replayed: true, actionAuthorized: false });
  assert.equal(state.bindingCreates, 1);
  state.candidateBinding = { ...state.candidateBinding, objectSha256: '0'.repeat(64) };
  await assert.rejects(bind(), /differs from committed row/);
  assert.equal(state.bindingCreates, 1);
});

test('candidate binding refuses a local change under its transaction lock', async () => {
  const { f, prisma, state } = await readyBytePermitPublisher();
  await publishVerifiedDocumentBytePermitCandidate(prisma,
    f.journal, f.store, f.context, f.keys, f.store);
  state.reads = 0;
  state.mutateAtRead = 3;
  await assert.rejects(bindVerifiedDocumentBytePermitCandidate(prisma,
    f.journal, f.store, f.context, f.keys, f.store), /differs from locked local authority/);
  assert.equal(state.bindingCreates, 0);
});

test('candidate binding reports a post-commit authority change and leaves an inert row', async () => {
  const { f, prisma, state } = await readyBytePermitPublisher();
  await publishVerifiedDocumentBytePermitCandidate(prisma,
    f.journal, f.store, f.context, f.keys, f.store);
  state.reads = 0;
  state.mutateAtRead = 4;
  await assert.rejects(bindVerifiedDocumentBytePermitCandidate(prisma,
    f.journal, f.store, f.context, f.keys, f.store), /current local authority/);
  assert.equal(state.bindingCreates, 1);
  assert.ok(state.candidateBinding);
});

test('document byte permit candidate uses separate encrypted immutable storage and remains non-executable', async () => {
  const f = await fixture();
  const facts = prepareDocumentBytePermitFacts({ format: 1,
    action: 'DOCUMENT_PRIMARY_BYTE_PERMIT_CANDIDATE',
    installationId: f.context.installationId, organisationId: f.context.organisationId,
    operationId: f.context.operationId, writerId: 'host', writerEpoch: f.context.writerEpoch,
    sourceRevision: f.context.sourceRevision,
    preparationDigest: f.prepared.digest, preparationEntryDigest: 'a'.repeat(64),
    preparationEnvelopeDigest: 'b'.repeat(64), preparationGeneration: 1,
    outcomeBodyDigest: 'c'.repeat(64), outcomeEntryDigest: 'd'.repeat(64),
    outcomeEnvelopeDigest: 'e'.repeat(64), outcomeGeneration: 2,
    controlRevision: 'synthetic-revision', currentAuthorityDigest: 'f'.repeat(64),
    outcomeId: 'outcome', claimId: 'claim', deletionId: 'job',
    authorizationId: f.facts.authorization.id, documentId: f.facts.document.id,
    actorUserId: f.facts.actorUserId, provider: f.facts.authorization.provider,
    storagePath: f.facts.authorization.storagePath,
    objectSha256: f.facts.authorization.sha256, fileSize: f.facts.authorization.fileSize,
    issuedAt: '2026-10-04T00:03:00.000Z' });
  f.loseAck();
  await assert.rejects(preserveDocumentBytePermit(facts.body, f.context, f.keys, f.store), /unresolved/);
  const saved = await preserveDocumentBytePermit(facts.body, f.context, f.keys, f.store);
  assert.equal(saved.replayed, true); assert.equal(saved.actionAuthorized, false);
  const envelope = await f.store.readDocumentBytePermit(f.context.operationId);
  assert.ok(envelope);
  assert.equal([...f.objects.keys()].filter(k => k.startsWith('document-byte-permits/')).length, 1);
  assert.equal(await f.store.readDocumentOutcome(f.context.operationId), null);
  assert.doesNotMatch(envelope!, /vault\/synthetic-object|DOCUMENT_PRIMARY_BYTE_PERMIT_CANDIDATE/);
  const verified = await readVerifiedDocumentBytePermit(saved.digest, f.context, f.keys, f.store);
  assert.equal(verified.body, facts.body); assert.equal(verified.actionAuthorized, false);
  assert.equal((await f.store.readControl()).generation, 0);
  await assert.rejects(f.store.createDocumentOutcome(f.context.operationId, envelope!), /envelope/);
  await assert.rejects(f.store.createDocumentBytePermit('other-operation', envelope!), /scope mismatch/);
  await assert.rejects(openDocumentBytePermit(JSON.stringify({ ...JSON.parse(envelope!),
    kind: 'DOCUMENT_PURGE_OUTCOME' }), f.context, f.keys), /decrypted/);
  await assert.rejects(readVerifiedDocumentBytePermit('0'.repeat(64), f.context, f.keys, f.store), /unresolved/);
  await assert.rejects(preserveDocumentBytePermit(facts.body.replace('synthetic-revision', 'changed-revision'),
    f.context, f.keys, f.store), /unresolved/);
  for (const key of f.objects.keys()) if (key.startsWith('document-byte-permits/')) f.objects.delete(key);
  await assert.rejects(readVerifiedDocumentBytePermit(saved.digest, f.context, f.keys, f.store), /unresolved/);
  assert.throws(() => prepareDocumentBytePermitFacts({ ...JSON.parse(facts.body),
    outcomeGeneration: 3 }), /Invalid/);
});

test('document publication refuses missing, changed, foreign and stale facts without journal writes', async () => {
  for (const scenario of ['missing', 'facts', 'foreign', 'control', 'occupied']) {
    const f = await fixture();
    if (scenario !== 'missing') {
      if (scenario === 'facts') f.facts.authorization.reason = 'Another synthetic decision';
      await preserveDocumentRecoveryPreparation(prepareDocumentRecoveryFacts(f.facts).body,
        f.context, f.keys, f.store);
    }
    if (scenario === 'foreign') {
      const original = await f.store.readDocumentPreparation(f.context.operationId);
      await assert.rejects(f.store.createDocumentPreparation('foreign-operation', original!), /scope mismatch/);
    }
    if (scenario === 'control') {
      const unwrap = f.keys.unwrap;
      f.keys.unwrap = async () => {
        const head = f.objects.get(f.headKey)!, value = JSON.parse(head.body);
        value.publicationId = '22222222-2222-4222-8222-222222222222';
        f.objects.set(f.headKey, { body: JSON.stringify(value), version: head.version + 1 });
        return unwrap();
      };
    }
    if (scenario === 'occupied') {
      const head = f.objects.get(f.headKey)!, value = JSON.parse(head.body);
      value.activeOperation.operationId = 'another-unresolved-operation';
      f.objects.set(f.headKey, { body: JSON.stringify(value), version: head.version + 1 });
    }
    const context = scenario === 'foreign' ? { ...f.context, organisationId: 'foreign' } : f.context;
    await assert.rejects(publishVerifiedDocumentPreparation(f.journal, f.store,
      f.request, context, f.keys, f.store));
    assert.equal([...f.objects.keys()].filter(key => /\/[0-9]{10}\.json$/.test(key)).length, 0);
  }
});

test('document claim outcome publishes only the committed result and remains occupied', async () => {
  const f = await fixture();
  await preserveDocumentRecoveryPreparation(f.prepared.body, f.context, f.keys, f.store);
  const prepReceipt = await publishVerifiedDocumentPreparation(f.journal, f.store,
    f.request, f.context, f.keys, f.store);
  const preparationEnvelope = await f.store.readDocumentPreparation(f.context.operationId);
  const preparationEnvelopeDigest = createHash('sha256').update(preparationEnvelope!).digest('hex');
  const control = await f.store.readControl();
  const transactionId = 9007199254740993n;
  const row = { id: 'outcome', transactionId,
    recordedAt: new Date('2026-10-04T00:02:01.000Z'),
    preparation: { id: 'preparation', installationId: f.context.installationId,
      organisationId: f.context.organisationId, operationId: f.context.operationId,
      writerEpoch: f.context.writerEpoch, authorizationId: f.facts.authorization.id,
      actorUserId: f.facts.actorUserId, facts: f.prepared.body,
      factsDigest: f.prepared.digest,
      execution: { writerId: f.request.writerId, generation: prepReceipt.generation,
        entryDigest: prepReceipt.digest, envelopeDigest: preparationEnvelopeDigest,
        controlRevision: control.revision, transactionId } },
    claim: { id: 'claim', organisationId: f.context.organisationId,
      authorizationId: f.facts.authorization.id, documentId: f.facts.document.id,
      deletionId: 'job', actorUserId: f.facts.actorUserId, transactionId,
      claimedAt: new Date('2026-10-04T00:02:00.000Z'),
      deletion: { id: 'job', organisationId: f.context.organisationId,
        sourceDocumentId: f.facts.document.id,
        storagePath: f.facts.authorization.storagePath,
        provider: f.facts.authorization.provider } } };
  const prisma = { documentRecoveryOutcome: { async findFirst() { return row; } } } as unknown as PrismaClient;
  const committed = await readCommittedDocumentOutcome(prisma, {
    organisationId: f.context.organisationId, installationId: f.context.installationId,
    operationId: f.context.operationId });
  f.loseAck();
  await assert.rejects(preserveDocumentOutcome(committed.body, f.context, f.keys, f.store), /unresolved/);
  assert.equal((await preserveDocumentOutcome(committed.body, f.context, f.keys, f.store)).replayed, true);
  const envelope = await f.store.readDocumentOutcome(f.context.operationId);
  assert.ok(envelope);
  assert.equal([...f.objects.keys()].filter(key => key.startsWith('document-outcomes/')).length, 1);
  assert.equal(await f.store.readOutcome(f.context.operationId), null);
  assert.doesNotMatch(envelope!, /SENSITIVE_SYNTHETIC_DISPOSAL_REASON|vault\/synthetic-object/);
  const request = { writerId: f.request.writerId, preparationDigest: f.prepared.digest,
    preparationGeneration: prepReceipt.generation,
    preparationEntryDigest: prepReceipt.digest, preparationEnvelopeDigest };
  const publish = () => publishVerifiedDocumentOutcome(f.journal, f.store,
    prisma, request, f.context, f.keys, f.store);
  row.claim.deletion.storagePath = 'foreign';
  await assert.rejects(publish, /binding mismatch/);
  row.claim.deletion.storagePath = f.facts.authorization.storagePath;
  await assert.rejects(publishVerifiedDocumentOutcome(f.journal, f.store,
    prisma, { ...request, preparationEntryDigest: '0'.repeat(64) },
    f.context, f.keys, f.store), /committed claim and preparation/);
  assert.equal([...f.objects.keys()].filter(key => /\/[0-9]{10}\.json$/.test(key)).length, 1);
  const originalUnwrap = f.keys.unwrap;
  f.keys.unwrap = async () => {
    const head = f.objects.get(f.headKey)!, value = JSON.parse(head.body);
    value.publicationId = '44444444-4444-4444-8444-444444444444';
    f.objects.set(f.headKey, { body: JSON.stringify(value), version: head.version + 1 });
    return originalUnwrap();
  };
  await assert.rejects(publish, /control changed/);
  f.keys.unwrap = originalUnwrap;
  f.loseAck(true);
  await assert.rejects(publish, /unknown/);
  assert.equal((await publish()).headPublished, true);
  const published = await readPublishedDocumentOutcome(f.journal, f.store, f.context, f.keys, f.store);
  assert.equal(published.body, committed.body);
  assert.equal(published.actionAuthorized, false);
  assert.equal((await f.store.readControl()).activeOperation?.operationId, f.context.operationId);
  const candidateFacts = prepareDocumentBytePermitFacts({ format: 1,
    action: 'DOCUMENT_PRIMARY_BYTE_PERMIT_CANDIDATE',
    installationId: f.context.installationId, organisationId: f.context.organisationId,
    operationId: f.context.operationId, writerId: f.request.writerId,
    writerEpoch: f.context.writerEpoch, sourceRevision: f.context.sourceRevision,
    preparationDigest: f.prepared.digest, preparationEntryDigest: prepReceipt.digest,
    preparationEnvelopeDigest, preparationGeneration: prepReceipt.generation,
    outcomeBodyDigest: committed.digest, outcomeEntryDigest: published.entryDigest,
    outcomeEnvelopeDigest: published.envelopeDigest,
    outcomeGeneration: prepReceipt.generation + 1,
    controlRevision: (await f.store.readControl()).revision,
    currentAuthorityDigest: 'f'.repeat(64),
    outcomeId: row.id, claimId: row.claim.id, deletionId: row.claim.deletionId,
    authorizationId: row.claim.authorizationId, documentId: row.claim.documentId,
    actorUserId: row.claim.actorUserId, provider: f.facts.authorization.provider,
    storagePath: f.facts.authorization.storagePath,
    objectSha256: f.facts.authorization.sha256, fileSize: f.facts.authorization.fileSize,
    issuedAt: '2026-10-04T00:03:00.000Z' });
  const candidate = await preserveDocumentBytePermit(candidateFacts.body, f.context, f.keys, f.store);
  const permitRequest = { writerId: f.request.writerId, writerEpoch: f.context.writerEpoch,
    operationId: f.context.operationId, preparationDigest: f.prepared.digest,
    outcomeGeneration: prepReceipt.generation + 1,
    outcomeEntryDigest: published.entryDigest, outcomeEnvelopeDigest: published.envelopeDigest,
    permitEnvelopeDigest: candidate.digest };
  await assert.rejects(f.journal.appendReservedDocumentBytePermit({ ...permitRequest,
    outcomeEntryDigest: '0'.repeat(64) }, f.store), /exact published claim outcome/);
  f.loseAck(true);
  await assert.rejects(f.journal.appendReservedDocumentBytePermit(permitRequest, f.store), /unknown/);
  const permit = await f.journal.appendReservedDocumentBytePermit(permitRequest, f.store);
  assert.equal(permit.generation, prepReceipt.generation + 2);
  assert.equal(permit.actionAuthorized, false);
  assert.equal(permit.replayed, true);
  assert.equal((await f.journal.appendReservedDocumentBytePermit(permitRequest, f.store)).replayed, true);
  assert.equal((await f.store.readControl()).activeOperation?.operationId, f.context.operationId);
  const readPermit = await readPublishedDocumentBytePermit(f.journal, f.store,
    f.context, f.keys, f.store);
  assert.equal(readPermit.body, candidateFacts.body);
  assert.equal(readPermit.actionAuthorized, false);
  const localDigest = 'f'.repeat(64);
  const matched = await compareDocumentBytePermitAuthority(
    async () => readPermit, async () => ({ digest: localDigest, actionAuthorized: false }));
  assert.equal(matched.currentAuthorityDigest, localDigest);
  assert.equal(matched.actionAuthorized, false);
  await assert.rejects(compareDocumentBytePermitAuthority(
    async () => readPermit, async () => ({ digest: 'e'.repeat(64), actionAuthorized: false })),
  /differs from current local authority/);
  let independentReads = 0;
  await assert.rejects(compareDocumentBytePermitAuthority(
    async () => ({ ...readPermit, revision: `${readPermit.revision}-${++independentReads}` }),
    async () => ({ digest: localDigest, actionAuthorized: false })),
  /changed during local authority read/);
  let localReads = 0;
  await assert.rejects(compareDocumentBytePermitAuthority(
    async () => readPermit,
    async () => ({ digest: ++localReads === 1 ? localDigest : 'e'.repeat(64),
      actionAuthorized: false })), /authority changed during independent permit read/);
  assert.equal((await readPublishedDocumentOutcome(f.journal, f.store,
    f.context, f.keys, f.store)).body, committed.body);
  await assert.rejects(f.journal.appendReservedDocumentBytePermit({ ...permitRequest,
    permitEnvelopeDigest: 'e'.repeat(64) }, f.store), /different facts/);
  f.keys.unwrap = async () => {
    const head = f.objects.get(f.headKey)!, value = JSON.parse(head.body);
    value.publicationId = '55555555-5555-4555-8555-555555555555';
    f.objects.set(f.headKey, { body: JSON.stringify(value), version: head.version + 1 });
    return originalUnwrap();
  };
  await assert.rejects(readPublishedDocumentOutcome(f.journal, f.store,
    f.context, f.keys, f.store), /changed while reading/);
  await assert.rejects(readPublishedDocumentBytePermit(f.journal, f.store,
    f.context, f.keys, f.store), /changed while reading/);
  f.keys.unwrap = originalUnwrap;
  await assert.rejects(f.store.createOutcome(f.context.operationId, envelope!), /envelope/);
  await assert.rejects(readVerifiedDocumentOutcome('0'.repeat(64), f.context, f.keys, f.store), /unresolved/);
  for (const key of f.objects.keys()) if (key.startsWith('document-outcomes/')) f.objects.delete(key);
  await assert.rejects(readPublishedDocumentOutcome(f.journal, f.store,
    f.context, f.keys, f.store), /unresolved/);
  await assert.rejects(readPublishedDocumentBytePermit(f.journal, f.store,
    f.context, f.keys, f.store), /unresolved/);
});
