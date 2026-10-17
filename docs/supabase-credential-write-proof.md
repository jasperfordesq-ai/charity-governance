# Synthetic standard storage-write evidence

17 October 2026. `SupabaseCredentialWriteProof` implements active, bounded tests
of exact modern server keys' CREATE, UPDATE and DELETE requests. It is an internal
component, with no public route, job or operator command. Current maintenance
protocol4 does **not** call it. Integrating durable baseline/report custody and
one-attempt dispatch is required before activation; an instance flag is not a
durable guard across processes.

The [exact-version evidence custody component](managed-write-evidence.md) now
implements separate baseline/report publication and readback. Its parent-head
pin and dispatch integration is still required; it does not activate this probe.

## Decision and boundary

GET refusal and management key absence cannot establish write refusal. Test
the standard object endpoints separately, with a successful prior exercise of
each operation and working controls. Keep signed upload, resumable/S3, in-flight
and privileged control-plane paths separate. This implements the delegated
product-engineering contract; it does not authorise a real cloud operation.

Only the fixed `charitypilot-recovery-write-probes` bucket is accepted. Paths are
generated from validated installation, exact attempt UUID and credential UUID:

`charitypilot-recovery-write-probe/<installation>/<attempt>/<credential>.txt`

Callers cannot supply document paths or object bytes. Payloads are fixed synthetic
text with no personal data; UPDATE uses a different known payload to detect a
provider that reports success without changing the object. Secret values must
match reviewed UUID/fingerprint pairs, be distinct modern server keys and be
explicitly supplied. The exact project origin is generated from the validated
reference; no redirects or ambient credentials are accepted.

## Baseline before revocation

For each tested credential:

1. Run a positive control CREATE/UPDATE/DELETE cycle. Read the exact bytes after
   creation and update, verify absence after deletion and check the private bucket
   before and after. Refuse an existing control object instead of overwriting it.
2. Require the tested credential's target to be absent. POST without upsert,
   PUT the different update payload, and DELETE only that exact target via the
   single-prefix request. Check each result with independent control reads.
3. Run another complete positive control cycle.

The baseline includes the canonical registry digest, attempt/plan/source/epoch,
tested IDs, payload hashes, operation list and observation time. It contains no
raw key, token or object bytes. The caller must independently retain and
authenticate its body/SHA before revoking keys. This component alone does not
provide that custody. Missing or uncertain baseline acknowledgement must prevent
the coordinator from advancing to revocation.

The registry digest excludes the per-attempt maintenance binding so a parent plan
can include the registry without a circular hash dependency. Baseline validation
separately requires exact attempt/plan/source/epoch equality. Construct the active
probe with the acquired attempt; never treat a registry digest as dispatch authority.

## Refusal after revocation

Validate the full canonical baseline/hash and exact current binding before any
HTTP request. For each credential:

- Bracket the check with the same working control cycles.
- Require its target to be absent. Require CREATE to return HTTP401/403 and
  confirm it remains absent.
- Use the control key to create the synthetic target with known initial bytes.
- Require the old credential's UPDATE and DELETE to return HTTP401/403; check
  that the initial bytes remain after **each** refusal.

Successful verification leaves one initial-payload synthetic object per tested
credential. There is no automatic post-verification cleanup. A failure never
triggers compensation, another mutation attempt or a new baseline. Record and
reconcile any synthetic residues through a separately authorised operation.

The result states `standardWriteRefusalsObserved=true` with exact per-operation
statuses, baseline/registry hashes and observation digest. `writeRejectionVerified`,
`signedCapabilitiesRevoked`, `inFlightWritesDrained`, `wholeStorageQuiesced` and
`actionAuthorized` remain false: a successful test of these three scoped endpoints
is not proof that all storage writes are excluded. HTTP403 can reflect policy;
the implementation does not attribute it solely to revocation.

## Uncertainty and inspection

Each instance permits one baseline attempt and one active refusal-verification
attempt. A lost mutation response stays uncertain even if it committed. A durable
coordinator must additionally guard new instances and retain original evidence;
do not call active verification from a supposedly read-only inspection path.

`inspect()` uses GET only. It reports current probe states ABSENT, INITIAL,
UPDATED or UNEXPECTED without returning object bytes. It never repairs, erases,
replays or reconstructs missing original outcomes. These are sequential current
observations, not an atomic provider snapshot or source-host fence.

Both phases and inspection have a one-hour outer bound, 1,600-request ceiling,
10-second request races and 16KiB read bounds. Late bodies are cancelled even
when an injected transport ignores abort. Generic failures omit provider bodies
and secrets. No SDK retry or automatic cleanup is present.

## Verification and remaining integration

HTTP models exercise the default writer-control adapter and this component
together, positive standard writes, 401/403 refusal, unchanged-byte checks,
ignored updates, denial with side effects, misleading success, outages/conflicts,
scope/baseline substitution, existing-object protection, lost response,
read-only inspection and late-response cancellation. These are synthetic
transports, not actual Supabase acceptance or independent custody.

Next integrate a source-bound, separately acknowledged durable write baseline
and report into managed maintenance without enlarging claims of the existing
read evidence. Do not retrofit write mutations into `inspect()`. Continue actual
capability/in-flight/control-plane fencing, common capture, full restoration and
provider/source-host-loss proof.

Primary contracts checked on 17 October 2026:

- [Supabase storage SDK source](https://github.com/supabase/storage-js/blob/main/src/packages/StorageFileApi.ts):
  POST/PUT object endpoints, no-upsert creation and single-prefix deletion.
- [Standard uploads](https://supabase.com/docs/guides/storage/uploads/standard-uploads).
- [Signed upload URLs](https://supabase.com/docs/reference/javascript/file-buckets-createsigneduploadurl):
  documented two-hour capability validity; ordinary key tests do not settle it.
