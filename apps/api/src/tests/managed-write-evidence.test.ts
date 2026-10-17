import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mock, test } from 'node:test';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { S3ManagedWriteEvidence } from '../services/managed-write-evidence.js';

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const maintenance = {
  attemptId: '11111111-1111-4111-8111-111111111111',
  planDigest: '1'.repeat(64),
  sourceSha: '2'.repeat(40),
  maintenanceEpoch: 1,
};
const config = {
  installationId: 'synthetic',
  bucket: 'synthetic-evidence',
  accountId: '123456789012',
  kmsKeyArn:
    'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-1111-1111-111111111111',
  maintenance,
  probeRegistryDigest: '3'.repeat(64),
};
const credentials = { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' };
function evidence() {
  const body = JSON.stringify({
    format: 1,
    kind: 'SUPABASE_STANDARD_WRITE_BASELINE_V1',
    configurationDigest: config.probeRegistryDigest,
    maintenance,
    capturedAt: '2026-10-17T00:00:00.000Z',
    credentialIds: ['22222222-2222-4222-8222-222222222222'],
    payloadSha256: '4'.repeat(64),
    updatePayloadSha256: '5'.repeat(64),
    operations: ['CREATE', 'UPDATE', 'DELETE'],
  });
  const baseline = {
    body,
    sha256: hash(body),
    byteLength: Buffer.byteLength(body),
  };
  const core = {
    kind: 'SUPABASE_STANDARD_WRITE_REFUSAL_V1',
    configurationDigest: config.probeRegistryDigest,
    baselineSha256: baseline.sha256,
    observedAt: '2026-10-17T00:01:00.000Z',
    refusals: [
      {
        credentialId: '22222222-2222-4222-8222-222222222222',
        create: 401,
        update: 403,
        delete: 401,
      },
    ],
  };
  const report = {
    ...core,
    observationDigest: hash(JSON.stringify(core)),
    standardWriteRefusalsObserved: true,
    coverage: 'EXPLICIT_MODERN_SECRET_STANDARD_WRITES_ONLY',
    retainedSyntheticObjects: 1,
    writeRejectionVerified: false,
    signedCapabilitiesRevoked: false,
    inFlightWritesDrained: false,
    wholeStorageQuiesced: false,
    actionAuthorized: false,
  };
  return { baseline, report };
}
function fixture() {
  const objects = new Map<string, { body: string; versionId: string }>(),
    calls: (GetObjectCommand | PutObjectCommand)[] = [];
  let fault:
    | ((command: GetObjectCommand | PutObjectCommand) => unknown)
    | undefined;
  const client = new S3Client({ region: 'eu-west-1', credentials });
  const metadata = (versionId: string) => ({
    VersionId: versionId,
    ServerSideEncryption: 'aws:kms' as const,
    SSEKMSKeyId: config.kmsKeyArn,
  });
  mock.method(
    client,
    'send',
    async (command: GetObjectCommand | PutObjectCommand) => {
      calls.push(command);
      assert.equal(command.input.Bucket, config.bucket);
      assert.equal(command.input.ExpectedBucketOwner, config.accountId);
      assert.ok(
        command.input.Key?.startsWith(
          'managed-maintenance/synthetic/' + maintenance.attemptId + '/write-',
        ),
      );
      const injected = fault?.(command);
      if (injected !== undefined) return injected;
      if (command instanceof PutObjectCommand) {
        assert.equal(command.input.IfNoneMatch, '*');
        assert.equal(command.input.IfMatch, undefined);
        assert.equal(command.input.ServerSideEncryption, 'aws:kms');
        assert.equal(command.input.SSEKMSKeyId, config.kmsKeyArn);
        assert.equal(
          command.input.ChecksumSHA256,
          createHash('sha256')
            .update(String(command.input.Body))
            .digest('base64'),
        );
        if (objects.has(command.input.Key!))
          throw { $metadata: { httpStatusCode: 412 } };
        const record = {
          body: String(command.input.Body),
          versionId: 'synthetic-version-' + (objects.size + 1),
        };
        objects.set(command.input.Key!, record);
        return metadata(record.versionId);
      }
      assert.equal(command.input.ChecksumMode, 'ENABLED');
      const record = objects.get(command.input.Key!);
      if (!record) throw { name: 'NoSuchKey' };
      assert.equal(command.input.VersionId, record.versionId);
      return {
        ...metadata(record.versionId),
        ContentLength: Buffer.byteLength(record.body),
        Body: Readable.from([Buffer.from(record.body)]),
      };
    },
  );
  return {
    objects,
    calls,
    metadata,
    client,
    setFault: (next: typeof fault) => {
      fault = next;
    },
    store: () => new S3ManagedWriteEvidence(config, credentials, client),
  };
}
test('write baseline and report are conditionally published and verified through exact version pins', async () => {
  const f = fixture(),
    store = f.store(),
    { baseline, report } = evidence();
  const bp = await store.publishBaseline(baseline);
  assert.equal(bp.sha256, baseline.sha256);
  assert.equal(bp.kind, 'BASELINE');
  const rp = await store.publishObservation(report, bp);
  assert.equal(rp.kind, 'OBSERVATION');
  const before = f.calls.length,
    fresh = f.store();
  assert.deepEqual(await fresh.observeBaseline(bp), {
    body: baseline.body,
    sha256: baseline.sha256,
  });
  const result = await fresh.observeObservation(rp, bp);
  assert.deepEqual(JSON.parse(result.body), report);
  assert.ok(f.calls.slice(before).every((c) => c instanceof GetObjectCommand));
  assert.equal(f.objects.size, 2);
  await assert.rejects(store.publishBaseline(baseline));
  assert.equal(f.objects.size, 2);
});
test('scope and compound report substitution refuse before writes even with recomputed hashes', async () => {
  const f = fixture(),
    { baseline, report } = evidence(),
    store = f.store();
  const decoded = JSON.parse(baseline.body);
  decoded.maintenance.sourceSha = '9'.repeat(40);
  const body = JSON.stringify(decoded);
  await assert.rejects(store.publishBaseline({ body, sha256: hash(body) }));
  assert.equal(f.calls.length, 0);
  const bp = await f.store().publishBaseline(baseline);
  for (const changed of [
    { baselineSha256: '0'.repeat(64) },
    { configurationDigest: '0'.repeat(64) },
    {
      refusals: [
        {
          ...report.refusals[0],
          credentialId: '33333333-3333-4333-8333-333333333333',
        },
      ],
    },
    { observedAt: '2026-10-16T00:00:00.000Z' },
    { wholeStorageQuiesced: true },
  ]) {
    const value = { ...report, ...changed };
    const core = {
      kind: value.kind,
      configurationDigest: value.configurationDigest,
      baselineSha256: value.baselineSha256,
      observedAt: value.observedAt,
      refusals: value.refusals,
    };
    value.observationDigest = hash(JSON.stringify(core));
    const before = f.calls.filter((c) => c instanceof PutObjectCommand).length;
    await assert.rejects(f.store().publishObservation(value, bp));
    assert.equal(
      f.calls.filter((c) => c instanceof PutObjectCommand).length,
      before,
    );
  }
});
test('lost publication acknowledgement cannot retry or manufacture a version pin', async () => {
  const f = fixture(),
    store = f.store(),
    { baseline } = evidence();
  let lost = false;
  f.setFault((command) => {
    if (command instanceof PutObjectCommand) {
      lost = true;
      f.objects.set(command.input.Key!, {
        body: String(command.input.Body),
        versionId: 'committed-unknown',
      });
      throw new Error('PRIVATE response lost');
    }
  });
  await assert.rejects(
    store.publishBaseline(baseline),
    (e) => e instanceof Error && !e.message.includes('PRIVATE'),
  );
  assert.equal(lost, true);
  const before = f.calls.length;
  await assert.rejects(store.publishBaseline(baseline));
  assert.equal(f.calls.length, before);
  f.setFault(undefined);
  await assert.rejects(f.store().publishBaseline(baseline));
  assert.equal(f.objects.size, 1);
});
test('wrong provider metadata, changed bytes and a forged pin fail exact readback', async () => {
  for (const mode of [
    'key',
    'version',
    'delete',
    'length',
    'bytes',
    'checksum',
  ] as const) {
    const f = fixture(),
      { baseline } = evidence(),
      bp = await f.store().publishBaseline(baseline);
    f.setFault((command) => {
      if (command instanceof GetObjectCommand) {
        const body = mode === 'bytes' ? baseline.body + ' ' : baseline.body;
        return {
          ...f.metadata(
            mode === 'version' ? 'different-version' : bp.versionId,
          ),
          SSEKMSKeyId: mode === 'key' ? 'wrong-key' : config.kmsKeyArn,
          DeleteMarker: mode === 'delete',
          ContentLength: mode === 'length' ? 99999 : Buffer.byteLength(body),
          Body: Readable.from([Buffer.from(body)]),
        };
      }
    });
    await assert.rejects(
      f
        .store()
        .observeBaseline(
          mode === 'checksum' ? { ...bp, sha256: '0'.repeat(64) } : bp,
        ),
    );
  }
});

test('maximum fifty-key baseline and report remain bounded with matching ordered identities', async () => {
  const f = fixture(),
    source = evidence(),
    decoded = JSON.parse(source.baseline.body);
  const ids = Array.from(
    { length: 50 },
    (_, i) => '22222222-2222-4222-8222-' + String(i + 1).padStart(12, '0'),
  );
  decoded.credentialIds = ids;
  const body = JSON.stringify(decoded),
    baseline = { body, sha256: hash(body) };
  const core = {
    kind: source.report.kind,
    configurationDigest: config.probeRegistryDigest,
    baselineSha256: baseline.sha256,
    observedAt: source.report.observedAt,
    refusals: ids.map((credentialId) => ({
      credentialId,
      create: 401,
      update: 403,
      delete: 401,
    })),
  };
  const report = {
      ...source.report,
      ...core,
      observationDigest: hash(JSON.stringify(core)),
      retainedSyntheticObjects: 50,
    },
    store = f.store();
  const bp = await store.publishBaseline(baseline),
    rp = await store.publishObservation(report, bp);
  assert.ok(bp.byteLength <= 8192);
  assert.ok(rp.byteLength <= 16384);
  assert.equal(
    JSON.parse((await f.store().observeObservation(rp, bp)).body).refusals
      .length,
    50,
  );
});

test('explicit SDK target has no ambient fallback, retry or regional redirect', async () => {
  assert.throws(() => new S3ManagedWriteEvidence(config, undefined as never));
  assert.throws(
    () =>
      new S3ManagedWriteEvidence(
        { ...config, accountId: '000000000000' },
        credentials,
      ),
  );
  const interception = mock.method(
    S3Client.prototype,
    'send',
    async function (this: S3Client) {
      assert.equal(await this.config.region(), 'eu-west-1');
      assert.equal(await this.config.maxAttempts(), 1);
      assert.equal(this.config.followRegionRedirects, false);
      const endpoint = await this.config.endpoint!();
      assert.equal(endpoint.protocol, 'https:');
      assert.equal(endpoint.hostname, 's3.eu-west-1.amazonaws.com');
      throw new Error('PRIVATE synthetic transport');
    },
  );
  try {
    await assert.rejects(
      new S3ManagedWriteEvidence(config, credentials).publishBaseline(
        evidence().baseline,
      ),
      (e) => e instanceof Error && !e.message.includes('PRIVATE'),
    );
  } finally {
    interception.mock.restore();
  }
});

test('a stalled exact-version body is destroyed at its deadline without publication retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(),
    body = new Readable({ read() {} }),
    baseline = evidence().baseline;
  f.setFault((command) =>
    command instanceof GetObjectCommand
      ? {
          ...f.metadata('synthetic-version-1'),
          ContentLength: baseline.byteLength,
          Body: body,
        }
      : undefined,
  );
  const refusal = assert.rejects(f.store().publishBaseline(baseline));
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(15001);
  await refusal;
  assert.equal(body.destroyed, true);
  assert.equal(f.calls.filter((c) => c instanceof PutObjectCommand).length, 1);
});
