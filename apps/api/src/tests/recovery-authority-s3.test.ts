import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { Readable } from 'node:stream';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { S3AuthorityObjectStore } from '../services/recovery-authority-s3.js';

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
