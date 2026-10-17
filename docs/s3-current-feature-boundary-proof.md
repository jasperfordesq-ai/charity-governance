# Current S3 feature-boundary proof

> **17 October protocol9 S3 integration:** The default coordinator now requires
> explicit S3 mode evidence, an original S3_BASELINED head acknowledgement before
> shutdown, and a fresh paired S3 report before OBSERVED_CLOSED. Saved inspection
> never repeats S3 probes or backfills ACKs. Both modes pass native PostgreSQL
> integration with synthetic providers. See [required S3 maintenance](durable-s3-maintenance.md).


17 October 2026. Local component and synthetic provider tests only.

## Engineering decision

An installation with S3 disabled must not enable it or issue credentials merely
to manufacture a working baseline. `SupabaseS3FeatureBoundaryProof` records a
separate current feature-boundary observation across DIRECT and GATEWAY routes.
It does not replace the [original working-capability proof](s3-capability-proof.md).
Further personal DPO review is optional under the software owner's delegation.

## Evidence collected

- Actual management adapter reads project, storage feature, legacy-key state and
  unrevealed API-key inventory twice before and twice after the data probe.
- PRE_CLOSURE requires S3 off and the exact configured writer/capture registry.
  POST_CLOSURE additionally requires legacy keys off and capture-only registry.
  Before/after metadata state must match; concurrent changes refuse completion.
- Each fixed endpoint checks a private synthetic bucket, absent attempt-specific
  paths and a conditional REST canary with exact readback. It then requires eight
  native XML403 `FeatureNotEnabled` responses and verifies unchanged protected
  bytes, absent target objects and a fresh working REST canary.
- Request shapes cover GET, create/update PUT, DELETE, multipart creation,
  unissued multipart part/completion and an invalid presigned request shape.
  No valid S3 credential, signature or issued UploadId is created or used.
- The actual AWS SDK decodes the bounded response through a local handler using
  dummy credentials. This decoder cannot perform network I/O. The existing
  working-capability probe shares the same native response predicate/decoder.

These are ACTIVE synthetic canaries, not read-only inspection. Requests include
mutating methods. Unexpected acceptance or unknown multipart effects remain
unresolved, with no automatic deletion or retry. A lost acknowledgement consumes
the instance; a fresh instance refuses existing canary residue. Durable parent
acquisition is still required before operational use.

## Closed contract and limits

The canonical bounded artifact binds installation, maintenance attempt, stage,
configured control, both endpoints, declared provider source/image, metadata and
ordered sixteen-response vector. Timing and digests are validated. Declared
provider identity is not hosted release attestation. Saved assertion is pure and
never authorises execution; old observations are historical evidence only.

Historical never-enabled status, original working S3 baseline, key revocation,
original presigned-capability refusal, multipart/in-flight drainage, unknown
multipart side-effect exclusion, management-actor exclusion, provider release
attestation, whole-storage quiescence and action authority remain explicitly false.
The REST capture credential's least privilege remains a separate requirement.

## Verification and continuation

Ten new tests cover both stages, both endpoint profiles, real metadata adapter
GETs, generic/non-XML/stale gateway failures, side effects, failed controls,
metadata drift, lost acknowledgements, residue, cancellation and forged evidence.
Together with twelve working-capability and four writer-control tests:26PASS.
Full API suite:3667PASS,1SKIP,0FAIL; existing disposable PostgreSQL scenario passes.
The PostgreSQL run verifies compatibility of existing parent behaviour, not
integration of this new component. All provider HTTP responses are synthetic.

Next: combined encrypted original URL/UploadId custody, independent public
artifacts, complete configured credential/endpoint mode selection and mandatory
fresh post-closure parent barriers. Default protocol8 has no S3 dispatch yet.
Retain all broader JWT/session, common capture, independent authority, full-app
restore, actual provider/source-host-loss and guarded reopening requirements.

## Primary sources checked

- [Supabase S3 compatibility](https://supabase.com/docs/guides/storage/s3/compatibility):
  REST/resumable/S3 interoperability and supported request operations; no S3 versioning.
- [Supabase S3 authentication](https://supabase.com/docs/guides/storage/s3/authentication):
  generated credentials and session-token authentication have distinct authority.
- Previously reviewed Storage source `c826a70ac6e6f56d3e6033ccb164fb1ff5282570`
  places feature gating before signature verification; this is source evidence,
  not proof of the actual hosted release or all possible routes.

## Durable mode addendum

The [explicit current-disabled mode](durable-s3-current-feature-evidence.md) now composes original PRE and fresh POST probes with conditional public publication/exact-version readback and saved-pair inspection. Common mode selection, parent integration and actual provider proof remain open.
