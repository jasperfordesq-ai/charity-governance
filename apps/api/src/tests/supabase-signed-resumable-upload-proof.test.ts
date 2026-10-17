import {
  signedResumableProbeFixture as fixture,
  config,
  control,
} from './fixtures/signed-resumable-upload.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  signedTusHash as hash,
  assertSignedResumableLocation,
  assertSignedResumablePair,
} from '../services/signed-resumable-upload-contract.js';
for (const format of ['PATH_V1', 'FILE_VERSION_V1'])
  test(
    'signed TUS uses original ' +
      format +
      ' location/token and bracketing current-issuer uploads',
    async () => {
      const f = fixture(format),
        service = f.factory(),
        a = await service.baseline(f.retain, f.custody);
      f.mode.revoked = true;
      const report = await service.verifyRefusal(a, f.custody, f.saved);
      assert.equal(report.testedSignedResumablePatchRefusalObserved, true);
      assert.equal(report.refusalCode, 'InvalidSignature');
      assert.equal(report.signedCapabilitiesRevoked, false);
      assert.equal(report.resumableSessionsRevoked, false);
      assert.equal(report.wholeStorageQuiesced, false);
      const old = f.calls.filter(
        (c) => c.url === f.saved.location && c.method === 'PATCH',
      );
      assert.equal(old.length, 2);
      assert.equal(old[0].signature, old[1].signature);
      assert.equal(
        f.calls.filter(
          (c) => c.method === 'POST' && c.url.endsWith('/resumable/sign'),
        ).length,
        3,
      );
      assert.equal(
        f.calls.filter((c) => c.method === 'HEAD' && c.url.includes('/sign/'))
          .length,
        0,
      );
      assert.equal(f.objects.size, 2);
      assert.ok(!JSON.stringify({ a, report }).includes(f.saved.token));
      assert.ok(!JSON.stringify({ a, report }).includes(f.saved.location));
      const before = f.calls.length;
      service.assertBaseline(a, f.custody);
      assert.equal(f.calls.length, before);
      await assert.rejects(service.baseline(f.retain, f.custody));
      await assert.rejects(service.verifyRefusal(a, f.custody, f.saved));
      assert.equal(f.calls.length, before);
    },
  );
test('continued old capability, side effects and failed retained controls cannot satisfy signed TUS closure', async () => {
  for (const mode of ['stillWorks', 'sideEffect', 'failControl'] as const) {
    const f = fixture(),
      s = f.factory(),
      a = await s.baseline(f.retain, f.custody);
    f.mode.revoked = true;
    f.mode[mode] = true;
    await assert.rejects(s.verifyRefusal(a, f.custody, f.saved));
  }
});
test('only explicit signature/access refusals count; missing, expired, conflicting and generic failures stay unresolved', async () => {
  for (const [status, body] of [
    [404, 'Access denied'],
    [410, 'Access denied'],
    [409, 'Access denied'],
    [500, 'invalid signature'],
    [400, 'The provided token has expired.'],
    [400, 'Missing x-signature header'],
    [400, '{"code":"AccessDenied"}'],
    [401, 'generic'],
    [403, '{"code":"ResourceAlreadyExists"}'],
  ] as const) {
    const f = fixture(),
      s = f.factory(),
      a = await s.baseline(f.retain, f.custody);
    f.mode.revoked = true;
    f.mode.refusalStatus = status;
    f.mode.refusalBody = body;
    await assert.rejects(s.verifyRefusal(a, f.custody, f.saved));
  }
  const f = fixture(),
    s = f.factory(),
    a = await s.baseline(f.retain, f.custody);
  f.mode.revoked = true;
  f.mode.refusalStatus = 403;
  f.mode.refusalBody = '{"code":"SignatureDoesNotMatch"}';
  assert.equal(
    (await s.verifyRefusal(a, f.custody, f.saved)).refusalCode,
    'SignatureDoesNotMatch',
  );
});
test('custody loss, invalid pin, unsigned location and expiry fail before original chunk dispatch', async () => {
  for (const mode of [
    'lost',
    'wrong-pin',
    'badLocation',
    'badExpiry',
  ] as const) {
    const f = fixture(),
      s = f.factory();
    if (mode === 'badLocation' || mode === 'badExpiry') f.mode[mode] = true;
    await assert.rejects(
      s.baseline(async (v, signal) => {
        if (mode === 'lost') throw new Error('synthetic lost acknowledgement');
        const pin = await f.retain(v, signal);
        return { ...pin, tokenSha256: '0'.repeat(64) };
      }, f.custody),
    );
    assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 0);
    const before = f.calls.length;
    await assert.rejects(s.baseline(f.retain, f.custody));
    assert.equal(f.calls.length, before);
  }
});
test('issuer, path and upload-scope mismatches fail before session creation', async () => {
  for (const mode of ['wrongIssuer', 'wrongScope', 'wrongPath'] as const) {
    const f = fixture();
    f.mode[mode] = true;
    await assert.rejects(f.factory().baseline(f.retain, f.custody));
    assert.equal(f.sessions.size, 0);
  }
});
test('original secret, reference, location, baseline and configuration substitutions refuse before provider work', async () => {
  const f = fixture(),
    a = await f.factory().baseline(f.retain, f.custody);
  f.mode.revoked = true;
  for (const secret of [
    { ...f.saved, reference: randomUUID() },
    { ...f.saved, token: f.saved.token.slice(0, -4) + 'AAAA' },
    { ...f.saved, location: f.saved.location.replace('/sign/', '/') },
    { ...f.saved, location: f.saved.location + '?token=unexpected' },
  ]) {
    const before = f.calls.length;
    await assert.rejects(f.factory().verifyRefusal(a, f.custody, secret));
    assert.equal(f.calls.length, before);
  }
  const changed = structuredClone(f.config);
  changed.maintenance.maintenanceEpoch = 2;
  const before = f.calls.length;
  await assert.rejects(f.factory(changed).verifyRefusal(a, f.custody, f.saved));
  await assert.rejects(f.factory().verifyRefusal(a, '0'.repeat(64), f.saved));
  assert.equal(f.calls.length, before);
});
test('signed locations bind the exact signed route and fixed synthetic target', () => {
  const f = fixture(),
    scope = {
      installationId: config.installationId,
      projectRef: config.projectRef,
      attemptId: config.maintenance.attemptId,
      uploadIdFormat: 'PATH_V1',
    },
    origin = 'https://' + config.projectRef + '.storage.supabase.co',
    encoded = Buffer.from(
      config.bucket +
        '/charitypilot-recovery-resumable-probe/synthetic/' +
        scope.attemptId +
        '/old.txt/' +
        randomUUID(),
    ).toString('base64url'),
    location = origin + '/storage/v1/upload/resumable/sign/' + encoded;
  assert.equal(assertSignedResumableLocation(location, scope), location);
  for (const v of [
    location.replace('/sign/', '/'),
    location.replace('.storage.supabase.co', '.supabase.co'),
    location + '?x=1',
    location + '#x',
    location.replace('/sign/', '/sign//'),
    location.replace('https://', 'https://user@'),
    location.replace('.co/', '.co:443/'),
  ])
    assert.throws(() => assertSignedResumableLocation(v, scope));
  assert.equal(f.calls.length, 0);
});
test('already-cancelled baseline consumes the phase without dispatch or disclosure', async () => {
  const f = fixture(),
    s = f.factory(),
    signal = AbortSignal.abort();
  await assert.rejects(
    s.baseline(f.retain, f.custody, signal),
    (e) => e instanceof Error && !e.message.includes(control.secret),
  );
  assert.equal(f.calls.length, 0);
  await assert.rejects(s.baseline(f.retain, f.custody));
});

