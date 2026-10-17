import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  SupabaseS3CapabilityProof,
  type RetainS3Capability,
} from '../../services/supabase-s3-capability-proof.js';
import { s3ProbeHash as hash } from '../../services/s3-capability-contract.js';
const encode = (v: string) =>
  encodeURIComponent(v).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
export const control = {
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
export function s3CapabilityProbeFixture(endpoint = 'DIRECT') {
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
