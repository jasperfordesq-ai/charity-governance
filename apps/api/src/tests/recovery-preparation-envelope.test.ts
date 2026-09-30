import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { S3AuthorityObjectStore } from '../services/recovery-authority-s3.js';
import { test } from 'node:test';
import { complaintPreparationFixture } from './complaint-preparation-fixture.js';
import { prepareComplaintRecoveryFacts } from '../services/complaint-recovery-preparation.js';
import { openRecoveryPreparation, sealRecoveryPreparation, preserveRecoveryPreparation, inspectRecoveryPreparationEnvelope, type RecoveryDataKeys } from '../services/recovery-preparation-envelope.js';

const keyId = 'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-4111-8111-111111111111';
function fixture() {
  const facts = complaintPreparationFixture();
  const context = { installationId: facts.installationId, organisationId: facts.organisationId,
    operationId: facts.operationId, writerEpoch: facts.writerEpoch, sourceRevision: facts.sourceRevision, keyId };
  const body = prepareComplaintRecoveryFacts(facts).body;
  const retained = new Map<string, Buffer>(); const delivered: Buffer[] = [];
  let generated = 0;
  const keys: RecoveryDataKeys = {
    async generate() {
      generated++;
      const key = randomBytes(32), wrappedKey = randomBytes(48).toString('base64');
      retained.set(wrappedKey, Buffer.from(key)); delivered.push(key); return { key, wrappedKey, keyId };
    },
    async unwrap(wrappedKey) {
      const key = Buffer.from(retained.get(wrappedKey)!); delivered.push(key); return { key, keyId };
    },
  };
  return { context, body, keys, delivered, generations: () => generated };
}

test('recovery envelope round-trips exact candidate bytes with a separately bound data key', async () => {
  const f = fixture();
  const sealed = await sealRecoveryPreparation(f.body, f.context, f.keys);
  assert.equal(sealed.actionAuthorized, false);
  assert.ok(!sealed.envelope.includes('Synthetic reviewed reason'));
  assert.equal((await openRecoveryPreparation(sealed.envelope, f.context, f.keys)).body, f.body);
  assert.ok(f.delivered.every(key => key.every(byte => byte === 0)));
  const second = await sealRecoveryPreparation(f.body, f.context, f.keys);
  assert.notEqual(second.envelope, sealed.envelope);
  assert.notEqual(second.digest, sealed.digest); // Retries must retain the first envelope, not re-seal.
});

