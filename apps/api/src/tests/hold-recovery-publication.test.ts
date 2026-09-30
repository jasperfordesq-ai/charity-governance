import type { PrismaClient } from '@prisma/client';
import { releaseCommittedHoldOperation } from '../services/release-hold-recovery-operation.js';
import { prepareComplaintHoldOutcomeFacts } from '../services/complaint-hold-recovery-outcome.js';
import { preserveHoldOutcome } from '../services/hold-outcome-envelope.js';
import { publishVerifiedHoldOutcome, readPublishedHoldOutcome } from '../services/published-hold-outcome.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { prepareComplaintHoldRecoveryFacts } from '../services/complaint-hold-recovery-preparation.js';
import { preserveHoldPreparation, readVerifiedHoldPreparation, openHoldPreparation } from '../services/hold-recovery-envelope.js';
import { publishVerifiedHoldPreparation, readPublishedHoldPreparation } from '../services/published-hold-preparation.js';
import { S3AuthorityObjectStore } from '../services/recovery-authority-s3.js';
import { RecoveryAuthorityJournal } from '../services/recovery-authority-journal.js';
import { reserveRecoveryOperation, validateRecoveryControlValue } from '../services/recovery-operation-reservation.js';

async function fixture() {
  const binding = { installationId: 'installation', organisationId: 'charity' };
  const context = { ...binding, operationId: 'hold-operation', writerEpoch: 1, sourceRevision: 'a'.repeat(40),
    keyId: 'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-4111-8111-111111111111' };
  const facts = { format: 1, action: 'COMPLAINT_HOLD_PREPARATION', ...binding, operationId: context.operationId,
    writerEpoch: 1, actorUserId: 'admin', sourceRevision: context.sourceRevision, preparedAt: '2026-09-30T12:00:00.000Z',
    complaint: { id: 'complaint', organisationId: binding.organisationId, revision: 1 }, previousHold: null,
    decision: { id: 'hold', revision: 1, recordRevision: 1, actorUserId: 'admin', held: true,
      evidenceRef: 'HOLD-001', reason: 'SENSITIVE_PRESERVATION_REASON' } };
  const prepared = prepareComplaintHoldRecoveryFacts(facts);
  const keys = { async generate() { return { key: Buffer.alloc(32, 7), keyId: context.keyId, wrappedKey: Buffer.alloc(48, 1).toString('base64') }; },
    async unwrap() { return { key: Buffer.alloc(32, 7), keyId: context.keyId }; } };
  const config = { ...binding, accountId: '123456789012', bucket: 'synthetic-hold-proof',
    kmsKeyArn: context.keyId.replaceAll('1111', '2222'), replayKeyArn: context.keyId };
  const headKey = `authority/${binding.installationId}/${binding.organisationId}/head.json`;
  const initial = { ...binding, generation: 0, digest: null };
  const control = validateRecoveryControlValue({ format: 2, ...initial, writerId: 'host', writerEpoch: 1, activeOperation: null });
  const objects = new Map<string, { body: string; version: number }>([[headKey, { body: JSON.stringify({ ...control,
    publicationId: '11111111-1111-4111-8111-111111111111' }), version: 1 }]]);
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
      return { ...metadata, VersionId: `v${old.version}`, ETag: etag(old.body), ContentLength: Buffer.byteLength(old.body),
        Body: Readable.from([Buffer.from(old.body)]) };
    }
    if ((command.input.IfNoneMatch === '*' && old) || (command.input.IfMatch && command.input.IfMatch !== etag(old!.body))) {
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
  const request = { writerId: 'host', preparationDigest: prepared.digest, expectedGeneration: 0, expectedDigest: null };
  await reserveRecoveryOperation({ ...binding, ...request, writerEpoch: 1, operationId: context.operationId }, store);
  return { context, facts, prepared, keys, store, journal, objects, request, headKey,
    loseAck: (headOnly = false) => { loseAck = headOnly ? 'head' : 'any'; } };
}

