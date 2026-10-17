import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  signedEvidenceFixture,
  signedEvidenceConfig as config,
  evidenceHash as hash,
} from './fixtures/signed-upload-evidence.js';
import {
  parseSignedUploadBaseline,
  parseSignedUploadObservation,
  signedUploadObservationArtifact,
} from '../services/signed-upload-evidence-contract.js';
function artifacts() {
  const b = {
    format: 2,
    kind: 'SUPABASE_SIGNED_UPLOAD_BASELINE_V2',
    configurationDigest: config.probeDigest,
    maintenance: config.maintenance,
    credentialReference: '22222222-2222-4222-8222-222222222222',
    credentialPin: {
      kind: 'SIGNED_UPLOAD_CREDENTIAL_PIN_V1',
      reference: '22222222-2222-4222-8222-222222222222',
      custodyDigest: config.credentialCustodyDigest,
      versionId: 'encrypted-version-1',
      sha256: '5'.repeat(64),
      byteLength: 1024,
      tokenSha256: '6'.repeat(64),
    },
    tokenProof: {
      tokenSha256: '6'.repeat(64),
      providerKeyId: '33333333-3333-4333-8333-333333333333',
      tokenKid: 'synthetic-kid',
      issuerFingerprint: '7'.repeat(64),
      issuedAt: '2026-10-17T00:00:00.000Z',
      expiresAt: '2026-10-17T02:00:00.000Z',
    },
    capturedAt: '2026-10-17T00:00:01.000Z',
    initialPayloadSha256: '8'.repeat(64),
    updatePayloadSha256: '9'.repeat(64),
  };
  const body = JSON.stringify(b),
    baseline = { body, sha256: hash(body) };
  const core = {
    kind: 'SUPABASE_SIGNED_UPLOAD_REFUSAL_V1',
    configurationDigest: config.probeDigest,
    baselineSha256: baseline.sha256,
    credentialPinSha256: b.credentialPin.sha256,
    tokenSha256: b.tokenProof.tokenSha256,
    issuerFingerprint: b.tokenProof.issuerFingerprint,
    observedAt: '2026-10-17T00:01:00.000Z',
    refusalStatus: 400,
    refusalCode: 'InvalidJWT',
    providerObservedAt: '2026-10-17T00:01:00.000Z',
  };
  const report = {
    ...core,
    observationDigest: hash(JSON.stringify(core)),
    testedSignedUploadRefusalObserved: true,
    issuedTokenSignatureMatched: true,
    coverage: 'ONE_REVIEWED_SYNTHETIC_SIGNED_UPLOAD_ONLY',
    storageTokenIssuerVerified: false,
    managementKeyAssociationVerified: false,
    providerReleaseAttested: false,
    signedCapabilitiesRevoked: false,
    inFlightWritesDrained: false,
    wholeStorageQuiesced: false,
    actionAuthorized: false,
  };
  return { baseline, report, core };
}
test('original signed baseline and report survive fresh exact-version read-only inspection', async () => {
  const f = signedEvidenceFixture(),
    s = f.store(),
    { baseline, report } = artifacts();
  const bp = await s.publishBaseline(baseline),
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
test('recomputed compound substitutions and unsupported refusal meanings cannot be published', async () => {
  const f = signedEvidenceFixture(),
    { baseline, report, core } = artifacts(),
    bp = await f.store().publishBaseline(baseline);
  for (const changes of [
    { baselineSha256: '0'.repeat(64) },
    { credentialPinSha256: '0'.repeat(64) },
    { tokenSha256: '0'.repeat(64) },
    { issuerFingerprint: '0'.repeat(64) },
    { configurationDigest: '0'.repeat(64) },
    {
      observedAt: '2026-10-17T02:01:00.000Z',
      providerObservedAt: '2026-10-17T02:01:00.000Z',
    },
    {
      observedAt: '2026-10-17T01:59:30.000Z',
      providerObservedAt: '2026-10-17T01:59:30.000Z',
    },
    {
      observedAt: '2026-10-17T00:00:00.000Z',
      providerObservedAt: '2026-10-17T00:00:00.000Z',
    },
    { refusalCode: 'ExpiredToken' },
    { refusalCode: 'AccessDenied' },
    { refusalStatus: 500 },
  ]) {
    const changed = { ...core, ...changes },
      before = f.calls.filter((c) => c instanceof PutObjectCommand).length;
    await assert.rejects(
      f
        .store()
        .publishObservation(
          {
            ...report,
            ...changed,
            observationDigest: hash(JSON.stringify(changed)),
          },
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
  for (const changes of [
    { maintenance: { ...config.maintenance, sourceSha: '0'.repeat(40) } },
    {
      credentialPin: {
        ...JSON.parse(baseline.body).credentialPin,
        custodyDigest: '0'.repeat(64),
      },
    },
  ]) {
    const g = signedEvidenceFixture(),
      body = JSON.stringify({ ...JSON.parse(baseline.body), ...changes });
    await assert.rejects(
      g.store().publishBaseline({ body, sha256: hash(body) }),
    );
    assert.equal(g.calls.length, 0);
  }
});
test('lost publication or readback acknowledgement consumes the operation without guessing a replacement', async () => {
  for (const stage of ['put', 'get']) {
    const f = signedEvidenceFixture(),
      s = f.store(),
      { baseline } = artifacts();
    f.setFault((c) => {
      if (stage === 'put' && c instanceof PutObjectCommand) {
        f.commit(c);
        throw new Error('synthetic lost ACK');
      }
      if (stage === 'get' && c instanceof GetObjectCommand)
        throw new Error('synthetic lost readback');
    });
    await assert.rejects(s.publishBaseline(baseline));
    const n = f.calls.length;
    await assert.rejects(s.publishBaseline(baseline));
    assert.equal(f.calls.length, n);
    f.setFault(undefined);
    await assert.rejects(f.store().publishBaseline(baseline));
    assert.equal(f.objects.size, 1);
    await assert.rejects(
      f
        .store()
        .observeBaseline({
          kind: 'BASELINE',
          versionId: 'guessed',
          sha256: baseline.sha256,
          byteLength: Buffer.byteLength(baseline.body),
        }),
    );
  }
});
test('exact version, encryption metadata and retained content are required on reads', async () => {
  const f = signedEvidenceFixture(),
    { baseline, report } = artifacts(),
    bp = await f.store().publishBaseline(baseline),
    rp = await f.store().publishObservation(report, bp);
  for (const change of [
    { VersionId: 'different' },
    { SSEKMSKeyId: 'wrong' },
    { ServerSideEncryption: 'AES256' },
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
  row.body = row.body.replace('synthetic-kid', 'synthetic-bad');
  await assert.rejects(f.store().observeBaseline(bp));
});
test('hung requests are bounded and late response streams cannot resume publication', async (t) => {
  const f = signedEvidenceFixture(),
    { baseline } = artifacts();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reply!: (v: unknown) => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.setFault((c) => {
    if (c instanceof GetObjectCommand) {
      entered();
      return new Promise((resolve) => {
        reply = resolve;
      });
    }
  });
  const s = f.store(),
    result = assert.rejects(s.publishBaseline(baseline));
  await started;
  t.mock.timers.tick(15001);
  await result;
  const body = Readable.from([Buffer.from(baseline.body)]);
  reply({
    ...f.metadata('synthetic-version-1'),
    ContentLength: Buffer.byteLength(baseline.body),
    Body: body,
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(body.destroyed, true);
  const n = f.calls.length;
  await assert.rejects(s.publishBaseline(baseline));
  assert.equal(f.calls.length, n);
});
test('artifact byte bounds, canonical shape and raw secrets are refused before storage', () => {
  const { baseline, report } = artifacts();
  assert.throws(() =>
    parseSignedUploadBaseline({ ...baseline, byteLength: 1 }),
  );
  const pretty = JSON.stringify(JSON.parse(baseline.body), null, 2);
  assert.throws(() =>
    parseSignedUploadBaseline({ body: pretty, sha256: hash(pretty) }),
  );
  const body = JSON.stringify({ ...report, token: 'synthetic.raw.token' });
  assert.throws(() =>
    parseSignedUploadObservation({ body, sha256: hash(body) }),
  );
  assert.throws(() =>
    signedUploadObservationArtifact({
      ...report,
      signedCapabilitiesRevoked: true,
    }),
  );
  const huge = ' '.repeat(8193);
  assert.throws(() =>
    parseSignedUploadBaseline({ body: huge, sha256: hash(huge) }),
  );
});
