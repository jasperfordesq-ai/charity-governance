# Managed service mesh binding

Format2 consolidates the managed gateway and API configuration into one
canonical record and fingerprint. It replaces their incompatible prototype
records. No deployed managed environment is migrated automatically. Existing
unconfigured private/public profiles continue using their established paths.

`packages/shared/runtime/managed-service-mesh.mjs` is the single parser/preparer.
The gateway and API preparation exports delegate to it. Its21 exact fields are:

```text
format=2, provider=render, region=frankfurt
installationId, ownerId, environmentId, sourceSha, publicOrigin
gatewayServiceId, webServiceId, apiServiceId, schedulerServiceId
apiServiceName, apiOrigin, webServiceName, webOrigin
issuerCertSha256, apiCertSha256, webCertSha256
gatewayClientCertSha256, webClientCertSha256
```

All four service IDs and five certificate DER digests must differ. Both upstream
origins are exact HTTPS addresses on bounded stable Render hostnames, API3002
and web3003. HTTP, IP/public/discovery targets, credentials, paths, fragments,
unknown fields and ambiguous identities are refused. Canonical field ordering
and the `CHARITYPILOT_MANAGED_SERVICE_MESH_V2` SHA-256 domain make one fingerprint
available to each image. Source SHA, provider inventory and certificate material
must be reconciled by the trusted deployment controller before building images.
Image digests are bound separately after the build, avoiding a circular hash.

The API currently consumes the record through its fixed image-pin/protected-file
loader. The gateway consumes the same record through its build pin and protected
client certificate loader. The private Next server/client integration remains
open; the older web V1/HTTP scaffold is not an activation substitute.

## Shared protected material reader

`protected-tls-material.mjs` provides the same Linux descriptor checks to API
and gateway: canonical absolute directory outside the application root, current
UID0700 directory, current UID0400 single-link regular files, bounded stable
reads, and no-follow/nonblocking file opens through a held directory descriptor.
Each service requests only its fixed filenames. Actual Linux tests cover these
checks; they do not establish how a provider will deliver real key material.

## Proof boundaries

The native gateway test builds the real gateway image, stages synthetic protected
material in isolated containers and reaches the actual compiled API runtime
loader/TLS factory through Caddy. The API has synthetic routes. A separate web
TLS fixture stands in for Next. This verifies the gateway/API transport and
positive protected loader path, not a full production application boot.

Caddy validates the explicit CA and exact upstream hostname and presents its
validated, pinned gateway client certificate. The API pins its own server leaf
at startup and independently pins inbound client leaves. Stock Caddy does not
compare the upstream leaf DER digest itself; it uses CA/name verification.
Issuer custody and complete revocation/rotation, including excluding old issuers
for replacement/recovery, remain required. Certificate possession is not an
attestation of the provider process or running image.

The API server requires TLS1.3; the positive Caddy/API and synthetic web tests
negotiate TLS1.3. This is not a claim that stock Caddy exposes a separate TLS1.3
client-minimum setting. Gateway health remains process-only. End-user address
verification, full Next/API/business-provider boot, actual image/provider/key
custody and independent host-loss/reopening evidence remain open.

References: [Caddy proxy TLS options](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy),
[pinned Caddy2.11.4 transport implementation](https://github.com/caddyserver/caddy/blob/v2.11.4/modules/caddyhttp/reverseproxy/httptransport.go),
[Render private networking](https://render.com/docs/private-network).
