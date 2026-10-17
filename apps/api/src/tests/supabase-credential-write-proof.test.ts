import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { SupabaseStorageWriterControl } from '../services/supabase-storage-writer-control.js';
import {
  SupabaseCredentialWriteProof,
  syntheticWriteProbe,
  syntheticWriteUpdate,
} from '../services/supabase-credential-write-proof.js';

const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const control = {
  id: '11111111-1111-4111-8111-111111111111',
  secret: 'sb_secret_' + 'a'.repeat(40),
};
const retired = {
  id: '22222222-2222-4222-8222-222222222222',
  secret: 'sb_secret_' + 'b'.repeat(40),
};
const binding = {
  attemptId: '33333333-3333-4333-8333-333333333333',
  planDigest: '1'.repeat(64),
  sourceSha: '2'.repeat(40),
  maintenanceEpoch: 1,
};
const config = {
  installationId: 'synthetic-installation',
  projectRef: 'abcdefghijklmnopqrst',
  bucket: 'charitypilot-recovery-write-probes',
  maintenance: binding,
  control: { id: control.id, sha256: hash(control.secret) },
  retired: [{ id: retired.id, sha256: hash(retired.secret) }],
};
function fixture(retiredKeys = [retired]) {
  const objects = new Map<string, string>(),
    calls: { key: string; method: string; path: string }[] = [];
  let deny = false,
    status = 401,
    controlFails = false,
    discardMutation = false,
    tamper = false;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      headers = new Headers(init?.headers),
      key = headers.get('apikey')!;
    assert.equal(url.origin, 'https://abcdefghijklmnopqrst.supabase.co');
    assert.equal(init?.redirect, 'error');
    assert.equal(headers.get('authorization'), null);
    assert.ok(
      key === control.secret || retiredKeys.some((k) => key === k.secret),
    );
    const method = init!.method!,
      path = decodeURIComponent(url.pathname);
    calls.push({ key, method, path });
    if (key === control.secret && controlFails)
      return new Response('PRIVATE provider error', { status: 503 });
    if (path.includes('/bucket/'))
      return Response.json({ id: config.bucket, public: false });
    if (deny && retiredKeys.some((k) => key === k.secret))
      return new Response('PRIVATE provider denial', { status });
    const root = '/storage/v1/object/' + config.bucket + '/',
      target = path.slice(root.length);
    if (method === 'GET')
      return objects.has(target)
        ? new Response(tamper ? 'wrong bytes' : objects.get(target), {
            headers: {
              'content-type': 'text/plain',
              'content-length': String(Buffer.byteLength(objects.get(target)!)),
            },
          })
        : new Response(null, { status: 404 });
    if (method === 'POST' || method === 'PUT') {
      assert.equal(headers.get('content-type'), 'text/plain');
      assert.equal(
        String(init?.body),
        method === 'POST' ? syntheticWriteProbe : syntheticWriteUpdate,
      );
      if (method === 'POST') {
        assert.equal(headers.get('x-upsert'), 'false');
        if (objects.has(target)) return new Response(null, { status: 409 });
      }
      if (method === 'PUT' && !objects.has(target))
        return new Response(null, { status: 404 });
      if (!discardMutation) objects.set(target, String(init?.body));
      return Response.json({ Key: config.bucket + '/' + target });
    }
    assert.equal(method, 'DELETE');
    assert.equal(path, '/storage/v1/object/' + config.bucket);
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(body), ['prefixes']);
    assert.equal(body.prefixes.length, 1);
    if (!discardMutation) objects.delete(body.prefixes[0]);
    return Response.json([]);
  };
  return {
    objects,
    calls,
    transport,
    set deny(v: boolean) {
      deny = v;
    },
    set status(v: number) {
      status = v;
    },
    set controlFails(v: boolean) {
      controlFails = v;
    },
    set discardMutation(v: boolean) {
      discardMutation = v;
    },
    set tamper(v: boolean) {
      tamper = v;
    },
    proof: () =>
      new SupabaseCredentialWriteProof(
        {
          ...config,
          retired: retiredKeys.map((k) => ({
            id: k.id,
            sha256: hash(k.secret),
          })),
        },
        { control, retired: retiredKeys },
        transport,
      ),
  };
}

