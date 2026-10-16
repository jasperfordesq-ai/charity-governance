# Managed API peer transport

Decision: use mutual TLS with exact certificate pins for managed internal API
connections. Private DNS, workspace network membership and forwarded headers
do not establish a service identity. This applies to the managed four-service
design, independently of existing private VM and personal-server profiles.

## Implemented boundary

`apps/api/src/services/managed-api-peer-transport.ts` supplies an actual Fastify
TLS server factory. Its first request hook is installed inside the factory;
callers cannot accidentally omit it by forgetting a separate registration.
The factory returns a server for subsequent ordinary application plugin/route
registration. It does not itself grant user or tenant permissions.

`createManagedApiPeerBinding` prepares a canonical17-field non-secret registry:

```text
format=1, provider=render, region=frankfurt
installationId, ownerId, environmentId, sourceSha, publicOrigin
gatewayServiceId, webServiceId, apiServiceId, schedulerServiceId
apiHostname
issuerCertSha256, apiCertSha256
gatewayClientCertSha256, webClientCertSha256
```

All four service IDs and all four certificate digests must be distinct. The API
hostname is a bounded stable `charitypilot-…-api-…` Render private hostname;
discovery endpoints and arbitrary public/IP destinations are refused. Registry
JSON must be canonical and at most8192bytes. Its SHA-256 uses the separate
`CHARITYPILOT_MANAGED_API_MTLS_V1` domain.

The constructor takes this JSON, a trusted image build pin/source SHA, runtime
production/Render/private-service identity and port3002, and protected issuer,
server-certificate and server-key PEM values. Source/service/build mismatches
refuse construction. The build argument must ultimately come from an immutable
image artifact, never from the same unverified runtime environment as the record.

Issuer and server certificates are bounded single-certificate inputs. The issuer
must be a current self-signed CA with its exact pinned DER digest. The server
leaf must be current, non-CA, signed by that issuer, match its private key and
digest, contain the server-auth usage and match the exact API DNS SAN. Subject
CN fallback and wildcard hostname matching are disabled. Key material is bounded
and never included in errors, logs or the public record.

The actual server requires TLS1.3 and a client certificate, rejects an untrusted
chain during handshake and has a bounded handshake timeout. The hook additionally
requires an authorised real TLS socket, a present current non-CA client leaf
with client-auth usage, and an exact gateway or web DER fingerprint. Resumed
sessions are refused; clients must disable session caching and use a full
handshake on new connections. Ordinary HTTP keepalive on a validated connection
remains available. Issuer/server/peer validity is checked again on each request.

- The gateway certificate may reach ordinary application routes, which must
  still perform their existing user, tenant and action checks.
- The web certificate may only make the exact `GET /api/v1/auth/me` request.
  Other paths, query variants, trailing slashes and methods are refused before
  an application handler.
- Refusal returns a generic no-store403 without certificate or role details.
- Proxy trust is always false. Forwarded, real-IP, Cloudflare and CharityPilot
  metadata claims are removed. Cookies, auth credentials and browser Origin
  remain for ordinary application controls. The socket address is a service
  peer address, not a verified end-user address.

The exported role accessor uses private request-object state populated only by
the certificate hook; request headers cannot manufacture that role.

## Proof and remaining integration

The API test suite generates disposable synthetic certificates with OpenSSL
and tests actual loopback Fastify/Node TLS sockets. It exercises legitimate
gateway/web requests, TLS1.3, preserved application credentials, stripped forged
metadata, web scope, missing/foreign/unlisted same-issuer peers, TLS1.2 refusal,
plaintext refusal, actual session resumption refusal, certificate material that
expires after startup, build/service/key mismatches, and independently pinned
leaves with wrong SAN or certificate usage. Temporary key files are synthetic,
stay outside the repository and are removed only from the verified fixture root.

**Not activated:** the normal API entry point still uses its existing transport.
Immutable API image-pin loading, protected key provisioning/custody, strict
production environment integration, gateway HTTPS/client certificates, web TLS
and API-client transport, record parity, rotation/revocation and the joined
browser-to-application flow remain required. The previous HTTP-only gateway/web
bindings are not sufficient for the chosen managed activation contract. Do not
turn them into an activated deployment by adding broad trusted proxy ranges.

Certificate possession is not proof of which provider process holds the key.
Provider identity/IAM/environment isolation and actual key custody still need
independent evidence. Verified end-user client-address handling remains open;
service socket addresses cannot close that requirement. No provider resource,
real certificate, key transfer or live API setting is changed by these tests.

References: [Node22 TLS](https://nodejs.org/docs/latest-v22.x/api/tls.html),
[Node22 X509](https://nodejs.org/docs/latest-v22.x/api/crypto.html#class-x509certificate),
[Render private networking](https://render.com/docs/private-network).
