import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SupabaseResumableUploadProof } from '../services/supabase-resumable-upload-proof.js';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const control = {
    id: '11111111-1111-4111-8111-111111111111',
    secret: 'sb_secret_' + 'a'.repeat(40),
  },
  retired = {
    id: '22222222-2222-4222-8222-222222222222',
    secret: 'sb_secret_' + 'b'.repeat(40),
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
  retired: { id: retired.id, sha256: hash(retired.secret) },
};
function fixture(format = 'PATH_V1') {
  const c = { ...config, uploadIdFormat: format },
    origin = 'https://' + config.projectRef + '.storage.supabase.co',
    endpoint = origin + '/storage/v1/upload/resumable',
    custody = '9'.repeat(64),
    sessions = new Map<
      string,
      { object: string; length: number; offset: number; expires: string }
    >(),
    objects = new Map<string, Uint8Array>(),
    calls: { method: string; url: string }[] = [];
  let revoked = false,
    acceptOld = false,
    status = 403,
    corruptLocation = '',
    sideEffect = false,
    failControl = false,
    headMissing = false,
    corruptHead = false,
    expired = false;
  let saved: { reference: string; location: string } | undefined;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      method = init?.method!,
      h = new Headers(init?.headers);
    calls.push({ method, url: String(input) });
    assert.equal(url.origin, origin);
    assert.equal(init?.redirect, 'error');
    const key = h.get('apikey');
    assert.ok(key === control.secret || key === retired.secret);
    const date = new Date().toUTCString(),
      headers = { date: date, 'tus-resumable': '1.0.0' };
    if (url.pathname.includes('/bucket/'))
      return Response.json({ id: c.bucket, public: false }, { headers });
    if (String(input) === endpoint && method === 'POST') {
      assert.equal(h.get('tus-resumable'), '1.0.0');
      assert.equal(h.get('x-upsert'), 'false');
      const metadata = Object.fromEntries(
        h
          .get('upload-metadata')!
          .split(',')
          .map((p) => {
            const [k, v] = p.split(' ');
            return [k, Buffer.from(v, 'base64').toString('utf8')];
          }),
      );
      assert.equal(metadata.bucketName, c.bucket);
      assert.ok(
        metadata.objectName.startsWith(
          'charitypilot-recovery-resumable-probe/synthetic/' +
            c.maintenance.attemptId +
            '/',
        ),
      );
      const encoded = Buffer.from(
          c.bucket +
            '/' +
            metadata.objectName +
            (format === 'PATH_V1' ? '/' : '-$v-') +
            randomUUID(),
        ).toString('base64url'),
        location = endpoint + '/' + encoded,
        expires = new Date(
          Date.parse(date) + (expired ? 30000 : 3600000),
        ).toUTCString();
      sessions.set(location, {
        object: c.bucket + '/' + metadata.objectName,
        length: Number(h.get('upload-length')),
        offset: 0,
        expires,
      });
      return new Response(null, {
        status: 201,
        headers: {
          ...headers,
          location: corruptLocation || location,
          'upload-expires': expires,
        },
      });
    }
    if (url.pathname.startsWith('/storage/v1/upload/resumable/')) {
      const s = sessions.get(String(input))!;
      assert.ok(s);
      if (method === 'HEAD')
        return new Response(null, {
          status: headMissing ? 404 : 200,
          headers: {
            ...headers,
            'upload-offset': String(s.offset + (corruptHead ? 1 : 0)),
            'upload-length': String(s.length),
            'upload-expires': s.expires,
          },
        });
      assert.equal(method, 'PATCH');
      assert.equal(h.get('content-type'), 'application/offset+octet-stream');
      assert.equal(Number(h.get('upload-offset')), s.offset);
      const body = init?.body as Uint8Array;
      const denied =
        (revoked && key === retired.secret && !acceptOld) ||
        (failControl && key === control.secret);
      if (!denied || sideEffect) {
        s.offset += body.byteLength;
        if (s.offset === s.length) objects.set(s.object, new Uint8Array(body));
      }
      if (denied)
        return Response.json({ code: 'AccessDenied' }, { status, headers });
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
    const path = url.pathname.slice('/storage/v1/object/'.length),
      value = objects.get(path);
    return value
      ? new Response(value, {
          headers: { ...headers, 'content-length': String(value.byteLength) },
        })
      : new Response(null, { status: 404, headers });
  };
  const retain = async (v: { location: string; sha256: string }) => {
    saved = {
      reference: '44444444-4444-4444-8444-444444444444',
      location: v.location,
    };
    return {
      reference: saved.reference,
      locationSha256: v.sha256,
      pin: {
        kind: 'RESUMABLE_LOCATION_PIN_V1' as const,
        reference: saved.reference,
        custodyDigest: custody,
        versionId: 'synthetic-encrypted-location',
        sha256: '8'.repeat(64),
        byteLength: 1024,
      },
    };
  };
  return {
    calls,
    sessions,
    objects,
    retain,
    custody,
    transport,
    get saved() {
      return saved!;
    },
    service: () =>
      new SupabaseResumableUploadProof(c, { control, retired }, transport),
    set revoked(v: boolean) {
      revoked = v;
    },
    set acceptOld(v: boolean) {
      acceptOld = v;
    },
    set status(v: number) {
      status = v;
    },
    set corruptLocation(v: string) {
      corruptLocation = v;
    },
    set sideEffect(v: boolean) {
      sideEffect = v;
    },
    set failControl(v: boolean) {
      failControl = v;
    },
    set headMissing(v: boolean) {
      headMissing = v;
    },
    set corruptHead(v: boolean) {
      corruptHead = v;
    },
    set expired(v: boolean) {
      expired = v;
    },
  };
}
test('original unfinished TUS session works before closure and valid PATCH refuses between working controls in both reviewed ID formats', async () => {
  for (const format of ['PATH_V1', 'FILE_VERSION_V1']) {
    const f = fixture(format),
      service = f.service(),
      b = await service.baseline(f.retain, f.custody),
      decoded = JSON.parse(b.body);
    assert.equal(decoded.offset, 6291456);
    assert.equal(decoded.uploadLength, 6291457);
    assert.equal(b.body.includes(f.saved.location), false);
    assert.equal(f.objects.size, 0);
    f.revoked = true;
    const r = await f.service().verifyRefusal(b, f.custody, f.saved);
    assert.equal(r.testedResumablePatchRefusalObserved, true);
    assert.equal(r.resumableSessionsRevoked, false);
    assert.equal(r.inFlightWritesDrained, false);
    assert.equal(r.signedResumableVerified, false);
    assert.equal(JSON.stringify(r).includes(f.saved.location), false);
    assert.equal(f.objects.size, 2);
    assert.equal(f.sessions.get(f.saved.location)!.offset, 6291456);
    assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 4);
    await assert.rejects(service.baseline(f.retain, f.custody));
  }
});
test('accepted old PATCH generic failure conflict expired/missing upload changed offset and failed positive controls never prove closure', async () => {
  for (const fault of [
    'accepted',
    '500',
    '409',
    '404',
    '410',
    'side-effect',
    'control',
    'missing',
    'offset',
  ]) {
    const f = fixture(),
      b = await f.service().baseline(f.retain, f.custody);
    f.revoked = true;
    if (fault === 'accepted') f.acceptOld = true;
    if (/^[0-9]+$/.test(fault)) f.status = Number(fault);
    if (fault === 'side-effect') f.sideEffect = true;
    if (fault === 'control') f.failControl = true;
    if (fault === 'missing') f.headMissing = true;
    if (fault === 'offset') f.corruptHead = true;
    const service = f.service();
    await assert.rejects(service.verifyRefusal(b, f.custody, f.saved));
    const n = f.calls.length;
    await assert.rejects(service.verifyRefusal(b, f.custody, f.saved));
    assert.equal(f.calls.length, n);
    if (fault === 'accepted' || fault === 'side-effect')
      assert.ok(f.objects.size > 0);
  }
});
test('untrusted or noncanonical locations cannot trigger a chunk write or custody callback', async () => {
  for (const location of [
    'https://other.example/storage/v1/upload/resumable/abc',
    'https://abcdefghijklmnopqrst.storage.supabase.co:443/storage/v1/upload/resumable/YQ',
    'https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/upload/resumable/YQ?token=secret',
    'https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/upload/resumable/' +
      Buffer.from('other-bucket/wrong/path/' + randomUUID()).toString(
        'base64url',
      ),
  ]) {
    const f = fixture();
    f.corruptLocation = location;
    let retained = false;
    await assert.rejects(
      f.service().baseline(async (v) => {
        retained = true;
        return f.retain(v);
      }, f.custody),
    );
    assert.equal(retained, false);
    assert.equal(
      f.calls.some((c) => c.method === 'PATCH'),
      false,
    );
  }
  const f = fixture();
  f.expired = true;
  await assert.rejects(f.service().baseline(f.retain, f.custody));
  assert.equal(
    f.calls.some((c) => c.method === 'PATCH'),
    false,
  );
});
test('copied baseline session or custody substitution refuses before provider access', async () => {
  const f = fixture(),
    b = await f.service().baseline(f.retain, f.custody);
  f.revoked = true;
  for (const change of [
    { credentialId: control.id },
    { maintenance: { ...config.maintenance, maintenanceEpoch: 9 } },
    { locationSha256: '0'.repeat(64) },
    { prefixSha256: '0'.repeat(64) },
  ]) {
    const body = JSON.stringify({ ...JSON.parse(b.body), ...change }),
      n = f.calls.length;
    await assert.rejects(
      f
        .service()
        .verifyRefusal({ body, sha256: hash(body) }, f.custody, f.saved),
    );
    assert.equal(f.calls.length, n);
  }
  const n = f.calls.length;
  await assert.rejects(f.service().verifyRefusal(b, '0'.repeat(64), f.saved));
  assert.equal(f.calls.length, n);
});
test('lost location acknowledgement never uploads chunks and a late callback cannot resume after deadline', async (t) => {
  const f = fixture(),
    service = f.service();
  await assert.rejects(
    service.baseline(async () => {
      throw new Error('synthetic lost custody ACK');
    }, f.custody),
  );
  assert.equal(
    f.calls.some((c) => c.method === 'PATCH'),
    false,
  );
  await assert.rejects(service.baseline(f.retain, f.custody));
  const g = fixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reply!: (v: Awaited<ReturnType<typeof g.retain>>) => void,
    entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  let held!: { location: string; sha256: string };
  const result = assert.rejects(
    g.service().baseline(async (v) => {
      held = v;
      entered();
      return new Promise((resolve) => {
        reply = resolve;
      });
    }, g.custody),
  );
  await started;
  t.mock.timers.tick(180001);
  await result;
  reply(await g.retain(held));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    g.calls.some((c) => c.method === 'PATCH'),
    false,
  );
});

test('hung provider requests stop at deadline and late bodies cannot create uploads', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reply!: (r: Response) => void,
    entered!: () => void,
    cancelled = false;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const transport: typeof fetch = async () => {
    entered();
    return new Promise((resolve) => {
      reply = resolve;
    });
  };
  const service = new SupabaseResumableUploadProof(
      config,
      { control, retired },
      transport,
    ),
    f = fixture();
  const result = assert.rejects(service.baseline(f.retain, f.custody));
  await started;
  t.mock.timers.tick(15001);
  await result;
  reply(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(cancelled, true);
  assert.equal(f.calls.length, 0);
});

test('invalid expected custody digest refuses before creating an upload', async () => {
  const f = fixture();
  await assert.rejects(f.service().baseline(f.retain, 'not-a-digest'));
  assert.equal(f.calls.length, 0);
});
