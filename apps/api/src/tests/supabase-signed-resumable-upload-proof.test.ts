import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import jwt from 'jsonwebtoken';
import {
  SupabaseSignedResumableUploadProof,
  type RetainSignedResumableCredential,
} from '../services/supabase-signed-resumable-upload-proof.js';
import { publicSigningKeyFingerprint } from '../services/supabase-signing-key-control.js';
import {
  signedTusHash as hash,
  assertSignedResumableLocation,
  assertSignedResumablePair,
} from '../services/signed-resumable-upload-contract.js';
const pair = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
  previous = pair(),
  current = pair();
const issuer = (p: ReturnType<typeof pair>, id: string) => {
  const publicJwk = p.publicKey.export({ format: 'jwk' });
  return {
    providerKeyId: id,
    tokenKid: id,
    algorithm: 'ES256',
    publicJwk,
    fingerprint: publicSigningKeyFingerprint('ES256', publicJwk),
  };
};
const control = {
    id: '11111111-1111-4111-8111-111111111111',
    secret: 'sb_secret_' + 'a'.repeat(40),
  },
  gateway = {
    id: '22222222-2222-4222-8222-222222222222',
    secret: 'sb_publishable_' + 'b'.repeat(40),
  };
const config = {
  installationId: 'synthetic',
  projectRef: 'abcdefghijklmnopqrst',
  bucket: 'charitypilot-recovery-resumable-probes',
  maintenance: {
    attemptId: '33333333-3333-4333-8333-333333333333',
    planDigest: '1'.repeat(64),
    sourceSha: '2'.repeat(40),
    maintenanceEpoch: 1,
  },
  providerRelease: { sourceSha: '3'.repeat(40), imageDigest: '4'.repeat(64) },
  uploadIdFormat: 'PATH_V1',
  control: { id: control.id, sha256: hash(control.secret) },
  gateway: { id: gateway.id, sha256: hash(gateway.secret) },
  previousIssuer: issuer(previous, '55555555-5555-4555-8555-555555555555'),
  currentIssuer: issuer(current, '66666666-6666-4666-8666-666666666666'),
};
function fixture(format = 'PATH_V1') {
  const c = { ...config, uploadIdFormat: format },
    origin = 'https://' + c.projectRef + '.storage.supabase.co',
    endpoint = origin + '/storage/v1/upload/resumable',
    custody = '9'.repeat(64);
  const sessions = new Map<
      string,
      { path: string; length: number; offset: number; expires: string }
    >(),
    objects = new Map<string, Uint8Array>(),
    calls: { url: string; method: string; signature: string | null }[] = [];
  let saved: { reference: string; token: string; location: string } | undefined;
  const mode = {
    revoked: false,
    stillWorks: false,
    sideEffect: false,
    failControl: false,
    refusalStatus: 400,
    refusalBody: 'invalid signature',
    badLocation: false,
    badExpiry: false,
    wrongIssuer: false,
    wrongScope: false,
    wrongPath: false,
  };
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      method = init!.method!,
      h = new Headers(init!.headers),
      signature = h.get('x-signature'),
      date = new Date().toUTCString(),
      headers = { date, 'tus-resumable': '1.0.0' };
    calls.push({ url: String(input), method, signature });
    assert.equal(url.origin, origin);
    assert.equal(init?.redirect, 'error');
    assert.equal(h.has('authorization'), false);
    if (url.pathname.startsWith('/storage/v1/object/upload/sign/')) {
      assert.equal(method, 'POST');
      assert.equal(h.get('apikey'), control.secret);
      assert.equal(h.get('x-upsert'), 'true');
      assert.equal(Buffer.from(init!.body as Uint8Array).toString(), '{}');
      const path = url.pathname.slice('/storage/v1/object/upload/sign/'.length),
        old = path.endsWith('/old.txt'),
        k = old && !mode.wrongIssuer ? previous : current,
        id = old && !mode.wrongIssuer ? c.previousIssuer : c.currentIssuer;
      const token = jwt.sign(
        {
          url: mode.wrongPath ? 'other/object' : path,
          scope: mode.wrongScope ? 'download' : 'upload',
          upsert: true,
        },
        k.privateKey,
        { algorithm: 'ES256', keyid: id.tokenKid, expiresIn: 7200 },
      );
      return Response.json(
        { url: '/object/upload/sign/' + path + '?token=' + token, token },
        { headers },
      );
    }
    if (url.pathname.startsWith('/storage/v1/bucket/')) {
      assert.equal(h.get('apikey'), control.secret);
      assert.equal(signature, null);
      return Response.json({ id: c.bucket, public: false }, { headers });
    }
    if (url.pathname.startsWith('/storage/v1/object/')) {
      assert.equal(h.get('apikey'), control.secret);
      assert.equal(signature, null);
      const path = url.pathname.slice('/storage/v1/object/'.length),
        data = objects.get(path);
      return data
        ? new Response(data, {
            headers: { ...headers, 'content-length': String(data.length) },
          })
        : new Response(null, { status: 404, headers });
    }
    if (method === 'HEAD') {
      assert.equal(h.get('apikey'), control.secret);
      assert.equal(signature, null);
      assert.ok(!url.pathname.includes('/sign/'));
      const encoded = url.pathname.slice(
          '/storage/v1/upload/resumable/'.length,
        ),
        s = sessions.get(encoded);
      assert.ok(s);
      return new Response(null, {
        status: 204,
        headers: {
          ...headers,
          'upload-length': String(s.length),
          'upload-offset': String(s.offset),
          'upload-expires': s.expires,
        },
      });
    }
    assert.equal(h.get('apikey'), gateway.secret);
    assert.ok(signature);
    assert.equal(h.get('x-upsert'), 'true');
    assert.ok(url.pathname.startsWith('/storage/v1/upload/resumable/sign'));
    const token = jwt.decode(signature, { complete: true });
    assert.ok(token && typeof token.payload === 'object');
    const claims = jwt.verify(
      signature,
      token.header.kid === c.previousIssuer.tokenKid
        ? previous.publicKey
        : current.publicKey,
      { algorithms: ['ES256'] },
    ) as jwt.JwtPayload;
    if (method === 'POST') {
      assert.equal(String(input), endpoint + '/sign');
      const metadata = Object.fromEntries(
        h
          .get('upload-metadata')!
          .split(',')
          .map((v) => {
            const [k, b] = v.split(' ');
            return [k, Buffer.from(b, 'base64').toString()];
          }),
      );
      const path = metadata.bucketName + '/' + metadata.objectName;
      assert.equal(claims.url, path);
      assert.equal(claims.upsert, true);
      assert.equal(claims.scope, 'upload');
      if (mode.failControl && !path.endsWith('/old.txt'))
        return new Response(null, { status: 403, headers });
      const encoded = Buffer.from(
          path + (format === 'PATH_V1' ? '/' : '-$v-') + randomUUID(),
        ).toString('base64url'),
        location = endpoint + '/sign/' + encoded,
        expires = new Date(
          Date.parse(date) + (mode.badExpiry ? 30000 : 3600000),
        ).toUTCString();
      sessions.set(encoded, {
        path,
        length: Number(h.get('upload-length')),
        offset: 0,
        expires,
      });
      return new Response(null, {
        status: 201,
        headers: {
          ...headers,
          location: mode.badLocation
            ? location.replace('/sign/', '/')
            : location,
          'upload-expires': expires,
        },
      });
    }
    assert.equal(method, 'PATCH');
    const encoded = url.pathname.slice(
        '/storage/v1/upload/resumable/sign/'.length,
      ),
      s = sessions.get(encoded);
    assert.ok(s);
    assert.equal(claims.url, s.path);
    assert.equal(Number(h.get('upload-offset')), s.offset);
    const data = Buffer.from(init!.body as Uint8Array),
      old = s.path.endsWith('/old.txt');
    if (old && mode.revoked && !mode.stillWorks) {
      if (mode.sideEffect) {
        s.offset += data.length;
        objects.set(s.path, data);
      }
      return new Response(mode.refusalBody, {
        status: mode.refusalStatus,
        headers: {
          ...headers,
          'content-type': mode.refusalBody.startsWith('{')
            ? 'application/json'
            : 'text/plain',
        },
      });
    }
    assert.ok(
      data.equals(old ? Buffer.alloc(6291456, 0x43) : Buffer.from('P')) ||
        (mode.stillWorks && data.equals(Buffer.from('P'))),
    );
    s.offset += data.length;
    if (s.offset === s.length) objects.set(s.path, data);
    return new Response(null, {
      status: 204,
      headers: { ...headers, 'upload-offset': String(s.offset) },
    });
  };
  const factory = (raw: unknown = c) =>
    new SupabaseSignedResumableUploadProof(
      raw,
      { control, gateway },
      transport,
    );
  const retain: RetainSignedResumableCredential = async (v, signal) => {
    signal.throwIfAborted();
    assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0);
    saved = { reference: randomUUID(), token: v.token, location: v.location };
    return {
      kind: 'SIGNED_RESUMABLE_CREDENTIAL_PIN_V1',
      reference: saved.reference,
      custodyDigest: custody,
      versionId: 'synthetic-original-version',
      sha256: '8'.repeat(64),
      byteLength: 1024,
      tokenSha256: v.tokenSha256,
      locationSha256: v.locationSha256,
    };
  };
  return {
    config: c,
    custody,
    factory,
    retain,
    calls,
    mode,
    sessions,
    objects,
    get saved() {
      assert.ok(saved);
      return saved;
    },
  };
}
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
