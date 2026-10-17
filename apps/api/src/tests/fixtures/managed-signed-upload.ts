import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mock } from 'node:test';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  KMSClient,
  GenerateDataKeyCommand,
  DecryptCommand,
} from '@aws-sdk/client-kms';
import jwt from 'jsonwebtoken';
import { ManagedSignedUploadEvidence } from '../../services/managed-signed-upload-evidence.js';
import {
  SupabaseSigningKeyControl,
  publicSigningKeyFingerprint,
} from '../../services/supabase-signing-key-control.js';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const pair = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
  old = pair(),
  current = pair();
const previousId = '55555555-5555-4555-8555-555555555555',
  currentId = '66666666-6666-4666-8666-666666666666';
const issuer = (p: ReturnType<typeof pair>, id: string) => {
  const publicJwk = p.publicKey.export({ format: 'jwk' });
  return {
    providerKeyId: id,
    tokenKid: id,
    algorithm: 'ES256',
    fingerprint: publicSigningKeyFingerprint('ES256', publicJwk),
    publicJwk,
  };
};
type Storage = {
  installationId: string;
  bucket: string;
  accountId: string;
  kmsKeyArn: string;
};
/** Actual default signed classes; only AWS/Storage/management transports are synthetic. */
export function managedSignedFixture(
  storage: Storage,
  client: S3Client,
  events: string[],
  control = {
    id: '11111111-1111-4111-8111-111111111111',
    secret: 'sb_secret_' + 'a'.repeat(40),
  },
) {
  const projectRef = 'abcdefghijklmnopqrst',
    credentials = { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' },
    gateway = {
      id: '77777777-7777-4777-8777-777777777777',
      secret: 'sb_publishable_' + 'g'.repeat(40),
    },
    registry = {
      installationId: storage.installationId,
      projectRef,
      bucket: 'charitypilot-recovery-signed-probes',
      providerRelease: {
        sourceSha: '7'.repeat(40),
        imageDigest: '8'.repeat(64),
      },
      control: { id: control.id, sha256: hash(control.secret) },
      gateway: { id: gateway.id, sha256: hash(gateway.secret) },
      previousIssuer: issuer(old, previousId),
      currentIssuer: issuer(current, currentId),
    },
    vaultStorage = {
      installationId: storage.installationId,
      bucket: storage.bucket,
      accountId: storage.accountId,
      storageKeyArn: storage.kmsKeyArn,
      dataKeyArn:
        'arn:aws:kms:eu-west-1:' +
        storage.accountId +
        ':key/88888888-8888-4888-8888-888888888888',
    },
    kms = new KMSClient({ region: 'eu-west-1', credentials }),
    wrapped = new Map<string, { key: Buffer; context: unknown }>(),
    objects = new Map<string, string>();
  let revoked = false,
    acceptOld = false,
    loseRevocationAck = false;
  const plaintext: Uint8Array[] = [];
  mock.method(
    kms,
    'send',
    async (command: GenerateDataKeyCommand | DecryptCommand) => {
      events.push(
        'signed-kms-' +
          (command instanceof GenerateDataKeyCommand ? 'generate' : 'decrypt'),
      );
      assert.equal(command.input.KeyId, vaultStorage.dataKeyArn);
      assert.equal(
        command.input.EncryptionContext?.installationId,
        storage.installationId,
      );
      assert.equal(
        command.input.EncryptionContext?.purpose,
        'charitypilot-signed-upload-credential-v1',
      );
      if (command instanceof GenerateDataKeyCommand) {
        const key = randomBytes(32),
          blob = randomBytes(48);
        wrapped.set(blob.toString('base64'), {
          key,
          context: structuredClone(command.input.EncryptionContext),
        });
        const p = Buffer.from(key);
        plaintext.push(p);
        return {
          KeyId: vaultStorage.dataKeyArn,
          Plaintext: p,
          CiphertextBlob: blob,
        };
      }
      const row = wrapped.get(
        Buffer.from(command.input.CiphertextBlob!).toString('base64'),
      )!;
      assert.deepEqual(command.input.EncryptionContext, row.context);
      const p = Buffer.from(row.key);
      plaintext.push(p);
      return {
        KeyId: vaultStorage.dataKeyArn,
        Plaintext: p,
        EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
      };
    },
  );
  const signingConfig = {
    installationId: storage.installationId,
    projectRef,
    organisationId: 'org-synthetic',
    region: 'eu-central-1',
    keys: [
      {
        id: previousId,
        algorithm: 'ES256',
        fingerprint: registry.previousIssuer.fingerprint,
        disposition: 'REVOKE_PREVIOUS',
      },
      {
        id: currentId,
        algorithm: 'ES256',
        fingerprint: registry.currentIssuer.fingerprint,
        disposition: 'RETAIN_CURRENT',
      },
    ],
  };
  const keyRow = (id: string) => ({
    id,
    algorithm: 'ES256',
    status:
      id === currentId ? 'in_use' : revoked ? 'revoked' : 'previously_used',
    public_jwk:
      id === currentId
        ? registry.currentIssuer.publicJwk
        : registry.previousIssuer.publicJwk,
    created_at: '2026-10-16T00:00:00Z',
    updated_at: '2026-10-17T00:00:00Z',
  });
  const management: typeof fetch = async (input, options) => {
    const u = new URL(String(input));
    assert.equal(u.origin, 'https://api.supabase.com');
    assert.equal(options?.redirect, 'error');
    events.push('signed-management-' + options?.method);
    if (options?.method === 'PATCH') {
      assert.ok(u.pathname.endsWith('/config/auth/signing-keys/' + previousId));
      assert.deepEqual(JSON.parse(String(options.body)), { status: 'revoked' });
      revoked = true;
      if (loseRevocationAck) throw new Error('synthetic committed signing-key ACK lost');
      return Response.json(keyRow(previousId));
    }
    assert.equal(options?.method, 'GET');
    if (u.pathname.endsWith('/config/auth/signing-keys'))
      return Response.json({ keys: [keyRow(previousId), keyRow(currentId)] });
    return Response.json({
      id: projectRef,
      ref: projectRef,
      organization_id: 'org-synthetic',
      region: 'eu-central-1',
      status: 'ACTIVE_HEALTHY',
    });
  };
  const transport: typeof fetch = async (input, options) => {
    const u = new URL(String(input)),
      method = options?.method,
      h = new Headers(options?.headers),
      headers = { date: new Date().toUTCString() };
    assert.equal(u.origin, 'https://' + projectRef + '.supabase.co');
    assert.equal(options?.redirect, 'error');
    events.push('signed-storage-' + method);
    if (u.pathname.includes('/bucket/'))
      return Response.json({ id: registry.bucket, public: false }, { headers });
    const prefix = '/storage/v1/object/';
    if (u.pathname.startsWith(prefix + 'upload/sign/')) {
      const path = u.pathname.slice((prefix + 'upload/sign/').length);
      if (method === 'POST') {
        assert.equal(h.get('apikey'), control.secret);
        const token = jwt.sign(
          { url: path, scope: 'upload', upsert: true },
          (revoked ? current : old).privateKey,
          {
            algorithm: 'ES256',
            keyid: revoked ? currentId : previousId,
            expiresIn: 7200,
          },
        );
        return Response.json(
          { url: '/object/upload/sign/' + path + '?token=' + token, token },
          { headers },
        );
      }
      assert.equal(method, 'PUT');
      assert.equal(h.get('apikey'), gateway.secret);
      const token = u.searchParams.get('token')!,
        kid = jwt.decode(token, { complete: true })!.header.kid;
      const payload = jwt.verify(
        token,
        (kid === previousId ? old : current).publicKey,
        { algorithms: ['ES256'] },
      ) as jwt.JwtPayload;
      assert.equal(payload.url, path);
      assert.equal(payload.scope, 'upload');
      if (revoked && kid === previousId && !acceptOld)
        return Response.json({ code: 'InvalidJWT' }, { status: 400, headers });
      objects.set(path, String(options?.body));
      return Response.json({ Key: path }, { headers });
    }
    const path = u.pathname.slice(prefix.length);
    assert.equal(h.get('apikey'), control.secret);
    if (method === 'GET')
      return objects.has(path)
        ? new Response(objects.get(path), {
            headers: {
              ...headers,
              'content-type': 'text/plain',
              'content-length': String(Buffer.byteLength(objects.get(path)!)),
            },
          })
        : new Response(null, { status: 404, headers });
    if (method === 'POST' && objects.has(path))
      return new Response(null, { status: 409, headers });
    assert.ok(method === 'POST' || method === 'PUT');
    objects.set(path, String(options?.body));
    return Response.json({ Key: path }, { headers });
  };
  const factory = () =>
    new ManagedSignedUploadEvidence(
      registry,
      { control, gateway },
      vaultStorage,
      storage,
      credentials,
      credentials,
      new SupabaseSigningKeyControl(
        signingConfig,
        'synthetic-management',
        management,
      ),
      transport,
      { vault: client, kms, evidence: client },
    );
  return {
    signResumableToken:(path:string,previous:boolean)=>jwt.sign({url:path,scope:'upload',upsert:true},(previous?old:current).privateKey,{algorithm:'ES256',keyid:previous?previousId:currentId,expiresIn:7200}),
    verifyResumableToken:(token:string)=>jwt.verify(token,jwt.decode(token,{complete:true})!.header.kid===previousId?old.publicKey:current.publicKey,{algorithms:['ES256']}) as jwt.JwtPayload,
    factory,
    objects,
    plaintext,
    registry,
    secrets: { control, gateway },
    vaultStorage,
    signingConfig,
    management,
    transport,
    kms,
    credentials,
    set acceptOld(value: boolean) {
      acceptOld = value;
    },
    set loseRevocationAck(value: boolean) { loseRevocationAck = value; },
    get revoked() {
      return revoked;
    },
    forceRevoked: () => {
      revoked = true;
    },
  };
}
