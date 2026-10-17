import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
import { ManagedResumableUploadEvidence } from '../../services/managed-resumable-upload-evidence.js';
export const cohortHash = (v: string) =>
  createHash('sha256').update(v).digest('hex');
export const cohortParent = {
  attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  planDigest: '1'.repeat(64),
  sourceSha: '2'.repeat(40),
  maintenanceEpoch: 1,
};
type FixtureOptions = {
  custodyPurpose?: 'charitypilot-s3-capability-v1';
  storage?: {
    installationId: string;
    bucket: string;
    accountId: string;
    kmsKeyArn: string;
  };
  client?: S3Client;
  events?: string[];
  control?: { id: string; secret: string };
  retired?: { id: string; secret: string }[];
  isRetiredAllowed?: (id: string) => boolean;
};
export function resumableCohortFixture(options: FixtureOptions = {}) {
  const storage = options.storage ?? {
      installationId: 'synthetic',
      bucket: 'synthetic-tus-cohort',
      accountId: '123456789012',
      kmsKeyArn:
        'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-4111-8111-111111111111',
    },
    control = options.control ?? {
      id: '11111111-1111-4111-8111-111111111111',
      secret: 'sb_secret_' + 'a'.repeat(40),
    },
    retired = options.retired ?? [
      {
        id: '22222222-2222-4222-8222-222222222222',
        secret: 'sb_secret_' + 'b'.repeat(40),
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        secret: 'sb_secret_' + 'c'.repeat(40),
      },
    ],
    registry = {
      installationId: storage.installationId,
      projectRef: 'abcdefghijklmnopqrst',
      bucket: 'charitypilot-recovery-resumable-probes',
      providerRelease: {
        sourceSha: '3'.repeat(40),
        imageDigest: '4'.repeat(64),
      },
      uploadIdFormat: 'PATH_V1',
      control: { id: control.id, sha256: cohortHash(control.secret) },
      retired: retired.map((k) => ({ id: k.id, sha256: cohortHash(k.secret) })),
    },
    vaultStorage = {
      installationId: storage.installationId,
      projectRef: registry.projectRef,
      uploadIdFormat: registry.uploadIdFormat,
      bucket: storage.bucket,
      accountId: storage.accountId,
      storageKeyArn: storage.kmsKeyArn,
      dataKeyArn:
        'arn:aws:kms:eu-west-1:123456789012:key/88888888-8888-4888-8888-888888888888',
    },
    credentials = { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' },
    sdk = options.client ?? new S3Client({ region: 'eu-west-1', credentials }),
    kms = new KMSClient({ region: 'eu-west-1', credentials }),
    events: string[] = options.events ?? [],
    objects = new Map<string, { body: string; version: string }>(),
    wrapped = new Map<string, { key: Buffer; context: unknown }>(),
    plaintext: Uint8Array[] = [],
    blocked = new Set<string>(),
    sessions = new Map<
      string,
      { object: string; offset: number; length: number; expires: string }
    >(),
    completed = new Map<string, Uint8Array>();
  let allowRetiredAfterClose = false;
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
  if (!options.client)
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
        options.custodyPurpose ?? 'charitypilot-resumable-location-v1',
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
  const origin = 'https://' + registry.projectRef + '.storage.supabase.co',
    endpoint = origin + '/storage/v1/upload/resumable';
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      method = init?.method!,
      h = new Headers(init?.headers),
      secret = h.get('apikey')!;
    events.push('tus-' + method);
    assert.equal(url.origin, origin);
    assert.equal(init?.redirect, 'error');
    assert.ok(
      secret === control.secret || retired.some((k) => k.secret === secret),
    );
    const headers = {
      date: new Date().toUTCString(),
      'tus-resumable': '1.0.0',
    };
    if (url.pathname.includes('/bucket/'))
      return Response.json({ id: registry.bucket, public: false }, { headers });
    if (String(input) === endpoint && method === 'POST') {
      const data = Object.fromEntries(
        h
          .get('upload-metadata')!
          .split(',')
          .map((p) => {
            const [k, v] = p.split(' ');
            return [k, Buffer.from(v, 'base64').toString('utf8')];
          }),
      );
      assert.equal(data.bucketName, registry.bucket);
      assert.ok(
        data.objectName.startsWith(
          'charitypilot-recovery-resumable-probe/' +
            storage.installationId +
            '/',
        ),
      );
      const object = registry.bucket + '/' + data.objectName,
        location =
          endpoint +
          '/' +
          Buffer.from(object + '/' + randomUUID()).toString('base64url'),
        expires = new Date(Date.now() + 3600000).toUTCString();
      sessions.set(location, {
        object,
        offset: 0,
        length: Number(h.get('upload-length')),
        expires,
      });
      return new Response(null, {
        status: 201,
        headers: { ...headers, location, 'upload-expires': expires },
      });
    }
    if (url.pathname.startsWith('/storage/v1/upload/resumable/')) {
      const s = sessions.get(String(input))!;
      assert.ok(s);
      if (method === 'HEAD')
        return new Response(null, {
          status: 200,
          headers: {
            ...headers,
            'upload-offset': String(s.offset),
            'upload-length': String(s.length),
            'upload-expires': s.expires,
          },
        });
      assert.equal(method, 'PATCH');
      assert.equal(Number(h.get('upload-offset')), s.offset);
      if (
        !allowRetiredAfterClose &&
        (blocked.has(secret) ||
          (retired.some((k) => k.secret === secret) &&
            options.isRetiredAllowed &&
            !options.isRetiredAllowed(
              retired.find((k) => k.secret === secret)!.id,
            )))
      )
        return Response.json(
          { code: 'AccessDenied' },
          { status: 403, headers },
        );
      const body = init?.body as Uint8Array;
      s.offset += body.byteLength;
      if (s.offset === s.length) completed.set(s.object, new Uint8Array(body));
      return new Response(null, {
        status: 204,
        headers: {
          ...headers,
          'upload-offset': String(s.offset),
          'upload-expires': s.expires,
        },
      });
    }
    assert.equal(method, 'GET');
    const data = completed.get(
      url.pathname.slice('/storage/v1/object/'.length),
    );
    return data
      ? new Response(data, {
          headers: { ...headers, 'content-length': String(data.byteLength) },
        })
      : new Response(null, { status: 404, headers });
  };
  const factory = () =>
    new ManagedResumableUploadEvidence(
      registry,
      { control, retired },
      vaultStorage,
      storage,
      credentials,
      credentials,
      transport,
      { vault: sdk, evidence: sdk, manifest: sdk, kms },
    );
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
    blocked,
    sessions,
    completed,
    transport,
    commit,
    metadata,
    factory,
    setFault: (value: typeof fault) => {
      fault = value;
    },
    set allowRetiredAfterClose(value: boolean) {
      allowRetiredAfterClose = value;
    },
    blockAll: () => retired.forEach((k) => blocked.add(k.secret)),
  };
}
