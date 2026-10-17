# Managed quarantine-only Storage capture composition

17 October 2026. Internal source integration; not activated in a hosted provider
or deployed to the private VM. No new cloud resources, permissions or key changes.

## Existing coordinator integration

`ManagedBackendMaintenance.captureQuarantined` joins the existing maintenance
coordinator, actual Supabase file-capture class and guarded PostgreSQL metadata
window. It requires a candidate UUID, original maintenance attempt UUID, exact
control revision and expected capture/window configuration digests. A separate
candidate ID distinguishes quarantined sets without changing the original attempt.

Before capture, it checks installation/project/bucket/retained credential ID
against the storage controller and both component digests. It requires the exact
OBSERVED_CLOSED head, source-bound protocol9 plan, epoch and installation. The
existing inspection validates original evidence and freshly observes its supported
metadata/read paths; this does not imply fresh active S3/upload refusal probes or
whole-Storage exclusion. The exact version/ETag/body-bound control revision is
checked before and after inspection, before entering the window and after capture.

The window calls the actual file capture with its cancellation signal. The
visitor receives file bytes, digest and cancellation signal; an archive visitor
must propagate that signal, use conditional candidate storage and avoid admission.
Completed capture is rechecked against the expected digests and the unchanged
control head with another inspection. No new control phase is written, no shutdown
is repeated and no old immutable receipt is rewritten. The default shutdown plan
stays protocol9; this additional candidate binding does not upgrade its guarantee.

The returned bundle binds installation, source version, maintenance epoch, original
attempt, control revision, candidate ID, plan and component configurations, candidate
inventory/byte hashes and metadata interval evidence. It remains QUARANTINE_ONLY.
Object-byte fencing, whole-backend quiescence, current tenant authority, archived-set
admission and action authority are explicitly false. The bundle digest is not an
independent signature or durable publication acknowledgement.

## Partial work and unresolved outcomes

Wrong scope, substituted configuration/attempt/revision, changed control head,
changed source bytes, failed visitor, lost lock/transaction acknowledgement or
cancellation cannot return a completed candidate bundle. Encrypted versions written
by a visitor before failure remain quarantined. This method neither deletes them
nor retries, backfills an acknowledgement, publishes an authenticated set root,
advances a latest pointer, restores live state or authorises reopening.

The caller must retain original candidate identity and custody receipts. There is
no durable candidate-attempt reservation/resume journal in this method yet; do not
interpret its candidate ID as a persisted execution guard. Reconciliation and
root/index publication must use separate guarded custody/admission contracts.
A caller must not change IDs to disguise an unresolved publication or treat a
partial encrypted object as a recovered set.

## Executed proof

Unit coverage uses the actual parent and file-capture class with an explicitly
synthetic window. It covers success, scope/configuration/attempt/revision
substitution, byte drift, head drift and unknown window acknowledgement. Existing
coordinator and capture tests remain passing.

The existing native disposable TLS PostgreSQL gate also invokes the actual parent,
metadata-window, file capture, document encryption, KMS-key adapter and conditional
S3 document-archive classes. It checks the actual granted SHARE lock and reads the
synthetic metadata row during the byte visitor. Candidate bytes are sealed with
AES-GCM, published once with expected owner/checksum/SSE-KMS and exact-version
readback, and compared through a source-held-digest encryption roundtrip. Provider
HTTP, S3 and KMS transports are synthetic; no real supplier IAM or custody is proved.
The database-context hash is explicitly synthetic, not a captured database dump.
This roundtrip is not source-host-off recovery or independent manifest admission.

Successful capture returns one scoped quarantined candidate. Source byte drift
after one archived object and an S3 acknowledgement lost after storage both reject,
leave their original encrypted versions and preserve the control revision. Exactly
three candidate object writes occur across these three separate test cases; no
root/index or disposal write occurs. Original supplied file buffers and owned KMS
plaintext responses are checked cleared. The test does not claim erasure of all
JavaScript strings or caller-owned copies.

## Remaining full-goal work

Establish the actual provider-supported DB/Storage/project/release mapping and
complete relation/actor coverage. Stop or independently account for non-SQL bytes,
in-flight uploads/multipart, cleanup, current issuers and privileged control-plane
actors. Join database capture and file custody under the common boundary, persist
original candidate execution/report evidence and root/index bindings, and finish
quarantine admission under independently current preservation/disposal authority.
Complete whole-application restore/replacement identities/secrets/sessions,
repeated epochs, source-host-off and guarded reopening proof. Further personal
Nikita review is optional; those engineering/provider gates remain required.

See [metadata interval](managed-storage-metadata-window.md),
[remaining boundaries](managed-writer-capture-audit-2026-10-17.md) and
[archived recovery sets](archived-recovery-sets.md).
