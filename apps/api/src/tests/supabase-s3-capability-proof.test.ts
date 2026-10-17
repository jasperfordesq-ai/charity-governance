import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  SupabaseS3CapabilityProof,
  type RetainS3Capability,
} from '../services/supabase-s3-capability-proof.js';
import {
  s3ProbeHash as hash,
  assertS3CapabilityPair,
  s3ProbeOperations,
} from '../services/s3-capability-contract.js';
const encode = (v: string) =>
  encodeURIComponent(v).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
const control = {
    id: '11111111-1111-4111-8111-111111111111',
    secret: 'sb_secret_' + 'a'.repeat(40),
  },
  retired = {
    id: '22222222-2222-4222-8222-222222222222',
    accessKeyId: 'SYNTHETIC_S3_KEY',
    secretAccessKey: 'synthetic-s3-secret-'.repeat(3),
  };
const configuration = {
  installationId: 'synthetic',
  projectRef: 'abcdefghijklmnopqrst',
  endpoint: 'DIRECT',
  region: 'eu-west-1',
  bucket: 'charitypilot-recovery-s3-probes',
  maintenance: {
    attemptId: '33333333-3333-4333-8333-333333333333',
    planDigest: '1'.repeat(64),
    sourceSha: '2'.repeat(40),
    maintenanceEpoch: 1,
  },
  providerRelease: { sourceSha: '3'.repeat(40), imageDigest: '4'.repeat(64) },
  control: { id: control.id, sha256: hash(control.secret) },
  retired: {
    id: retired.id,
    accessKeyIdSha256: hash(retired.accessKeyId),
    secretAccessKeySha256: hash(retired.secretAccessKey),
  },
};
function fixture(endpoint = 'DIRECT') {
  const config = { ...configuration, endpoint },
    origin =
      'https://' +
      config.projectRef +
      (endpoint === 'DIRECT' ? '.storage.supabase.co' : '.supabase.co'),
    objects = new Map<string, Buffer>(),
    uploads = new Map<
      string,
      { key: string; parts: Map<number, { bytes: Buffer; etag: string }> }
    >(),
    calls: { method: string; path: string; url: string; presigned: boolean }[] =
      [];
  const mode = {
    disabled: false,
    stillWorks: false,
    failControl: false,
    sideEffect: false,
    status: 403,
    code: 'FeatureNotEnabled',
    completeError200: false,
    contentType: 'application/xml',
    errorHeader: '',
  };
  let saved:
    | { reference: string; presignedUrl: string; uploadId: string }
    | undefined;
  const xml = (
    text: string,
    status = 200,
    headers: Record<string, string> = {},
  ) =>
    new Response(text, {
      status,
      headers: {
        date: new Date().toUTCString(),
        'content-type': mode.contentType,
        ...(mode.errorHeader ? { 'x-amzn-errortype': mode.errorHeader } : {}),
        ...headers,
      },
    });
  const transport: typeof fetch = async (input, options) => {
    const url = new URL(String(input)),
      method = options!.method!,
      h = new Headers(options!.headers),
      body = options?.body
        ? Buffer.from(options.body as Uint8Array)
        : Buffer.alloc(0),
      presigned = url.searchParams.has('X-Amz-Signature');
    assert.equal(url.origin, origin);
    assert.equal(options!.redirect, 'error');
    assert.equal(h.get('cache-control'), 'no-cache, no-store');
    calls.push({ method, path: url.pathname, url: String(input), presigned });
    if (url.pathname.startsWith('/storage/v1/bucket/')) {
      assert.equal(h.get('apikey'), control.secret);
      assert.equal(h.has('authorization'), false);
      return Response.json(
        { id: config.bucket, public: false },
        { headers: { date: new Date().toUTCString() } },
      );
    }
    if (url.pathname.startsWith('/storage/v1/object/')) {
      assert.equal(h.get('apikey'), control.secret);
      assert.equal(h.has('authorization'), false);
      const key = url.pathname.slice(
        ('/storage/v1/object/' + config.bucket + '/').length,
      );
      if (method === 'POST') {
        if (mode.failControl)
          return new Response(null, {
            status: 503,
            headers: { date: new Date().toUTCString() },
          });
        assert.ok(!objects.has(key));
        objects.set(key, body);
        return Response.json(
          { Key: key },
          { headers: { date: new Date().toUTCString() } },
        );
      }
      assert.equal(method, 'GET');
      const value = objects.get(key);
      return value
        ? new Response(value, {
            headers: {
              date: new Date().toUTCString(),
              'content-length': String(value.length),
            },
          })
        : new Response(null, {
            status: 404,
            headers: { date: new Date().toUTCString() },
          });
    }
    assert.ok(url.pathname.startsWith('/storage/v1/s3/' + config.bucket + '/'));
    assert.equal(h.has('apikey'), false);
    // Independent SigV4 verification of real SDK headers and real presigned URL.
    const auth = h.get('authorization') ?? '',
      match =
        /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/.exec(
          auth,
        ),
      q = url.searchParams;
    const credential = presigned ? q.get('X-Amz-Credential')! : match![1],
      signedHeaders = presigned ? q.get('X-Amz-SignedHeaders')! : match![2],
      signature = presigned ? q.get('X-Amz-Signature')! : match![3],
      date = presigned ? q.get('X-Amz-Date')! : h.get('x-amz-date')!,
      scope = credential.split('/');
    assert.equal(scope[0], retired.accessKeyId);
    assert.equal(scope[1], date.slice(0, 8));
    assert.equal(scope[2], config.region);
    assert.equal(scope[3], 's3');
    assert.equal(scope[4], 'aws4_request');
    if (presigned) {
      assert.equal(h.has('authorization'), false);
      assert.equal(q.get('X-Amz-Expires'), '900');
    }
    const canonicalQuery = [...q.entries()]
      .filter(([k]) => k !== 'X-Amz-Signature')
      .map(([k, v]) => [encode(k), encode(v)])
      .sort(([a, av], [b, bv]) =>
        a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
      )
      .map(([k, v]) => k + '=' + v)
      .join('&');
    const canonicalHeaders = signedHeaders
        .split(';')
        .map(
          (name) =>
            name +
            ':' +
            (name === 'host' ? url.host : h.get(name)!)
              .trim()
              .replace(/\s+/g, ' ') +
            '\n',
        )
        .join(''),
      payloadHash = presigned
        ? q.get('X-Amz-Content-Sha256')!
        : h.get('x-amz-content-sha256')!;
    if (!presigned && payloadHash !== 'UNSIGNED-PAYLOAD')
      assert.equal(payloadHash, hash(body));
    const request = [
        method,
        url.pathname,
        canonicalQuery,
        canonicalHeaders,
        signedHeaders,
        payloadHash,
      ].join('\n'),
      stringToSign = [
        'AWS4-HMAC-SHA256',
        date,
        scope.slice(1).join('/'),
        hash(request),
      ].join('\n');
    const hmac = (key: string | Buffer, data: string) =>
      createHmac('sha256', key).update(data).digest();
    let signingKey = hmac('AWS4' + retired.secretAccessKey, scope[1]);
    for (const part of scope.slice(2)) signingKey = hmac(signingKey, part);
    assert.equal(
      createHmac('sha256', signingKey).update(stringToSign).digest('hex'),
      signature,
    );
    const key = url.pathname.slice(
        ('/storage/v1/s3/' + config.bucket + '/').length,
      ),
      uploadId = q.get('uploadId'),
      partNumber = Number(q.get('partNumber'));
    if (mode.disabled && !mode.stillWorks) {
      if (
        mode.sideEffect &&
        (method === 'PUT' || method === 'DELETE') &&
        !uploadId
      ) {
        if (method === 'DELETE') objects.delete(key);
        else objects.set(key, body);
      }
      return xml(
        '<Error><Code>' +
          mode.code +
          '</Code><Message>feature not enabled for this tenant</Message></Error>',
        mode.status,
      );
    }
    if (method === 'POST' && q.has('uploads')) {
      const id = randomUUID();
      uploads.set(id, { key, parts: new Map() });
      return xml(
        '<InitiateMultipartUploadResult><Bucket>' +
          config.bucket +
          '</Bucket><Key>' +
          key +
          '</Key><UploadId>' +
          id +
          '</UploadId></InitiateMultipartUploadResult>',
      );
    }
    if (uploadId) {
      const upload = uploads.get(uploadId);
      assert.ok(upload);
      assert.equal(upload.key, key);
      if (method === 'PUT') {
        assert.ok(Number.isInteger(partNumber) && partNumber > 0);
        const etag = '"' + createHash('md5').update(body).digest('hex') + '"';
        upload.parts.set(partNumber, { bytes: body, etag });
        return new Response(null, {
          status: 200,
          headers: { date: new Date().toUTCString(), etag },
        });
      }
      if (method === 'GET')
        return xml(
          '<ListPartsResult><Bucket>' +
            config.bucket +
            '</Bucket><Key>' +
            key +
            '</Key><UploadId>' +
            uploadId +
            '</UploadId><IsTruncated>false</IsTruncated>' +
            [...upload.parts.entries()]
              .map(
                ([n, p]) =>
                  '<Part><PartNumber>' +
                  n +
                  '</PartNumber><ETag>' +
                  p.etag +
                  '</ETag><Size>' +
                  p.bytes.length +
                  '</Size></Part>',
              )
              .join('') +
            '</ListPartsResult>',
        );
      assert.equal(method, 'POST');
      if (mode.completeError200)
        return xml(
          '<Error><Code>FeatureNotEnabled</Code><Message>not completed</Message></Error>',
        );
      assert.ok(body.toString().includes('CompleteMultipartUpload'));
      const data = Buffer.concat(
        [...upload.parts.values()].map((v) => v.bytes),
      );
      objects.set(key, data);
      uploads.delete(uploadId);
      return xml(
        '<CompleteMultipartUploadResult><Bucket>' +
          config.bucket +
          '</Bucket><Key>' +
          key +
          '</Key><ETag>"synthetic-complete"</ETag></CompleteMultipartUploadResult>',
      );
    }
    if (method === 'PUT') {
      objects.set(key, body);
      return new Response(null, {
        status: 200,
        headers: { date: new Date().toUTCString(), etag: '"synthetic-put"' },
      });
    }
    if (method === 'DELETE') {
      objects.delete(key);
      return new Response(null, {
        status: 204,
        headers: { date: new Date().toUTCString() },
      });
    }
    assert.equal(method, 'GET');
    const data = objects.get(key);
    return data
      ? new Response(data, {
          headers: {
            date: new Date().toUTCString(),
            'content-length': String(data.length),
          },
        })
      : xml('<Error><Code>NoSuchKey</Code></Error>', 404);
  };
  const custody = '9'.repeat(64),
    factory = (raw: unknown = config) =>
      new SupabaseS3CapabilityProof(raw, { control, retired }, transport),
    retain: RetainS3Capability = async (v, signal) => {
      signal.throwIfAborted();
      assert.equal(uploads.get(v.uploadId)!.parts.size, 0);
      assert.equal(calls.filter((c) => c.presigned).length, 0);
      saved = {
        reference: randomUUID(),
        presignedUrl: v.presignedUrl,
        uploadId: v.uploadId,
      };
      return {
        kind: 'S3_CAPABILITY_PIN_V1',
        reference: saved.reference,
        custodyDigest: custody,
        versionId: 'synthetic-capability-version',
        sha256: '8'.repeat(64),
        byteLength: 2048,
        presignedUrlSha256: v.presignedUrlSha256,
        uploadIdSha256: v.uploadIdSha256,
      };
    };
  return {
    mode,
    transport,
    calls,
    objects,
    uploads,
    custody,
    config,
    factory,
    retain,
    get saved() {
      assert.ok(saved);
      return saved;
    },
  };
}
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
