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

`createManagedApiPeerBinding` delegates to the canonical21-field format2
[shared service mesh record](managed-service-mesh.md):

```text
format=2, provider=render, region=frankfurt
installationId, ownerId, environmentId, sourceSha, publicOrigin
gatewayServiceId, webServiceId, apiServiceId, schedulerServiceId
apiServiceName, apiOrigin, webServiceName, webOrigin
issuerCertSha256, apiCertSha256, webCertSha256
gatewayClientCertSha256, webClientCertSha256
```

All four service IDs and all five certificate digests must be distinct. The API
hostname is a bounded stable `charitypilot-…-api-…` Render private hostname;
discovery endpoints and arbitrary public/IP destinations are refused. Registry
JSON must be canonical and at most8192bytes. Its SHA-256 uses the separate
`CHARITYPILOT_MANAGED_SERVICE_MESH_V2` domain. The API hostname is derived from
the exact HTTPS API origin. Image-pin metadata remains format1 independently
of the service record's format2. Old enabled V1 records/images require a fresh
reviewed record and image build; there is no automatic reinterpretation.

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

## Runtime entry and image binding

The normal API entry point now conditionally calls `loadManagedApiRuntime`
before validating the full environment and registering application plugins.
With no managed selector it retains the existing transport and proxy checks.
Any provider/API-binding/TLS-directory selector, including an empty value,
opts into the managed loader; failure never falls back to HTTP.

The API image build accepts optional
`CHARITYPILOT_MANAGED_API_PEER_BINDING_SHA256`. With a full source SHA and binding
hash it generates root-owned0444 metadata at the fixed
`/opt/charitypilot/managed-api-build.json` path before switching to `node`.
Builds without this argument generate an explicit disabled pin. An environment
hash cannot enable such an image. The source build context excludes this file.
The loader requires non-root Linux, a root-owned non-shared-writable parent,
a non-linked root-owned0444 regular file, bounded stable descriptor reads and
canonical metadata. CI also checks actual image ownership and write refusal.

Supply runtime `CHARITYPILOT_MANAGED_API_PEER_BINDING` and
`CHARITYPILOT_MANAGED_API_TLS_DIRECTORY` alongside the existing Render/source
identity values. All four public frontend/browser/canonical web/API origin
variables must equal the bound public origin. `TRUSTED_PROXY_ADDRESSES` must be
unset or empty. In the TLS directory, `issuer.pem`, `server.pem` and `server.key`
must be current-user-owned0400 regular files in a current-user-owned0700
directory outside the application/source root. PEM/key files are also excluded
from source build contexts. The Linux loader rejects symlinked roots/children, hardlinks, shared
or writable files and oversized material. It opens children through a held
directory descriptor with no-follow/nonblocking flags and bounded stable reads.
Native Windows loading is unsupported for this Render mode; the existing
Windows personal-server path is separate and unaffected.

Only the configured TLS factory can mint the private server context used by
environment validation. That context must still match the exact environment;
an arbitrary object, stale context or selector alone cannot exempt proxy-IP
validation. Every other production check remains active, including database
TLS, secrets, origins and provider configuration. A lifecycle allowlist entry
explicitly permits this module to exclude appliance and disposable profiles;
behavioural feature code still uses capability axes.

The protected reader is shared with the gateway. Local tests cover configuration-only opt-in, metadata, forged/stale contexts
and remaining production gates. A pinned, isolated Linux container separately
tests the actual descriptor/ownership/mode/link/size checks from the Windows
host. These are component checks, not a full managed application boot.

The real gateway container now reaches this fixed-pin/protected-material loader
and TLS factory in a Linux fixture. Its API routes are synthetic; it does not
run the full production environment/provider boot. Gateway/API record parity
comes from the shared format2 parser and fingerprint.

**Not deployed or activation-ready:** real protected material provisioning and
custody, complete production image/application boot proof, actual provider/key
custody, rotation/revocation
and the joined browser-to-application flow remain required. Provider secret
mounts must be inspected: a shared-readable or symlinked mount does not satisfy
this contract. Prepare a protected delivery step rather than weakening the
reader. Previous HTTP-only gateway/web bindings are not sufficient for the
chosen managed activation contract. Do not add broad trusted proxy ranges.

Certificate possession is not proof of which provider process holds the key.
Provider identity/IAM/environment isolation and actual key custody still need
independent evidence. Verified end-user client-address handling remains open;
service socket addresses cannot close that requirement. No provider resource,
real certificate, key transfer or live API setting is changed by these tests.

References: [Node22 TLS](https://nodejs.org/docs/latest-v22.x/api/tls.html),
[Node22 X509](https://nodejs.org/docs/latest-v22.x/api/crypto.html#class-x509certificate),
[Render private networking](https://render.com/docs/private-network).


The private web now shares mesh V2 and implements protected server/client TLS;
its compiled Next image is part of the synthetic gateway integration test.
See [web transport](managed-web-api-binding.md). API/web enabled image pins cannot
be disabled by deleting runtime managed flags. Further provider/full business
boot evidence remains open as described above.


## Optional provider secret-file staging

The normal entry point supports the service-scoped
[TLS delivery contract](managed-tls-delivery.md). It validates the pinned bundle
before creating protected runtime directories. Direct protected-directory input
remains available when this delivery selector is absent. Actual provider mount
permissions, key custody, issuance and complete rotation/recovery evidence remain
required; synthetic staging is not evidence that those gates have passed.
