import Fastify, {
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { createSecureContext, TLSSocket } from 'node:tls';

const fields = [
  'format',
  'provider',
  'region',
  'installationId',
  'ownerId',
  'environmentId',
  'sourceSha',
  'publicOrigin',
  'gatewayServiceId',
  'webServiceId',
  'apiServiceId',
  'schedulerServiceId',
  'apiHostname',
  'issuerCertSha256',
  'apiCertSha256',
  'gatewayClientCertSha256',
  'webClientCertSha256',
] as const;
type PeerRole = 'gateway' | 'web';
const roles = new WeakMap<FastifyRequest, PeerRole>();
const refusal = () => new Error('Managed API peer transport refused');
const digest = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');

export function createManagedApiPeerBinding(raw: unknown) {
  try {
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      Object.keys(raw).sort().join('|') !== [...fields].sort().join('|')
    )
      throw refusal();
    const value = raw as Record<string, unknown>;
    const text = (key: (typeof fields)[number], pattern: RegExp) => {
      const v = value[key];
      if (typeof v !== 'string' || !pattern.test(v)) throw refusal();
      return v;
    };
    if (
      value.format !== 1 ||
      value.provider !== 'render' ||
      value.region !== 'frankfurt'
    )
      throw refusal();
    const record = {
      format: 1,
      provider: 'render',
      region: 'frankfurt',
      installationId: text('installationId', /^[A-Za-z0-9_-]{1,120}$/),
      ownerId: text('ownerId', /^[a-z][a-z0-9-]{1,99}$/),
      environmentId: text('environmentId', /^[a-z][a-z0-9-]{1,99}$/),
      sourceSha: text('sourceSha', /^[a-f0-9]{40}$/),
      publicOrigin: text('publicOrigin', /^.{1,512}$/),
      gatewayServiceId: text('gatewayServiceId', /^srv-[a-z0-9]{20}$/),
      webServiceId: text('webServiceId', /^srv-[a-z0-9]{20}$/),
      apiServiceId: text('apiServiceId', /^srv-[a-z0-9]{20}$/),
      schedulerServiceId: text('schedulerServiceId', /^srv-[a-z0-9]{20}$/),
      apiHostname: text(
        'apiHostname',
        /^charitypilot(?:-[a-z0-9]+)*-api-[a-z0-9]{4,20}$/,
      ),
      issuerCertSha256: text('issuerCertSha256', /^[a-f0-9]{64}$/),
      apiCertSha256: text('apiCertSha256', /^[a-f0-9]{64}$/),
      gatewayClientCertSha256: text(
        'gatewayClientCertSha256',
        /^[a-f0-9]{64}$/,
      ),
      webClientCertSha256: text('webClientCertSha256', /^[a-f0-9]{64}$/),
    };
    const front = new URL(record.publicOrigin);
    if (
      front.protocol !== 'https:' ||
      front.origin !== record.publicOrigin ||
      front.username ||
      front.password ||
      front.port ||
      !front.hostname.includes('.') ||
      !/^[a-z0-9.-]+$/.test(front.hostname) ||
      /^[\d.]+$/.test(front.hostname) ||
      record.apiHostname.length > 63 ||
      record.apiHostname.endsWith('-discovery') ||
      new Set([
        record.gatewayServiceId,
        record.webServiceId,
        record.apiServiceId,
        record.schedulerServiceId,
      ]).size !== 4 ||
      new Set([
        record.issuerCertSha256,
        record.apiCertSha256,
        record.gatewayClientCertSha256,
        record.webClientCertSha256,
      ]).size !== 4
    )
      throw refusal();
    const json = JSON.stringify(record);
    return {
      record: Object.freeze(record),
      json,
      sha256: digest('CHARITYPILOT_MANAGED_API_MTLS_V1\n' + json),
    };
  } catch {
    throw refusal();
  }
}

