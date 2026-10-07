import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { prepareDocumentRecoveryFacts } from '../services/document-recovery-preparation.js';
import { openDocumentRecoveryPreparation, preserveDocumentRecoveryPreparation,
  readVerifiedDocumentRecoveryPreparation } from '../services/document-recovery-envelope.js';
import { publishVerifiedDocumentPreparation,
  readPublishedDocumentPreparation } from '../services/published-document-preparation.js';
import { S3AuthorityObjectStore } from '../services/recovery-authority-s3.js';
import { RecoveryAuthorityJournal } from '../services/recovery-authority-journal.js';
import { reserveRecoveryOperation, validateRecoveryControlValue } from '../services/recovery-operation-reservation.js';

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
