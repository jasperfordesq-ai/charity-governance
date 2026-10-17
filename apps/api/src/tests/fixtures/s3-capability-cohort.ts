import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { mock } from 'node:test';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
  KMSClient,
  GenerateDataKeyCommand,
  DecryptCommand,
} from '@aws-sdk/client-kms';
import { s3CapabilityProbeFixture } from './s3-capability-proof.js';
import { s3CapabilityChildAttempt } from '../../services/s3-capability-cohort-contract.js';
import { ManagedS3CapabilityEvidence } from '../../services/managed-s3-capability-evidence.js';
export const cohortHash = (v: string) =>
  createHash('sha256').update(v).digest('hex');
export const cohortParent = {
  attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  planDigest: '1'.repeat(64),
  sourceSha: '2'.repeat(40),
  maintenanceEpoch: 1,
};
export function s3CapabilityCohortFixture() {
  const storage = {
      installationId: 'synthetic',
      bucket: 'synthetic-tus-cohort',
      accountId: '123456789012',
      kmsKeyArn:
        'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-4111-8111-111111111111',
    },
    control = {
      id: '11111111-1111-4111-8111-111111111111',
      secret: 'sb_secret_' + 'a'.repeat(40),
    },
    retired = [
      {
        id: '22222222-2222-4222-8222-222222222222',
        accessKeyId: 'SYNTHETIC_KEY_B',
        secretAccessKey: 'synthetic-secret-b-'.repeat(3),
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        accessKeyId: 'SYNTHETIC_KEY_C',
        secretAccessKey: 'synthetic-secret-c-'.repeat(3),
      },
    ],
    registry = {
      installationId: storage.installationId,
      projectRef: 'abcdefghijklmnopqrst',
      mode: 'WORKING_CAPABILITIES',
      region: 'eu-west-1',
      bucket: 'charitypilot-recovery-s3-probes',
      providerRelease: {
        sourceSha: '3'.repeat(40),
        imageDigest: '4'.repeat(64),
      },
      control: { id: control.id, sha256: cohortHash(control.secret) },
      retired: retired.map((k) => ({
        id: k.id,
        accessKeyIdSha256: cohortHash(k.accessKeyId),
        secretAccessKeySha256: cohortHash(k.secretAccessKey),
      })),
    },
    vaultStorage = {
      installationId: storage.installationId,
      projectRef: registry.projectRef,
      bucket: storage.bucket,
      accountId: storage.accountId,
      storageKeyArn: storage.kmsKeyArn,
      dataKeyArn:
        'arn:aws:kms:eu-west-1:123456789012:key/88888888-8888-4888-8888-888888888888',
    },
    credentials = { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' },
    sdk = new S3Client({ region: 'eu-west-1', credentials }),
    kms = new KMSClient({ region: 'eu-west-1', credentials }),
    events: string[] = [],
    objects = new Map<string, { body: string; version: string }>(),
    wrapped = new Map<string, { key: Buffer; context: unknown }>(),
    plaintext: Uint8Array[] = [];
  let fault:
    | ((command: GetObjectCommand | PutObjectCommand) => unknown)
    | undefined;
  const metadata = (version: string) => ({
    VersionId: version,
    ServerSideEncryption: 'aws:kms' as const,
    SSEKMSKeyId: storage.kmsKeyArn,
  });
  const commit = (command: PutObjectCommand) => {
    assert.equal(command.input.IfNoneMatch, '*');
    assert.equal(command.input.SSEKMSKeyId, storage.kmsKeyArn);
    assert.equal(
      command.input.ChecksumSHA256,
      createHash('sha256').update(String(command.input.Body)).digest('base64'),
    );
    if (objects.has(command.input.Key!))
      throw new Error('synthetic conditional conflict');
    const row = {
      body: String(command.input.Body),
      version: 'cohort-version-' + (objects.size + 1),
    };
    objects.set(command.input.Key!, row);
    return metadata(row.version);
  };
  mock.method(
    sdk,
    'send',
    async (command: GetObjectCommand | PutObjectCommand) => {
      events.push(command instanceof PutObjectCommand ? 's3-put' : 's3-get');
      assert.equal(command.input.Bucket, storage.bucket);
      assert.equal(command.input.ExpectedBucketOwner, storage.accountId);
      assert.ok(
        command.input.Key!.startsWith(
          'managed-maintenance/' + storage.installationId + '/',
        ),
      );
      const injected = fault?.(command);
      if (injected !== undefined) return injected;
      if (command instanceof PutObjectCommand) return commit(command);
      assert.equal(command.input.ChecksumMode, 'ENABLED');
      const row = objects.get(command.input.Key!);
      if (!row) throw new Error('synthetic absent artifact');
      assert.equal(command.input.VersionId, row.version);
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
      events.push(
        command instanceof GenerateDataKeyCommand
          ? 'kms-generate'
          : 'kms-decrypt',
      );
      assert.equal(command.input.KeyId, vaultStorage.dataKeyArn);
      assert.equal(
        command.input.EncryptionContext?.purpose,
        'charitypilot-s3-capability-v1',
      );
      if (command instanceof GenerateDataKeyCommand) {
        const key = randomBytes(32),
          blob = randomBytes(48),
          p = Buffer.from(key);
        wrapped.set(blob.toString('base64'), {
          key,
          context: structuredClone(command.input.EncryptionContext),
        });
        plaintext.push(p);
        return {
          KeyId: vaultStorage.dataKeyArn,
          Plaintext: p,
          CiphertextBlob: blob,
        };
      }
      const row = wrapped.get(
        Buffer.from(command.input.CiphertextBlob!).toString('base64'),
      )!;
      assert.deepEqual(command.input.EncryptionContext, row.context);
      const p = Buffer.from(row.key);
      plaintext.push(p);
      return {
        KeyId: vaultStorage.dataKeyArn,
        Plaintext: p,
        EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
      };
    },
  );
  const children = new Map<
    string,
    ReturnType<typeof s3CapabilityProbeFixture>
  >();
  const transport: typeof fetch = async (input, init) => {
    events.push('provider-' + init?.method);
    const url = new URL(String(input)),
      endpoint = url.hostname.includes('.storage.') ? 'DIRECT' : 'GATEWAY';
    const childId =
      /\/charitypilot-recovery-s3-probe\/synthetic\/([^/]+)\//.exec(
        url.pathname,
      )?.[1];
    const f = childId
      ? children.get(endpoint + ':' + childId)
      : [...children.entries()].find(([k]) =>
          k.startsWith(endpoint + ':'),
        )?.[1];
    assert.ok(f, 'registered S3 child/endpoint');
    return f.transport(input, init);
  };
  const factory = (
    raw: unknown = registry,
    secrets: unknown = { control, retired },
  ) =>
    new ManagedS3CapabilityEvidence(
      raw,
      secrets,
      vaultStorage,
      storage,
      credentials,
      credentials,
      transport,
      { vault: sdk, evidence: sdk, manifest: sdk, kms },
    );
  const digest = factory().configurationDigest();
  for (let i = 0; i < retired.length; i++)
    for (const endpoint of ['DIRECT', 'GATEWAY']) {
      const attemptId = s3CapabilityChildAttempt(
        cohortParent,
        retired[i].id,
        endpoint,
        digest,
      );
      const f = s3CapabilityProbeFixture(endpoint, {
        config: {
          installationId: registry.installationId,
          projectRef: registry.projectRef,
          endpoint,
          region: registry.region,
          bucket: registry.bucket,
          providerRelease: registry.providerRelease,
          control: registry.control,
          retired: registry.retired[i],
          maintenance: { ...cohortParent, attemptId },
        },
        retired: retired[i],
        control,
      });
      children.set(endpoint + ':' + attemptId, f);
    }
  return {
    storage,
    control,
    retired,
    registry,
    vaultStorage,
    credentials,
    sdk,
    kms,
    events,
    objects,
    plaintext,
    children,
    transport,
    factory,
    metadata,
    commit,
    setFault: (f: typeof fault) => {
      fault = f;
    },
    blockAll: () => {
      for (const f of children.values()) f.mode.disabled = true;
    },
  };
}
