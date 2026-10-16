# Managed private web/API origin binding

> **Prototype status:** This page describes the existing V1/HTTP web scaffold.
> The managed API and gateway now require the shared HTTPS/mTLS
> [format2 mesh record](managed-service-mesh.md). The web server/client migration
> is still open; these V1 instructions do not permit managed activation.

This is an opt-in Node-server configuration boundary for the four-component
Render design. It is not an activated provider deployment or network-peer
authentication. Existing private VM, personal-server and isolated-E2E origin
contracts remain separate.

## Preparation and build

A trusted deployment controller must reconcile the exact installation,
workspace, environment and all four service identities with reviewed provider
inventory. It calls `createManagedWebApiBinding` in
`apps/web/src/lib/server-api-config.server.ts` with this exact format:

```text
format: 1; provider: render; region: frankfurt
installationId; ownerId; environmentId; sourceSha (40 lowercase hex)
publicOrigin (canonical HTTPS origin)
gatewayServiceId; webServiceId; apiServiceId; schedulerServiceId (all distinct)
apiServiceName; apiOrigin
```

The API name is a `charitypilot-…-api` application service. Its internal origin
must be exact HTTP port3002 at the corresponding single-label Render hostname
with a 4–20 lowercase alphanumeric suffix. Discovery endpoints, IP addresses,
public domains, credentials, paths, queries and fragments are refused. A changed
provider hostname convention needs a reviewed contract change, not a fallback.

The helper returns canonical JSON and its SHA-256. Build the web image with:

- `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_CHARITYPILOT_CANONICAL_API_ORIGIN` both
  equal to the reviewed public gateway origin.
- `NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE=public-production`.
- `NEXT_PUBLIC_CHARITYPILOT_MANAGED_WEB_BINDING_SHA256` equal to that fingerprint.

Only this non-secret fingerprint is a new Docker build argument. Never put the
registry JSON or credentials into a `NEXT_PUBLIC_*` variable. The record excludes
image digests: the web image depends on its build pin, so including its own digest
would introduce a circular dependency. After building, the maintenance registry
must independently bind the resulting exact four images.

## Request-time checks

Supply the same public values at runtime, plus:

- `CHARITYPILOT_MANAGED_PROVIDER=render`.
- `CHARITYPILOT_MANAGED_WEB_BINDING`: the exact canonical JSON, maximum4096bytes.
- `CHARITYPILOT_INTERNAL_API_URL`: the exact record API origin.
- `CHARITYPILOT_BUILD_COMMIT`: the record source SHA.
- Provider read-only `RENDER_SERVICE_ID` equal to the private web service ID and
  `RENDER_SERVICE_TYPE=pserv`.

Node must run in production. An optional API deployment-mode selector must be
`production`; personal-server and disposable-E2E configurations cannot opt in.
The proxy compares literal compiled public values against the live environment,
canonical JSON, fingerprint and service/build identity. Partial or conflicting
configuration returns a generic503 with no-store headers before any auth fetch,
including on public login pages. There is no public-origin fallback. The older
shared server getter refuses managed settings so it cannot bypass this guard.

Protected session checks use only the validated private API. Redirects and CSP
use the pinned public origin, ignoring incoming Host/forwarded-host values for
this origin decision. Existing API authentication/organisation checks still
apply. The private record module is imported only by Node proxy code.

## Evidence and unfinished integration

Unit tests cover exact and mismatched identities/builds/profiles, malformed and
duplicate-key JSON, partial records, unsafe destinations and existing profiles.
Proxy tests exercise positive auth, cookie minimisation, forged host headers,
canonical redirects and refusal before fetch. An actual Next production build
with synthetic private canaries verifies Node crypto compatibility and absence
of private registry values in browser static assets. The actual compiled Node
server also passes a canonical redirect with the exact record and returns503
when runtime record/hash values are changed together or removed. This exercises
the compiled pin independently of the TypeScript unit tests. Dated details are
private; these are loopback synthetic server tests, not hosted provider tests.

The SHA is consistency evidence, not a signature or independent attestation.
Provider environment values do not prove DNS ownership, actual image provenance,
network confidentiality or caller permission. Gateway image/routing, private API
trusted-peer policy, deployment-controller provenance and complete hosted flow
remain required. No provider resource is created by this module.

References: [Render environment variables](https://render.com/docs/environment-variables),
[Render private networking](https://render.com/docs/private-network), and
[Next Proxy runtime](https://nextjs.org/docs/app/api-reference/file-conventions/proxy#runtime).
The Proxy API reference specifies Node runtime; no unsupported runtime override
is configured.
