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
three distinct pinned-image service IDs: web_service for compiled web,
private_service for API and background_worker for the singleton scheduler.
The service response must match its identity, type, Frankfurt region, image
runtime and exact image digest. Independent auto-deploy must be off. Scheduler
must report one configured instance and no autoscaling configuration.

Preflight reads the complete bounded environment inventory, including previews,
and rejects extra/missing/duplicate services. It follows deploy/job pagination,
rejects duplicate IDs and cursor cycles, and refuses unknown states or any active
or queued deployment. Do not cancel deploys automatically: a queued deploy may
start as another is canceled. Historical terminal records do not imply no active
work; filtered lists are still paginated and validated.

The mutation method suspends each observed unsuspended service once, rereads all
services, separately inventories surviving jobs and requests each cancellation
once. A complete fresh readback must still match all service identities/images,
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
