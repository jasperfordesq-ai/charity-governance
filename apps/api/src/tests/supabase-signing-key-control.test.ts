import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { z } from 'zod';
import {
  SupabaseSigningKeyControl,
  publicSigningKeyFingerprint,
} from '../services/supabase-signing-key-control.js';
const current = '11111111-1111-4111-8111-111111111111',
  previous = '22222222-2222-4222-8222-222222222222';
const currentJwk = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
}).publicKey.export({ format: 'jwk' });
const previousJwk = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
}).publicKey.export({ format: 'jwk' });
const config = {
  installationId: 'synthetic',
  projectRef: 'abcdefghijklmnopqrst',
  organisationId: 'org-synthetic',
  region: 'eu-west-1',
  keys: [
    {
      id: current,
      algorithm: 'ES256',
      fingerprint: publicSigningKeyFingerprint('ES256', currentJwk),
      disposition: 'RETAIN_CURRENT',
    },
    {
      id: previous,
      algorithm: 'ES256',
      fingerprint: publicSigningKeyFingerprint('ES256', previousJwk),
      disposition: 'REVOKE_PREVIOUS',
    },
  ],
};
function fixture() {
  let status = 'previously_used',
    fault = '';
  const calls: { method: string; path: string }[] = [];
  const key = (id: string) => ({
    id,
    algorithm: 'ES256',
    status: id === current ? 'in_use' : status,
    public_jwk: id === current ? currentJwk : previousJwk,
    created_at: '2026-10-16T00:00:00Z',
    updated_at: '2026-10-17T00:00:00Z',
  });
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      method = init?.method!;
    calls.push({ method, path: url.pathname });
    assert.equal(url.origin, 'https://api.supabase.com');
    assert.equal(init?.redirect, 'error');
    assert.equal(
      new Headers(init?.headers).get('authorization'),
      'Bearer synthetic-management-token',
    );
    if (fault === 'denied')
      return new Response('PRIVATE provider error', { status: 403 });
    if (fault === 'missing') return new Response(null, { status: 404 });
    if (url.pathname.endsWith('/config/auth/signing-keys')) {
      const rows = [key(current), key(previous)];
      if (fault === 'extra')
        rows.push({
          ...key(previous),
          id: '33333333-3333-4333-8333-333333333333',
        });
      if (fault === 'material') rows[1].public_jwk = currentJwk;
      if (fault === 'private')
        rows[1].public_jwk = { ...previousJwk, d: 'PRIVATE' };
      if (fault === 'standby') rows[1].status = 'standby';
      return Response.json({ keys: rows });
    }
    if (method === 'PATCH') {
      assert.ok(url.pathname.endsWith('/' + previous));
      assert.deepEqual(JSON.parse(String(init?.body)), { status: 'revoked' });
      if (fault !== 'stale') status = 'revoked';
      if (fault === 'lost') throw new Error('PRIVATE committed ACK lost');
      return Response.json(key(previous));
    }
    return Response.json({
      ref: config.projectRef,
      organization_id: fault === 'owner' ? 'other' : config.organisationId,
      region: fault === 'region' ? 'us-east-1' : config.region,
      status: 'ACTIVE_HEALTHY',
    });
  };
  return {
    calls,
    transport,
    set fault(v: string) {
      fault = v;
    },
    get status() {
      return status;
    },
    service: () =>
      new SupabaseSigningKeyControl(
        config,
        'synthetic-management-token',
        transport,
      ),
  };
}
test('reviewed previous signing keys are revoked while current key is retained and inspection stays read-only', async () => {
  const f = fixture(),
    service = f.service(),
    result = await service.revokeReviewed();
  assert.equal(f.status, 'revoked');
  assert.equal(result.configuredSigningKeysObservedRevoked, true);
  assert.equal(result.signedCapabilitiesRevoked, false);
  assert.equal(result.inFlightWritesDrained, false);
  assert.equal(result.actionAuthorized, false);
  const before = f.calls.length;
  await assert.rejects(service.revokeReviewed());
  assert.equal(f.calls.length, before);
  const observed = await f.service().observeRevoked();
  assert.equal(observed.configuredSigningKeysObservedRevoked, true);
  assert.ok(f.calls.slice(before).every((c) => c.method === 'GET'));
  await assert.rejects(f.service().revokeReviewed());
  assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 1);
  assert.equal(
    JSON.stringify(result).includes('synthetic-management-token'),
    false,
  );
});
test('scope, keys, material and provider failures refuse without revocation', async () => {
  for (const fault of [
    'owner',
    'region',
    'extra',
    'material',
    'private',
    'standby',
    'denied',
    'missing',
  ]) {
    const f = fixture();
    f.fault = fault;
    await assert.rejects(
      f.service().revokeReviewed(),
      (e) => e instanceof Error && !e.message.includes('PRIVATE'),
    );
    assert.equal(
      f.calls.some((c) => c.method === 'PATCH'),
      false,
    );
  }
  assert.throws(
    () =>
      new SupabaseSigningKeyControl(
        { ...config, keys: [config.keys[1]] },
        'synthetic',
      ),
  );
  assert.throws(
    () =>
      new SupabaseSigningKeyControl(
        { ...config, keys: [config.keys[0], config.keys[0]] },
        'synthetic',
      ),
  );
});
test('unknown acknowledgement never retries revocation and fresh observation cannot recreate it', async () => {
  const f = fixture(),
    service = f.service();
  f.fault = 'lost';
  await assert.rejects(service.revokeReviewed());
  assert.equal(f.status, 'revoked');
  f.fault = '';
  const before = f.calls.length;
  await assert.rejects(service.revokeReviewed());
  assert.equal(f.calls.length, before);
  await f.service().observeRevoked();
  await assert.rejects(f.service().revokeReviewed());
  assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 1);
  const stale = fixture();
  stale.fault = 'stale';
  await assert.rejects(stale.service().revokeReviewed());
});
test('fingerprints use validated public key material and reject private, ambiguous or symmetric exports', () => {
  assert.equal(
    publicSigningKeyFingerprint('ES256', { ...currentJwk, kid: current }),
    publicSigningKeyFingerprint('ES256', currentJwk),
  );
  assert.throws(() =>
    publicSigningKeyFingerprint('ES256', { ...currentJwk, d: 'private' }),
  );
  assert.throws(() =>
    publicSigningKeyFingerprint('ES256', { ...currentJwk, x: 'AA' }),
  );
  assert.throws(() =>
    publicSigningKeyFingerprint('HS256', { kty: 'oct', k: 'private' }),
  );
  assert.equal(publicSigningKeyFingerprint('HS256', null), null);
});

