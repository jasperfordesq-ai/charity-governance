import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
  S3CapabilityEvidence,
  s3CapabilityEvidenceScope,
} from '../services/s3-capability-evidence.js';
import { S3CapabilityVault } from '../services/s3-capability-vault.js';
import {
  parseS3CapabilityObservation,
  s3CapabilityObservationArtifact,
  s3ProbeHash as hash,
} from '../services/s3-capability-contract.js';
import { s3CapabilityProbeFixture } from './fixtures/s3-capability-proof.js';
import {
  maintenanceSecretVaultFixture,
  syntheticAwsCredentials,
} from './fixtures/resumable-location-vault.js';
const storage = {
  installationId: 'synthetic',
  bucket: 'synthetic-evidence',
  accountId: '123456789012',
  kmsKeyArn:
    'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-4111-8111-111111111111',
};
function fixture(
  config: typeof storage & {
    maintenance: {
      attemptId: string;
      sourceSha: string;
      planDigest: string;
      maintenanceEpoch: number;
    };
    probeDigest: string;
    capabilityCustodyDigest: string;
    credentialId: string;
  },
) {
  const client = new S3Client({
      region: 'eu-west-1',
      credentials: syntheticAwsCredentials,
    }),
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
    assert.equal(c.input.SSEKMSKeyId, config.kmsKeyArn);
    assert.equal(c.input.ServerSideEncryption, 'aws:kms');
    assert.equal(
      c.input.ChecksumSHA256,
      createHash('sha256').update(String(c.input.Body)).digest('base64'),
    );
    if (objects.has(c.input.Key!)) throw new Error('synthetic conflict');
    const row = {
      body: String(c.input.Body),
      versionId: 'version-' + (objects.size + 1),
    };
    objects.set(c.input.Key!, row);
    return metadata(row.versionId);
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
          '^managed-maintenance/synthetic/' +
            config.maintenance.attemptId +
            '/s3-capability/[a-f0-9]{64}/(baseline|observation)\\.json$',
        ),
      );
      const result = fault?.(c);
      if (result !== undefined) return result;
      if (c instanceof PutObjectCommand) return commit(c);
      const row = objects.get(c.input.Key!);
      if (!row) throw new Error('synthetic missing object');
      assert.equal(c.input.VersionId, row.versionId);
      assert.equal(c.input.ChecksumMode, 'ENABLED');
      return {
        ...metadata(row.versionId),
        ContentLength: Buffer.byteLength(row.body),
        Body: Readable.from([Buffer.from(row.body)]),
      };
    },
  );
  return {
    config,
    calls,
    objects,
    metadata,
    commit,
    setFault: (f: typeof fault) => {
      fault = f;
    },
    store: (raw: unknown = config) =>
      new S3CapabilityEvidence(raw, syntheticAwsCredentials, client),
  };
}
async function artifacts(endpoint = 'DIRECT') {
  const p = s3CapabilityProbeFixture(endpoint),
    probe = p.factory(),
    baseline = await probe.baseline(p.retain, p.custody);
  p.mode.disabled = true;
  const report = await probe.verifyRefusal(baseline, p.custody, p.saved);
  const f = fixture({
    ...storage,
    maintenance: p.config.maintenance,
    probeDigest: probe.configurationDigest(),
    capabilityCustodyDigest: p.custody,
    credentialId: p.config.retired.id,
  });
  return { f, p, baseline, report };
}
for (const endpoint of ['DIRECT', 'GATEWAY'])
  test(
    endpoint +
      ' actual SDK, combined encrypted custody and original public artifacts compose; inspection makes GETs only',
    async () => {
      const p = s3CapabilityProbeFixture(endpoint),
        probe = p.factory(),
        probeDigest = probe.configurationDigest();
      const keyHash = p.config.retired.accessKeyIdSha256;
      const v = maintenanceSecretVaultFixture(
        { probeDigest },
        's3-capability/' +
          endpoint +
          '/eu-west-1/' +
          keyHash +
          '/' +
          probeDigest +
          '.json',
        'charitypilot-s3-capability-v1',
      );
      const { uploadIdFormat, ...base } = v.config;
      const vault = () =>
        new S3CapabilityVault(
          {
            ...base,
            endpoint,
            region: 'eu-west-1',
            accessKeyIdSha256: keyHash,
          },
          syntheticAwsCredentials,
          syntheticAwsCredentials,
          { storage: v.storage, kms: v.kms },
        );
      const custody = vault().configurationDigest(),
        baseline = await probe.baseline(
          (input, signal) => vault().retain(input, signal),
          custody,
        );
      const f = fixture({
        ...storage,
        maintenance: p.config.maintenance,
        probeDigest,
        capabilityCustodyDigest: custody,
        credentialId: p.config.retired.id,
      });
      const bp = await f.store().publishBaseline(baseline),
        cap = JSON.parse(baseline.body).capabilityPin;
      p.mode.disabled = true;
      const report = await vault().withCredential(
        cap,
        cap.reference,
        (value, signal) =>
          p.factory().verifyRefusal(baseline, custody, value, signal),
      );
      const rp = await f.store().publishObservation(report, bp),
        before = f.calls.length,
        providerBefore = p.calls.length,
        secretBefore = v.calls.length;
      assert.deepEqual(await f.store().observeBaseline(bp), baseline);
      assert.deepEqual(
        JSON.parse((await f.store().observeObservation(rp, bp)).body),
        report,
      );
      assert.ok(
        f.calls.slice(before).every((c) => c instanceof GetObjectCommand),
      );
      assert.equal(p.calls.length, providerBefore);
      assert.equal(v.calls.length, secretBefore);
      assert.equal(f.objects.size, 2);
      await vault().withCredential(cap, cap.reference, async (value) => {
        for (const row of f.objects.values()) {
          assert.ok(!row.body.includes(value.presignedUrl));
          assert.ok(!row.body.includes(value.uploadId));
        }
      });
    },
  );

