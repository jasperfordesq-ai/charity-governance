import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  resumableEvidenceFixture,
  resumableEvidenceConfig as config,
  evidenceHash as hash,
} from './fixtures/resumable-upload-evidence.js';
import {
  resumablePrefixSha256,
  parseResumableUploadBaseline,
  parseResumableUploadObservation,
  resumableUploadObservationArtifact,
} from '../services/resumable-upload-evidence-contract.js';
function artifacts() {
  const body = JSON.stringify({
      format: 1,
      kind: 'SUPABASE_RESUMABLE_BASELINE_V1',
      configurationDigest: config.probeDigest,
      maintenance: config.maintenance,
      credentialId: '22222222-2222-4222-8222-222222222222',
      reference: '33333333-3333-4333-8333-333333333333',
      locationSha256: '5'.repeat(64),
      locationPin: {
        kind: 'RESUMABLE_LOCATION_PIN_V1',
        reference: '33333333-3333-4333-8333-333333333333',
        custodyDigest: config.locationCustodyDigest,
        versionId: 'encrypted-location-1',
        sha256: '6'.repeat(64),
        byteLength: 1024,
      },
      capturedAt: '2026-10-17T00:00:00.000Z',
      expiresAt: '2026-10-17T01:00:00.000Z',
      offset: 6291456,
      uploadLength: 6291457,
      prefixSha256: resumablePrefixSha256,
    }),
    baseline = { body, sha256: hash(body) };
  const core = {
    kind: 'SUPABASE_RESUMABLE_REFUSAL_V1',
    configurationDigest: config.probeDigest,
    baselineSha256: baseline.sha256,
    locationPinSha256: '6'.repeat(64),
    credentialId: '22222222-2222-4222-8222-222222222222',
    observedAt: '2026-10-17T00:01:00.000Z',
    refusalStatus: 403,
    providerObservedAt: '2026-10-17T00:01:00.000Z',
  };
  const report = {
    ...core,
    observationDigest: hash(JSON.stringify(core)),
    testedResumablePatchRefusalObserved: true,
    coverage: 'ONE_REVIEWED_MODERN_SECRET_TUS_SESSION_ONLY',
    resumableSessionsRevoked: false,
    signedResumableVerified: false,
    inFlightWritesDrained: false,
    providerReleaseAttested: false,
    wholeStorageQuiesced: false,
    actionAuthorized: false,
  };
  return { baseline, core, report };
}
test('original TUS baseline and report publish through exact version pins and fresh inspection uses GET only', async () => {
  const f = resumableEvidenceFixture(),
    s = f.store(),
    { baseline, report } = artifacts(),
    bp = await s.publishBaseline(baseline),
    rp = await s.publishObservation(report, bp),
    before = f.calls.length;
  assert.deepEqual(await f.store().observeBaseline(bp), baseline);
  assert.deepEqual(
    JSON.parse((await f.store().observeObservation(rp, bp)).body),
    report,
  );
  assert.ok(f.calls.slice(before).every((c) => c instanceof GetObjectCommand));
  assert.equal(f.objects.size, 2);
  await assert.rejects(s.publishBaseline(baseline));
  await assert.rejects(s.publishObservation(report, bp));
  await assert.rejects(f.store().publishBaseline(baseline));
  assert.equal(f.objects.size, 2);
});
test('recomputed report substitutions wrong credential wrong pin chronology expiry and non-authentication refusals never publish', async () => {
  const f = resumableEvidenceFixture(),
    { baseline, report, core } = artifacts(),
    bp = await f.store().publishBaseline(baseline);
  for (const change of [
    { baselineSha256: '0'.repeat(64) },
    { locationPinSha256: '0'.repeat(64) },
    { configurationDigest: '0'.repeat(64) },
    { credentialId: '44444444-4444-4444-8444-444444444444' },
    { observedAt: '2026-10-16T23:00:00.000Z' },
    { providerObservedAt: '2026-10-16T23:00:00.000Z' },
    {
      observedAt: '2026-10-17T00:59:30.000Z',
      providerObservedAt: '2026-10-17T00:59:30.000Z',
    },
    { observedAt: '2026-10-17T00:10:00.000Z' },
    { refusalStatus: 404 },
    { refusalStatus: 409 },
    { refusalStatus: 500 },
  ]) {
    const c = { ...core, ...change },
      n = f.calls.filter((c) => c instanceof PutObjectCommand).length;
    await assert.rejects(
      f
        .store()
        .publishObservation(
          { ...report, ...c, observationDigest: hash(JSON.stringify(c)) },
          bp,
        ),
    );
    assert.equal(
      f.calls.filter((c) => c instanceof PutObjectCommand).length,
      n,
    );
  }
  await assert.rejects(
    f
      .store()
      .publishObservation({ ...report, resumableSessionsRevoked: true }, bp),
  );
});
test('scope format target and unfinished-state substitutions cannot enter baseline publication', async () => {
  const { baseline } = artifacts(),
    v = JSON.parse(baseline.body);
  for (const change of [
    { maintenance: { ...config.maintenance, sourceSha: '0'.repeat(40) } },
    { locationPin: { ...v.locationPin, custodyDigest: '0'.repeat(64) } },
    { reference: '44444444-4444-4444-8444-444444444444' },
    { credentialId: '44444444-4444-4444-8444-444444444444' },
    { offset: 6291457 },
    { uploadLength: 6291456 },
    { prefixSha256: '0'.repeat(64) },
    { expiresAt: '2026-10-17T00:00:30.000Z' },
    { expiresAt: '2026-10-19T00:00:00.000Z' },
  ]) {
    const f = resumableEvidenceFixture(),
      body = JSON.stringify({ ...v, ...change });
    await assert.rejects(
      f.store().publishBaseline({ body, sha256: hash(body) }),
    );
    assert.equal(f.calls.length, 0);
  }
});
test('lost publication and readback ACKs consume the operation without overwrites or guessed evidence', async () => {
  for (const stage of ['put', 'get']) {
    const f = resumableEvidenceFixture(),
      s = f.store(),
      { baseline } = artifacts();
    f.setFault((c) => {
      if (stage === 'put' && c instanceof PutObjectCommand) {
        f.commit(c);
        throw new Error('synthetic lost TUS ACK');
      }
      if (stage === 'get' && c instanceof GetObjectCommand)
        throw new Error('synthetic lost TUS readback');
    });
    await assert.rejects(s.publishBaseline(baseline));
    const n = f.calls.length;
    await assert.rejects(s.publishBaseline(baseline));
    assert.equal(f.calls.length, n);
    f.setFault(undefined);
    await assert.rejects(f.store().publishBaseline(baseline));
    assert.equal(f.objects.size, 1);
  }
});
test('retained version metadata content and pin kind are checked before returning a report', async () => {
  const f = resumableEvidenceFixture(),
    { baseline, report } = artifacts(),
    bp = await f.store().publishBaseline(baseline),
    rp = await f.store().publishObservation(report, bp);
  for (const change of [
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
            ...change,
          }
        : undefined,
    );
    await assert.rejects(f.store().observeBaseline(bp));
  }
  f.setFault(undefined);
  await assert.rejects(f.store().observeBaseline(rp));
  const row = [...f.objects.values()][0];
  row.body = row.body.replace('encrypted-location-1', 'encrypted-location-2');
  await assert.rejects(f.store().observeBaseline(bp));
});
test('closed canonical artifacts exclude raw URLs secrets and inflated coverage', () => {
  const { baseline, report } = artifacts(),
    pretty = JSON.stringify(JSON.parse(baseline.body), null, 2);
  assert.throws(() =>
    parseResumableUploadBaseline({ body: pretty, sha256: hash(pretty) }),
  );
  assert.throws(() =>
    parseResumableUploadBaseline({ ...baseline, byteLength: 1 }),
  );
  const body = JSON.stringify({
    ...report,
    location: 'https://synthetic.example/private',
  });
  assert.throws(() =>
    parseResumableUploadObservation({ body, sha256: hash(body) }),
  );
  assert.throws(() =>
    resumableUploadObservationArtifact({
      ...report,
      inFlightWritesDrained: true,
    }),
  );
});
