import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import {
  SupabaseSignedResumableUploadProof,
  type RetainSignedResumableCredential,
} from '../../services/supabase-signed-resumable-upload-proof.js';
import { publicSigningKeyFingerprint } from '../../services/supabase-signing-key-control.js';
import { signedTusHash as hash } from '../../services/signed-resumable-upload-contract.js';
const pair = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
  previous = pair(),
  current = pair();
const issuer = (p: ReturnType<typeof pair>, id: string) => {
  const publicJwk = p.publicKey.export({ format: 'jwk' });
  return {
    providerKeyId: id,
    tokenKid: id,
    algorithm: 'ES256',
    publicJwk,
    fingerprint: publicSigningKeyFingerprint('ES256', publicJwk),
  };
};
export const control = {
    id: '11111111-1111-4111-8111-111111111111',
    secret: 'sb_secret_' + 'a'.repeat(40),
  },
  gateway = {
    id: '22222222-2222-4222-8222-222222222222',
    secret: 'sb_publishable_' + 'b'.repeat(40),
  };
export const config = {
  installationId: 'synthetic',
  projectRef: 'abcdefghijklmnopqrst',
  bucket: 'charitypilot-recovery-resumable-probes',
  maintenance: {
    attemptId: '33333333-3333-4333-8333-333333333333',
    planDigest: '1'.repeat(64),
    sourceSha: '2'.repeat(40),
    maintenanceEpoch: 1,
  },
  providerRelease: { sourceSha: '3'.repeat(40), imageDigest: '4'.repeat(64) },
  uploadIdFormat: 'PATH_V1',
  control: { id: control.id, sha256: hash(control.secret) },
  gateway: { id: gateway.id, sha256: hash(gateway.secret) },
  previousIssuer: issuer(previous, '55555555-5555-4555-8555-555555555555'),
  currentIssuer: issuer(current, '66666666-6666-4666-8666-666666666666'),
};
export function signedResumableProbeFixture(format = 'PATH_V1') {
  const c = { ...config, uploadIdFormat: format },
    origin = 'https://' + c.projectRef + '.storage.supabase.co',
    endpoint = origin + '/storage/v1/upload/resumable',
    custody = '9'.repeat(64);
  const sessions = new Map<
      string,
      { path: string; length: number; offset: number; expires: string }
    >(),
    objects = new Map<string, Uint8Array>(),
    calls: { url: string; method: string; signature: string | null }[] = [];
  let saved: { reference: string; token: string; location: string } | undefined;
  const mode = {
    revoked: false,
    stillWorks: false,
    sideEffect: false,
    failControl: false,
    refusalStatus: 400,
    refusalBody: 'invalid signature',
    badLocation: false,
    badExpiry: false,
    wrongIssuer: false,
    wrongScope: false,
    wrongPath: false,
  };
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      method = init!.method!,
      h = new Headers(init!.headers),
      signature = h.get('x-signature'),
      date = new Date().toUTCString(),
      headers = { date, 'tus-resumable': '1.0.0' };
    calls.push({ url: String(input), method, signature });
    assert.equal(url.origin, origin);
    assert.equal(init?.redirect, 'error');
    assert.equal(h.has('authorization'), false);
    if (url.pathname.startsWith('/storage/v1/object/upload/sign/')) {
      assert.equal(method, 'POST');
      assert.equal(h.get('apikey'), control.secret);
      assert.equal(h.get('x-upsert'), 'true');
      assert.equal(Buffer.from(init!.body as Uint8Array).toString(), '{}');
      const path = url.pathname.slice('/storage/v1/object/upload/sign/'.length),
        old = path.endsWith('/old.txt'),
        k = old && !mode.wrongIssuer ? previous : current,
        id = old && !mode.wrongIssuer ? c.previousIssuer : c.currentIssuer;
      const token = jwt.sign(
        {
          url: mode.wrongPath ? 'other/object' : path,
          scope: mode.wrongScope ? 'download' : 'upload',
          upsert: true,
        },
        k.privateKey,
        { algorithm: 'ES256', keyid: id.tokenKid, expiresIn: 7200 },
      );
      return Response.json(
        { url: '/object/upload/sign/' + path + '?token=' + token, token },
        { headers },
      );
    }
    if (url.pathname.startsWith('/storage/v1/bucket/')) {
      assert.equal(h.get('apikey'), control.secret);
      assert.equal(signature, null);
      return Response.json({ id: c.bucket, public: false }, { headers });
    }
    if (url.pathname.startsWith('/storage/v1/object/')) {
      assert.equal(h.get('apikey'), control.secret);
      assert.equal(signature, null);
      const path = url.pathname.slice('/storage/v1/object/'.length),
        data = objects.get(path);
      return data
        ? new Response(data, {
            headers: { ...headers, 'content-length': String(data.length) },
          })
        : new Response(null, { status: 404, headers });
    }
    if (method === 'HEAD') {
      assert.equal(h.get('apikey'), control.secret);
      assert.equal(signature, null);
      assert.ok(!url.pathname.includes('/sign/'));
      const encoded = url.pathname.slice(
          '/storage/v1/upload/resumable/'.length,
        ),
        s = sessions.get(encoded);
      assert.ok(s);
      return new Response(null, {
        status: 204,
        headers: {
          ...headers,
          'upload-length': String(s.length),
          'upload-offset': String(s.offset),
          'upload-expires': s.expires,
        },
      });
    }
    assert.equal(h.get('apikey'), gateway.secret);
    assert.ok(signature);
    assert.equal(h.get('x-upsert'), 'true');
    assert.ok(url.pathname.startsWith('/storage/v1/upload/resumable/sign'));
    const token = jwt.decode(signature, { complete: true });
    assert.ok(token && typeof token.payload === 'object');
    const claims = jwt.verify(
      signature,
      token.header.kid === c.previousIssuer.tokenKid
        ? previous.publicKey
        : current.publicKey,
      { algorithms: ['ES256'] },
    ) as jwt.JwtPayload;
    if (method === 'POST') {
      assert.equal(String(input), endpoint + '/sign');
      const metadata = Object.fromEntries(
        h
          .get('upload-metadata')!
          .split(',')
          .map((v) => {
            const [k, b] = v.split(' ');
            return [k, Buffer.from(b, 'base64').toString()];
          }),
      );
      const path = metadata.bucketName + '/' + metadata.objectName;
      assert.equal(claims.url, path);
      assert.equal(claims.upsert, true);
      assert.equal(claims.scope, 'upload');
      if (mode.failControl && !path.endsWith('/old.txt'))
        return new Response(null, { status: 403, headers });
      const encoded = Buffer.from(
          path + (format === 'PATH_V1' ? '/' : '-$v-') + randomUUID(),
        ).toString('base64url'),
        location = endpoint + '/sign/' + encoded,
        expires = new Date(
          Date.parse(date) + (mode.badExpiry ? 30000 : 3600000),
        ).toUTCString();
      sessions.set(encoded, {
        path,
        length: Number(h.get('upload-length')),
        offset: 0,
        expires,
      });
      return new Response(null, {
        status: 201,
        headers: {
          ...headers,
          location: mode.badLocation
            ? location.replace('/sign/', '/')
            : location,
          'upload-expires': expires,
        },
      });
    }
    assert.equal(method, 'PATCH');
    const encoded = url.pathname.slice(
        '/storage/v1/upload/resumable/sign/'.length,
      ),
      s = sessions.get(encoded);
    assert.ok(s);
    assert.equal(claims.url, s.path);
    assert.equal(Number(h.get('upload-offset')), s.offset);
    const data = Buffer.from(init!.body as Uint8Array),
      old = s.path.endsWith('/old.txt');
    if (old && mode.revoked && !mode.stillWorks) {
      if (mode.sideEffect) {
        s.offset += data.length;
        objects.set(s.path, data);
      }
      return new Response(mode.refusalBody, {
        status: mode.refusalStatus,
        headers: {
          ...headers,
          'content-type': mode.refusalBody.startsWith('{')
            ? 'application/json'
            : 'text/plain',
        },
      });
    }
    assert.ok(
      data.equals(old ? Buffer.alloc(6291456, 0x43) : Buffer.from('P')) ||
        (mode.stillWorks && data.equals(Buffer.from('P'))),
    );
    s.offset += data.length;
    if (s.offset === s.length) objects.set(s.path, data);
    return new Response(null, {
      status: 204,
      headers: { ...headers, 'upload-offset': String(s.offset) },
    });
  };
  const factory = (raw: unknown = c) =>
    new SupabaseSignedResumableUploadProof(
      raw,
      { control, gateway },
      transport,
    );
  const retain: RetainSignedResumableCredential = async (v, signal) => {
    signal.throwIfAborted();
    assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0);
    saved = { reference: randomUUID(), token: v.token, location: v.location };
    return {
      kind: 'SIGNED_RESUMABLE_CREDENTIAL_PIN_V1',
      reference: saved.reference,
      custodyDigest: custody,
      versionId: 'synthetic-original-version',
      sha256: '8'.repeat(64),
      byteLength: 1024,
      tokenSha256: v.tokenSha256,
      locationSha256: v.locationSha256,
    };
  };
  return {
    config: c,
    custody,
    factory,
    retain,
    calls,
    mode,
    sessions,
    objects,
    get saved() {
      assert.ok(saved);
      return saved;
    },
  };
}