test('recomputed public report substitutions cannot change original pairing, coverage or order', async () => {
  const { f, baseline, report } = await artifacts(),
    bp = await f.store().publishBaseline(baseline);
  for (const patch of [
    { baselineSha256: '0'.repeat(64) },
    { capabilityPinSha256: '0'.repeat(64) },
    { credentialId: randomUUID() },
    { configurationDigest: '0'.repeat(64) },
    { observedAt: '2000-01-01T00:00:00.000Z' },
    { refusals: report.refusals.slice(1) },
    { refusals: [...report.refusals].reverse() },
    { refusals: report.refusals.map((v) => ({ ...v, status: 404 })) },
  ]) {
    const changed = { ...report, ...patch };
    const {
      observationDigest,
      testedS3FeatureRefusalsObserved,
      coverage,
      s3CredentialsRevoked,
      presignedCapabilitiesRevoked,
      multipartUploadsDrained,
      inFlightWritesDrained,
      providerReleaseAttested,
      wholeStorageQuiesced,
      actionAuthorized,
      ...core
    } = changed;
    const before = f.calls.filter((c) => c instanceof PutObjectCommand).length;
    await assert.rejects(
      f
        .store()
        .publishObservation(
          { ...changed, observationDigest: hash(JSON.stringify(core)) },
          bp,
        ),
    );
    assert.equal(
      f.calls.filter((c) => c instanceof PutObjectCommand).length,
      before,
    );
  }
  await assert.rejects(
    f.store().publishObservation({ ...report, wholeStorageQuiesced: true }, bp),
  );
});

test('wrong baseline scope, custody, attempt or original key refuses before evidence dispatch', async () => {
  const { f, baseline } = await artifacts(),
    v = JSON.parse(baseline.body);
  for (const patch of [
    { configurationDigest: '0'.repeat(64) },
    { credentialId: randomUUID() },
    { maintenance: { ...v.maintenance, attemptId: randomUUID() } },
    { capabilityPin: { ...v.capabilityPin, custodyDigest: '0'.repeat(64) } },
  ]) {
    const body = JSON.stringify({ ...v, ...patch }),
      before = f.calls.length;
    await assert.rejects(
      f.store().publishBaseline({ body, sha256: hash(body) }),
    );
    assert.equal(f.calls.length, before);
  }
});

