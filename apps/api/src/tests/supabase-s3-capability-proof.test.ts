import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SupabaseS3CapabilityProof } from '../services/supabase-s3-capability-proof.js';
import {
  s3ProbeHash as hash,
  assertS3CapabilityPair,
  s3ProbeOperations,
} from '../services/s3-capability-contract.js';
import {
  s3CapabilityProbeFixture as fixture,
  control,
  retired,
} from './fixtures/s3-capability-proof.js';
for (const endpoint of ['DIRECT', 'GATEWAY'])
  test(
    'actual SDK ' +
      endpoint +
      ' signed key/presigned/multipart baseline and eight feature-specific refusals',
    async () => {
      const f = fixture(endpoint),
        s = f.factory(),
        baseline = await s.baseline(f.retain, f.custody);
      assert.equal(f.uploads.size, 1);
      f.mode.disabled = true;
      const report = await s.verifyRefusal(baseline, f.custody, f.saved);
      assert.deepEqual(
        report.refusals.map((v) => v.operation),
        s3ProbeOperations,
      );
      assert.equal(report.s3CredentialsRevoked, false);
      assert.equal(report.multipartUploadsDrained, false);
      assert.equal(f.uploads.get(f.saved.uploadId)!.parts.size, 1);
      assert.ok(
        !JSON.stringify({ baseline, report }).includes(f.saved.presignedUrl),
      );
      assert.ok(
        !JSON.stringify({ baseline, report }).includes(f.saved.uploadId),
      );
      const old = f.calls.filter((c) => c.presigned);
      assert.equal(old.length, 2);
      assert.equal(old[0].url, old[1].url);
      const before = f.calls.length;
      s.assertBaseline(baseline, f.custody);
      assert.equal(f.calls.length, before);
      await assert.rejects(s.baseline(f.retain, f.custody));
      await assert.rejects(s.verifyRefusal(baseline, f.custody, f.saved));
      assert.equal(f.calls.length, before);
    },
  );
test('generic errors, missing/expired uploads, invalid credentials, redirects and service failure never count as feature closure', async () => {
  for (const [status, code] of [
    [403, 'AccessDenied'],
    [403, 'SignatureDoesNotMatch'],
    [403, 'ExpiredToken'],
    [401, 'FeatureNotEnabled'],
    [404, 'NoSuchKey'],
    [404, 'NoSuchUpload'],
    [409, 'Conflict'],
    [500, 'FeatureNotEnabled'],
    [307, 'FeatureNotEnabled'],
  ] as const) {
    const f = fixture(),
      s = f.factory(),
      a = await s.baseline(f.retain, f.custody);
    f.mode.disabled = true;
    f.mode.status = status;
    f.mode.code = code;
    await assert.rejects(s.verifyRefusal(a, f.custody, f.saved));
  }
});
test('continued S3 acceptance, side effects and failed retained REST controls prevent success', async () => {
  for (const mode of ['stillWorks', 'sideEffect', 'failControl'] as const) {
    const f = fixture(),
      s = f.factory(),
      a = await s.baseline(f.retain, f.custody);
    f.mode.disabled = true;
    f.mode[mode] = true;
    await assert.rejects(s.verifyRefusal(a, f.custody, f.saved));
  }
});
test('lost or mismatched capability custody prevents presigned use and first original part', async () => {
  for (const lost of [true, false]) {
    const f = fixture(),
      s = f.factory();
    await assert.rejects(
      s.baseline(async (v, signal) => {
        if (lost) throw new Error('synthetic lost acknowledgement');
        return {
          ...(await f.retain(v, signal)),
          uploadIdSha256: '0'.repeat(64),
        };
      }, f.custody),
    );
    assert.equal(f.calls.filter((c) => c.presigned).length, 0);
    assert.ok([...f.uploads.values()].every((v) => v.parts.size === 0));
    const before = f.calls.length;
    await assert.rejects(s.baseline(f.retain, f.custody));
    assert.equal(f.calls.length, before);
  }
});
test('substituted original capabilities, scope, endpoint and custody fail before verification dispatch', async () => {
  const f = fixture(),
    baseline = await f.factory().baseline(f.retain, f.custody);
  f.mode.disabled = true;
  for (const secret of [
    { ...f.saved, reference: randomUUID() },
    { ...f.saved, uploadId: randomUUID() },
    {
      ...f.saved,
      presignedUrl: f.saved.presignedUrl.replace(
        '.storage.supabase.co',
        '.supabase.co',
      ),
    },
    { ...f.saved, presignedUrl: f.saved.presignedUrl + '&X-Amz-Expires=900' },
  ]) {
    const before = f.calls.length;
    await assert.rejects(
      f.factory().verifyRefusal(baseline, f.custody, secret),
    );
    assert.equal(f.calls.length, before);
  }
  const before = f.calls.length;
  await assert.rejects(
    f
      .factory({
        ...f.config,
        maintenance: { ...f.config.maintenance, maintenanceEpoch: 2 },
      })
      .verifyRefusal(baseline, f.custody, f.saved),
  );
  await assert.rejects(
    f.factory().verifyRefusal(baseline, '0'.repeat(64), f.saved),
  );
  assert.equal(f.calls.length, before);
});
test('recomputed report hashes cannot change original association or hide omitted/out-of-order refusals', async () => {
  const f = fixture(),
    s = f.factory(),
    baseline = await s.baseline(f.retain, f.custody);
  f.mode.disabled = true;
  const report = await s.verifyRefusal(baseline, f.custody, f.saved),
    keys = [
      'kind',
      'configurationDigest',
      'baselineSha256',
      'capabilityPinSha256',
      'credentialId',
      'observedAt',
      'refusals',
    ];
  const rehash = (r: Record<string, unknown>) => ({
    ...r,
    observationDigest: hash(
      JSON.stringify(Object.fromEntries(keys.map((k) => [k, r[k]]))),
    ),
  });
  for (const patch of [
    { baselineSha256: '0'.repeat(64) },
    { capabilityPinSha256: '0'.repeat(64) },
    { configurationDigest: '0'.repeat(64) },
    { credentialId: randomUUID() },
    { refusals: report.refusals.slice(1) },
    { refusals: [...report.refusals].reverse() },
    { s3CredentialsRevoked: true },
    { observedAt: '2000-01-01T00:00:00.000Z' },
  ])
    assert.throws(() =>
      assertS3CapabilityPair(baseline, rehash({ ...report, ...patch })),
    );
});
test('HTTP200 multipart error bodies cannot prove a working baseline completion', async () => {
  const f = fixture();
  f.mode.completeError200 = true;
  await assert.rejects(f.factory().baseline(f.retain, f.custody));
});
test('cancelled capability retention cannot resume first part or presigned PUT after late acknowledgement', async () => {
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
  assert.ok([...f.uploads.values()].every((v) => v.parts.size === 0));
  assert.equal(f.calls.filter((c) => c.presigned).length, 0);
});

