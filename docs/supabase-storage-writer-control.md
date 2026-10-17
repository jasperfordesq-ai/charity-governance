# Named Supabase storage access-path control

17 October 2026. `SupabaseStorageWriterControl` implements a provider primitive
inside [managed maintenance protocol4](durable-credential-read-baseline.md).
No route, scheduler, operator command or
live account activates it. Actual project-wide credential revocation requires
appropriate operator authority and separately supplied credentials/registry.
The private VM and personal-server operating modes are unchanged.

## Reviewed target and sequence

Configuration binds installation, project reference, provider organisation,
explicit EU region, bucket, one retained modern secret-key ID and up to50 exact
modern writer-key IDs/types. IDs are unique; the retained key cannot appear in
the revocation list. Copy and sort the registry before hashing it. The bucket
names the capture target; key revocation affects the entire reviewed project.

The only endpoint is `https://api.supabase.com/v1/projects/<projectRef>`.
The management token is explicit, never discovered from the environment or
returned in observations. No redirects, SDK retries, key creation, grants,
project deletion or automatic reopening are implemented.

1. Read the exact healthy project and require organisation/region/ref equality.
   Read storage config, legacy-key enablement and API-key inventory with
   `reveal=false`. Unexpected modern keys, missing reviewed keys or missing
   capture key refuse before any mutation.
2. If enabled, PATCH `features.s3Protocol.enabled=false`; read it again and
   require the disabled value. A stale readback stops before key changes.
3. If enabled, PUT legacy-key enablement to false and require its response.
   A missing/removed legacy endpoint is unresolved; HTTP404 is not disabled proof.
4. DELETE only the configured modern writer-key IDs, with `reveal=false`, one
   request each. Check each returned ID/type. Never delete the retained capture
   key or an unreviewed key.
5. Read all four sources twice. Require matching project/settings/key projections,
   disabled legacy/S3 and exactly the retained modern secret key. Return a
   bounded observation digest; no secret values or descriptive metadata escape.

Each request has a10-second race/deadline, a1MiB JSON bound and generic errors;
the whole primitive is bounded to180seconds/128requests. Late response bodies are
cancelled, even when the injected transport ignores cancellation. The instance
allows one close attempt. `observeClosed` makes only GET requests and never
finishes an uncertain shutdown. The independent coordinator guard is mandatory
for durable exclusion across fresh processes; an instance flag alone is not it.

## Maintenance protocol integration

`ManagedBackendMaintenance` now binds protocol4, a named-key revocation policy
and the storage registry digest alongside source/epoch, Render and database
registries and independently retained credential-read evidence. An authorised
READY head must name this exact new plan. Protocol1–3
plans refuse before acquiring or dispatching a new workflow.

After the acknowledged independent attempt and saved/read-back read baseline,
suspend/drain Render components,
close/drain database writers and invalidate their passwords, then close the
configured Supabase paths. Fresh combined observations include storageDigest
before writing OBSERVED_CLOSED. A lost response leaves the original independent
attempt consumed; fresh coordinators refuse another shutdown.

The independent control envelope remains format1. Its optional storageDigest
allows old evidence to remain readable. Protocol4 inspection refuses an
OBSERVED_CLOSED record missing that field; it does not fill it in retrospectively.
Fresh provider observations are separate from recorded observations, including
after a committed key deletion or final control write whose response was lost.

## Proof limits

The [credential read-proof component](supabase-credential-read-proof.md) now
supplies a separately scoped baseline/control/refusal check. Its independent
baseline custody and parent-plan integration now exist in protocol4, with actual
provider custody still required before activation;
it does not turn a management configuration observation into write exclusion.
The separate [synthetic standard-write component](supabase-credential-write-proof.md)
adds active CREATE/UPDATE/DELETE checks but awaits its own durable integration.

`configuredAccessPathsObservedClosed=true` means current management responses
report the named settings and key absence. It does not mean an old credential
has been tested at the data plane, the retained capture credential is read-only,
or all writes have stopped. Results explicitly keep wholeStorageQuiesced,
controlPlaneWritersExcluded, dataPlaneRejectionVerified,
signedCapabilitiesRevoked and inFlightWritesDrained false. The coordinator keeps
wholeBackendQuiesced and reopening authority false.

Previously issued signed capabilities, resumable/in-flight requests, privileged
SQL, management actors or the retained privileged capture key can be separate
write paths. Actual custody/least privilege, old-key negative tests with a valid
positive control, signed-capability expiry/revocation, writer/control-plane
exclusion and the full common-capture worker remain required. Do not turn a
successful configuration response into permission to restore or reopen.

## Verification

HTTP models cover exact scoped closure, project/region/key mismatch, permission
denial, removed legacy endpoint, stale S3 readback and lost key-delete response.
Fresh observation can report current closure without recreating the original
acknowledgement. Tests cover deadlines and late-body cancellation.

The disposable TLS PostgreSQL proof now composes the actual database fence,
Render adapter, this Supabase adapter and S3 maintenance control with synthetic
provider HTTP/SDK responses. It checks real password/session closure before any
storage mutation, protocol downgrade refusal, lost acquisition/database/password/
storage-key/final-control responses and fresh retry refusal. Fixture-only cleanup
after earlier uncertain cases is explicit and separate from production inspect.
This is not real Supabase/Render/S3 custody or provider/source-host-loss proof.

Primary contracts checked 17 October 2026:

- [Project identity](https://supabase.com/docs/reference/api/v1-get-project).
- [Read storage config](https://supabase.com/docs/reference/api/v1-get-storage-config) and [update](https://supabase.com/docs/reference/api/v1-update-storage-config).
- [Legacy-key state](https://supabase.com/docs/reference/api/v1-get-project-legacy-api-keys) and [disable](https://supabase.com/docs/reference/api/v1-update-project-legacy-api-keys).
- [Key inventory](https://supabase.com/docs/reference/api/v1-get-project-api-keys) and [delete exact key](https://supabase.com/docs/reference/api/v1-delete-project-api-key).

## Separate S3 data-path evidence

The [original S3 capability probe](s3-capability-proof.md) now exercises actual
SDK-signed keys, presigned PUT and multipart requests through synthetic HTTP.
It requires the native feature-disabled response; this metadata primitive alone
still does not prove S3 capability exclusion. The probe's combined custody,
public evidence, complete factory and default parent integration remain next.

## Current disabled-feature metadata

s3FeatureProofScope is a pure configured-scope getter. observeS3Disabled performs GET-only paired snapshots and accepts a caller cancellation signal. PRE_CLOSURE checks the exact writer/capture registry with S3 off; POST_CLOSURE requires the existing fully closed metadata condition. It does not change the existing closure operation or configuration digest. The separate [data-path component](s3-current-feature-boundary-proof.md) uses active synthetic canaries; neither method proves historical revocation or global quiescence.
