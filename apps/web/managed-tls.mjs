import {isManagedProxyClaim} from '../../packages/shared/runtime/managed-application-headers.mjs';
import { createServer, request as httpsRequest, Agent } from "node:https";
import { TLSSocket, checkServerIdentity } from "node:tls";
import { readManagedServiceImagePin } from "../../packages/shared/runtime/managed-service-image-pin.mjs";
import { createManagedServiceMeshBinding } from "../../packages/shared/runtime/managed-service-mesh.mjs";
import { readProtectedTlsMaterial } from "../../packages/shared/runtime/protected-tls-material.mjs";
import {
  validateManagedTlsIdentity,
  tlsCertificateDigest,
  tlsCertificateIsCurrent,
} from "../../packages/shared/runtime/managed-tls-identity.mjs";
const refused = () => new Error("Managed web TLS configuration refused");
export function hasManagedWebTlsSettings(env) {
  return (
    env.CHARITYPILOT_MANAGED_PROVIDER !== undefined ||
    env.CHARITYPILOT_MANAGED_WEB_BINDING !== undefined ||
    env.CHARITYPILOT_MANAGED_WEB_TLS_DIRECTORY !== undefined ||
    env.CHARITYPILOT_MANAGED_WEB_API_TLS_DIRECTORY !== undefined ||
    Boolean(env.NEXT_PUBLIC_CHARITYPILOT_MANAGED_WEB_BINDING_SHA256)
  );
}
export function resolveManagedWebContext(env, pin) {
  try {
    const raw = env.CHARITYPILOT_MANAGED_WEB_BINDING;
    if (typeof raw !== "string" || Buffer.byteLength(raw) > 8192)
      throw refused();
    const binding = createManagedServiceMeshBinding(JSON.parse(raw)),
      r = binding.record;
    if (
      raw !== binding.json ||
      pin?.format !== 1 ||
      binding.sha256 !== pin.bindingSha256 ||
      r.sourceSha !== pin.sourceSha ||
      env.NODE_ENV !== "production" ||
      env.PORT !== "3003" ||
      env.CHARITYPILOT_MANAGED_PROVIDER !== "render" ||
      env.NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE !== "public-production" ||
      env.NEXT_PUBLIC_CHARITYPILOT_E2E_MODE ||
      env.CHARITYPILOT_E2E_MODE ||
      (env.CHARITYPILOT_DEPLOYMENT_MODE &&
        env.CHARITYPILOT_DEPLOYMENT_MODE !== "production") ||
      env.RENDER_SERVICE_TYPE !== "pserv" ||
      env.RENDER_SERVICE_ID !== r.webServiceId ||
      env.CHARITYPILOT_BUILD_COMMIT !== r.sourceSha ||
      env.NEXT_PUBLIC_API_URL !== r.publicOrigin ||
      env.NEXT_PUBLIC_CHARITYPILOT_CANONICAL_API_ORIGIN !== r.publicOrigin ||
      env.NEXT_PUBLIC_CHARITYPILOT_MANAGED_WEB_BINDING_SHA256 !==
        binding.sha256 ||
      env.CHARITYPILOT_INTERNAL_API_URL !== r.apiOrigin
    )
      throw refused();
    return r;
  } catch {
    throw refused();
  }
}
export function createManagedWebHttpsServer(env, pin, material, handler) {
  const r = resolveManagedWebContext(env, pin),
    identity = validateManagedTlsIdentity(
      material,
      r.issuerCertSha256,
      r.webCertSha256,
      "server",
      new URL(r.webOrigin).hostname,
    );
  return createServer(
    {
      key: material.keyPem,
      cert: material.certPem,
      ca: material.issuerCertPem,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      handshakeTimeout: 5000,
    },
    (req, res) => {
      const socket = req.socket,
        peer =
          socket instanceof TLSSocket
            ? socket.getPeerX509Certificate()
            : undefined;
      if (
        !(socket instanceof TLSSocket) ||
        !socket.authorized ||
        socket.isSessionReused() ||
        !peer ||
        peer.ca ||
        !peer.keyUsage?.includes("1.3.6.1.5.5.7.3.2") ||
        !tlsCertificateIsCurrent(identity.issuer) ||
        !tlsCertificateIsCurrent(identity.leaf) ||
        !tlsCertificateIsCurrent(peer) ||
        tlsCertificateDigest(peer) !== r.gatewayClientCertSha256
      ) {
        res.writeHead(403, { "Cache-Control": "no-store" });
        res.end("Request refused");
        return;
      }
      if (req.headers.host !== new URL(r.publicOrigin).host) {
        res.writeHead(404, { "Cache-Control": "no-store" });
        res.end("Not found");
        return;
      }
      for (const key of Object.keys(req.headers))
        if (
          isManagedProxyClaim(key)
        )
          delete req.headers[key];
      handler(req, res);
    },
  );
}
export function loadManagedWebTls(env = process.env) {
  try {
    const pin = readManagedServiceImagePin(
      "web",
      hasManagedWebTlsSettings(env),
    );
    if (!pin) return null;
    const record = resolveManagedWebContext(env, pin);
    const files = readProtectedTlsMaterial(
      env.CHARITYPILOT_MANAGED_WEB_TLS_DIRECTORY,
      ["issuer.pem", "server.pem", "server.key"],
    );
    const material = {
      issuerCertPem: files["issuer.pem"],
      certPem: files["server.pem"],
      keyPem: files["server.key"],
    };
    validateManagedTlsIdentity(
      material,
      record.issuerCertSha256,
      record.webCertSha256,
      "server",
      new URL(record.webOrigin).hostname,
    );
    return (handler) =>
      createManagedWebHttpsServer(env, pin, material, handler);
  } catch {
    throw refused();
  }
}
let agent, agentBinding;
export function closeManagedWebClients() {
  agent?.destroy();
  agent = undefined;
  agentBinding = undefined;
}
export async function managedWebAuthMe(env, pin, cookie, signal) {
  try {
    const r = resolveManagedWebContext(env, pin),
      files = readProtectedTlsMaterial(
        env.CHARITYPILOT_MANAGED_WEB_API_TLS_DIRECTORY,
        ["issuer.pem", "client.pem", "client.key"],
      );
    const material = {
      issuerCertPem: files["issuer.pem"],
      certPem: files["client.pem"],
      keyPem: files["client.key"],
    };
    validateManagedTlsIdentity(
      material,
      r.issuerCertSha256,
      r.webClientCertSha256,
      "client",
    );
    if (agentBinding !== pin.bindingSha256) {
      closeManagedWebClients();
      agent = new Agent({
        keepAlive: true,
        maxCachedSessions: 0,
        maxSockets: 16,
        maxFreeSockets: 4,
        timeout: 10000,
      });
      agentBinding = pin.bindingSha256;
    }
    const deadline = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
      : AbortSignal.timeout(5000);
    return await new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      const q = httpsRequest(
        new URL("/api/v1/auth/me", r.apiOrigin),
        {
          method: "GET",
          headers: { Cookie: cookie },
          ca: material.issuerCertPem,
          cert: material.certPem,
          key: material.keyPem,
          servername: new URL(r.apiOrigin).hostname,
          rejectUnauthorized: true,
          minVersion: "TLSv1.3",
          maxVersion: "TLSv1.3",
          agent,
          signal: deadline,
          timeout: 5000,
          checkServerIdentity: (host, cert) =>
            checkServerIdentity(host, cert) ||
            (tlsCertificateDigest({ raw: cert.raw }) === r.apiCertSha256
              ? undefined
              : new Error("Managed API identity refused")),
        },
        (res) => {
          let bytes = 0;
          res.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > 65536) {
              done(null);
              res.destroy();
            }
          });
          res.on("error", () => done(null));
          res.on("end", () => {
            try {
              const headers = {};
              for (const key of [
                "retry-after",
                "x-charitypilot-mfa-enrolment-required",
              ])
                if (typeof res.headers[key] === "string")
                  headers[key] = res.headers[key];
              done(new Response(null, { status: res.statusCode, headers }));
            } catch {
              done(null);
            }
          });
        },
      );
      q.on("upgrade", (_, socket) => {
        socket.destroy();
        done(null);
      });
      q.on("error", () => done(null));
      q.on("timeout", () => {
        done(null);
        q.destroy();
      });
      q.end();
    });
  } catch {
    return null;
  }
}