test('expired original presigned capability refuses before any S3 or control dispatch', async (t) => {
  const f = fixture(),
    baseline = await f.factory().baseline(f.retain, f.custody),
    before = f.calls.length,
    now = Date.now();
  t.mock.method(Date, 'now', () => now + 901000);
  await assert.rejects(f.factory().verifyRefusal(baseline, f.custody, f.saved));
  assert.equal(f.calls.length, before);
});
test('late original multipart creation response cannot invoke custody or resume after cancellation', async () => {
  const f = fixture(),
    controller = new AbortController();
  let entered!: () => void,
    release!: () => void,
    retains = 0;
  const ready = new Promise<void>((r) => {
      entered = r;
    }),
    late = new Promise<void>((r) => {
      release = r;
    });
  const transport: typeof fetch = async (input, options) => {
    const response = await f.transport(input, options),
      url = new URL(String(input));
    if (
      options?.method === 'POST' &&
      url.searchParams.has('uploads') &&
      url.pathname.endsWith('/multipart.bin')
    ) {
      entered();
      await late;
    }
    return response;
  };
  const service = new SupabaseS3CapabilityProof(
      f.config,
      { control, retired },
      transport,
    ),
    pending = service.baseline(
      async (v, signal) => {
        retains++;
        return f.retain(v, signal);
      },
      f.custody,
      controller.signal,
    );
  await ready;
  controller.abort();
  await assert.rejects(pending);
  const before = f.calls.length;
  release();
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(retains, 0);
  assert.equal(f.calls.length, before);
  assert.ok([...f.uploads.values()].every((v) => v.parts.size === 0));
  assert.equal(f.calls.filter((c) => c.presigned).length, 0);
});

test('proxy error headers or non-XML bodies cannot substitute for the native S3 feature code', async () => {
  for (const mismatch of ['header', 'mime']) {
    const f = fixture(),
      s = f.factory(),
      baseline = await s.baseline(f.retain, f.custody);
    f.mode.disabled = true;
    if (mismatch === 'header') {
      f.mode.code = 'AccessDenied';
      f.mode.errorHeader = 'FeatureNotEnabled';
    } else f.mode.contentType = 'application/json';
    await assert.rejects(s.verifyRefusal(baseline, f.custody, f.saved));
  }
});
