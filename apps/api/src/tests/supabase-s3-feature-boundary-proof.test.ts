import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { SupabaseStorageWriterControl } from '../services/supabase-storage-writer-control.js';
import { SupabaseS3FeatureBoundaryProof } from '../services/supabase-s3-feature-boundary-proof.js';
import { decodeNativeS3FeatureDisabled } from '../services/s3-feature-response.js';
import {
  s3FeatureOperations,
  parseS3FeatureBoundary,
} from '../services/s3-feature-boundary-contract.js';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const control = {
    id: '11111111-1111-4111-8111-111111111111',
    secret: 'sb_secret_' + 'a'.repeat(40),
  },
  writer = '22222222-2222-4222-8222-222222222222';
const metadataConfig = {
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
function fixture(stage = 'PRE_CLOSURE') {
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
    setManagementFault: (fault: typeof managementFault) => {
      managementFault = fault;
    },
  };
}
for (const stage of ['PRE_CLOSURE', 'POST_CLOSURE'])
  test(
    'current ' +
      stage +
      ' feature proof covers both endpoints without creating usable S3 credentials or historical claims',
    async () => {
      const f = fixture(stage),
        service = f.factory(),
        artifact = await service.probe(),
        report = parseS3FeatureBoundary(artifact).value;
      assert.equal(report.refusals.length, 16);
      assert.deepEqual(
        report.refusals.slice(0, 8).map((v) => v.operation),
        s3FeatureOperations,
      );
      assert.ok(
        report.refusals.slice(8).every((v) => v.endpoint === 'GATEWAY'),
      );
      assert.equal(report.originalWorkingS3BaselineProven, false);
      assert.equal(report.historicalNeverEnabledProven, false);
      assert.equal(report.s3CredentialsRevoked, false);
      assert.equal(report.savedObservationAuthorizesExecution, false);
      assert.equal(report.unknownMultipartSideEffectsExcluded, false);
      const s3 = f.calls.filter(
        (c) =>
          c.kind === 'data' &&
          new URL(c.url).pathname.startsWith('/storage/v1/s3/'),
      );
      assert.equal(s3.length, 16);
      assert.ok(s3.every((c) => c.auth === false));
      assert.ok(
        f.calls
          .filter((c) => c.kind === 'metadata')
          .every((c) => c.method === 'GET'),
      );
      assert.equal(f.objects.size, 4);
      const before = f.calls.length;
      service.assertObservation(artifact);
      f.factory().assertObservation(artifact);
      assert.equal(f.calls.length, before);
      await assert.rejects(service.probe());
      assert.equal(f.calls.length, before);
    },
  );