test('lost blob acknowledgement preserves the original ciphertext and refuses altered retry facts', async () => {
  const f = fixture(); let saved: string | null = null; let loseAck = true;
  const store = { async readReplay() { return saved; }, async createReplay(_id: string, body: string) {
    if (saved !== null) return false;
    saved = body;
    if (loseAck) { loseAck = false; throw new Error('lost acknowledgement'); }
    return true;
  } };
  await assert.rejects(() => preserveRecoveryPreparation(f.body, f.context, f.keys, store), /unresolved/);
  const bytes = saved!;
  const retry = await preserveRecoveryPreparation(f.body, f.context, f.keys, store);
  assert.equal(retry.digest, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(retry.replayed, true); assert.equal(retry.actionAuthorized, false);
  assert.equal(saved, bytes); assert.equal(f.generations(), 1);
  const changed = JSON.parse(f.body); changed.authorization.reason = 'A different reviewed reason';
  await assert.rejects(() => preserveRecoveryPreparation(prepareComplaintRecoveryFacts(changed).body, f.context, f.keys, store));
  assert.equal(saved, bytes); assert.equal(f.generations(), 1);
});

test('concurrent envelope creators return the same winning stored digest', async () => {
  const f = fixture(); let saved: string | null = null;
  const store = { async readReplay() { return saved; }, async createReplay(_id: string, body: string) {
    if (saved !== null) return false; saved = body; return true;
  } };
  const results = await Promise.all([1, 2].map(() => preserveRecoveryPreparation(f.body, f.context, f.keys, store)));
  assert.equal(results[0]!.digest, results[1]!.digest);
  assert.equal(results.filter(result => result.replayed).length, 1);
  assert.equal(f.generations(), 2);
});

test('S3 replay storage separates encrypted envelopes from small intent entries', async () => {
  const f = fixture(); const objects = new Map<string, string>();
  const credentials = { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' };
  const config = { bucket: 'synthetic-replay-test', accountId: '123456789012',
    installationId: f.context.installationId, organisationId: f.context.organisationId,
    kmsKeyArn: keyId.replace('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'), replayKeyArn: keyId };
  const metadata = { VersionId: 'synthetic-version', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: config.kmsKeyArn };
  const client = new S3Client({ region: 'eu-west-1', credentials }); let calls = 0;
  client.send = (async (command: GetObjectCommand | PutObjectCommand) => {
    calls++;
    assert.equal(command.input.ExpectedBucketOwner, config.accountId);
    assert.equal(command.input.Key, 'replay/install/charity/operation.json');
    if (command instanceof GetObjectCommand) {
      const body = objects.get(command.input.Key!);
      if (!body) throw { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } };
      return { ...metadata, ContentLength: Buffer.byteLength(body), Body: Readable.from([Buffer.from(body)]) };
    }
    assert.equal(command.input.IfNoneMatch, '*'); assert.equal(command.input.SSEKMSKeyId, config.kmsKeyArn);
    if (objects.has(command.input.Key!)) throw { $metadata: { httpStatusCode: 412 } };
    objects.set(command.input.Key!, String(command.input.Body)); return metadata;
  }) as typeof client.send;
  const store = new S3AuthorityObjectStore(config, credentials, client);
  const facts = JSON.parse(f.body); facts.authorization.reason = 'x'.repeat(500); facts.removal.reason = 'y'.repeat(500);
  const body = prepareComplaintRecoveryFacts(facts).body;
  const receipt = await preserveRecoveryPreparation(body, f.context, f.keys, store);
  assert.equal(receipt.actionAuthorized, false);
  assert.ok(Buffer.byteLength([...objects.values()][0]!) > 4096);
  const before = calls;
  await assert.rejects(() => store.create('authority/install/charity/0000000001.json', [...objects.values()][0]!));
  await assert.rejects(() => store.createReplay('other-operation', [...objects.values()][0]!));
  await assert.rejects(() => store.createReplay('operation', '{}'));
  const { replayKeyArn: _key, ...disabledConfig } = config;
  await assert.rejects(() => new S3AuthorityObjectStore(disabledConfig, credentials, client).readReplay('operation'));
  assert.equal(calls, before);
});

test('every recovery binding component refuses substitution before key access', async () => {
  const f = fixture(); const sealed = await sealRecoveryPreparation(f.body, f.context, f.keys);
  for (const [name, value] of Object.entries({ installationId: 'other', organisationId: 'other', operationId: 'other',
    writerEpoch: 2, sourceRevision: 'b'.repeat(40), keyId: keyId.replace('123456789012', '123456789013') })) {
    const count = f.delivered.length;
    await assert.rejects(() => openRecoveryPreparation(sealed.envelope, { ...f.context, [name]: value }, f.keys),
      { message: 'Recovery preparation could not be decrypted' });
    assert.equal(f.delivered.length, count);
  }
});

test('tampering, truncated tags, noncanonical encoding and oversized envelopes refuse', async () => {
  const f = fixture(); const sealed = await sealRecoveryPreparation(f.body, f.context, f.keys);
  type Stored = { sealed: { tag: string; ciphertext: string; generation: number }; wrappedKey: string; kind: string; extra?: string };
  const mutations = [
    (v: Stored) => { v.sealed.tag = Buffer.alloc(4).toString('base64'); },
    (v: Stored) => { v.sealed.ciphertext = 'AAAA' + v.sealed.ciphertext.slice(4); },
    (v: Stored) => { v.wrappedKey += '\n'; },
    (v: Stored) => { v.sealed.generation++; },
    (v: Stored) => { v.kind = 'INTEGRATION_SECRET'; },
    (v: Stored) => { v.extra = 'unexpected'; },
  ];
  for (const mutate of mutations) {
    const value = JSON.parse(sealed.envelope); mutate(value);
    await assert.rejects(() => openRecoveryPreparation(JSON.stringify(value), f.context, f.keys));
  }
  await assert.rejects(() => openRecoveryPreparation(' '.repeat(65537), f.context, f.keys));
  assert.ok(f.delivered.every(key => key.every(byte => byte === 0)));
});

test('wrapped key bytes are authenticated even if a provider returns the same plaintext key', async () => {
  const f = fixture(); const sealed = await sealRecoveryPreparation(f.body, f.context, f.keys);
  const value = JSON.parse(sealed.envelope); const original = value.wrappedKey;
  const unwrap = f.keys.unwrap;
  f.keys.unwrap = (_wrapped, context) => unwrap(original, context);
  value.wrappedKey = Buffer.from('different wrapping of same data key').toString('base64');
  await assert.rejects(() => openRecoveryPreparation(JSON.stringify(value), f.context, f.keys));
  assert.ok(f.delivered.every(key => key.every(byte => byte === 0)));
});

test('wrong provider key identity clears the returned key and hides underlying errors', async () => {
  const f = fixture(); const key = randomBytes(32);
  f.keys.generate = async () => ({ key, keyId: 'wrong', wrappedKey: 'AAAA' });
  await assert.rejects(() => sealRecoveryPreparation(f.body, f.context, f.keys), error => {
    assert.equal((error as Error).message, 'Recovery preparation could not be encrypted');
    assert.equal((error as Error).cause, undefined); return true;
  });
  assert.ok(key.every(byte => byte === 0));
  f.keys.generate = async () => { throw new Error('sensitive provider details'); };
  await assert.rejects(() => sealRecoveryPreparation(f.body, f.context, f.keys), { message: 'Recovery preparation could not be encrypted' });
});

test('unbound or noncanonical candidate facts are refused before generating a data key', async () => {
  const f = fixture(); let calls = 0;
  f.keys.generate = async () => { calls++; throw new Error('must not run'); };
  const foreign = JSON.parse(f.body); foreign.organisationId = 'foreign';
  for (const body of [JSON.stringify(foreign), f.body + ' ', '{malformed', 'x'.repeat(32769)]) {
    await assert.rejects(() => sealRecoveryPreparation(body, f.context, f.keys));
  }
  assert.equal(calls, 0);
});

test('ignored duplicate JSON fields cannot carry plaintext into replay storage', async () => {
  const f = fixture(); const sealed = await sealRecoveryPreparation(f.body, f.context, f.keys);
  const duplicate = sealed.envelope.replace('"wrappedKey":', '"wrappedKey":"unwanted plaintext","wrappedKey":');
  assert.throws(() => inspectRecoveryPreparationEnvelope(duplicate));
  const count = f.delivered.length;
  await assert.rejects(() => openRecoveryPreparation(duplicate, f.context, f.keys));
  assert.equal(f.delivered.length, count);
});