test('hold publication preserves encrypted bytes across lost acknowledgements and retains reservation', async () => {
  const f = await fixture();
  f.loseAck();
  await assert.rejects(preserveHoldPreparation(f.prepared.body, f.context, f.keys, f.store), /unresolved/);
  const preserved = await preserveHoldPreparation(f.prepared.body, f.context, f.keys, f.store);
  assert.equal(preserved.replayed, true);
  const envelope = await f.store.readHoldPreparation(f.context.operationId);
  assert.doesNotMatch(envelope!, /SENSITIVE_PRESERVATION_REASON/);
  f.loseAck();
  const publish = () => publishVerifiedHoldPreparation(f.journal, f.store, f.request, f.context, f.keys, f.store);
  await assert.rejects(publish);
  f.loseAck(true);
  await assert.rejects(publish, /unknown/);
  assert.equal((await publish()).headPublished, true);
  assert.equal(await f.store.readHoldPreparation(f.context.operationId), envelope);
  const read = await readPublishedHoldPreparation(f.journal, f.store, f.context, f.keys, f.store);
  assert.equal(read.body, f.prepared.body); assert.equal(read.actionAuthorized, false);
  assert.equal((await f.store.readControl()).activeOperation!.operationId, f.context.operationId);
  await assert.rejects(f.store.createReplay(f.context.operationId, envelope!), /envelope/);
  const changed = JSON.stringify({ ...JSON.parse(envelope!), kind: 'COMPLAINT_RECOVERY_OUTCOME' });
  await assert.rejects(openHoldPreparation(changed, f.context, f.keys), /decrypted/);
  await assert.rejects(openHoldPreparation(envelope!, { ...f.context, writerEpoch: 2 }, f.keys), /decrypted/);
  const unwrap = f.keys.unwrap;
  f.keys.unwrap = async () => {
    const head = f.objects.get(f.headKey)!; const body = JSON.parse(head.body);
    body.publicationId = '33333333-3333-4333-8333-333333333333';
    f.objects.set(f.headKey, { body: JSON.stringify(body), version: head.version + 1 });
    return unwrap();
  };
  await assert.rejects(readPublishedHoldPreparation(f.journal, f.store, f.context, f.keys, f.store), /changed while reading/);
  for (const key of f.objects.keys()) if (key.startsWith('hold-preparations/')) f.objects.delete(key);
  await assert.rejects(readVerifiedHoldPreparation(preserved.digest, f.context, f.keys, f.store), /unresolved/);
});

test('hold publication refuses unreserved facts, missing payload and changed control before journal writes', async () => {
  for (const scenario of ['facts', 'missing', 'control', 'occupied']) {
    const f = await fixture();
    if (scenario !== 'missing') {
      if (scenario === 'facts') f.facts.decision.reason = 'Different reviewed preservation';
      await preserveHoldPreparation(prepareComplaintHoldRecoveryFacts(f.facts).body, f.context, f.keys, f.store);
    }
    if (scenario === 'control') {
      const unwrap = f.keys.unwrap;
      f.keys.unwrap = async () => {
        const head = f.objects.get(f.headKey)!; const body = JSON.parse(head.body);
        body.publicationId = '22222222-2222-4222-8222-222222222222';
        f.objects.set(f.headKey, { body: JSON.stringify(body), version: head.version + 1 });
        return unwrap();
      };
    }
    if (scenario === 'occupied') {
      const head = f.objects.get(f.headKey)!; const body = JSON.parse(head.body);
      body.activeOperation.operationId = 'another-unresolved-operation';
      f.objects.set(f.headKey, { body: JSON.stringify(body), version: head.version + 1 });
    }
    await assert.rejects(publishVerifiedHoldPreparation(f.journal, f.store, f.request, f.context, f.keys, f.store));
    assert.equal([...f.objects.keys()].filter(key => /\/[0-9]{10}\.json$/.test(key)).length, 0);
  }
});

