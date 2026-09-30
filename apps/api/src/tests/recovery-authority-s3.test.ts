import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { Readable } from 'node:stream';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { S3AuthorityObjectStore } from '../services/recovery-authority-s3.js';
import { RecoveryAuthorityJournal } from '../services/recovery-authority-journal.js';
import { createHash } from 'node:crypto';

const config = { bucket: 'synthetic-authority-test', accountId: '123456789012',
  kmsKeyArn: 'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-1111-1111-111111111111',
  installationId: 'install-a', organisationId: 'charity-a' };
const credentials = { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' };
const key = 'authority/install-a/charity-a/0000000001.json';
function fixture(handler: (command: unknown) => Promise<unknown>) {
  const client = new S3Client({ region: 'eu-west-1', credentials });
  mock.method(client, 'send', handler);
  return new S3AuthorityObjectStore(config, credentials, client);
}
const metadata = { VersionId: 'version-1', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: config.kmsKeyArn };

test('S3 intents use conditional creation, expected owner, KMS and explicit integrity checksum', async () => {
  const store = fixture(async command => {
    assert.ok(command instanceof PutObjectCommand);
    assert.equal(command.input.IfNoneMatch, '*');
    assert.equal(command.input.ExpectedBucketOwner, config.accountId);
    assert.equal(command.input.SSEKMSKeyId, config.kmsKeyArn);
    assert.equal(command.input.ServerSideEncryption, 'aws:kms');
    assert.equal(command.input.Bucket, config.bucket);
    assert.equal(command.input.Key, key);
    assert.equal(command.input.Body, '{}');
    assert.ok(command.input.ChecksumSHA256);
    return metadata;
  });
  assert.equal(await store.create(key, '{}'), true);
});

test('S3 reads require current version metadata and bounded authenticated content', async () => {
  const store = fixture(async command => {
    assert.ok(command instanceof GetObjectCommand);
    assert.equal(command.input.ExpectedBucketOwner, config.accountId);
    assert.equal(command.input.VersionId, undefined);
    return { ...metadata, ContentLength: 2, Body: Readable.from([Buffer.from('{}')]) };
  });
  assert.equal(await store.read(key), '{}');
});

test('only NoSuchKey means missing and only a write precondition failure means existing', async () => {
  const missing = fixture(async () => { throw { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } }; });
  assert.equal(await missing.read(key), null);
  const conflict = fixture(async () => { throw { $metadata: { httpStatusCode: 412 } }; });
  assert.equal(await conflict.create(key, '{}'), false);
  for (const error of [{ name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } },
    { $metadata: { httpStatusCode: 403 } }, { $metadata: { httpStatusCode: 409 } }, new Error('secret must not leak')]) {
    const store = fixture(async () => { throw error; });
    await assert.rejects(() => store.read(key), /^Error: Recovery S3 read failed$/);
    await assert.rejects(() => store.create(key, '{}'), /^Error: Recovery S3 write outcome is unknown$/);
  }
});

test('S3 rejects foreign keys, oversized content and missing version/encryption proof', async () => {
  let calls = 0;
  const store = fixture(async () => { calls++; return {}; });
  await assert.rejects(() => store.read(key.replace('charity-a', 'charity-b')));
  await assert.rejects(() => store.create(key, 'x'.repeat(4097)));
  assert.equal(calls, 0);
  await assert.rejects(() => store.create(key, '{}'), /unknown/);
  for (const change of [{ VersionId: 'null' }, { SSEKMSKeyId: 'wrong' }, { DeleteMarker: true },
    { ContentLength: 5000 }, { ContentLength: 2, Body: Readable.from([Buffer.alloc(5000)]) }]) {
    const bad = fixture(async () => ({ ...metadata, ContentLength: 2,
      Body: Readable.from([Buffer.from('{}')]), ...change }));
    await assert.rejects(() => bad.read(key), /read failed/);
  }
});

test('the journal can read its overflow sentinel but cannot create an out-of-range intent', async () => {
  let calls = 0;
  const store = fixture(async () => { calls++; throw { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } }; });
  const sentinel = key.replace('0000000001', '0000010001');
  assert.equal(await store.read(sentinel), null);
  await assert.rejects(() => store.create(sentinel, '{}'), /scope/);
  assert.equal(calls, 1);
});

