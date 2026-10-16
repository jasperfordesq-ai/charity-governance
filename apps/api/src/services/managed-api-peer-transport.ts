import {
  parseManagedCertificate,
  parseManagedPrivateKey,
} from '../../../../packages/shared/runtime/managed-tls-identity.mjs';
import Fastify, {
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import { createHash, X509Certificate } from 'node:crypto';
import { createSecureContext, TLSSocket } from 'node:tls';

import { createManagedServiceMeshBinding } from '../../../../packages/shared/runtime/managed-service-mesh.mjs';

export const createManagedApiPeerBinding = createManagedServiceMeshBinding;
type PeerRole = 'gateway' | 'web';
const roles = new WeakMap<FastifyRequest, PeerRole>();
const refusal = () => new Error('Managed API peer transport refused');
const digest = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');

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
const certificate = parseManagedCertificate;

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
      !leaf.checkPrivateKey(parseManagedPrivateKey(input.serverKeyPem)) ||
      leaf.checkHost(new URL(r.apiOrigin).hostname, {
        subject: 'never',
        wildcards: false,
        partialWildcards: false,
        multiLabelWildcards: false,
      }) !== new URL(r.apiOrigin).hostname ||
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
