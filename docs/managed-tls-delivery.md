# Managed TLS secret-file delivery

This optional startup path converts a service-specific provider secret file into
fresh node-owned protected runtime files. It does not issue, upload, rotate or
revoke certificates, activate a provider or establish independent key custody.
The managed image and mesh binding are prerequisites.

## Selection and startup ordering

Set `CHARITYPILOT_MANAGED_TLS_DELIVERY=render-secret-file-v1` only on the selected
image-backed service. Other values, including empty, refuse. Do not also supply
that service's protected TLS directory variables: conflicting delivery paths
refuse rather than overwrite an operator path.

The normal API `dist/start.js`, web `server.mjs` and gateway `start.mjs` stage
material before starting their application listener. API and web require their
fixed enabled root-owned image pin. Gateway passes its validated immutable build
pin after normal binding validation. Source, canonical mesh JSON/fingerprint,
provider, production mode, exact service ID/type and port must all match.
The scheduler receives no mesh listener/client credential through this path.

Without the selector the existing protected-directory path remains available.
An enabled image with missing configuration still refuses; this does not provide
an alternate way to enable a legacy disabled image.

## Provider input contract

The fixed input is `/etc/secrets/charitypilot-<service>-tls.json`, where service is
exactly gateway, api or web. There is no environment-selected input filename.
Require a canonical non-symlink root-owned parent without group/other write,
a held no-follow directory descriptor, and a root-owned group1000 file of exactly
0440 mode. Runtime must be non-root Linux in primary group1000. Refuse links,
nonregular/empty/oversized files, changed descriptor state and invalid UTF-8.

This mode/ownership contract must be checked on the actual provider mount before
activation; documentation about access alone does not prove it. Do not relax
runtime protection to accommodate a different mount. Prepare another reviewed
delivery mechanism if the inspected provider cannot meet this contract.

The canonical JSON ends with one newline and has fields in this order:

```text
format=1, service, meshSha256, issuerCertPem
[serverCertPem, serverKeyPem]  // api and web only
[clientCertPem, clientKeyPem]  // gateway and web only
```

No other fields are accepted. The JSON is bounded to98304 bytes; each PEM/key is
individually bounded by the identity validator. Require a single certificate or
unencrypted private-key PEM block per field; appended keys/certificates or other
text refuse before staging. The shared parser also protects direct API, web and
gateway material paths. The issuer must be the current
pinned self-signed CA. Each service receives only its own server/client keys,
with exact pinned leaf, intended usage, private-key match and server SAN checks.
The CA private key must never appear in these bundles or service containers.
A bundle from another service or mesh cannot be reused.

## Protected staging and cleanup

Validate the entire bundle before creating any runtime directory. Create a fresh
`/tmp/charitypilot-managed-tls-*` directory, separate0700 server/client directories
and0400 node-owned issuer/certificate/key files. Exclusive no-follow creation
prevents overwrite. Re-read them through the protected runtime reader before
publishing their directory variables to the process. Partial staging cleans up
owned files and fails without starting an application. Errors are generic and
carry neither provider input nor key material.

Exit cleanup targets only the created directory/files with their recorded
filesystem identities, with no recursive removal. The provider source is never
modified or deleted by the application. A killed host or filesystem remanence is
not proof of key erasure. Rotation/recovery must exclude old keys/issuers through
a separate authority and deployment procedure.

The original provider file remains group-readable. Copying it does not remove
that access or establish independent custody. Before deployment, demonstrate
per-service/container isolation, permitted group membership/processes, provider
administrative access, encrypted storage/delivery and accountable key management.
Never distribute all services' keys in a shared environment-group bundle.

## Packaging and proof

Only non-secret public origins/source/fingerprints enter image builds. Images
are built independently and deployed by exact digest. Explicit Docker context
deny rules exclude the three bundle filenames, including provider-injected root
context files; do not add secret build arguments or secret COPY instructions.
The isolated E2E context lists the helper and its declaration explicitly.

`test:managed-tls-delivery` validates all three bundle shapes, foreign identities,
noncanonical inputs and invalid UTF-8. The native gateway test creates synthetic
root/group1000 input mounts in hardened local containers and exercises actual
startup staging for gateway, compiled Next and the compiled API loader. It also
checks source permission/link refusals, protected output modes and owned cleanup.
The API routes remain synthetic. This is not an actual Render mount, full
production business boot, real issuance or provider/host-loss demonstration.

Source checked16 October2026: [Render Docker secrets](https://render.com/docs/docker-secrets)
documents runtime `/etc/secrets` access, group1000, and secret files being copied
into Docker build contexts. Those facts motivate the explicit input inspection,
separate protected staging and build exclusions above; they do not establish
that an uninspected live mount satisfies this contract.
