# Configured working S3 capability cohort

17 October 2026. Local source and synthetic provider/evidence tests.

`ManagedS3CapabilityEvidence` constructs the original working-capability probe,
encrypted custody and independent public artifact store for every configured S3
credential at both DIRECT and GATEWAY endpoints. This is the working-baseline
branch of the planned complete S3 factory. It requires mode WORKING_CAPABILITIES
and a non-empty registry; it cannot turn an empty key list or current disabled
metadata into a historical exemption. The already-disabled component still needs
its durable mode wrapper and common coordinator integration.

## Exact configured scope

The constructor validates fixed installation/project/region/bucket, declared
provider source/image, retained control and1–50 reviewed S3 credentials. IDs,
access-key hashes and secret-key hashes must be unique and supplied credentials
must match exactly. Input order is normalised. The configuration digest also
binds independent evidence and encrypted-custody storage. Declared source/image
is not hosted attestation. The separate storage-scope assertion binds the actual
metadata adapter's installation/project/region/capture-key identity.

Each configured key has a DIRECT and GATEWAY child, ordered by key ID and then
endpoint. A deterministic application UUIDv8 binds the original parent
plan/source/epoch/attempt, full cohort configuration, credential and endpoint.
It is a distinct identity, never a durable acquisition or execution grant.
Original uploaded objects, multipart sessions and encrypted/public evidence are
therefore separate for each child. These are active synthetic writes, not
read-only probes. Uncertain residue is preserved without automatic cleanup.

## Baseline and fresh refusal

Each child requires actual SDK-signed working requests and the original900-second
presigned URL plus multipart UploadId, acknowledged only after encrypted
exact-version readback. Its original public baseline is also conditionally
published and read back. Only when every child succeeds is the complete parent
baseline manifest published and recursively checked. The caller must durably
record that original manifest pin before closing writers.

Verification re-reads the complete original manifest and every child baseline
before decrypting/using original capabilities. Each child must return all eight
native feature-specific refusals with retained REST controls and publish its
paired report. One still-working key or endpoint, missing original artifact,
wrong scope/pin/version, side effect or failed control prevents aggregate success.
The aggregate manifest binds every original child identity/report digest and
baseline hash. Child observations must fit the original baseline/expiry timing
and be within240seconds of the aggregate observation; changing the aggregate
clock cannot make stale child evidence fresh.

The complete manifests use canonical closed131072-byte contracts and the
`s3-capability-cohort` namespace under the original parent attempt. Existing
artifact namespaces keep their original paths/limits. Unknown child or aggregate
write/readback ACKs consume the corresponding instance; fresh inspection does
not retry, backfill or reconstruct the missing acknowledgement. All aggregate
work is bounded by300seconds and caller cancellation propagates to child work.

## Inspection and proof limits

Fresh saved-manifest inspection recursively uses exact-version public GETs only.
It does not invoke KMS, provider requests, new uploads, key changes or publication.
Historical evidence remains readable; it does not authorise execution/reopening.
Configured-cohort coverage is not issuer-wide inventory completeness. Explicit
false flags remain for credential inventory completeness, key/presigned
revocation, multipart/in-flight drainage, provider attestation, global storage
quiescence and action authority.

Eight new tests compose two credentials/four endpoints with real SDK/HMAC
verification, encryption and stored artifact readback under synthetic transports.
They exercise registry/scope substitution, one working gateway, missing original
child, lost aggregate ACKs, altered/omitted manifest entries, cancellation and
stale observations. Existing single-probe/custody/evidence tests also pass.

Next: durable already-disabled PRE/POST current-feature evidence; explicit common
mode selection; mandatory parent acquisition/baseline/closure/report barriers and
native unknown-ACK tests. Default protocol8 still does not dispatch S3. Preserve
JWT/session/other capabilities, in-flight/control-plane/capture privilege,
common database/files capture, independent catalogue/current preservation and
disposal authority, full application restore, actual provider/source-host-loss
and guarded reopening requirements in the full goal.

The [durable already-disabled branch](durable-s3-current-feature-evidence.md) is now locally implemented separately. Common mode selection and mandatory parent integration remain next; working-mode empty registries are still refused.

The [common explicit mode selector](managed-s3-maintenance-evidence.md) now binds working/cohort scope to the actual metadata configuration. It does not fall back to current-disabled mode if a working key or endpoint fails. Mandatory coordinator integration remains next.
