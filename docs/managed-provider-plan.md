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
