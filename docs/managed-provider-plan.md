# Managed provider configuration compiler

`scripts/managed-provider-plan.mjs` replaces hand-edited shape drafts with a pure
configuration compiler for the existing four-service synthetic review topology.
It does not provision resources, publish images, upload secrets or apply a Blueprint.

```sh
node scripts/managed-provider-plan.mjs --stdin < /protected/operator/provider-plan-input.json
```

The bounded 32 KiB UTF-8 input contains exactly:

- `format: 1`, `purpose: "SYNTHETIC_MANAGED_REVIEW"`;
- `mesh`: the canonical [21-field V2 service mesh](managed-service-mesh.md);
- `names`: the gateway and scheduler service names; API/web names come from the mesh;
- `images`: gateway, web and API records, each with immutable `url`, `sourceSha`,
  `bindingSha256` and `platform: "linux/amd64"`;
- `recoveryKeys`: four distinct same-account Ireland KMS key ARNs named
  `storageKeyArn`, `dataKeyArn`, `indexMacKeyArn` and `rootMacKeyArn`.

Image URLs are restricted to the software owner's `ghcr.io/jasperfordesq-ai`
namespace and SHA-256 digests. Mutable tags, all-zero image placeholders, wrong
source/mesh/platform, ambiguous topology, cross-account/duplicate keys and extra
input fields refuse with one fixed error and no artifact. The scheduler uses the
reviewed API image. These checks validate input consistency, not registry ownership,
image provenance, actual KMS types/policies or provider state. No credentials or
certificate/private-key material belong in this input.

## Output and runtime contract

The output joins the canonical mesh to non-secret image build arguments, a Blueprint,
the exact four-service maintenance registry, three TLS secret-file requirements,
two database CA files and provider-managed service identities. Its deterministic
configuration digest does not attest its own source or any provider observation.

Only the gateway is public. Web/API are private and the scheduler is a singleton
worker, all Frankfurt `1c-2g`. All service definitions use prebuilt images, one
instance and automatic deploy trigger off. Gateway/web/API retain Dockerfile CMDs;
only the worker selects `node dist/jobs/production-scheduler.js`. The compiled
gateway loader, API startup and web TLS loader therefore remain in their paths.

The synthetic profile is multi-organisation, registration closed, manual-link
delivery, billing/error alerts disabled and privileged MFA required. It uses
Supabase storage in the explicit `charitypilot-synthetic-review` bucket; this
compiler neither creates nor verifies that bucket. All web capability axes and
canonical origins are identical at image build and runtime. No tenant policy or
real-data eligibility is inferred from the synthetic-purpose label.

Application secrets are listed only as `sync: false` requirements for API/worker;
the gateway/web receive no application database or signing secret. TLS bundles use
the fixed [protected delivery](managed-tls-delivery.md) paths. Provider service IDs
and types are observations to reconcile, not environment overrides to inject.

## Required operator gates

The input already needs assigned provider service IDs and stable private hostnames.
Initial identity bootstrap therefore remains a separate controlled provisioning
step; this is not a first-account installer. The Blueprint names the selected
`CharityPilot synthetic managed review` project and `synthetic-review` environment.
Reconcile those names to the exact trusted owner/environment/service IDs before
considering any application. Name similarity cannot establish identity.

Before actual use, independently verify all of the following:

1. Exact source, registry image digest/platform and immutable in-image mesh pins.
2. Actual owner, project/environment/service identities, private addresses,
   instance counts, jobs, deployment hooks and all control-plane writers.
3. Complete current environment and explicit removal of conflicting/stale settings.
   Omitted Blueprint variables are not deleted. In particular check E2E variables,
   node preload options, proxy trust and conflicting TLS-directory selectors.
4. Separate authorised secret delivery and database CA verification. `sync: false`
   is not a secret updater on existing resources; do not assume it rotated or
   delivered credentials. Review private-registry pull credentials separately.
5. Fresh [database preflight](managed-backend-maintenance.md), real provider
   mutation compatibility and the full maintenance/capture/recovery gates.
6. Four actual same-account KMS keys with the required encryption/MAC types,
   independently administered IAM/custody, original genesis/checkpoint custody,
   retention/rollback controls and physical-host recovery proof.
7. Separate account, legal, spend, access and data-scope approval; no real charity
   data, policy adoption, purge, disclosure or reopening follows from this artifact.

