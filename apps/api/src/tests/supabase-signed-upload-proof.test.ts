import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import test from 'node:test';
import { vaultFixture } from './fixtures/signed-upload-vault.js';
import { signedEvidenceFixture, signedEvidenceConfig } from './fixtures/signed-upload-evidence.js';
import { SupabaseSignedUploadProof } from '../services/supabase-signed-upload-proof.js';
import { publicSigningKeyFingerprint } from '../services/supabase-signing-key-control.js';
import {
  syntheticWriteProbe,
  syntheticWriteUpdate,
} from '../services/supabase-credential-write-proof.js';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const modelPin = (reference: string, tokenSha256: string) => ({
  kind: 'SIGNED_UPLOAD_CREDENTIAL_PIN_V1' as const,
  reference,
  custodyDigest: '9'.repeat(64),
  versionId: 'synthetic-retained-1',
  sha256: '8'.repeat(64),
  byteLength: 1024,
  tokenSha256,
});
const pair = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
  old = pair(),
  fresh = pair();
const ids = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
];
const issuer = (p: ReturnType<typeof pair>, id: string) => {
  const publicJwk = p.publicKey.export({ format: 'jwk' });
  return {
    providerKeyId: id,
    tokenKid: 'storage:' + id,
    algorithm: 'ES256',
    fingerprint: publicSigningKeyFingerprint('ES256', publicJwk),
    publicJwk,
  };
};
const control = { id: ids[0], secret: 'sb_secret_' + 'a'.repeat(40) },
  gateway = { id: ids[1], secret: 'sb_publishable_' + 'b'.repeat(40) };
