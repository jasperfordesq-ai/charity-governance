# Render maintenance control

Internal compatibility prototype for the managed whole-backend decision. No
route, worker, CLI, credential lookup or live provider activation is included.
The existing private and personal-server operator contracts remain authoritative.

## Source contract

Checked 16 October 2026 against Render's official API specification and docs:

- [One-off jobs](https://render.com/docs/one-off-jobs): suspending the base service
  does not terminate an existing job. Inventory and cancellation are separate.
- [API specification](https://api-docs.render.com/openapi/render-public-api-1.json):
  service suspension POST returns202; job cancellation POST returns200. Those
  status codes acknowledge commands, not a completed shutdown.
- [List jobs](https://api-docs.render.com/reference/list-job) and
  [cancel job](https://api-docs.render.com/reference/cancel-job) define the separate
  pending/running inventory and per-service job cancellation paths.

## Implementation

`RenderMaintenanceControl` requires a trusted exact workspace/environment and
four distinct pinned-image service IDs: web_service for the Caddy gateway,
private_service for compiled web and API, and background_worker for the singleton
scheduler. The old three-service shape and a publicly exposed web are refused.
The service response must match its identity, type, Frankfurt region, image
runtime and exact image digest. Independent auto-deploy must be off. Scheduler
must report one configured instance and no autoscaling configuration.

Preflight reads the complete bounded environment inventory, including previews,
and rejects extra/missing/duplicate services. It follows deploy/job pagination,
rejects duplicate IDs and cursor cycles, and refuses unknown states or any active
or queued deployment. Do not cancel deploys automatically: a queued deploy may
start as another is canceled. Historical terminal records do not imply no active
work; filtered lists are still paginated and validated.

The mutation method first suspends the gateway once and requires a fresh exact
gateway GET to confirm its identity/image/type and suspended state. A202 alone
cannot advance shutdown. It then suspends scheduler, private web and API in that
order, regardless of provider inventory order, rereads all four services,
separately inventories surviving jobs and requests each cancellation once. A complete fresh readback must still match all service identities/images,
report every service suspended and report no active jobs/deployments. A202 or
job response body alone cannot satisfy that readback. New jobs, changed config,
continued activity and unknown command outcomes keep the operation unresolved.
A later observation is read-only. There is no resume, deploy, resource creation,
provider-content deletion or secret-change method, and no automatic retry of a
failed mutation.

Transport pins https://api.render.com/v1, rejects redirects and supplies only
explicit credentials. Responses are bounded to1MiB, pages to10 per inventory,
requests to96 and an operation to60 seconds with5-second request aborts. Reaching
a bound refuses the observation; it does not declare a truncated list empty.
Provider errors and credentials are excluded from returned errors/receipts.

## Evidence limits and integration

The returned unkeyed digest is a point-in-time observation of the configured
Render environment, not authenticated independent custody or an IAM lock. The
caller must first coordinate all control-plane writers, Blueprint/deploy hooks,
manual jobs and external actors. Configured instance counts are not physical
host attestations. An API snapshot does not prove that every process stopped
instantaneously, that already dispatched external IO completed, or that no
outside scheduler/credential can write.

Combine this adapter with database principal/session fencing, credential rotation,
current independent authority, protected operator journal and whole application
and document-byte restore checks. Preserve uncertainty after an interrupted
operation; no automatic reopening. Actual provider acceptance, source-host-off
recovery and reopening remain required. No wholeBackendQuiesced,
databaseWritersFenced, sourceHostFenced, reopeningAuthorised or actionAuthorized
flag is true in this adapter's observation.

The synthetic HTTP contract suite verifies exact requests, ordered observation,
job survival/cancellation, paging, stale/changed configuration, uncertain IO and
abort/error handling. It uses injected responses, not live Render infrastructure.
These tests do not establish actual vendor suspension timing or custody.

The [guarded shutdown prototype](managed-backend-maintenance.md) now composes
these component observations under a separate installation-wide one-attempt
control. Its native database proof uses synthetic provider transports and does
not close the remaining activation, custody, credential or host-loss gates.

## Four-component contract binding

The configuration digest includes a dedicated
GATEWAY_PRIVATE_WEB_API_SCHEDULER_V1 domain and all four exact component bindings.
The guarded maintenance plan therefore differs from the old three-service plan;
no stored READY record is automatically upgraded or reused. Current snapshot,
job ownership, active-deploy, bounded paging, copied configuration and error
controls apply to the gateway as well as internal services. A resumed or changed
gateway at final readback refuses the result. Tests populate one-off jobs for
every component and reverse the provider inventory to verify explicit ordering.
The actual PostgreSQL integration now also proves an old three-service control
cannot dispatch a provider command or close a database role.

This closes the maintenance inventory/sequence gap, not the managed hosting fit
assessment. A gateway image, exact managed internal API origin, peer/forwarded
header trust, matching build-time configuration and provider/IAM/custody tests
remain required before using the proposed four-service deployment. This adapter
is still inactive and does not create a provider resource or reopen services.