test('synthetic standard writes have a positive baseline and control-bracketed create/update/delete refusals', async () => {
  const f = fixture(),
    proof = f.proof(),
    baseline = await proof.baseline();
  assert.equal(f.objects.size, 0);
  assert.equal(baseline.sha256, hash(baseline.body));
  assert.equal(
    JSON.parse(baseline.body).maintenance.sourceSha,
    binding.sourceSha,
  );
  f.deny = true;
  const report = await proof.verifyWriteRefusal(baseline.body, baseline.sha256);
  assert.deepEqual(report.refusals, [
    { credentialId: retired.id, create: 401, update: 401, delete: 401 },
  ]);
  assert.equal(report.standardWriteRefusalsObserved, true);
  assert.equal(report.wholeStorageQuiesced, false);
  assert.equal(report.signedCapabilitiesRevoked, false);
  assert.equal(report.actionAuthorized, false);
  assert.equal(f.objects.size, 1);
  assert.equal([...f.objects.values()][0], syntheticWriteProbe);
  assert.equal(
    f.calls.filter((c) => c.method === 'DELETE' && c.key === retired.secret)
      .length,
    2,
  );
  assert.equal(
    JSON.stringify({ baseline, report }).includes(control.secret),
    false,
  );
  assert.equal(
    JSON.stringify({ baseline, report }).includes(retired.secret),
    false,
  );
  const before = f.calls.length;
  await assert.rejects(
    proof.verifyWriteRefusal(baseline.body, baseline.sha256),
  );
  assert.equal(f.calls.length, before);
});

test('outages, conflicts, unexpected write success and misleading successful mutations never pass', async () => {
  for (const status of [200, 204, 400, 404, 409, 429, 500]) {
    const f = fixture(),
      proof = f.proof(),
      b = await proof.baseline();
    f.deny = true;
    f.status = status;
    await assert.rejects(
      proof.verifyWriteRefusal(b.body, b.sha256),
      (e) => e instanceof Error && !e.message.includes('PRIVATE'),
    );
  }
  for (const mode of ['control', 'ignored', 'bytes'] as const) {
    const f = fixture(),
      proof = f.proof();
    if (mode === 'control') f.controlFails = true;
    if (mode === 'ignored') f.discardMutation = true;
    if (mode === 'bytes') f.tamper = true;
    await assert.rejects(proof.baseline());
  }
});

test('scope, credentials and baseline substitutions refuse before mutations', async () => {
  const f = fixture();
  for (const changed of [
    { bucket: 'real-governance' },
    { projectRef: '../../evil' },
    { maintenance: { ...binding, attemptId: '../bad' } },
  ])
    assert.throws(
      () =>
        new SupabaseCredentialWriteProof(
          { ...config, ...changed },
          { control, retired: [retired] },
          f.transport,
        ),
    );
  assert.throws(
    () =>
      new SupabaseCredentialWriteProof(
        config,
        { control, retired: [{ ...retired, secret: control.secret }] },
        f.transport,
      ),
  );
  const b = await f.proof().baseline(),
    before = f.calls.length;
  assert.equal(
    new SupabaseCredentialWriteProof(
      { ...config, maintenance: { ...binding, planDigest: '5'.repeat(64) } },
      { control, retired: [retired] },
      f.transport,
    ).configurationDigest(),
    f.proof().configurationDigest(),
  );
  for (const changed of [
    { sourceSha: '3'.repeat(40) },
    { attemptId: control.id },
    { maintenanceEpoch: 2 },
    { planDigest: '4'.repeat(64) },
  ]) {
    const decoded = JSON.parse(b.body);
    decoded.maintenance = { ...decoded.maintenance, ...changed };
    const body = JSON.stringify(decoded);
    await assert.rejects(f.proof().verifyWriteRefusal(body, hash(body)));
  }
  assert.equal(f.calls.length, before);
});

