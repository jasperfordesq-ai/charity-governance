import assert from 'node:assert/strict';
import test from 'node:test';
import { SupabaseStorageWriterControl } from '../services/supabase-storage-writer-control.js';
const config = {
  installationId: 'fixture',
  projectRef: 'abcdefghijklmnopqrst',
  bucket: 'documents',
  organisationId: 'org-synthetic',
  region: 'eu-central-1',
  captureKeyId: '11111111-1111-4111-8111-111111111111',
  writerKeys: [
    { id: '22222222-2222-4222-8222-222222222222', type: 'secret' as const },
  ],
};
function fixture() {
  let legacy = true,
    s3 = true,
    keys = [{ id: config.captureKeyId, type: 'secret' }, ...config.writerKeys];
  let fault = '',
    mutations = 0;
  const calls: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      path = url.pathname,
      method = init?.method ?? 'GET';
    assert.equal(url.origin, 'https://api.supabase.com');
    assert.equal(new Headers(init?.headers).get('accept-encoding'), 'identity');
    assert.equal(init?.redirect, 'error');
    assert.equal(
      new Headers(init?.headers).get('authorization'),
      'Bearer synthetic-management-token',
    );
    calls.push(method + ' ' + path);
    if (fault === '403')
      return new Response('private provider details', { status: 403 });
    if (path.endsWith('/config/storage')) {
      if (method === 'PATCH') {
        mutations++;
        assert.deepEqual(JSON.parse(String(init?.body)), {
          features: { s3Protocol: { enabled: false } },
        });
        s3 = false;
        return Response.json({});
      }
      return Response.json({
        features: { s3Protocol: { enabled: fault === 'stale-s3' ? true : s3 } },
      });
    }
    if (path.endsWith('/api-keys/legacy')) {
      if (fault === 'legacy-404') return new Response(null, { status: 404 });
      if (method === 'PUT') {
        mutations++;
        assert.equal(url.searchParams.get('enabled'), 'false');
        legacy = false;
      }
      return Response.json({ enabled: legacy });
    }
    if (path.endsWith('/api-keys')) {
      assert.equal(url.searchParams.get('reveal'), 'false');
      return Response.json(
        fault === 'extra-key'
          ? [
              ...keys,
              { id: '33333333-3333-4333-8333-333333333333', type: 'secret' },
            ]
          : keys,
      );
    }
    if (method === 'DELETE') {
      mutations++;
      assert.ok(path.endsWith('/' + config.writerKeys[0].id));
      assert.equal(url.searchParams.get('reveal'), 'false');
      const deleted = keys.find((k) => path.endsWith(k.id))!;
      keys = keys.filter((k) => k !== deleted);
      if (fault === 'lost-delete')
        throw new Error('synthetic committed key deletion response lost');
      return Response.json(deleted);
    }
    return Response.json({
      ref: config.projectRef,
      organization_id:
        fault === 'wrong-owner' ? 'other' : config.organisationId,
      region: fault === 'wrong-region' ? 'us-east-1' : config.region,
      status: 'ACTIVE_HEALTHY',
    });
  };
  return {
    transport,
    calls,
    get mutations() {
      return mutations;
    },
    set fault(value: string) {
      fault = value;
    },
    state: () => ({ legacy, s3, keys }),
  };
}
test('reviewed named storage paths close with exact project/key scope; fresh inspection is read-only', async () => {
  const f = fixture(),
    service = new SupabaseStorageWriterControl(
      config,
      'synthetic-management-token',
      f.transport,
    );
  const result = await service.close();
  assert.equal(result.configuredAccessPathsObservedClosed, true);
  assert.equal(result.wholeStorageQuiesced, false);
  assert.equal(f.mutations, 3);
  const before = f.mutations;
  assert.equal(
    (
      await new SupabaseStorageWriterControl(
        config,
        'synthetic-management-token',
        f.transport,
      ).observeClosed()
    ).configuredAccessPathsObservedClosed,
    true,
  );
  await assert.rejects(service.close());
  assert.equal(f.mutations, before);
});
test('a storage registry cannot be bound into another installation plan', () => {
  const f = fixture(),
    service = new SupabaseStorageWriterControl(
      config,
      'synthetic-management-token',
      f.transport,
    );
  assert.throws(() => service.configurationDigest('another-installation'));
  assert.equal(f.calls.length, 0);
});
test('wrong owner, unknown keys and permission denial refuse before mutation; lost delete ACK never retries', async () => {
  for (const fault of [
    'wrong-owner',
    'wrong-region',
    'extra-key',
    '403',
    'legacy-404',
  ]) {
    const f = fixture();
    f.fault = fault;
    await assert.rejects(
      new SupabaseStorageWriterControl(
        config,
        'synthetic-management-token',
        f.transport,
      ).close(),
      (error) => {
        assert.equal(
          (error as Error).message,
          'Supabase storage maintenance is unresolved',
        );
        return true;
      },
    );
    assert.equal(f.mutations, 0);
  }
  const f = fixture();
  f.fault = 'lost-delete';
  await assert.rejects(
    new SupabaseStorageWriterControl(
      config,
      'synthetic-management-token',
      f.transport,
    ).close(),
  );
  assert.equal(f.mutations, 3);
  const fresh = new SupabaseStorageWriterControl(
    config,
    'synthetic-management-token',
    f.transport,
  );
  assert.equal(
    (await fresh.observeClosed()).configuredAccessPathsObservedClosed,
    true,
  );
  await assert.rejects(fresh.close());
  assert.equal(f.mutations, 3);
});
test('stale shutdown readback cannot proceed to key revocation and request deadlines cancel late bodies', async (t) => {
  const f = fixture();
  f.fault = 'stale-s3';
  await assert.rejects(
    new SupabaseStorageWriterControl(
      config,
      'synthetic-management-token',
      f.transport,
    ).close(),
  );
  assert.equal(f.mutations, 1);
  assert.equal(f.state().legacy, true);
  assert.equal(f.state().keys.length, 2);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reply!: (value: Response) => void,
    cancelled = false;
  const pending = new SupabaseStorageWriterControl(
    config,
    'synthetic-management-token',
    () =>
      new Promise<Response>((resolve) => {
        reply = resolve;
      }),
  ).observeClosed();
  t.mock.timers.tick(10001);
  await assert.rejects(pending);
  reply(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
          throw new Error('synthetic private cancellation error');
        },
      }),
    ),
  );
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(cancelled, true);
});