const config = {
  installationId: 'synthetic',
  projectRef: 'abcdefghijklmnopqrst',
  bucket: 'charitypilot-recovery-signed-probes',
  maintenance: {
    attemptId: '33333333-3333-4333-8333-333333333333',
    planDigest: '1'.repeat(64),
    sourceSha: '2'.repeat(40),
    maintenanceEpoch: 1,
  },
  providerRelease: { sourceSha: '3'.repeat(40), imageDigest: '4'.repeat(64) },
  control: { id: control.id, sha256: hash(control.secret) },
  gateway: { id: gateway.id, sha256: hash(gateway.secret) },
  previousIssuer: issuer(old, ids[0]),
  currentIssuer: issuer(fresh, ids[1]),
};
function fixture() {
  let rotated = false,
    denial = 400,
    code = 'InvalidJWT',
    acceptOld = false,
    sideEffect = false,
    controlFails = false,
    corruptUrl = false;
  const objects = new Map<string, string>(),
    calls: { method: string; path: string; credential: string | null }[] = [];
  let saved: { reference: string; token: string } | undefined;
  let clockShift = 0;
  const headers = () => ({
    date: new Date(Date.now() + clockShift).toUTCString(),
  });
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      h = new Headers(init?.headers),
      method = init!.method!,
      prefix = '/storage/v1/object/';
    assert.equal(url.origin, 'https://abcdefghijklmnopqrst.supabase.co');
    assert.equal(init?.redirect, 'error');
    assert.equal(h.get('authorization'), null);
    calls.push({ method, path: url.pathname, credential: h.get('apikey') });
    if (url.pathname.includes('/bucket/'))
      return Response.json(
        { id: config.bucket, public: false },
        { headers: headers() },
      );
    if (url.pathname.startsWith(prefix + 'upload/sign/')) {
      const path = url.pathname.slice((prefix + 'upload/sign/').length);
      if (method === 'POST') {
        assert.equal(h.get('apikey'), control.secret);
        assert.equal(h.get('x-upsert'), 'true');
        const selected = rotated ? fresh : old,
          kid = rotated
            ? config.currentIssuer.tokenKid
            : config.previousIssuer.tokenKid;
        const token = jwt.sign(
          { url: path, scope: 'upload', upsert: true },
          selected.privateKey,
          { algorithm: 'ES256', keyid: kid, expiresIn: 7200 },
        );
        return Response.json(
          {
            url:
              (corruptUrl ? 'https://other.example' : '') +
              '/object/upload/sign/' +
              path +
              '?token=' +
              token,
            token,
          },
          { headers: headers() },
        );
      }
      assert.equal(method, 'PUT');
      assert.equal(h.get('apikey'), gateway.secret);
      const token = url.searchParams.get('token')!,
        decoded = jwt.decode(token, { complete: true })!;
      if (controlFails && decoded.header.kid === config.currentIssuer.tokenKid)
        return Response.json(
          { code: 'InvalidJWT' },
          { status: 400, headers: headers() },
        );
      if (
        rotated &&
        decoded.header.kid === config.previousIssuer.tokenKid &&
        !acceptOld
      ) {
        if (sideEffect) objects.set(path, String(init?.body));
        return Response.json(
          { code, message: 'PRIVATE ' + token },
          { status: denial, headers: headers() },
        );
      }
      objects.set(path, String(init?.body));
      return Response.json({ Key: path }, { headers: headers() });
    }
    const path = url.pathname.slice(prefix.length);
    assert.equal(h.get('apikey'), control.secret);
    if (method === 'GET')
      return objects.has(path)
        ? new Response(objects.get(path), {
            headers: {
              ...headers(),
              'content-type': 'text/plain',
              'content-length': String(Buffer.byteLength(objects.get(path)!)),
            },
          })
        : new Response(null, { status: 404, headers: headers() });
    if (method === 'POST' && objects.has(path))
      return new Response(null, { status: 409, headers: headers() });
    assert.ok(method === 'POST' || method === 'PUT');
    objects.set(path, String(init?.body));
    return Response.json({ Key: path }, { headers: headers() });
  };
  const retain = async (value: { token: string; sha256: string }) => {
    saved = {
      reference: '44444444-4444-4444-8444-444444444444',
      token: value.token,
    };
    return {
      reference: saved.reference,
      tokenSha256: value.sha256,
      pin: modelPin(saved.reference, value.sha256),
    };
  };
  return {
    objects,
    calls,
    transport,
    retain,
    get saved() {
      return saved!;
    },
    set rotated(v: boolean) {
      rotated = v;
    },
    set denial(v: number) {
      denial = v;
    },
    set code(v: string) {
      code = v;
    },
    set acceptOld(v: boolean) {
      acceptOld = v;
    },
    set sideEffect(v: boolean) {
      sideEffect = v;
    },
    set controlFails(v: boolean) {
      controlFails = v;
    },
    set corruptUrl(v: boolean) {
      corruptUrl = v;
    },
    set clockShift(v: number) {
      clockShift = v;
    },
    service: () =>
      new SupabaseSignedUploadProof(config, { control, gateway }, transport),
  };
}
test('a previously working issued signed upload is refused while the retained issuer works before and after it', async () => {
  const f = fixture(),
    service = f.service(),
    baseline = await service.baseline(f.retain);
  f.rotated = true;
  assert.equal(JSON.stringify(baseline).includes(f.saved.token), false);
  assert.equal([...f.objects.values()][0], syntheticWriteProbe);
  const report = await service.verifyRefusal(
    baseline.body,
    baseline.sha256,
    f.saved,
  );
  assert.equal(report.testedSignedUploadRefusalObserved, true);
  assert.equal(report.issuedTokenSignatureMatched, true);
  assert.equal(report.storageTokenIssuerVerified, false);
  assert.equal(report.managementKeyAssociationVerified, false);
  assert.equal(report.refusalCode, 'InvalidJWT');
  assert.equal(report.signedCapabilitiesRevoked, false);
  assert.equal(report.inFlightWritesDrained, false);
  assert.equal(report.providerReleaseAttested, false);
  assert.equal(JSON.stringify(report).includes(f.saved.token), false);
  assert.ok([...f.objects.values()].every((v) => v === syntheticWriteProbe));
  const before = f.calls.length;
  await assert.rejects(
    service.verifyRefusal(baseline.body, baseline.sha256, f.saved),
  );
  assert.equal(f.calls.length, before);
  const inspected = await service.inspect();
  assert.equal(inspected.originalOutcomeReconstructed, false);
  assert.ok(f.calls.slice(before).every((c) => c.method === 'GET'));
});
test('acceptance, outages, expired-error codes and denial with side effects cannot pass', async () => {
  for (const mode of [
    'accepted',
    'outage',
    'expiry',
    'side-effect',
    'control',
  ] as const) {
    const f = fixture(),
      service = f.service(),
      b = await service.baseline(f.retain);
    f.rotated = true;
    if (mode === 'accepted') f.acceptOld = true;
    if (mode === 'outage') f.denial = 503;
    if (mode === 'expiry') f.code = 'ExpiredToken';
    if (mode === 'side-effect') f.sideEffect = true;
    if (mode === 'control') f.controlFails = true;
    await assert.rejects(
      service.verifyRefusal(b.body, b.sha256, f.saved),
      (e) => e instanceof Error && !e.message.includes(f.saved.token),
    );
    if (mode === 'accepted')
      assert.ok([...f.objects.values()].includes(syntheticWriteUpdate));
  }
});
test('untrusted URL and unacknowledged credential custody never produce a baseline or retry mutations', async () => {
  const f = fixture(),
    service = f.service();
  f.corruptUrl = true;
  await assert.rejects(service.baseline(f.retain));
  assert.equal(f.saved, undefined);
  const g = fixture(),
    second = g.service();
  await assert.rejects(
    second.baseline(async () => {
      throw new Error('PRIVATE credential ACK lost');
    }),
  );
  const before = g.calls.length;
  await assert.rejects(second.baseline(g.retain));
  assert.equal(g.calls.length, before);
  assert.equal([...g.objects.values()][0], syntheticWriteProbe);
});