test('an existing synthetic probe refuses without overwriting it or attempting cleanup', async () => {
  const f = fixture(),
    path =
      'charitypilot-recovery-write-probe/' +
      config.installationId +
      '/' +
      binding.attemptId +
      '/' +
      control.id +
      '.txt';
  f.objects.set(path, 'preserved existing bytes');
  await assert.rejects(f.proof().baseline());
  assert.equal(f.objects.get(path), 'preserved existing bytes');
  assert.equal(
    f.calls.some((c) => c.method !== 'GET'),
    false,
  );
});

test('ignored updates and denied requests with side effects fail byte-level verification', async () => {
  const ignored = fixture();
  const fakeUpdate: typeof fetch = async (input, init) =>
    init?.method === 'PUT'
      ? Response.json({ Key: 'ignored' })
      : ignored.transport(input, init);
  await assert.rejects(
    new SupabaseCredentialWriteProof(
      config,
      { control, retired: [retired] },
      fakeUpdate,
    ).baseline(),
  );
  for (const operation of ['POST', 'PUT', 'DELETE']) {
    const f = fixture(),
      baseline = await f.proof().baseline();
    f.deny = true;
    const sideEffect: typeof fetch = async (input, init) => {
      if (
        new Headers(init?.headers).get('apikey') === retired.secret &&
        init?.method === operation
      ) {
        const target =
          'charitypilot-recovery-write-probe/' +
          config.installationId +
          '/' +
          binding.attemptId +
          '/' +
          retired.id +
          '.txt';
        if (operation === 'DELETE') f.objects.delete(target);
        else
          f.objects.set(
            target,
            operation === 'POST' ? syntheticWriteProbe : syntheticWriteUpdate,
          );
      }
      return f.transport(input, init);
    };
    await assert.rejects(
      new SupabaseCredentialWriteProof(
        config,
        { control, retired: [retired] },
        sideEffect,
      ).verifyWriteRefusal(baseline.body, baseline.sha256),
    );
  }
});

test('lost mutation acknowledgement leaves diagnostics read-only and cannot authorise another baseline', async () => {
  const f = fixture();
  let lost = false;
  const transport: typeof fetch = async (input, init) => {
    const response = await f.transport(input, init);
    if (init?.method === 'POST' && !lost) {
      lost = true;
      throw new Error('PRIVATE committed response lost');
    }
    return response;
  };
  const proof = new SupabaseCredentialWriteProof(
    config,
    { control, retired: [retired] },
    transport,
  );
  await assert.rejects(proof.baseline());
  const before = f.calls.length;
  await assert.rejects(proof.baseline());
  assert.equal(f.calls.length, before);
  const result = await proof.inspect();
  assert.equal(result.originalOutcomeReconstructed, false);
  assert.equal(result.probes[0].state, 'INITIAL');
  assert.ok(f.calls.slice(before).every((c) => c.method === 'GET'));
  assert.equal(f.objects.size, 1);
});

test('403 refusal works and read-only inspection reports unexpected content without returning bytes', async () => {
  const f = fixture(),
    proof = f.proof(),
    baseline = await proof.baseline();
  f.deny = true;
  f.status = 403;
  const report = await proof.verifyWriteRefusal(baseline.body, baseline.sha256);
  assert.equal(report.refusals[0].delete, 403);
  const path = [...f.objects.keys()][0];
  f.objects.set(path, 'PRIVATE unexpected material');
  const before = f.calls.length,
    result = await proof.inspect();
  assert.equal(result.probes[1].state, 'UNEXPECTED');
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.ok(f.calls.slice(before).every((c) => c.method === 'GET'));
});

