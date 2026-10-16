import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { KMSClient } from '@aws-sdk/client-kms';
import { S3Client } from '@aws-sdk/client-s3';
import { KmsDocumentBackupKeys } from '../services/document-byte-backup-kms.js';
import { S3DocumentByteBackups } from '../services/document-byte-backup-s3.js';
import {
  sealDocumentByteBackup,
  openDocumentByteBackup,
} from '../services/document-byte-backup.js';

type Request = {
  protocol: string;
  hostname: string;
  headers: Record<string, string>;
  body?: unknown;
  path: string;
  method: string;
};
const keyArn =
  'arn:aws:kms:eu-west-1:123456789012:key/22222222-2222-4222-8222-222222222222';
const storageKeyArn =
  'arn:aws:kms:eu-west-1:123456789012:key/33333333-3333-4333-8333-333333333333';
const credentials = { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' };
const bytes = Buffer.from('private synthetic byte backup content');
const context = {
  installationId: 'fixture',
  setId: '11111111-1111-4111-8111-111111111111',
  organisationId: 'charity',
  documentId: 'document',
  sourceSha: 'a'.repeat(40),
  databaseSha256: 'b'.repeat(64),
  sourceBindingSha256: 'c'.repeat(64),
  bytesSha256: createHash('sha256').update(bytes).digest('hex'),
  byteLength: bytes.length,
  keyArn,
};
const config = {
  bucket: 'synthetic-byte-backups',
  accountId: '123456789012',
  storageKeyArn,
  dataKeyArn: keyArn,
  installationId: 'fixture',
};

test('signed KMS and S3 transports recover the immutable encrypted bytes with fresh clients and no primary copy', async () => {
  const retained = new Map<string, { key: Buffer; context: unknown }>(),
    objects = new Map<string, string>();
  let writes = 0,
    reads = 0,
    kmsRequests = 0,
    lost = false;
  const kms = () =>
    new KMSClient({
      region: 'eu-west-1',
      credentials,
      endpoint: 'https://kms.eu-west-1.amazonaws.com',
      maxAttempts: 1,
      requestHandler: {
        async handle(request: Request) {
          assert.equal(request.hostname, 'kms.eu-west-1.amazonaws.com');
          assert.equal(request.protocol, 'https:');
          assert.match(request.headers.authorization, /AWS4-HMAC-SHA256/);
          kmsRequests++;
          const body = JSON.parse(
            typeof request.body === 'string'
              ? request.body
              : new TextDecoder().decode(request.body as Uint8Array),
          );
          assert.equal(body.KeyId, keyArn);
          assert.equal(
            body.EncryptionContext.purpose,
            'charitypilot-document-byte-backup-v1',
          );
          assert.equal(
            body.EncryptionContext.databaseSha256,
            context.databaseSha256,
          );
          let key: Buffer, wrapped: string | undefined;
          if (request.headers['x-amz-target'].endsWith('.GenerateDataKey')) {
            key = randomBytes(32);
            wrapped = Buffer.from('wrapped-' + kmsRequests).toString('base64');
            retained.set(wrapped, {
              key: Buffer.from(key),
              context: body.EncryptionContext,
            });
          } else {
            const record = retained.get(body.CiphertextBlob);
            assert.ok(record);
            assert.deepEqual(body.EncryptionContext, record.context);
            key = record.key;
          }
          return {
            response: {
              statusCode: 200,
              headers: { 'content-type': 'application/x-amz-json-1.1' },
              body: Readable.from([
                Buffer.from(
                  JSON.stringify({
                    KeyId: keyArn,
                    Plaintext: key.toString('base64'),
                    ...(wrapped
                      ? { CiphertextBlob: wrapped }
                      : { EncryptionAlgorithm: 'SYMMETRIC_DEFAULT' }),
                  }),
                ),
              ]),
            },
          };
        },
      },
    });
  const s3 = () =>
    new S3Client({
      region: 'eu-west-1',
      credentials,
      endpoint: 'https://s3.eu-west-1.amazonaws.com',
      maxAttempts: 1,
      requestHandler: {
        async handle(request: Request) {
          assert.equal(request.protocol, 'https:');
          assert.match(request.hostname, /s3\.eu-west-1\.amazonaws\.com$/);
          assert.match(request.headers.authorization, /AWS4-HMAC-SHA256/);
          assert.equal(
            request.headers['x-amz-expected-bucket-owner'],
            config.accountId,
          );
          if (request.method === 'PUT') {
            writes++;
            assert.equal(request.headers['if-none-match'], '*');
            assert.equal(
              request.headers['x-amz-server-side-encryption-aws-kms-key-id'],
              storageKeyArn,
            );
            if (objects.has(request.path))
              return {
                response: {
                  statusCode: 412,
                  headers: {},
                  body: Readable.from([
                    Buffer.from(
                      '<Error><Code>PreconditionFailed</Code></Error>',
                    ),
                  ]),
                },
              };
            const value =
              typeof request.body === 'string'
                ? request.body
                : new TextDecoder().decode(request.body as Uint8Array);
            objects.set(request.path, value);
            if (lost) throw new Error('synthetic lost acknowledgement');
          } else reads++;
          const value = objects.get(request.path);
          assert.ok(value);
          const headers = {
            'x-amz-version-id': 'synthetic-v1',
            etag: '"synthetic-etag"',
            'x-amz-server-side-encryption': 'aws:kms',
            'x-amz-server-side-encryption-aws-kms-key-id': storageKeyArn,
            'x-amz-checksum-sha256': createHash('sha256')
              .update(value)
              .digest('base64'),
            'content-length': String(Buffer.byteLength(value)),
          };
          return {
            response: {
              statusCode: 200,
              headers,
              body: Readable.from([
                Buffer.from(request.method === 'GET' ? value : ''),
              ]),
            },
          };
        },
      },
    });
  const firstKms = kms(),
    firstS3 = s3(),
    nextKms = kms(),
    nextS3 = s3();
  try {
    const primary = Buffer.from(bytes),
      sealed = await sealDocumentByteBackup(
        context,
        primary,
        new KmsDocumentBackupKeys(keyArn, credentials, firstKms),
      );
    const store = new S3DocumentByteBackups(config, credentials, firstS3);
    lost = true;
    await assert.rejects(store.publish(context, sealed));
    assert.equal(writes, 1);
    primary.fill(0);
    lost = false;
    const observed = await new S3DocumentByteBackups(
      config,
      credentials,
      nextS3,
    ).observe(context, sealed.sha256);
    assert.equal(observed.versionId, 'synthetic-v1');
    assert.equal(writes, 1);
    const recovered = await openDocumentByteBackup(
      context,
      observed.body,
      sealed.sha256,
      new KmsDocumentBackupKeys(keyArn, credentials, nextKms),
    );
    assert.deepEqual(recovered, bytes);
    assert.equal(kmsRequests, 2);
    assert.ok(reads >= 1);
    for (const object of objects.values()) {
      assert.ok(!object.includes(bytes.toString()));
      assert.ok(!object.includes(bytes.toString('base64')));
    }
    await assert.rejects(store.publish(context, sealed));
    assert.equal(writes, 2); // one new explicit call, never an SDK retry
  } finally {
    firstKms.destroy();
    firstS3.destroy();
    nextKms.destroy();
    nextS3.destroy();
    for (const value of retained.values()) value.key.fill(0);
  }
});
