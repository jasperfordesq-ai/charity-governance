# Durable quarantined candidate request and report custody

17 October 2026. Internal implementation; no hosted activation, real supplier
resources/IAM, tenant policy changes, deployment or spend. Full recovery remains
unfinished. Further personal Nikita review is optional.

## Required coordinator sequence

`captureQuarantined` now requires `ManagedCandidateCaptureJournal` and a declared
journal configuration digest. Candidate binding format2/V2 adds that digest;
pre-journal requests cannot execute this new workflow. Original protocol9 shutdown,
head formats and historical archive readers are unchanged.

After exact original closed-head and component checks, the coordinator:

1. Builds the source/epoch/plan/attempt/revision/candidate/component/journal binding.
2. Conditionally writes the immutable REQUESTED_ONLY record and verifies its exact
   version/body readback before entering the metadata window or invoking capture.
3. Rechecks the original head, performs guarded file capture, then repeats head
   and supported metadata/evidence inspection.
4. Snapshots the full candidate report, including the original request pin, and
   conditionally stores/read-verifies a separate exact-version report.
5. Rechecks the head and returns the stored candidate snapshot with both pins.
   In-process publication permission is cleared on every acknowledged run's exit.

There is no default no-journal fallback. An unknown request write/readback ACK
stops before capture. An unresolved file capture leaves the request plus any
partial encrypted files. An unknown report publication ACK cannot return a
completed workflow result. No branch retries, overwrites, changes candidate IDs,
repeats shutdown, reconstructs a command ACK, writes a recovery root/index/latest
pointer or admits/restores/reopens anything.

## Custody and bounded contracts

The existing `S3MaintenanceArtifactStore` gains only the capture-candidate namespace.
Other paths and size ceilings stay unchanged. Each candidate uses
`managed-maintenance/<installation>/<attempt>/capture-candidate/<SHA256(candidateId)>/`.
The path depends on candidate identity, so changing configuration with the same
candidate cannot select a fresh key. Binding changes on a cached candidate also
refuse. Cross-bucket/global identity enforcement is not established by this path.

Request and full-report files use If-None-Match:*, expected bucket owner, SSE-KMS,
checksums and exact version readback. The request limit is 8KiB. The separate
report limit is 128MiB, accommodating the source capture's bounded 5,000-file
metadata inventory without fitting it into the unchanged 8KiB control head.
Report handling is buffered and is not a measured host-memory readiness claim.
The schema accepts only known nested fields and conservative scope flags, checks
binding/report/window digests and file/object agreement, and rejects unknown
fields that might accidentally contain secrets. Source documents are encrypted
separately; this report holds private paths/metadata/hashes, not plaintext bytes
or raw credentials. Actual bucket privacy, key custody, IAM and retention remain
activation requirements.

The journal snapshots caller data before awaited I/O and returns a copy of the
exact stored report. A mutable caller container cannot change the stored report
or returned candidate during readback. Inspection cannot activate the private
publication permission; only the original acknowledged conditional request can.
A fresh session cannot backfill a missing report from later observations.

## Restart inspection

A new journal client with the separately trusted original binding can:

- inspect a supplied exact request pin, or discover the saved request through
  current checksum/version metadata followed by exact-version body validation;
- inspect an exact report pin paired with its original request pin, or discover
  the report and then validate that same exact version and request pairing.

Single-candidate discovery above performs GETs only; unknown-ID catalogue discovery
now also uses scoped LIST through [the bootstrap catalogue](managed-candidate-catalogue.md). It does not list, create keys, decrypt document
contents, repeat provider probes/capture, publish, or rewrite records. Missing,
forbidden, malformed or ambiguous reads remain unresolved; an absent report never
proves capture did not run. REQUESTED_ONLY describes the request record, not a
claim that execution never began. Saved observations explicitly do not authorise
execution/admission or reconstruct an original acknowledgement.

AWS conditional writes check the current object version; a delete marker can
permit a subsequent write. Before live use, verify deletion/version-deletion and
lifecycle exclusions, conditional-write policy enforcement, independent custody
and privileged actor boundaries. The client methods do not prove permanent
anti-replay enforcement or supplier policy state.
[AWS conditional-write contract](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html).

## Executed evidence and remaining goal

Focused tests cover request/report ACK loss, fresh read-only discovery, refused
replay, refused publication from an inspection-only session, substituted bindings,
unknown fields/authority flags and mutation during awaited report publication.
The native TLS PostgreSQL composition uses the actual parent/window/file capture,
AES-GCM/KMS adapter, conditional document archive and journal classes. It covers
success, byte drift, lost file ACK, lost request ACK and lost report ACK; fresh
clients discover originals without new data writes or file capture. HTTP, KMS
and S3 transports remain synthetic. No real IAM, independent manifest admission,
actual database dump or source-host-off recovery is claimed.

The full report and original request are now retained by the synthetic custody
workflow. Still required: real provider-backed discovery and a separately trusted multi-epoch/bootstrap catalogue;
complete DB+file capture under the supported provider boundary; non-SQL/in-flight/issuer/control-plane writer accounting; file receipt
and index/root linkage; independently current preservation/disposal authority;
whole-application quarantine/replacement, identities/secrets/sessions/repeated
epochs and actual provider/host-loss/guarded reopening proof. These records remain
quarantine-only; they do not create a tenant Board approval or policy adoption.
See [capture composition](managed-quarantined-storage-capture.md).