export type ManagedApiPeerInput = {
  recordJson: string;
  build: { sourceSha: string; bindingSha256: string };
  runtime: {
    nodeEnv: string;
    provider: string;
    deploymentMode: string;
    serviceType: string;
    serviceId: string;
    sourceSha: string;
    port: string;
    e2eMode?: string;
  };
  issuerCertPem: string;
  serverCertPem: string;
  serverKeyPem: string;
};
function certificate(pem: string) {
  if (
    typeof pem !== 'string' ||
    Buffer.byteLength(pem) > 16384 ||
    (pem.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length !== 1 ||
    (pem.match(/-----END CERTIFICATE-----/g) ?? []).length !== 1
  )
    throw refusal();
  return new X509Certificate(pem);
}
function current(cert: X509Certificate) {
  const now = Date.now(),
    start = Date.parse(cert.validFrom),
    end = Date.parse(cert.validTo);
  return (
    Number.isFinite(start) && Number.isFinite(end) && start <= now && now < end
  );
}

/** Actual Fastify TLS server factory. No environment loader or production route
 * activation is supplied here: the trusted image controller must provide the
 * immutable build pin and protected, reviewed key material. Never pass request
 * values or an unverified environment fingerprint as `build`.
 *
 * TLS peer identity is additional to application user/tenant authorization.
 * Forwarded addresses remain untrusted and never become end-user evidence. */
export function createManagedApiPeerServer(
  input: ManagedApiPeerInput,
  logger: FastifyServerOptions['logger'] = false,
) {
  try {
    if (
      typeof input.recordJson !== 'string' ||
      Buffer.byteLength(input.recordJson) > 8192
    )
      throw refusal();
    const binding = createManagedApiPeerBinding(JSON.parse(input.recordJson)),
      r = binding.record,
      env = input.runtime;
    if (
      binding.json !== input.recordJson ||
      binding.sha256 !== input.build.bindingSha256 ||
      r.sourceSha !== input.build.sourceSha ||
      env.nodeEnv !== 'production' ||
      env.provider !== 'render' ||
      env.deploymentMode !== 'production' ||
      env.serviceType !== 'pserv' ||
      env.serviceId !== r.apiServiceId ||
      env.sourceSha !== r.sourceSha ||
      env.port !== '3002' ||
      env.e2eMode
    )
      throw refusal();
    const issuer = certificate(input.issuerCertPem),
      leaf = certificate(input.serverCertPem);
    if (
      typeof input.serverKeyPem !== 'string' ||
      Buffer.byteLength(input.serverKeyPem) > 16384 ||
      !issuer.ca ||
      !issuer.checkIssued(issuer) ||
      !issuer.verify(issuer.publicKey) ||
      leaf.ca ||
      !current(issuer) ||
      !current(leaf) ||
      digest(issuer.raw) !== r.issuerCertSha256 ||
      digest(leaf.raw) !== r.apiCertSha256 ||
      !leaf.checkIssued(issuer) ||
      !leaf.verify(issuer.publicKey) ||
      !leaf.checkPrivateKey(createPrivateKey(input.serverKeyPem)) ||
      leaf.checkHost(r.apiHostname, {
        subject: 'never',
        wildcards: false,
        partialWildcards: false,
        multiLabelWildcards: false,
      }) !== r.apiHostname ||
      !leaf.keyUsage?.includes('1.3.6.1.5.5.7.3.1')
    )
      throw refusal();
    const https = {
      key: input.serverKeyPem,
      cert: input.serverCertPem,
      ca: input.issuerCertPem,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3' as const,
      maxVersion: 'TLSv1.3' as const,
      handshakeTimeout: 5000,
    };
    // Fail before creating any listener if Node/OpenSSL rejects the material.
    createSecureContext(https);
    const app = Fastify({ logger, https, trustProxy: false });
    app.addHook('onRequest', async (request, reply) => {
      const socket = request.raw.socket;
      let role: PeerRole | undefined;
      if (
        current(issuer) &&
        current(leaf) &&
        socket instanceof TLSSocket &&
        socket.authorized &&
        !socket.isSessionReused()
      ) {
        const peer = socket.getPeerX509Certificate();
        if (
          peer &&
          !peer.ca &&
          current(peer) &&
          peer.keyUsage?.includes('1.3.6.1.5.5.7.3.2')
        ) {
          const fingerprint = digest(peer.raw);
          if (fingerprint === r.gatewayClientCertSha256) role = 'gateway';
          else if (fingerprint === r.webClientCertSha256) role = 'web';
        }
      }
      if (
        !role ||
        (role === 'web' &&
          (request.method !== 'GET' || request.raw.url !== '/api/v1/auth/me'))
      ) {
        return reply
          .code(403)
          .header('Cache-Control', 'no-store')
          .send({ error: 'Request refused', code: 'MANAGED_PEER_REFUSED' });
      }
      roles.set(request, role);
      for (const key of Object.keys(request.headers)) {
        if (
          key === 'forwarded' ||
          key.startsWith('x-forwarded-') ||
          key === 'x-real-ip' ||
          key === 'cf-connecting-ip' ||
          key === 'true-client-ip' ||
          key.startsWith('x-charitypilot-')
        )
          delete request.headers[key];
      }
    });
    return app;
  } catch {
    throw refusal();
  }
}

export function managedApiPeerRole(
  request: FastifyRequest,
): PeerRole | undefined {
  return roles.get(request);
}