test('the AWS SDK serializes and signs conditional writes without a network request', async () => {
  let requests = 0;
  const client = new S3Client({ region: 'eu-west-1', credentials, maxAttempts: 1,
    endpoint: 'https://s3.eu-west-1.amazonaws.com', requestHandler: {
      async handle(request: { protocol: string; headers: Record<string, string> }) {
        requests++;
        assert.equal(request.protocol, 'https:');
        assert.equal(request.headers['if-none-match'], '*');
        assert.equal(request.headers['x-amz-expected-bucket-owner'], config.accountId);
        assert.equal(request.headers['x-amz-server-side-encryption'], 'aws:kms');
        assert.ok(request.headers.authorization?.startsWith('AWS4-HMAC-SHA256 '));
        return { response: { statusCode: 200, headers: { 'x-amz-version-id': 'version-1',
          'x-amz-server-side-encryption': 'aws:kms',
          'x-amz-server-side-encryption-aws-kms-key-id': config.kmsKeyArn }, body: Readable.from([]) } };
      },
    } });
  const store = new S3AuthorityObjectStore(config, credentials, client);
  assert.equal(await store.create(key, '{}'), true);
  assert.equal(requests, 1);
  client.destroy();
});

test('a failed response body cannot impersonate a missing object', async () => {
  const store = fixture(async () => ({ ...metadata, ContentLength: 2,
    Body: Readable.from((async function* () {
      yield Buffer.from('{');
      throw { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } };
    })()) }));
  await assert.rejects(() => store.read(key), /read failed/);
});

function headFixture() {
  let version = 0;
  let body = JSON.stringify({ format: 1, installationId: config.installationId,
    organisationId: config.organisationId, generation: 0, digest: null,
    publicationId: '11111111-1111-4111-8111-111111111111' });
  let lostAck = false;
  const publications: string[] = [];
  const store = fixture(async command => {
    if (command instanceof GetObjectCommand) {
      assert.equal(command.input.Key, 'authority/install-a/charity-a/head.json');
      return { ...metadata, VersionId: `version-${version}`, ETag: `"etag-${version}"`,
        ContentLength: Buffer.byteLength(body), Body: Readable.from([Buffer.from(body)]) };
    }
    assert.ok(command instanceof PutObjectCommand);
    assert.equal(command.input.IfNoneMatch, undefined);
    if (command.input.IfMatch !== `"etag-${version}"`) throw { $metadata: { httpStatusCode: 412 } };
    body = String(command.input.Body); version++; publications.push(body);
    if (lostAck) { lostAck = false; throw new Error('lost ack'); }
    return { ...metadata, VersionId: `version-${version}` };
  });
  return { store, publications, loseAck() { lostAck = true; }, replaceBody(value: string) { body = value; } };
}
const firstHead = { installationId: config.installationId, organisationId: config.organisationId,
  generation: 1, digest: 'a'.repeat(64) };

test('S3 head publication uses ETag conditional replacement and unique publication identities', async () => {
  const f = headFixture();
  const initial = await f.store.readHead();
  assert.equal(initial.generation, 0);
  assert.equal(await f.store.compareAndSwap( initial.revision, firstHead), true);
  const head = await f.store.readHead();
  assert.equal(head.generation, 1); assert.notEqual(head.revision, initial.revision);
  assert.equal(await f.store.compareAndSwap( initial.revision, firstHead), false);
  await f.store.compareAndSwap( head.revision, { ...firstHead, generation: 2 });
  assert.notEqual(JSON.parse(f.publications[0]!).publicationId, JSON.parse(f.publications[1]!).publicationId);
});

test('competing S3 heads cannot both replace one revision', async () => {
  const f = headFixture(); const head = await f.store.readHead();
  const outcomes = await Promise.all([firstHead, { ...firstHead, digest: 'b'.repeat(64) }].map(next =>
    f.store.compareAndSwap( head.revision, next)));
  assert.equal(outcomes.filter(Boolean).length, 1); assert.equal(f.publications.length, 1);
});

