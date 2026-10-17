import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { SupabaseCredentialReadProof } from '../services/supabase-credential-read-proof.js';

const fingerprint = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const control = {
  id: '11111111-1111-4111-8111-111111111111',
  secret: 'sb_secret_' + 'a'.repeat(40),
};
const retired = {
  id: '22222222-2222-4222-8222-222222222222',
  secret: 'sb_secret_' + 'b'.repeat(40),
};
const canary = 'synthetic recovery access canary';
const config = {
  installationId: 'fixture',
  projectRef: 'abcdefghijklmnopqrst',
  bucket: 'charitypilot-recovery-canaries' as const,
  canary: {
    fileUrl: 'charitypilot-recovery-canary/fixture/test.txt',
    bytes: Buffer.byteLength(canary),
    sha256: fingerprint(canary),
  },
  control: { id: control.id, sha256: fingerprint(control.secret) },
  retired: [{ id: retired.id, sha256: fingerprint(retired.secret) }],
};
function fixture() {
  let deny = false,
    code = 401,
    failControl = false,
    badBody = false,
    reads = 0,
    breakAfterDenied = false,
    refused = false;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      headers = new Headers(init?.headers);
    assert.equal(url.origin, 'https://abcdefghijklmnopqrst.supabase.co');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal(headers.get('authorization'), null);
    const key = headers.get('apikey');
    assert.ok(key === control.secret || key === retired.secret);
    reads++;
    if (
      key === control.secret &&
      (failControl || (breakAfterDenied && refused))
    )
      return new Response(null, { status: 503 });
    if (key === retired.secret && deny) {
      refused = true;
      return new Response('provider private details', { status: code });
    }
    if (url.pathname.includes('/bucket/'))
      return Response.json({ id: config.bucket, public: false });
    assert.equal(
      url.pathname,
      '/storage/v1/object/' + config.bucket + '/' + config.canary.fileUrl,
    );
    return new Response(
      Buffer.from(badBody ? 'x'.repeat(Buffer.byteLength(canary)) : canary),
      {
        headers: {
          'content-type': 'text/plain',
          'content-length': String(Buffer.byteLength(canary)),
        },
      },
    );
  };
  return {
    transport,
    get reads() {
      return reads;
    },
    set deny(v: boolean) {
      deny = v;
    },
    set code(v: number) {
      code = v;
    },
    set failControl(v: boolean) {
      failControl = v;
    },
    set badBody(v: boolean) {
      badBody = v;
    },
    set breakAfterDenied(v: boolean) {
      breakAfterDenied = v;
    },
  };
}
test('previously valid exact credentials produce a read refusal only between successful control reads', async () => {
  for (const status of [401, 403]) {
    const f = fixture(),
      first = new SupabaseCredentialReadProof(
        config,
        { control, retired: [retired] },
        f.transport,
      );
    const baseline = await first.baseline();
    f.deny = true;
    f.code = status;
    const result = await new SupabaseCredentialReadProof(
      config,
      { control, retired: [retired] },
      f.transport,
    ).verifyReadRefusal(baseline.body, baseline.sha256);
    assert.equal(result.credentialReadRefusalsObserved, true);
    assert.equal(result.refusals[0].status, status);
    assert.equal(result.writeRejectionVerified, false);
    assert.equal(result.wholeStorageQuiesced, false);
    assert.ok(!JSON.stringify({ baseline, result }).includes(control.secret));
    assert.ok(!JSON.stringify({ baseline, result }).includes(retired.secret));
  }
});
test('bad source baseline, outage, missing object, successful old credential or changed canary never establish refusal', async () => {
  for (const status of [401, 403]) {
    const f = fixture();
    f.deny = true;
    f.code = status;
    await assert.rejects(
      new SupabaseCredentialReadProof(
        config,
        { control, retired: [retired] },
        f.transport,
      ).baseline(),
    );
  }
  for (const status of [200, 404, 429, 500]) {
    const f = fixture(),
      service = new SupabaseCredentialReadProof(
        config,
        { control, retired: [retired] },
        f.transport,
      );
    const baseline = await service.baseline();
    f.deny = true;
    f.code = status;
    await assert.rejects(
      service.verifyReadRefusal(baseline.body, baseline.sha256),
    );
  }
  const f = fixture(),
    service = new SupabaseCredentialReadProof(
      config,
      { control, retired: [retired] },
      f.transport,
    );
  const baseline = await service.baseline();
  f.deny = true;
  f.failControl = true;
  await assert.rejects(
    service.verifyReadRefusal(baseline.body, baseline.sha256),
  );
  f.failControl = false;
  f.badBody = true;
  await assert.rejects(
    service.verifyReadRefusal(baseline.body, baseline.sha256),
  );
  f.badBody = false;
  f.breakAfterDenied = true;
  await assert.rejects(
    service.verifyReadRefusal(baseline.body, baseline.sha256),
  );
});
test('wrong supplied key, cross-scope baseline, tampering and cancellation refuse before source reads', async () => {
  const f = fixture();
  assert.throws(
    () =>
      new SupabaseCredentialReadProof(
        config,
        { control, retired: [{ ...retired, secret: control.secret }] },
        f.transport,
      ),
  );
  assert.throws(
    () =>
      new SupabaseCredentialReadProof(
        { ...config, bucket: 'documents' },
        { control, retired: [retired] },
        f.transport,
      ),
  );
  const service = new SupabaseCredentialReadProof(
      config,
      { control, retired: [retired] },
      f.transport,
    ),
    baseline = await service.baseline();
  const before = f.reads;
  await assert.rejects(
    service.verifyReadRefusal(baseline.body + ' ', baseline.sha256),
  );
  const other = new SupabaseCredentialReadProof(
    {
      ...config,
      installationId: 'other',
      canary: {
        ...config.canary,
        fileUrl: 'charitypilot-recovery-canary/other/test.txt',
      },
    },
    { control, retired: [retired] },
    f.transport,
  );
  await assert.rejects(other.verifyReadRefusal(baseline.body, baseline.sha256));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    service.verifyReadRefusal(
      baseline.body,
      baseline.sha256,
      controller.signal,
    ),
  );
  assert.equal(f.reads, before);
});
test('negative-read deadline cancels a late body without treating timeout as refusal', async (t) => {
  const f = fixture(),
    first = new SupabaseCredentialReadProof(
      config,
      { control, retired: [retired] },
      f.transport,
    );
  const baseline = await first.baseline();
  let enter!: () => void,
    reply!: (value: Response) => void,
    cancelled = false;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const transport: typeof fetch = (input, init) =>
    new Headers(init?.headers).get('apikey') === retired.secret
      ? new Promise<Response>((resolve) => {
          reply = resolve;
          enter();
        })
      : f.transport(input, init);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = new SupabaseCredentialReadProof(
    config,
    { control, retired: [retired] },
    transport,
  ).verifyReadRefusal(baseline.body, baseline.sha256);
  await entered;
  t.mock.timers.tick(10001);
  await assert.rejects(pending);
  reply(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
          throw new Error('private late body cancellation error');
        },
      }),
      { status: 401 },
    ),
  );
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(cancelled, true);
});