test('RSA metadata requires a strong public key and shared material cannot masquerade as a new issuer', () => {
  const rsa = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicExponent: 65537,
  }).publicKey.export({ format: 'jwk' });
  assert.match(publicSigningKeyFingerprint('RS256', rsa)!, /^[a-f0-9]{64}$/);
  const weak = generateKeyPairSync('rsa', {
    modulusLength: 1024,
  }).publicKey.export({ format: 'jwk' });
  assert.throws(() => publicSigningKeyFingerprint('RS256', weak));
  assert.throws(() =>
    publicSigningKeyFingerprint('RS256', { ...rsa, d: 'private' }),
  );
  assert.throws(
    () =>
      new SupabaseSigningKeyControl(
        {
          ...config,
          keys: [
            config.keys[0],
            { ...config.keys[1], fingerprint: config.keys[0].fingerprint },
          ],
        },
        'synthetic',
      ),
  );
});

test('partial multi-key revocation cannot be silently completed by a fresh instance', async () => {
  const id = '33333333-3333-4333-8333-333333333333',
    jwk = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    }).publicKey.export({ format: 'jwk' });
  const registry = {
    ...config,
    keys: [
      ...config.keys,
      {
        id,
        algorithm: 'ES256',
        fingerprint: publicSigningKeyFingerprint('ES256', jwk),
        disposition: 'REVOKE_PREVIOUS',
      },
    ],
  };
  const states = new Map([
    [current, 'in_use'],
    [previous, 'previously_used'],
    [id, 'previously_used'],
  ]);
  let patches = 0;
  const row = (key: string) => ({
    id: key,
    algorithm: 'ES256',
    status: states.get(key),
    public_jwk:
      key === current ? currentJwk : key === previous ? previousJwk : jwk,
    created_at: '2026-10-16T00:00:00Z',
    updated_at: '2026-10-17T00:00:00Z',
  });
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === 'PATCH') {
      patches++;
      const key = url.pathname.split('/').at(-1)!;
      if (key === id)
        throw new Error('PRIVATE second key request lost before commit');
      states.set(key, 'revoked');
      return Response.json(row(key));
    }
    if (url.pathname.endsWith('signing-keys'))
      return Response.json({ keys: [id, current, previous].map(row) });
    return Response.json({
      ref: config.projectRef,
      organization_id: config.organisationId,
      region: config.region,
      status: 'ACTIVE_HEALTHY',
    });
  };
  const service = () =>
    new SupabaseSigningKeyControl(registry, 'synthetic', transport);
  await assert.rejects(service().revokeReviewed());
  assert.equal(states.get(previous), 'revoked');
  assert.equal(states.get(id), 'previously_used');
  await assert.rejects(service().observeRevoked());
  await assert.rejects(service().revokeReviewed());
  assert.equal(patches, 2);
});

