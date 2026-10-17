import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { decodeNativeS3FeatureDisabled } from '../services/s3-feature-response.js';
import {
  s3FeatureOperations,
  parseS3FeatureBoundary,
} from '../services/s3-feature-boundary-contract.js';
import {
  s3FeatureBoundaryFixture as fixture,
  metadataConfig,
  writer,
} from './fixtures/s3-feature-boundary.js';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
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