async function outcomeFixture() {
  const f = await fixture();
  const preserved = await preserveHoldPreparation(f.prepared.body, f.context, f.keys, f.store);
  const preparation = await publishVerifiedHoldPreparation(f.journal, f.store, f.request, f.context, f.keys, f.store);
  const request = { writerId: 'host', preparationDigest: f.prepared.digest,
    preparationGeneration: preparation.generation, preparationEntryDigest: preparation.digest,
    preparationEnvelopeDigest: preserved.digest };
  const facts = { format: 1, action: 'COMPLAINT_HOLD_COMMITTED', installationId: f.context.installationId,
    organisationId: f.context.organisationId, operationId: f.context.operationId, writerEpoch: 1,
    preparationSourceRevision: f.context.sourceRevision, preparationId: 'preparation', preparationDigest: f.prepared.digest,
    outcomeId: 'outcome', holdEventId: 'hold', complaintId: 'complaint', actorUserId: 'admin',
    holdRevision: 1, recordRevision: 1, held: true, transactionId: '123',
    occurredAt: '2026-09-30T12:01:00Z', recordedAt: '2026-09-30T12:01:01Z' };
  return { ...f, outcomeRequest: request, outcomeFacts: facts };
}

test('published hold outcome authenticates both payloads and retries exact bytes without releasing reservation', async () => {
  const f = await outcomeFixture();
  const body = prepareComplaintHoldOutcomeFacts(f.outcomeFacts).body;
  await preserveHoldOutcome(body, f.context, f.keys, f.store);
  const publish = () => publishVerifiedHoldOutcome(f.journal, f.store, f.outcomeRequest, f.context, f.keys, f.store);
  f.loseAck(); await assert.rejects(publish, /unknown/);
  f.loseAck(true); await assert.rejects(publish, /unknown/);
  const before = [...f.objects.entries()];
  assert.equal((await publish()).headPublished, true);
  assert.deepEqual([...f.objects.entries()], before);
  const source = { readHead: async () => { const { installationId, organisationId, generation, digest, revision } = await f.store.readControl();
    return { installationId, organisationId, generation, digest, revision }; } };
  const read = () => readPublishedHoldOutcome(f.journal, source, f.context, f.keys, f.store);
  const result = await read(); assert.equal(result.body, body); assert.equal(result.preparationBody, f.prepared.body);
  assert.equal(result.actionAuthorized, false);
  assert.equal((await f.store.readControl()).activeOperation?.operationId, f.context.operationId);
  const unwrap = f.keys.unwrap;
  f.keys.unwrap = async () => {
    const head = f.objects.get(f.headKey)!; const control = JSON.parse(head.body);
    control.publicationId = '33333333-3333-4333-8333-333333333333';
    f.objects.set(f.headKey, { body: JSON.stringify(control), version: head.version + 1 }); return unwrap();
  };
  await assert.rejects(read, /changed while reading/);
  f.keys.unwrap = unwrap;
  for (const key of f.objects.keys()) if (key.startsWith('hold-outcomes/')) f.objects.delete(key);
  await assert.rejects(read, /unresolved/);
});

test('hold outcome publication refuses mismatched decisions and missing bytes before advancing history', async () => {
  for (const changed of [{ holdEventId: 'wrong' }, { holdRevision: 2 }, { recordRevision: 2 }, { held: false },
    { complaintId: 'wrong' }, { actorUserId: 'wrong' }, { preparationDigest: 'b'.repeat(64) }, null]) {
    const f = await outcomeFixture();
    if (changed) await preserveHoldOutcome(prepareComplaintHoldOutcomeFacts({ ...f.outcomeFacts, ...changed }).body,
      f.context, f.keys, f.store);
    await assert.rejects(publishVerifiedHoldOutcome(f.journal, f.store, f.outcomeRequest, f.context, f.keys, f.store), /match|missing/);
    assert.equal((await f.store.readControl()).generation, 1);
    assert.equal([...f.objects.keys()].filter(key => /\/[0-9]{10}\.json$/.test(key)).length, 1);
  }
});