test('original report association and chronology survive recomputed digest attacks', async () => {
  const f = fixture(),
    service = f.factory(),
    a = await service.baseline(f.retain, f.custody);
  f.mode.revoked = true;
  const report = await service.verifyRefusal(a, f.custody, f.saved);
  const coreKeys = [
    'kind',
    'configurationDigest',
    'baselineSha256',
    'credentialPinSha256',
    'tokenSha256',
    'locationSha256',
    'issuerFingerprint',
    'observedAt',
    'providerObservedAt',
    'refusalStatus',
    'refusalCode',
  ];
  const rehash = (r: Record<string, unknown>) => ({
    ...r,
    observationDigest: hash(
      JSON.stringify(Object.fromEntries(coreKeys.map((k) => [k, r[k]]))),
    ),
  });
  assert.deepEqual(assertSignedResumablePair(a, report), report);
  for (const field of [
    'configurationDigest',
    'baselineSha256',
    'credentialPinSha256',
    'tokenSha256',
    'locationSha256',
    'issuerFingerprint',
  ])
    assert.throws(() =>
      assertSignedResumablePair(
        a,
        rehash({ ...report, [field]: '0'.repeat(64) }),
      ),
    );
  for (const patch of [
    { observedAt: '2000-01-01T00:00:00.000Z' },
    { providerObservedAt: '2000-01-01T00:00:00.000Z' },
    { providerObservedAt: new Date(Date.now() + 120000).toISOString() },
    { refusalStatus: 400, refusalCode: 'AccessDenied' },
    { signedCapabilitiesRevoked: true },
  ])
    assert.throws(() =>
      assertSignedResumablePair(a, rehash({ ...report, ...patch })),
    );
  const parsed = JSON.parse(a.body);
  parsed.credentialPin.locationSha256 = '0'.repeat(64);
  const body = JSON.stringify(parsed);
  assert.throws(() =>
    assertSignedResumablePair(
      { body, sha256: hash(body) },
      rehash({ ...report, baselineSha256: hash(body) }),
    ),
  );
});
test('late combined-custody acknowledgement after cancellation never starts the original chunk', async () => {
  const f = fixture(),
    s = f.factory(),
    controller = new AbortController();
  let started!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => {
      started = r;
    }),
    late = new Promise<void>((r) => {
      release = r;
    });
  const pending = s.baseline(
    async (v, signal) => {
      const pin = await f.retain(v, signal);
      started();
      await late;
      return pin;
    },
    f.custody,
    controller.signal,
  );
  await ready;
  controller.abort();
  await assert.rejects(pending);
  release();
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 0);
  const before = f.calls.length;
  await assert.rejects(s.baseline(f.retain, f.custody));
  assert.equal(f.calls.length, before);
});