test('legacy symmetric signing metadata is revoked without reading secret material', async () => {
  const f = fixture(),
    registry = {
      ...config,
      keys: [
        config.keys[0],
        { ...config.keys[1], algorithm: 'HS256', fingerprint: null },
      ],
    };
  const transport: typeof fetch = async (input, init) => {
    const response = await f.transport(input, init),
      url = new URL(String(input));
    if (!url.pathname.includes('signing-keys')) return response;
    const value = z.record(z.unknown()).parse(await response.json()),
      replace = (row: Record<string, unknown>) =>
        row.id === previous
          ? { ...row, algorithm: 'HS256', public_jwk: null }
          : row;
    return Response.json(
      'keys' in value
        ? {
            keys: z.array(z.record(z.unknown())).parse(value.keys).map(replace),
          }
        : replace(value),
    );
  };
  const result = await new SupabaseSigningKeyControl(
    registry,
    'synthetic-management-token',
    transport,
  ).revokeReviewed();
  assert.equal(result.configuredSigningKeysObservedRevoked, true);
  assert.equal(result.storageTokenIssuerVerified, false);
  assert.equal(
    f.calls.some((c) => c.path.endsWith('/legacy')),
    false,
  );
});

test('deadline consumes an attempt and cancels late or stalled bodies without retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reply!: (v: Response) => void,
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
  const service = new SupabaseSigningKeyControl(config, 'synthetic', transport),
    pending = assert.rejects(service.revokeReviewed());
  await started;
  t.mock.timers.tick(10001);
  await pending;
  reply(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
          throw new Error('PRIVATE cancellation');
        },
      }),
    ),
  );
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(cancelled, true);
  await assert.rejects(service.revokeReviewed());
  assert.equal(calls, 1);
  let bodyCancelled = false;
  const stalled: typeof fetch = async () =>
    new Response(
      new ReadableStream({
        cancel() {
          bodyCancelled = true;
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  const failure = assert.rejects(
    new SupabaseSigningKeyControl(
      config,
      'synthetic',
      stalled,
    ).revokeReviewed(),
  );
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(10001);
  await failure;
  assert.equal(bodyCancelled, true);
});
