import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SupabaseStorageWriterControl } from '../../services/supabase-storage-writer-control.js';
import { SupabaseS3FeatureBoundaryProof } from '../../services/supabase-s3-feature-boundary-proof.js';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
export const control = {
    id: '11111111-1111-4111-8111-111111111111',
    secret: 'sb_secret_' + 'a'.repeat(40),
  },
  writer = '22222222-2222-4222-8222-222222222222';
export const metadataConfig = {
  installationId: 'synthetic',
  projectRef: 'abcdefghijklmnopqrst',
  bucket: 'synthetic-governance',
  organisationId: 'org-synthetic',
  region: 'eu-west-1',
  captureKeyId: control.id,
  writerKeys: [{ id: writer, type: 'secret' }],
};
const base = {
  installationId: metadataConfig.installationId,
  projectRef: metadataConfig.projectRef,
  region: metadataConfig.region,
  bucket: 'charitypilot-recovery-s3-probes',
  stage: 'PRE_CLOSURE',
  maintenance: {
    attemptId: '33333333-3333-4333-8333-333333333333',
    planDigest: '1'.repeat(64),
    sourceSha: '2'.repeat(40),
    maintenanceEpoch: 1,
  },
  providerRelease: { sourceSha: '3'.repeat(40), imageDigest: '4'.repeat(64) },
  control: { id: control.id, sha256: hash(control.secret) },
};
export function s3FeatureBoundaryFixture(stage = 'PRE_CLOSURE') {
  const config = { ...base, stage },
    objects = new Map<string, Buffer>(),
    calls: {
      kind: 'metadata' | 'data';
      method: string;
      url: string;
      auth: boolean;
      body?: Buffer;
    }[] = [];
  const mode = {
    metadataEnabled: false,
    dataEnabled: false,
    extraKey: false,
    legacy: stage === 'PRE_CLOSURE',
    status: 403,
    code: 'FeatureNotEnabled',
    mime: 'application/xml',
    badEndpoint: '',
    sideEffect: false,
    failAfter: false,
    metadataDrift: false,
    lostCanaryAck: false,
  };
  let managementFault:
    | ((
        input: Parameters<typeof fetch>[0],
        options: Parameters<typeof fetch>[1],
      ) => Promise<Response> | undefined)
    | undefined;
  const management: typeof fetch = async (input, options) => {
    calls.push({
      kind: 'metadata',
      method: options!.method!,
      url: String(input),
      auth: true,
    });
    assert.equal(options!.method, 'GET');
    assert.equal(options!.redirect, 'error');
    assert.equal(
      new Headers(options!.headers).get('authorization'),
      'Bearer synthetic-management',
    );
    const fault = managementFault?.(input, options);
    if (fault) return fault;
    const url = new URL(String(input)),
      path = '/v1/projects/' + config.projectRef;
    if (url.pathname === path)
      return Response.json({
        ref: config.projectRef,
        organization_id: metadataConfig.organisationId,
        region: config.region,
        status: 'ACTIVE_HEALTHY',
      });
    if (url.pathname === path + '/config/storage')
      return Response.json({
        features: { s3Protocol: { enabled: mode.metadataEnabled } },
      });
    if (url.pathname === path + '/api-keys/legacy')
      return Response.json({ enabled: mode.legacy });
    assert.equal(url.pathname, path + '/api-keys');
    assert.equal(url.search, '?reveal=false');
    return Response.json([
      { id: control.id, type: 'secret' },
      ...(stage === 'PRE_CLOSURE' ? [{ id: writer, type: 'secret' }] : []),
      ...(mode.extraKey
        ? [{ id: '99999999-9999-4999-8999-999999999999', type: 'secret' }]
        : []),
    ]);
  };
  const metadata = new SupabaseStorageWriterControl(
    metadataConfig,
    'synthetic-management',
    management,
  );
  const transport: typeof fetch = async (input, options) => {
    const u = new URL(String(input)),
      h = new Headers(options!.headers),
      method = options!.method!,
      body = options?.body
        ? Buffer.from(options.body as Uint8Array)
        : undefined;
    assert.ok(
      [
        'https://' + config.projectRef + '.storage.supabase.co',
        'https://' + config.projectRef + '.supabase.co',
      ].includes(u.origin),
    );
    assert.equal(options!.redirect, 'error');
    assert.equal(h.get('cache-control'), 'no-cache, no-store');
    calls.push({
      kind: 'data',
      method,
      url: String(input),
      auth: h.has('apikey') || h.has('authorization'),
      body,
    });
    const headers = { date: new Date().toUTCString() };
    if (u.pathname.startsWith('/storage/v1/bucket/')) {
      assert.equal(h.get('apikey'), control.secret);
      return Response.json({ id: config.bucket, public: false }, { headers });
    }
    if (u.pathname.startsWith('/storage/v1/object/')) {
      assert.equal(h.get('apikey'), control.secret);
      assert.equal(h.has('authorization'), false);
      const path = u.pathname.slice(
        ('/storage/v1/object/' + config.bucket + '/').length,
      );
      if (method === 'POST') {
        assert.equal(h.get('x-upsert'), 'false');
        if (objects.has(path))
          return new Response(null, { status: 409, headers });
        if (mode.failAfter && path.endsWith('/after.bin'))
          return new Response(null, { status: 503, headers });
        objects.set(path, body!);
        if (mode.lostCanaryAck)
          throw new Error('synthetic committed canary ACK lost');
        return Response.json({ Key: path }, { headers });
      }
      assert.equal(method, 'GET');
      const data = objects.get(path);
      return data
        ? new Response(data, {
            headers: { ...headers, 'content-length': String(data.length) },
          })
        : new Response(null, { status: 404, headers });
    }
    assert.ok(u.pathname.startsWith('/storage/v1/s3/' + config.bucket + '/'));
    assert.equal(h.has('apikey'), false);
    assert.equal(h.has('authorization'), false);
    const path = u.pathname.slice(
      ('/storage/v1/s3/' + config.bucket + '/').length,
    );
    if (u.searchParams.has('uploadId'))
      assert.equal(
        u.searchParams.get('uploadId'),
        'charitypilot-unissued-' + config.maintenance.attemptId,
      );
    if (u.searchParams.has('X-Amz-Signature')) {
      assert.equal(u.searchParams.get('X-Amz-Signature'), '0'.repeat(64));
      assert.ok(
        u.searchParams
          .get('X-Amz-Credential')!
          .startsWith('CHARITYPILOT_UNISSUED_PROBE/'),
      );
    }
    if (mode.metadataDrift) mode.legacy = false;
    if (mode.sideEffect && method === 'PUT' && path.endsWith('/create.bin'))
      objects.set(path, body!);
    const endpoint = u.hostname.includes('.storage.') ? 'DIRECT' : 'GATEWAY',
      code =
        mode.dataEnabled || mode.badEndpoint === endpoint
          ? 'AccessDenied'
          : mode.code;
    return new Response(
      '<Error><Code>' +
        code +
        '</Code><Message>feature boundary fixture</Message></Error>',
      {
        status: mode.status,
        headers: { ...headers, 'content-type': mode.mime },
      },
    );
  };
  const factory = (raw: unknown = config) =>
    new SupabaseS3FeatureBoundaryProof(
      raw,
      control.secret,
      metadata,
      transport,
    );
  return {
    config,
    metadata,
    mode,
    objects,
    calls,
    transport,
    factory,
    setStage: (next: string) => {
      stage = next;
      mode.legacy = next === 'PRE_CLOSURE';
    },
    setManagementFault: (fault: typeof managementFault) => {
      managementFault = fault;
    },
  };
}
