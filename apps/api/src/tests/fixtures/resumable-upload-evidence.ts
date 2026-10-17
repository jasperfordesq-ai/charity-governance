import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mock } from 'node:test';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { S3ResumableUploadEvidence } from '../../services/resumable-upload-evidence.js';
export const evidenceHash = (v: string) =>
  createHash('sha256').update(v).digest('hex');
export const resumableEvidenceConfig = {
  installationId: 'synthetic',
  bucket: 'synthetic-evidence',
  accountId: '123456789012',
  kmsKeyArn:
    'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-4111-8111-111111111111',
  maintenance: {
    attemptId: '11111111-1111-4111-8111-111111111111',
    planDigest: '1'.repeat(64),
    sourceSha: '2'.repeat(40),
    maintenanceEpoch: 1,
  },
  credentialId: '22222222-2222-4222-8222-222222222222',
  probeDigest: '3'.repeat(64),
  locationCustodyDigest: '4'.repeat(64),
};
export function resumableEvidenceFixture(
  config = resumableEvidenceConfig,
  namespace: 'resumable' | 's3-current-feature' = 'resumable',
) {
  const credentials = {
      accessKeyId: 'synthetic',
      secretAccessKey: 'synthetic',
    },
    client = new S3Client({ region: 'eu-west-1', credentials }),
    calls: (GetObjectCommand | PutObjectCommand)[] = [],
    objects = new Map<string, { body: string; versionId: string }>();
  let fault: ((c: GetObjectCommand | PutObjectCommand) => unknown) | undefined;
  const metadata = (versionId: string) => ({
    VersionId: versionId,
    ServerSideEncryption: 'aws:kms' as const,
    SSEKMSKeyId: config.kmsKeyArn,
  });
  const commit = (c: PutObjectCommand) => {
    assert.equal(c.input.IfNoneMatch, '*');
    assert.equal(c.input.IfMatch, undefined);
    assert.equal(c.input.ServerSideEncryption, 'aws:kms');
    assert.equal(c.input.SSEKMSKeyId, config.kmsKeyArn);
    assert.equal(
      c.input.ChecksumSHA256,
      createHash('sha256').update(String(c.input.Body)).digest('base64'),
    );
    if (objects.has(c.input.Key!))
      throw new Error('synthetic conditional conflict');
    const v = {
      body: String(c.input.Body),
      versionId: 'synthetic-version-' + (objects.size + 1),
    };
    objects.set(c.input.Key!, v);
    return metadata(v.versionId);
  };
  mock.method(
    client,
    'send',
    async (c: GetObjectCommand | PutObjectCommand) => {
      calls.push(c);
      assert.equal(c.input.Bucket, config.bucket);
      assert.equal(c.input.ExpectedBucketOwner, config.accountId);
      assert.match(
        c.input.Key!,
        new RegExp(
          '^managed-maintenance/' +
            config.installationId +
            '/' +
            config.maintenance.attemptId +
            '/' +
            namespace +
            '-(baseline|observation)\\.json$',
        ),
      );
      const injected = fault?.(c);
      if (injected !== undefined) return injected;
      if (c instanceof PutObjectCommand) return commit(c);
      const v = objects.get(c.input.Key!);
      if (!v) throw new Error('synthetic missing object');
      assert.equal(c.input.ChecksumMode, 'ENABLED');
      assert.equal(c.input.VersionId, v.versionId);
      return {
        ...metadata(v.versionId),
        ContentLength: Buffer.byteLength(v.body),
        Body: Readable.from([Buffer.from(v.body)]),
      };
    },
  );
  return {
    client,
    credentials,
    calls,
    objects,
    metadata,
    commit,
    setFault: (f: typeof fault) => {
      fault = f;
    },
    store: () => new S3ResumableUploadEvidence(config, credentials, client),
  };
}