test('lost S3 head acknowledgement is unknown and a later read observes the committed publication', async () => {
  const f = headFixture(); const head = await f.store.readHead(); f.loseAck();
  await assert.rejects(async () => f.store.compareAndSwap( head.revision, firstHead), /unknown/);
  assert.equal((await f.store.readHead()).generation, 1);
  assert.equal(await f.store.compareAndSwap( head.revision, firstHead), false);
  assert.equal(f.publications.length, 1);
});

test('S3 head refuses foreign, malformed, missing and nonsequential publications', async () => {
  const f = headFixture(); const head = await f.store.readHead();
  await assert.rejects(() => f.store.compareAndSwap(head.revision, { ...firstHead, organisationId: 'foreign' }), /binding/);
  await assert.rejects(() => f.store.compareAndSwap(head.revision, { ...firstHead, generation: 2 }), /one generation/);
  assert.equal(f.publications.length, 0);
  for (const value of ['{}', 'not-json', JSON.stringify({ ...firstHead, format: 1, publicationId: 'not-uuid' })]) {
    f.replaceBody(value);
    await assert.rejects(() => f.store.readHead(), /verification failed/);
  }
  const missing = fixture(async () => { throw { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } }; });
  await assert.rejects(() => missing.readHead(), /initialization is not automatic/);
});

test('journal and S3 adapter recover a lost publication acknowledgement together', async () => {
  const binding = { installationId: config.installationId, organisationId: config.organisationId };
  const initial = { ...binding, generation: 0, digest: null };
  const headKey = 'authority/install-a/charity-a/head.json';
  const objects = new Map([[headKey, { body: JSON.stringify({ format: 1, ...initial,
    publicationId: '11111111-1111-4111-8111-111111111111' }), version: 1 }]]);
  let lostAck = true; let version = 1;
  const tag = (body: string) => `"${createHash('sha256').update(body).digest('hex')}"`;
  const store = fixture(async command => {
    assert.ok(command instanceof GetObjectCommand || command instanceof PutObjectCommand);
    const object = objects.get(command.input.Key!);
    if (command instanceof GetObjectCommand) {
      if (!object) throw { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } };
      return { ...metadata, VersionId: `version-${object.version}`, ETag: tag(object.body),
        ContentLength: Buffer.byteLength(object.body), Body: Readable.from([Buffer.from(object.body)]) };
    }
    if ((command.input.IfNoneMatch === '*' && object) ||
      (command.input.IfMatch && (!object || command.input.IfMatch !== tag(object.body)))) {
      throw { $metadata: { httpStatusCode: 412 } };
    }
    const body = String(command.input.Body);
    objects.set(command.input.Key!, { body, version: ++version });
    if (command.input.Key === headKey && lostAck) { lostAck = false; throw new Error('publication timeout'); }
    return { ...metadata, VersionId: `version-${version}` };
  });
  const intent = { operationId: 'intent-one', kind: 'DISPOSAL_INTENT' as const,
    factsDigest: 'a'.repeat(64), expectedGeneration: 0, expectedDigest: null };
  const journal = new RecoveryAuthorityJournal(store, binding, initial);
  await assert.rejects(() => journal.appendPublished(intent, store), /unknown/);
  const restarted = new RecoveryAuthorityJournal(store, binding, initial);
  const receipt = await restarted.appendPublished(intent, store);
  assert.equal(receipt.replayed, true); assert.equal(receipt.headPublished, true);
  assert.equal(receipt.actionAuthorized, false); assert.equal(objects.size, 2); assert.equal(version, 3);
  assert.equal((await restarted.inspectCurrent(store)).generation, 1);
});

test('a stalled S3 response body is aborted within the operation deadline', { timeout: 22000 }, async () => {
  const body = new Readable({ read() {} });
  const store = fixture(async () => ({ ...metadata, ContentLength: 2, Body: body }));
  const started = Date.now();
  const watchdog = setTimeout(() => body.destroy(new Error('Test watchdog expired')), 20000);
  try {
    await assert.rejects(() => store.read(key), /read failed/);
    assert.ok(Date.now() - started < 19000, 'the operation must abort before the test watchdog');
    assert.equal(body.destroyed, true);
  } finally { clearTimeout(watchdog); body.destroy(); }
});