async function releaseFixture() {
  const f = await outcomeFixture();
  const row = { id: 'outcome', preparationId: 'preparation', holdEventId: 'hold', transactionId: 123n,
    recordedAt: new Date(f.outcomeFacts.recordedAt),
    preparation: { id: 'preparation', organisationId: f.context.organisationId, installationId: f.context.installationId,
      operationId: f.context.operationId, writerEpoch: 1, actorUserId: 'admin', complaintId: 'complaint',
      facts: f.prepared.body, factsDigest: f.prepared.digest },
    holdEvent: { ...f.facts.decision, organisationId: f.context.organisationId, complaintId: 'complaint',
      occurredAt: new Date(f.outcomeFacts.occurredAt) } };
  const prisma = { complaintHoldRecoveryOutcome: { async findFirst() { return row; } } } as unknown as PrismaClient;
  const body = prepareComplaintHoldOutcomeFacts({ ...f.outcomeFacts,
    occurredAt: row.holdEvent.occurredAt.toISOString(), recordedAt: row.recordedAt.toISOString() }).body;
  await preserveHoldOutcome(body, f.context, f.keys, f.store);
  await publishVerifiedHoldOutcome(f.journal, f.store, f.outcomeRequest, f.context, f.keys, f.store);
  const release = () => releaseCommittedHoldOperation(prisma, f.journal, f.store, 'host', f.context, f.keys, f.store);
  return { ...f, row, prisma, release };
}

test('committed hold release survives lost acknowledgement and retains exact published history', async () => {
  const f = await releaseFixture(); const before = await f.store.readControl();
  f.loseAck(true); await assert.rejects(f.release, /unknown/);
  const after = await f.store.readControl(); assert.equal(after.activeOperation, null);
  assert.equal(after.digest, before.digest); assert.equal(after.generation, before.generation);
  assert.equal(after.writerId, before.writerId); assert.equal(after.writerEpoch, before.writerEpoch);
  const objects = [...f.objects.entries()];
  assert.deepEqual(await f.release(), { released: true, replayed: true, actionAuthorized: false });
  assert.deepEqual([...f.objects.entries()], objects);
  await reserveRecoveryOperation({ ...f.request, installationId: f.context.installationId,
    organisationId: f.context.organisationId, writerEpoch: 1, operationId: 'next-operation',
    expectedGeneration: after.generation, expectedDigest: after.digest }, f.store);
  await assert.rejects(f.release, /writer or operation/);
});

test('hold release refuses missing committed evidence, changed facts, stale writer and concurrent control changes', async () => {
  for (const scenario of ['missing', 'facts', 'writer', 'epoch', 'control']) {
    const f = await releaseFixture();
    if (scenario === 'missing') f.prisma.complaintHoldRecoveryOutcome.findFirst = (async () => null) as never;
    if (scenario === 'facts') f.row.id = 'different-committed-outcome';
    if (scenario === 'writer' || scenario === 'epoch') {
      const head = f.objects.get(f.headKey)!; const value = JSON.parse(head.body);
      if (scenario === 'writer') value.writerId = 'different-host'; else value.writerEpoch = 2;
      f.objects.set(f.headKey, { body: JSON.stringify(value), version: head.version + 1 });
    }
    if (scenario === 'control') {
      const read = f.prisma.complaintHoldRecoveryOutcome.findFirst;
      f.prisma.complaintHoldRecoveryOutcome.findFirst = (async () => {
        const head = f.objects.get(f.headKey)!; const value = JSON.parse(head.body);
        value.publicationId = '33333333-3333-4333-8333-333333333333';
        f.objects.set(f.headKey, { body: JSON.stringify(value), version: head.version + 1 });
        return read();
      }) as never;
    }
    await assert.rejects(f.release, /unavailable|does not match|mismatch/);
    assert.notEqual((await f.store.readControl()).activeOperation, null);
  }
});