test('lost committed baseline/report PUT or readback acknowledgement consumes operation without overwrites', async () => {
  for (const kind of ['baseline', 'observation'])
    for (const stage of ['put', 'get']) {
      const { f, baseline, report } = await artifacts(),
        store = f.store(),
        bp =
          kind === 'observation'
            ? await store.publishBaseline(baseline)
            : undefined;
      f.setFault((c) => {
        if (c.input.Key!.endsWith('/' + kind + '.json')) {
          if (stage === 'put' && c instanceof PutObjectCommand) {
            f.commit(c);
            throw new Error('synthetic lost PUT');
          }
          if (stage === 'get' && c instanceof GetObjectCommand)
            throw new Error('synthetic lost readback');
        }
      });
      const publish = (s: ReturnType<typeof f.store>) =>
        kind === 'baseline'
          ? s.publishBaseline(baseline)
          : s.publishObservation(report, bp);
      await assert.rejects(publish(store));
      const before = f.calls.length;
      await assert.rejects(publish(store));
      assert.equal(f.calls.length, before);
      f.setFault(undefined);
      await assert.rejects(publish(f.store()));
      assert.equal(f.objects.size, kind === 'baseline' ? 1 : 2);
    }
});

test('cross-scope pins, wrong versions, SSE and content never become original evidence', async () => {
  const { f, baseline, report } = await artifacts(),
    bp = await f.store().publishBaseline(baseline),
    rp = await f.store().publishObservation(report, bp);
  for (const patch of [
    { VersionId: 'other' },
    { SSEKMSKeyId: 'wrong' },
    { DeleteMarker: true },
    { ContentLength: 9999 },
  ]) {
    f.setFault((c) =>
      c instanceof GetObjectCommand
        ? {
            ...f.metadata(bp.versionId),
            ContentLength: bp.byteLength,
            Body: Readable.from([Buffer.from(baseline.body)]),
            ...patch,
          }
        : undefined,
    );
    await assert.rejects(f.store().observeBaseline(bp));
  }
  f.setFault(undefined);
  await assert.rejects(f.store().observeBaseline(rp));
  await assert.rejects(
    f.store({ ...f.config, probeDigest: '0'.repeat(64) }).observeBaseline(bp),
  );
  const row = [...f.objects.values()][0];
  row.body = row.body.replace(
    'synthetic-capability-version',
    'other-capability-version',
  );
  await assert.rejects(f.store().observeBaseline(bp));
});

test('distinct same-attempt scopes retain separate public baseline objects', async () => {
  const { f, baseline } = await artifacts(),
    b = JSON.parse(baseline.body);
  await f.store().publishBaseline(baseline);
  const config = {
      ...f.config,
      probeDigest: '0'.repeat(64),
      credentialId: randomUUID(),
    },
    body = JSON.stringify({
      ...b,
      configurationDigest: config.probeDigest,
      credentialId: config.credentialId,
    });
  await f.store(config).publishBaseline({ body, sha256: hash(body) });
  assert.equal(f.objects.size, 2);
  assert.notEqual(
    s3CapabilityEvidenceScope(f.config),
    s3CapabilityEvidenceScope(config),
  );
});

test('closed canonical reports reject raw capabilities and inflated authority', async () => {
  const { report } = await artifacts(),
    body = JSON.stringify({
      ...report,
      presignedUrl: 'https://synthetic.example/private',
    });
  assert.throws(() =>
    parseS3CapabilityObservation({ body, sha256: hash(body) }),
  );
  assert.throws(() =>
    s3CapabilityObservationArtifact({ ...report, actionAuthorized: true }),
  );
  const pretty = JSON.stringify(report, null, 2);
  assert.throws(() =>
    parseS3CapabilityObservation({ body: pretty, sha256: hash(pretty) }),
  );
});

test('late publication acknowledgement after cancellation cannot return a pin or backfill inspection', async () => {
  const { f, baseline } = await artifacts(),
    controller = new AbortController();
  let entered!: () => void, reply!: (r: unknown) => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  f.setFault((c) => {
    if (c instanceof PutObjectCommand) {
      const ack = f.commit(c);
      entered();
      return new Promise((r) => {
        reply = () => r(ack);
      });
    }
  });
  const s = f.store(),
    pending = assert.rejects(s.publishBaseline(baseline, controller.signal));
  await started;
  controller.abort();
  await pending;
  const before = f.calls.length;
  reply(undefined);
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(f.calls.length, before);
  await assert.rejects(s.publishBaseline(baseline));
  assert.equal(f.objects.size, 1);
});
