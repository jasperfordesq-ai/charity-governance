# Managed gateway implementation

The four-component managed design uses a dedicated public Caddy gateway,
private Next web, private API and singleton scheduler. The managed gateway is a
new opt-in image. It does not change either existing personal-server profile or
the deployed private VM.

## Build and runtime binding

`caddy/managed/config.mjs` exports `createGatewayBinding`. Prepare a reviewed
record using the canonical21-field
[format2 service mesh](managed-service-mesh.md), shared with the API. Both
upstreams require HTTPS at exact stable private hostnames, API3002 and web3003.
HTTP, unknown fields, unsafe origins, duplicate identities and noncanonical JSON
are refused. The old format1 HTTP prototype is no longer accepted.

The helper returns canonical JSON and the shared
`CHARITYPILOT_MANAGED_SERVICE_MESH_V2` SHA-256. Build `caddy/managed/Dockerfile` with
`CHARITYPILOT_BUILD_COMMIT` and `CHARITYPILOT_MANAGED_GATEWAY_BINDING_SHA256`.
The image contains an immutable build-pin file. Supply runtime:

- `CHARITYPILOT_MANAGED_PROVIDER=render`.
- `CHARITYPILOT_MANAGED_GATEWAY_BINDING`: exact canonical JSON, maximum8192bytes.
- `CHARITYPILOT_MANAGED_GATEWAY_TLS_DIRECTORY`: protected Linux material folder
  containing `issuer.pem`, `client.pem` and `client.key`.
- `CHARITYPILOT_BUILD_COMMIT`: the bound source SHA.
- Render read-only gateway `RENDER_SERVICE_ID` and `RENDER_SERVICE_TYPE=web`.
- `NODE_ENV=production`, `PORT=10000` (image defaults).

The trusted deployment controller must reconcile gateway/web records and actual
provider inventory and images; the helpers alone do not establish that trust.
A different service, source, record or compiled fingerprint refuses startup
before a listener is created. No unbound/default upstream is available.

The shared Linux reader enforces current-UID0700 directories outside the
application root and current-UID0400 regular, non-linked bounded files. Before
starting Caddy, Node verifies the pinned current self-signed issuer and pinned
current non-CA client leaf, its issuer/signature, client-auth usage and private
key match. Validated bytes are copied into private0400 snapshots in the process's
own temporary directory, so Caddy does not reopen changing delivery files.

The image pins Node and Caddy bases, installs no package at build time and copies
only explicit code. Caddy's binary bytes are recreated without inherited file
capabilities: port10000 needs no privileged bind. Retaining those capabilities
caused actual EPERM under the test's all-capabilities-dropped boundary.

Run as the `node` user with a read-only root, no new privileges, all capabilities
dropped and writable temporary storage. The Docker proof explicitly uses a
32MiB `/tmp` tmpfs with mode1777. Each process creates its own private temporary
directory and0600 Caddy configuration, forwards shutdown signals and removes
its own configuration and credential snapshots on exit. The image entry is now
`node caddy/managed/start.mjs`. Admin API, config persistence and automatic TLS
are disabled; this HTTP listener is intended behind Render's managed HTTPS edge.

Each private upstream uses explicit CA trust, client certificate/key and exact
TLS server name, with a bounded handshake. API client identity is independently
checked by the actual API peer hook. Stock Caddy uses CA/name verification for
the server; it does not compare the server leaf DER pin itself. See the shared
mesh proof limits and remaining issuer-custody/revocation requirements.

## Routes and metadata

Only the configured public Host reaches upstreams. `/api/v1` and `/api/v1/*`
retain their paths to the exact API address; other paths go to the exact web
address. Unknown hosts return404. The separate `/healthz` returns no-store
`gateway-process-only`; it proves neither API nor database readiness. Managed
deployment must independently check both upstreams before opening traffic.

Before proxying, remove incoming Forwarded, X-Forwarded-*, X-Real-IP,
CF-Connecting-IP, True-Client-IP and X-CharityPilot-* claims. Set upstream Host,
forwarded host and HTTPS scheme from the reviewed public origin. Forwarded-for
contains the direct socket peer only. This is often Render's load balancer,
**not a verified end-user address**. Caddy trusts no incoming proxy metadata.

Header removal happens before `reverse_proxy`. Putting a wildcard deletion and
replacement headers together in `header_up` deleted the replacement values in
the actual pinned Caddy runtime; the runtime test caught and corrected that.
Cookies, ordinary auth headers, paths, queries and bodies are preserved. This
does not replace application authentication, tenancy or origin protections.

Request-body size and server/upstream timeouts are bounded. No access logger is
configured. The default error logger deletes the whole request object, covering
callback queries and auth/cookie headers even when an upstream connection fails.
Startup diagnostics report only a fixed stage and bounded filesystem error code.

## Executable proof and activation limits

Run `npm run test:managed-gateway`. CI runs the same command. Unit contracts cover
bindings, injection, topology, routing and image constraints. The actual image
test first verifies the local Docker endpoint/runtime and pins every child to
it, rejects ambient overrides, creates synthetic isolated upstreams, and exposes
only the gateway on a dynamically selected loopback port. It proves API/web/root
API routing, bodies/cookies, canonical headers, stripped forged metadata,
unknown-host refusal, narrow health wording, actual error-log redaction, graceful
shutdown and malformed-binding startup refusal. The API side uses its actual
fixed-pin/protected-file loader and Fastify TLS factory with synthetic routes;
the web side first uses a TLS fixture, then the actual compiled Next image. Both positive hops negotiate TLS1.3. Foreign
CA and wrong-host servers are proved listening before the negative requests;
each request must produce a fresh certificate-verification error, not merely a
connection failure, and cannot reach the rogue HTTP handler. Callback canaries
remain absent from those actual error logs. It removes only its own uniquely
named fixture containers, networks and image.

This is local container evidence, not an actual Render deployment or full
browser/public-TLS/full-business journey. Render private networking includes other regional
workspace services and mutable instance addresses. A private hostname is not
peer authentication. API peer pins and gateway/API parity now have component
proof; compiled Next transport now also passes. End-user address policy, environment
isolation/provider observations, controller provenance and full joined
flow remain activation gates. Do not populate broad trusted proxy ranges or
claim socket-peer rate limits are end-user rate limits. The shape-only private
blueprint remains non-deployable until those gates and real image/resource,
custody and recovery requirements are met.

References checked16October2026:
[Render private networking](https://render.com/docs/private-network),
[Render private services](https://render.com/docs/private-services),
[Caddy proxy headers](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy),
[Caddy proxy trust](https://caddyserver.com/docs/caddyfile/options#trusted-proxies).


## Optional provider secret-file staging

The normal entry point supports the service-scoped
[TLS delivery contract](managed-tls-delivery.md). It validates the pinned bundle
before creating protected runtime directories. Direct protected-directory input
remains available when this delivery selector is absent. Actual provider mount
permissions, key custody, issuance and complete rotation/recovery evidence remain
required; synthetic staging is not evidence that those gates have passed.


## Normal application phase superseding earlier transport-only limits

The native test now also builds the actual enabled API runner and boots its
normal command with the complete migrated TLS database and production validators.
It exercises real synthetic tenant sessions, Member byte access/isolation,
compiled Next authentication and required privileged MFA. This self-contained
provider configuration supplements the earlier synthetic-route phases above.
See [normal runtime proof](managed-application-runtime-proof.md), including the
application-header policy. External providers, public browser/edge, real key/IAM
custody, independent recovery and host-loss/reopening remain open.