test('request cancellation does not retry and cancels a late response body', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reply!: (response: Response) => void,
    entered!: () => void,
    cancelled = false,
    calls = 0;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const transport: typeof fetch = async () => {
    calls++;
    entered();
    return new Promise<Response>((resolve) => {
      reply = resolve;
    });
  };
  const proof = new SupabaseCredentialWriteProof(
      config,
      { control, retired: [retired] },
      transport,
    ),
    pending = assert.rejects(proof.baseline());
  await started;
  t.mock.timers.tick(10001);
  await pending;
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
  assert.equal(calls, 1);
  await assert.rejects(proof.baseline());
  assert.equal(calls, 1);
});

test('default management key revocation composes with positive and negative standard-write evidence', async () => {
  const f = fixture(),
    proof = f.proof(),
    baseline = await proof.baseline();
  let legacy = true,
    s3 = true,
    writerPresent = true;
  const registry = {
    installationId: config.installationId,
    projectRef: config.projectRef,
    bucket: 'documents',
    organisationId: 'org-synthetic',
    region: 'eu-central-1',
    captureKeyId: control.id,
    writerKeys: [{ id: retired.id, type: 'secret' }],
  };
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      method = init?.method ?? 'GET';
    assert.equal(url.origin, 'https://api.supabase.com');
    assert.equal(init?.redirect, 'error');
    assert.equal(
      new Headers(init?.headers).get('authorization'),
      'Bearer synthetic-management-token',
    );
    if (url.pathname.endsWith('/config/storage')) {
      if (method === 'PATCH') s3 = false;
      return Response.json({ features: { s3Protocol: { enabled: s3 } } });
    }
    if (url.pathname.endsWith('/api-keys/legacy')) {
      if (method === 'PUT') legacy = false;
      return Response.json({ enabled: legacy });
    }
    if (url.pathname.endsWith('/api-keys'))
      return Response.json([
        { id: control.id, type: 'secret' },
        ...(writerPresent ? [{ id: retired.id, type: 'secret' }] : []),
      ]);
    if (method === 'DELETE') {
      assert.ok(url.pathname.endsWith('/' + retired.id));
      writerPresent = false;
      f.deny = true;
      return Response.json({ id: retired.id, type: 'secret' });
    }
    return Response.json({
      ref: config.projectRef,
      organization_id: registry.organisationId,
      region: registry.region,
      status: 'ACTIVE_HEALTHY',
    });
  };
  const result = await new SupabaseStorageWriterControl(
    registry,
    'synthetic-management-token',
    transport,
  ).close();
  assert.equal(result.configuredAccessPathsObservedClosed, true);
  assert.equal(writerPresent, false);
  const observed = await proof.verifyWriteRefusal(
    baseline.body,
    baseline.sha256,
  );
  assert.equal(observed.standardWriteRefusalsObserved, true);
  assert.equal(observed.wholeStorageQuiesced, false);
});

test('the maximum fifty-key registry fits the bounded baseline and request budget', async () => {
  const keys = Array.from({ length: 50 }, (_, i) => ({
    id: '22222222-2222-4222-8222-' + String(i + 1).padStart(12, '0'),
    secret: 'sb_secret_synthetic-write-key-' + String(i + 1).padStart(20, '0'),
  }));
  const f = fixture(keys),
    proof = f.proof(),
    baseline = await proof.baseline();
  assert.ok(baseline.byteLength <= 8192);
  assert.equal(f.objects.size, 0);
  assert.ok(f.calls.length <= 1600);
  const before = f.calls.length;
  f.deny = true;
  const result = await proof.verifyWriteRefusal(baseline.body, baseline.sha256);
  assert.equal(result.refusals.length, 50);
  assert.equal(f.objects.size, 50);
  assert.ok(f.calls.length - before <= 1600);
});
