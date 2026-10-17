import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { mock } from 'node:test';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import {
  KMSClient,
  GenerateDataKeyCommand,
  DecryptCommand,
} from '@aws-sdk/client-kms';
import { S3ResumableLocationVault } from '../../services/resumable-location-vault.js';
export const locationVaultConfig = {
  installationId: 'synthetic',
  projectRef: 'abcdefghijklmnopqrst',
  uploadIdFormat: 'PATH_V1',
  bucket: 'synthetic-credential-custody',
  accountId: '123456789012',
  dataKeyArn:
    'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-1111-1111-111111111111',
  storageKeyArn:
    'arn:aws:kms:eu-west-1:123456789012:key/22222222-2222-2222-2222-222222222222',
  maintenance: {
    attemptId: '33333333-3333-4333-8333-333333333333',
    planDigest: '1'.repeat(64),
    sourceSha: '2'.repeat(40),
    maintenanceEpoch: 1,
  },
  probeDigest: '9'.repeat(64),
};
export const syntheticAwsCredentials = {
  accessKeyId: 'synthetic',
  secretAccessKey: 'synthetic',
};
export function maintenanceSecretVaultFixture(
  overrides: Partial<typeof locationVaultConfig> = {},
  objectName = 'resumable-location.json',
  purpose = 'charitypilot-resumable-location-v1',
  events?:string[],
) {
  const config = { ...locationVaultConfig, ...overrides },
    objects = new Map<string, { body: string; version: string }>(),
    wrapped = new Map<string, { key: Buffer; context: unknown }>();
  const plaintextResponses: Uint8Array[] = [],
    calls: unknown[] = [];
  let fault: ((command: unknown) => unknown) | undefined;
  const storage = new S3Client({
      region: 'eu-west-1',
      credentials: syntheticAwsCredentials,
    }),
    kms = new KMSClient({
      region: 'eu-west-1',
      credentials: syntheticAwsCredentials,
    });
  const metadata = (version: string) => ({
    VersionId: version,
    ServerSideEncryption: 'aws:kms' as const,
    SSEKMSKeyId: config.storageKeyArn,
  });
  const commit = (command: PutObjectCommand) => {
    const key = command.input.Key!;
    if (objects.has(key)) throw { $metadata: { httpStatusCode: 412 } };
    const row = {
      body: String(command.input.Body),
      version: 'version-' + (objects.size + 1),
    };
    objects.set(key, row);
    return metadata(row.version);
  };
  mock.method(
    storage,
    'send',
    async (command: GetObjectCommand | PutObjectCommand) => {
      calls.push(command);
      const result = fault?.(command);
      if (result !== undefined) return result;
      assert.equal(command.input.Bucket, config.bucket);
      assert.equal(command.input.ExpectedBucketOwner, config.accountId);
      assert.equal(
        command.input.Key,
        'managed-maintenance/' +
          config.installationId +
          '/' +
          config.maintenance.attemptId +
          '/' +
          objectName,
      );
      if (command instanceof PutObjectCommand) {
        assert.equal(command.input.IfNoneMatch, '*');
        assert.equal(command.input.SSEKMSKeyId, config.storageKeyArn);
        assert.equal(
          command.input.ChecksumSHA256,
          createHash('sha256')
            .update(String(command.input.Body))
            .digest('base64'),
        );
        return commit(command);
      }
      const row = objects.get(command.input.Key!);
      if (!row) throw { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } };
      if (command.input.VersionId !== undefined)
        assert.equal(command.input.VersionId, row.version);
      assert.equal(command.input.ChecksumMode, 'ENABLED');
      return {
        ...metadata(row.version),
        ContentLength: Buffer.byteLength(row.body),
        Body: Readable.from([Buffer.from(row.body)]),
      };
    },
  );
  mock.method(
    kms,
    'send',
    async (command: GenerateDataKeyCommand | DecryptCommand) => {
      calls.push(command);
      const result = fault?.(command);
      if (result !== undefined) return result;
      events?.push('secret-kms-'+(command instanceof GenerateDataKeyCommand?'generate':'decrypt'));
      assert.equal(command.input.KeyId, config.dataKeyArn);
      assert.equal(command.input.EncryptionContext?.purpose, purpose);
      assert.equal(
        command.input.EncryptionContext?.installationId,
        config.installationId,
      );
      assert.equal(
        command.input.EncryptionContext?.sourceSha,
        config.maintenance.sourceSha,
      );
      if (command instanceof GenerateDataKeyCommand) {
        assert.equal(command.input.KeySpec, 'AES_256');
        const key = randomBytes(32),
          blob = randomBytes(48);
        wrapped.set(blob.toString('base64'), {
          key,
          context: structuredClone(command.input.EncryptionContext),
        });
        const plaintext = Buffer.from(key);
        plaintextResponses.push(plaintext);
        return {
          KeyId: config.dataKeyArn,
          Plaintext: plaintext,
          CiphertextBlob: blob,
        };
      }
      assert.equal(command.input.EncryptionAlgorithm, 'SYMMETRIC_DEFAULT');
      const row = wrapped.get(
        Buffer.from(command.input.CiphertextBlob!).toString('base64'),
      )!;
      assert.deepEqual(command.input.EncryptionContext, row.context);
      const plaintext = Buffer.from(row.key);
      plaintextResponses.push(plaintext);
      return {
        KeyId: config.dataKeyArn,
        EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
        Plaintext: plaintext,
      };
    },
  );
  return {
    config,
    objects,
    calls,
    plaintextResponses,
    storage,
    kms,
    metadata,
    commit,
    setFault: (next: typeof fault) => {
      fault = next;
    },
  };
}
export function locationVaultFixture(
  overrides: Partial<typeof locationVaultConfig> = {},
) {
  const f = maintenanceSecretVaultFixture(overrides);
  return {
    ...f,
    vault: () =>
      new S3ResumableLocationVault(
        f.config,
        syntheticAwsCredentials,
        syntheticAwsCredentials,
        { storage: f.storage, kms: f.kms },
      ),
  };
}
