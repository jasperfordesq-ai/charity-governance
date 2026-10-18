# Initial managed service identity bootstrap

The permanent managed mesh binds four provider-assigned service IDs, private
hostnames and certificate pins before final images are built. This separate,
synthetic-only bootstrap obtains initial identities without starting an
unconfigured application. It does not weaken the permanent mesh or the private
personal-server profile.

Render's [create-service API](https://api-docs.render.com/reference/create-service)
has no suspended-at-creation field in the OpenAPI snapshot reviewed 18 October
2026. An [image-backed creation starts an initial deployment](https://render.com/docs/deploying-an-image).
Disabling automatic deployments does not suppress that initial deployment.

## Inert image and request review

`deploy/managed-bootstrap/Dockerfile` contains only Node and explicit bootstrap
helpers. Its Dockerfile-specific context allowlist excludes application code,
dependencies, source-control state, documents and credentials. It runs as `node`.
A root-owned, single-link, mode0444 pin at
`/opt/charitypilot/managed-bootstrap-build.json` binds source and bootstrap digest.
The pin is read without symlink following; caller environment hashes cannot
replace it. This path/domain is separate from permanent API/web/gateway pins.

The strict format1 binding has exactly `provider: render`, `region: frankfurt`,
`purpose: SYNTHETIC_IDENTITY_ONLY`, UUIDv4 `bootstrapId`, `installationId`,
`ownerId`, `environmentId`, forty-hex `sourceSha`, canonical UTC `expiresAt` and
four role names under `names`. Expiry must be future and at most one hour away.
The canonical binding uses domain `CHARITYPILOT_MANAGED_IDENTITY_BOOTSTRAP_V1`.
It contains no service IDs, private hosts, certificates or secrets.

Compile a review artifact with:

```sh
node scripts/managed-bootstrap-plan.mjs --stdin < /protected/operator/bootstrap-review.json
```

Input is bounded8KiB UTF-8, with exactly `format: 1`, `binding` and `image`.
Image metadata has `url`, `sourceSha`, `bindingSha256`, `platform: linux/amd64`;
the image URL must use the canonical owner's GHCR namespace and nonzero digest.
The compiler emits the build arguments and four create-request bodies, never HTTP
or a provider token. These are public gateway, private web/API and singleton worker,
Frankfurt/1c-2g, automatic deployments off and previews off. No registry credential
is created or supplied. Image metadata consistency does not prove provenance.

The runtime requires provider-shaped service ID/type and matching source, role,
port and canonical binding. A provider-shaped ID is not an independently verified
identity. Environment credentials, known application capabilities and Node/loader
preloads refuse startup. A shell entrypoint refuses Node preload options before
Node starts; runtime checks alone could run after a preload. Host/control-plane
integrity is still an external prerequisite. No application or outbound client is present.

Only exact `GET /bootstrap-health` returns200 and explicitly reports
`applicationReady: false`. Business routes, other methods and query variants
return503. No request values, cookies, redirects or authentication are emitted.
The worker has no listener or job executor. A fixed timer terminates the process
by its initial lifetime, even if the wall clock moves backwards. Expiry is not a
spending limit: provider restarts/resource billing require separate reconciliation
and suspension. Public HTTP health proves only an inert placeholder is running.

## Required before real use

This is not yet a supported provisioning executor. No creation, spending, terms,
registry publication/access grant, real data or application secret upload is
authorised by a compiled artifact. The operator must first review the actual
account, plan, isolated environment, image custody and approved activation scope.

Creation must preserve each original returned resource/deployment receipt before
continuing. A lost creation acknowledgement remains unknown: do not retry or
adopt resources by a matching name, label or reconstructed receipt. Reconcile
and suspend exactly known resources before final configuration. Actual private
DNS, identities, environment isolation, image provenance, inherited configuration,
controller exclusion and stored/runtime secret delivery need provider evidence.
Then build the final mesh/TLS images and use the existing provider readback and
database compatibility procedures. Initial placeholder health is not release,
maintenance, recovery or whole-backend acceptance.

## Verification

`node --test scripts/managed-bootstrap.test.mjs` exercises binding substitution,
expiry, credential/preload refusal, compiler requests, bounded CLI and real local
HTTP responses. The production-check test entry includes these tests.

The explicit native fixture runs only in a clean canonical Linux checkout as a
non-root operator, with the verified local Unix Docker daemon:

```sh
node scripts/managed-bootstrap-image-proof.mjs <exact-source-sha>
```

It builds a local image without build network access, runs four synthetic roles
with no network/host port/mount, verifies the baked pin and requests over container
loopback, and checks startup refusals. Cleanup uses original returned IDs and
matching original image/job custody, never label adoption or a resource sweep.
No image is published. Native/container success cannot prove Render compatibility,
actual provider permission boundaries or independent physical-host recovery.