The compiler keeps `providerInventoryVerified`, `imageProvenanceVerified`,
`secretDeliveryVerified`, `databaseCompatibilityVerified`,
`controlPlaneExclusionVerified`, `independentRecoveryVerified`, `applyAuthorized`,
`releaseReady`, execution and action authority false.

## Sources and verification scope

Reviewed 18 October 2026:

- [Render Blueprint specification](https://render.com/docs/blueprint-spec): schema,
  default Docker CMD and secret prompting/update behaviour.
- [Render infrastructure as code](https://render.com/docs/infrastructure-as-code):
  automatic sync is a separate control and omitted environment values survive.
- [Prebuilt images](https://render.com/docs/deploying-an-image): Linux amd64 and
  retained registry digests for rollback.
- [Docker secret files](https://render.com/docs/docker-secrets): separately delivered
  material; do not put it into a source/image build context.

Tests exercise real gateway/web binding parsers and build-pin helpers, input
substitution, command refusal, deterministic output and secret-free Blueprint
requirements. The generated synthetic Blueprint also passed the current downloaded
Render JSON schema offline. That is structural/local proof, not Render API
validation, provisioning, image execution or provider acceptance. Exact schema
hash and validation result are retained in the ignored private review pack.

## Read-only Render inspection and complete cursor traversal

The compiled API exposes `jobs:inspect-managed-render`. From a reviewed operator
build, pipe an operator-protected JSON input through stdin:

```sh
npm run jobs:inspect-managed-render -w @charitypilot/api < /protected/operator/render-inspection.json
```

Input is strict UTF-8 JSON, at most16KiB: `format: 1`, `registry`, `token` and
`expectedConfigurationDigest`. The registry is the compiler's exact four-service
`maintenanceRegistry`, reviewed against the actual account. Compute its expected
digest with the reviewed `RenderMaintenanceControl.configurationDigest()`; the
provided digest binds that input, not independent registry completeness. No ambient
provider credential, endpoint override, mutation switch or new access grant exists.
The command reads only `https://api.render.com/v1`; store no token in tracked files,
arguments, shell history or tickets. An authorised provider credential is still
required before actual use.

All service, deployment and job lists now follow every non-empty page's final
cursor, including short pages, to an empty page. Duplicates, cursor cycles, unknown
states, truncation, more than1000rows, more than11pages, or the existing96request/
60second budget refuse the observation. Deployment and job histories are read without status filters, so differing array-query conventions or filtered unfamiliar states cannot justify absence. Large histories that exceed the bounds remain unresolved. Active deploys stop before any shutdown.
For every service, exactly one current `live` deploy must name the configured
immutable image reference and its matching resolved SHA-256. Missing/ambiguous
live records and a different resolved image refuse. A configured service image
alone cannot prove what is deployed. A suspended service whose current release
cannot be verified also remains unresolved; no success is inferred from its state.

The same snapshot feeds existing maintenance checks. It does not relax original
mutation acknowledgements, gateway-first shutdown, surviving one-off-job accounting
or database/storage/capture/recovery gates. Original deployment IDs and image pins
are included in the internal observation digest, but the CLI emits only bounded
counts/digests/time and false authority flags. Active jobs are reported; the command
never suspends a service or cancels a job. Success is a point-in-time configured
service/work observation, not maintenance readiness or a permanent fence.

Complete environment variables/groups, Blueprint sync, hooks, secret-file bytes,
image provenance, IAM/controller writers and physical-host recovery are NOT covered.
Their flags stay false and their independent review remains required. Keep the
running command's source/image evidence separately; it cannot attest its own release.
Errors are fixed/redacted and produce no successful diagnostic report.

Contract checked18October2026 against Render's official
[OpenAPI source](https://api-docs.render.com/openapi/render-public-api-1.json),
[pagination](https://api-docs.render.com/reference/pagination),
[service listing](https://api-docs.render.com/reference/list-services) and
[image deployment behaviour](https://render.com/docs/deploying-an-image).
The full source snapshot/hash is retained privately. API-shape tests, short-page
counterexamples, live-image substitutions and native integration are synthetic
transport proof; they do not establish actual hosted API behaviour or account state.
## Declared configuration and stored-secret readback

`scripts/inspect-managed-provider.mjs` joins the compiled plan to read-only Render
control-plane observations. Build the API helper first, then pipe protected input:

```sh
npm run build -w @charitypilot/api
node scripts/inspect-managed-provider.mjs --stdin < /protected/operator/provider-readback.json
```

The strict64KiB UTF-8 input contains `format: 1`, `configuration` (the compiler
input), `expectedConfigurationSha256`, `token`, `projectId`, `blueprintId`,
`secrets` and `secretFileSha256`. The plan digest must match before any HTTP.
`secrets` has exactly the compiler's `sync: false` key/value sets for API and
scheduler. `secretFileSha256` maps each of gateway/web/API/scheduler to the exact
required file basenames and hashes of independently reviewed original bytes:
three service TLS JSON bundles, plus `database-ca.pem` for API and scheduler.
Empty per-service maps remain explicit. No material is generated, uploaded,
rotated or granted by this command. Keep the input outside the source checkout
under operator-only permissions; it contains application credentials.

All requests, including the existing service/deployment/job observer, pass through
one fixed-origin GET-only transport. It refuses redirects, errors, invalid UTF-8,
truncation, duplicate/cyclic pages, excessive bodies and deadlines: maximum256
requests,90seconds total,5seconds per request,1MiB per response and8MiB total.
The CLI accepts no apply, endpoint, transport or timeout override. Its internal
transport seam exists only for tests. Input is snapshotted before asynchronous use.

The reader verifies:

- Exact owner/project/environment and the four selected service identities; no
  additional project environment, database, Redis or environment group in the
  selected synthetic environment. Network isolation is explicit in the compiler
  (`networking.isolation: enabled`) and must be observed as enabled.
- Visible owner-level group metadata, including groups outside the selected
  environment, so an inherited group cannot be ignored. The current isolated
  compiler profile declares no inherited groups; any group linked to a selected
  service refuses. Unrelated groups are allowed only after complete bounded
  pagination. The published group schema does not require a cursor on nonempty
  results: absent actual continuation evidence leaves the observation unverified;
  no group ID or short page is substituted for that evidence.
- A single selected Blueprint controller, exact resources, canonical repository/
  master branch, in-sync status and automatic sync off. Other visible Blueprints
  are fetched separately to check resource overlap. Visible sync history must
  contain only terminal success/error entries. Render excludes unapproved created
  syncs from that list; their absence is not proven.
- Runtime type/region/plan/one instance, current source-bound image pins, exact
  commands, no pre-deploy command, no autoscaling and previews off. Gateway/web/API
  retain the image CMD; the singleton worker uses the scheduler command.
- Exact directly declared environment key/value sets, including original supplied
  secrets. Stale additional settings such as node preloads or conflicting TLS
  directory selectors refuse. No inferred secret delivery from `sync: false`.
- Exact stored file inventory and byte hashes. Existing TLS-bundle validation
  checks the pinned issuer/leaves, current validity, private-key matches and usages
  without writing material to disk. The database CA is compared with its trusted
  original hash; this does not establish a live database connection.

Two matching configuration samples are bracketed by service/work observations
with the same stable state fingerprint. An older compiled API without that
fingerprint refuses. Resource/property ordering and opaque cursors alone are not
configuration changes. These are sampled readbacks, without an atomic provider
snapshot, a lock or a permission lease. Changes outside the samples remain possible.

The report contains public configuration/state digests, sample times, counts and
observed checks. It includes no token, application secret, file content or derived
secret-value fingerprint. Credential/file comparisons occur only in memory;
transient buffers are cleared where possible, without a claim to erase JavaScript
strings. Refusals expose a fixed message and an allowlisted stage code only.
Timeouts also cancel bodies that arrive late or never complete.

Runtime environment/mounted-file delivery, provider permission visibility,
private DNS, image provenance, unapproved sync exclusion, control-plane writers,
independent custody, own release attestation, whole-backend closure, release
readiness and action/execution authority remain false. Account/access/spend/legal
approval and actual provider/host-loss exercises remain separate prerequisites.
No real provider account has been tested by the synthetic transport tests.

Sources reviewed18October2026: [direct variables omit inherited groups](https://api-docs.render.com/reference/get-env-vars-for-service),
[stored secret files](https://api-docs.render.com/reference/list-secret-files-for-service),
[owner group inventory](https://api-docs.render.com/reference/list-env-groups),
[Blueprint details](https://api-docs.render.com/reference/retrieve-blueprint) and the
[public OpenAPI schema](https://api-docs.render.com/openapi/render-public-api-1.json).
Its resource/list differences and incomplete cursor declaration are retained as
proof limits rather than filled with inferred provider history.