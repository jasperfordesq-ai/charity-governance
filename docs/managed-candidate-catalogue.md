# Read-only candidate bootstrap catalogue

17 October 2026. Internal discovery from independent journal storage, with native
PostgreSQL composition and synthetic S3 transport evidence. No real provider
activation/IAM change, deployment, procurement or host-loss certification.

## Trusted bootstrap and discovery

`ManagedCandidateCaptureJournal.discoverCandidates` takes an original trusted
attempt ID, plan digest, source version, maintenance epoch and control revision.
The journal's installation/bucket/account/key configuration must also be trusted
outside the lost source. Candidate IDs are deliberately not inputs. Do not derive
a trusted source/epoch or storage identity from whichever candidate is found first.
A separately protected multi-epoch/root bootstrap remains required.

Discovery lists only the installation/attempt's capture-candidate namespace with
expected bucket owner, no delimiter or start-after filter, and bounded opaque
continuation tokens. It verifies response scope/counts/shape, refuses repeated
keys/tokens, malformed or unexpected paths and incomplete page sequences, and
never substitutes an empty catalogue after a failed response. Bounds per listing
are 20 pages, 2,000 keys and 1,000 candidate groups, with a five-minute overall
budget and bounded requests/streams. Directory buckets are unsupported.
[AWS ListObjectsV2 contract](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html).

Each listed request is read under an 8KiB limit and its ETag/size/SSE-KMS/version/
checksum checked. Its full strict request contract must match the trusted bootstrap
and journal configuration. SHA-256(candidateId) must match the listed directory.
The request is then verified again using its exact version and canonical original
bytes. A report, when listed, is paired with that exact request version and fully
validated through the existing journal contract. Unpaired reports or wrong source,
epoch, plan, head, candidate path or journal identities leave discovery unresolved.

The complete listing is repeated after record reads; any observed listing drift
rejects the result. Stable boundary listings do not prove a cross-page atomic
snapshot, unseen/deleted-version history or absence of changes between reads.
No partial result is promoted into a complete catalogue. The maximum report remains
128MiB and processing is sequential; this is not measured host-memory readiness.

## Result and authority limits

The result contains learned bindings, exact request/report pins, report digests,
object counts and a listing/result digest. It does not return full file inventories
by default. Individual exact records remain available through journal inspection.

SAVED_REPORT_OBSERVED means the saved scoped report was read; NOT_LISTED_AT_BOUNDARY
means no report key was seen in that listing. Neither reconstructs its original
publication ACK. Missing reports do not prove capture never ran. Empty listings
do not prove an unused installation, complete erasure or permission to recover.

History completeness, cross-page snapshot, actual source-host loss, reconstructed
ACK, saved-observation execution, archive admission and action authority are all
explicitly false. Discovery invokes only LIST/GET, never provider probes, database
queries, capture, data-key generation, document decryption, publication, disposal,
repair, takeover, resume or reopening. It cannot activate a journal publication
permission. Invalid, cancelled or ambiguous reads return an unresolved error.

The journal now shares one explicit, pinned regional SDK client across its sessions
and discovery. Actual prefix-scoped ListBucket/GetObjectVersion/SSE-KMS permissions
must be verified before activation; no grant is made by source code. Deletion,
version-deletion/lifecycle exclusion, conditional-write enforcement and privileged
actor/rollback proof remain required. This is observed current-namespace discovery,
not a signed monotonic catalogue or independently current preservation authority.

## Executed coverage

Unit tests exercise unknown-ID bootstrap with multi-page traversal, exact version
reads and SDK-style body cancellation ownership. They reject malformed/repeated
pages, explicit null contents (never converted to empty success), duplicate/out-of-scope keys, orphan reports, listing drift, wrong bootstrap,
path/body substitution and pre-request cancellation. An uncooperative listing
transport is cancelled without body reads or writes.

The native composed workflow first produces five real guarded candidate test
cases and their journal records. It disconnects the source PostgreSQL holder and
creates a fresh GET/LIST-only SDK client. Using only trusted storage/attempt
bootstrap, it discovers all five unknown IDs, observes two saved reports and three
unresolved report absences. No new candidate write, capture or KMS response occurs.
Actual PostgreSQL/TLS/locks/encryption are native; cloud transports are synthetic.
The backend map remains in the test process, so actual source-host-off recovery
and independent provider custody are not proved.

## Remaining full-goal work

Verify real provider discovery/IAM and retain its trust bootstrap independently.
Complete a protected multi-epoch catalogue/current-authority and rollback model;
join database capture, file receipts and authenticated index/root publication under
the common supported boundary. Account for non-SQL/in-flight/issuer/control-plane
writers and independently current preservation/disposal decisions. Complete actual
whole-application quarantine/replacement, identities/secrets/sessions/repeated
epochs, provider/source-host-off and guarded reopening evidence. The existing `recovery-authority-journal.ts` and `recovery-authority-s3.ts`
provide authenticated head, revision/CAS and scoped history contracts. Reuse those
semantics where scope fits; the organisation-bound authority ledger and Confluence
V2 source history must not be replaced or treated as installation-wide candidate
policy. The full delegated goal remains active; further personal Nikita review is optional.

See [durable candidate journal](managed-candidate-capture-journal.md) and
[remaining writer/capture boundaries](managed-writer-capture-audit-2026-10-17.md).