test('changed maintenance or credential references refuse before any provider access', async () => {
  const f = fixture(),
    baseline = await f.service().baseline(f.retain),
    before = f.calls.length;
  for (const changed of [
    { maintenance: { ...config.maintenance, sourceSha: '9'.repeat(40) } },
    { credentialReference: ids[0] },
    {
      tokenProof: {
        ...JSON.parse(baseline.body).tokenProof,
        issuerFingerprint: '0'.repeat(64),
      },
    },
  ]) {
    const body = JSON.stringify({ ...JSON.parse(baseline.body), ...changed });
    await assert.rejects(f.service().verifyRefusal(body, hash(body), f.saved));
  }
  await assert.rejects(
    f.service().verifyRefusal(baseline.body, baseline.sha256, {
      ...f.saved,
      reference: ids[1],
    }),
  );
  assert.equal(f.calls.length, before);
});

test('provider clock uncertainty and near-expiry tokens never establish refusal', async (t) => {
  const f = fixture(),
    service = f.service(),
    b = await service.baseline(f.retain);
  f.rotated = true;
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(7139000);
  f.clockShift = 30000;
  await assert.rejects(service.verifyRefusal(b.body, b.sha256, f.saved));
  const g = fixture();
  g.clockShift = 120000;
  await assert.rejects(g.service().baseline(g.retain));
  assert.equal(
    g.calls.some((c) => c.method === 'POST' || c.method === 'PUT'),
    false,
  );
});