test('enabled metadata or unexpected credential inventory refuses before data probes or REST canaries', async () => {
  for (const issue of ['metadataEnabled', 'extraKey'] as const) {
    const f = fixture();
    f.mode[issue] = true;
    await assert.rejects(f.factory().probe());
    assert.equal(f.calls.filter((c) => c.kind === 'data').length, 0);
    assert.equal(f.objects.size, 0);
  }
});
test('one stale endpoint, authentication denial, nonXML, missing routes and generic failures cannot establish the boundary', async () => {
  for (const issue of [
    'dataEnabled',
    'gateway',
    'mime',
    'missing',
    'server',
  ] as const) {
    const f = fixture();
    if (issue === 'gateway') f.mode.badEndpoint = 'GATEWAY';
    else if (issue === 'mime') f.mode.mime = 'application/json';
    else if (issue === 'missing') f.mode.status = 404;
    else if (issue === 'server') f.mode.status = 500;
    else f.mode.dataEnabled = true;
    await assert.rejects(f.factory().probe());
  }
});
test('observed side effects, failed after-control or changed metadata leave the probe unresolved', async () => {
  for (const issue of ['sideEffect', 'failAfter', 'metadataDrift'] as const) {
    const f = fixture();
    f.mode[issue] = true;
    await assert.rejects(f.factory().probe());
  }
});
test('lost canary ACK cannot repeat the instance or turn existing residue into a reconstructed report', async () => {
  const f = fixture(),
    service = f.factory();
  f.mode.lostCanaryAck = true;
  await assert.rejects(service.probe());
  assert.equal(f.objects.size, 1);
  const before = f.calls.length;
  await assert.rejects(service.probe());
  assert.equal(f.calls.length, before);
  f.mode.lostCanaryAck = false;
  await assert.rejects(f.factory().probe());
  assert.equal(f.objects.size, 1);
  assert.equal(
    f.calls.filter(
      (c) =>
        c.kind === 'data' &&
        new URL(c.url).pathname.startsWith('/storage/v1/s3/'),
    ).length,
    0,
  );
});
test('cancelled metadata read stops without later canary writes or automatic resume', async () => {
  const f = fixture(),
    controller = new AbortController();
  let entered!: () => void, release!: (v: Response) => void;
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  f.setManagementFault(() => {
    entered();
    return new Promise<Response>((r) => {
      release = r;
    });
  });
  const pending = f.factory().probe(controller.signal);
  await ready;
  controller.abort();
  await assert.rejects(pending);
  const before = f.calls.length;
  release(
    Response.json({
      ref: f.config.projectRef,
      organization_id: metadataConfig.organisationId,
      region: f.config.region,
      status: 'ACTIVE_HEALTHY',
    }),
  );
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(f.calls.length, before);
  assert.equal(f.objects.size, 0);
});
test('scope and metadata-substitution or coverage forgeries remain invalid despite recomputed outer digest', async () => {
  const f = fixture(),
    artifact = await f.factory().probe(),
    original = JSON.parse(artifact.body),
    keys = [
      'format',
      'kind',
      'configurationDigest',
      'maintenance',
      'stage',
      'beganAt',
      'observedAt',
      'metadataBefore',
      'metadataAfter',
      'refusals',
    ];
  const forged = (v: Record<string, unknown>) => {
    v.observationDigest = hash(
      JSON.stringify(Object.fromEntries(keys.map((k) => [k, v[k]]))),
    );
    const body = JSON.stringify(v);
    return { body, sha256: hash(body) };
  };
  const patches = [
    { refusals: original.refusals.slice(0, 8) },
    { refusals: [...original.refusals].reverse() },
    { historicalNeverEnabledProven: true },
    { originalWorkingS3BaselineProven: true },
    { wholeStorageQuiesced: true },
    { observedAt: '2000-01-01T00:00:00.000Z' },
    {
      metadataAfter: { ...original.metadataAfter, stateSha256: '0'.repeat(64) },
    },
    { maintenance: { ...f.config.maintenance, maintenanceEpoch: 2 } },
  ];
  const before = f.calls.length;
  for (const patch of patches)
    assert.throws(() =>
      f.factory().assertObservation(forged({ ...original, ...patch })),
    );
  assert.equal(f.calls.length, before);
  assert.throws(() => f.factory({ ...f.config, region: 'eu-central-1' }));
  assert.throws(() =>
    f.factory({ ...f.config, control: { ...f.config.control, id: writer } }),
  );
  assert.equal(f.calls.length, before);
});
test('native feature response decoder is local-only, bounded and rejects status/content/error substitutions', async (t) => {
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetches++;
    throw new Error('decoder network forbidden');
  });
  const response = {
    status: 403,
    headers: new Headers({ 'content-type': 'application/xml' }),
    bytes: Buffer.from(
      '<Error><Code>FeatureNotEnabled</Code><Message>feature not enabled</Message></Error>',
    ),
  };
  assert.equal(await decodeNativeS3FeatureDisabled(response), true);
  for (const patch of [
    { status: 404 },
    { headers: new Headers({ 'content-type': 'application/json' }) },
    { bytes: Buffer.from('<Error><Code>AccessDenied</Code></Error>') },
    { bytes: Buffer.alloc(32769, 65) },
  ])
    assert.equal(
      await decodeNativeS3FeatureDisabled({ ...response, ...patch }),
      false,
    );
  assert.equal(fetches, 0);
  assert.ok(response.bytes.toString().includes('FeatureNotEnabled'));
});
