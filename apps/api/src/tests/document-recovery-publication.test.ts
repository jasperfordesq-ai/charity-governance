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
import { readPublishedDocumentBytePermit } from '../services/published-document-byte-permit.js';

function documentFacts() {
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
    fileUrl: 'vault/synthetic-object', storageProvider: 'local' as const, fileSize: 123 };
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

async function fixture() {
  const facts = documentFacts(), prepared = prepareDocumentRecoveryFacts(facts);
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