test('a late secret-custody ACK after timeout cannot resume a signed mutation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(),
    service = f.service();
  let reply!: (value: {
      reference: string;
      tokenSha256: string;
      pin: ReturnType<typeof modelPin>;
    }) => void,
    entered!: () => void,
    tokenSha256 = '';
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = assert.rejects(
    service.baseline(async (value) => {
      tokenSha256 = value.sha256;
      entered();
      return new Promise((resolve) => {
        reply = resolve;
      });
    }),
  );
  await started;
  const before = f.calls.length;
  t.mock.timers.tick(180001);
  await pending;
  const reference = '44444444-4444-4444-8444-444444444444';
  reply({ reference, tokenSha256, pin: modelPin(reference, tokenSha256) });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.calls.length, before);
  assert.equal([...f.objects.values()][0], syntheticWriteProbe);
});
test('signed probe composes with encrypted custody and fresh instances use the same original token', async () => {
  const f = fixture(),
    probe = f.service(),
    custody = vaultFixture({ probeDigest: probe.configurationDigest() }),
    vault = custody.vault();
  const baseline = await probe.baseline((input, signal) =>
      vault.retain(input, signal),
    ),
    saved = JSON.parse(baseline.body);
  assert.equal(saved.format, 2);
  assert.equal(saved.credentialPin.kind, 'SIGNED_UPLOAD_CREDENTIAL_PIN_V1');
  const evidence = signedEvidenceFixture({
    ...signedEvidenceConfig,
    installationId: custody.config.installationId,
    maintenance: saved.maintenance,
    probeDigest: probe.configurationDigest(),
    credentialCustodyDigest: vault.configurationDigest(),
  });
  const baselinePin = await evidence.store().publishBaseline(baseline);
  const retainedBaseline = await evidence.store().observeBaseline(baselinePin);
  f.rotated = true;
  const report = await custody
    .vault()
    .withCredential(
      saved.credentialPin,
      saved.credentialReference,
      (secret, signal) =>
        f
          .service()
          .verifyRefusal(retainedBaseline.body, retainedBaseline.sha256, secret, signal),
    );
  const reportPin = await evidence.store().publishObservation(report, baselinePin);
  const providerCalls = f.calls.length;
  assert.deepEqual(JSON.parse((await evidence.store().observeObservation(reportPin, baselinePin)).body), report);
  assert.equal(f.calls.length, providerCalls);
  assert.equal(report.testedSignedUploadRefusalObserved, true);
  assert.equal(report.tokenSha256, saved.tokenProof.tokenSha256);
  assert.equal(report.credentialPinSha256, saved.credentialPin.sha256);
  assert.ok(custody.plaintextResponses.every((b) => b.every((v) => v === 0)));
  assert.equal(
    [...custody.objects.values()][0].body.includes('"token":'),
    false,
  );
  const legacy = {
    ...saved,
    format: 1,
    kind: 'SUPABASE_SIGNED_UPLOAD_BASELINE_V1',
  };
  delete legacy.credentialPin;
  const body = JSON.stringify(legacy),
    before = f.calls.length;
  await custody
    .vault()
    .withCredential(
      saved.credentialPin,
      saved.credentialReference,
      async (secret) => {
        await assert.rejects(
          f.service().verifyRefusal(body, hash(body), secret),
        );
      },
    );
  assert.equal(f.calls.length, before);
});

test('pure saved signed baseline checks bind actual configured issuer payload and encrypted custody without provider access',async()=>{
 const f=fixture(),probe=f.service(),baseline=await probe.baseline(f.retain),saved=JSON.parse(baseline.body),before=f.calls.length;
 assert.deepEqual(probe.assertBaseline(baseline,saved.credentialPin.custodyDigest),{body:baseline.body,sha256:baseline.sha256});
 for(const change of [
  {tokenProof:{...saved.tokenProof,providerKeyId:'99999999-9999-4999-8999-999999999999'}},
  {tokenProof:{...saved.tokenProof,tokenKid:'synthetic-substituted-kid'}},
  {tokenProof:{...saved.tokenProof,issuerFingerprint:'0'.repeat(64)}},
  {initialPayloadSha256:'0'.repeat(64)},
  {maintenance:{...saved.maintenance,maintenanceEpoch:999}},
 ]){
  const body=JSON.stringify({...saved,...change});assert.throws(()=>probe.assertBaseline({body,sha256:hash(body)},saved.credentialPin.custodyDigest));
 }
 assert.throws(()=>probe.assertBaseline(baseline,'0'.repeat(64)));assert.equal(f.calls.length,before);
});
