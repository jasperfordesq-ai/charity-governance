# Current managed recovery inspection

17 October 2026. Internal read-only composition; not an operator restore,
provider activation, history repair or application-reopening command.

`ManagedCandidateCaptureJournal.inspectCurrentRecovery(control, minimumEpoch,
archive, signal)` composes the existing current-head discovery, original job
custody and common archive verifier. It requires the separately trusted
installation configuration, explicit reader credentials, archive configuration
and protected epoch floor. It accepts no local candidate IDs, source-release
guesses or saved result pins as current discovery authority.

## Read sequence

1. Read the live closed protocol9 head, its exact-version plan descriptor and
   the matching candidate catalogue using existing strict discovery methods.
2. For each common candidate, inspect its saved job baseline, service identity
   and optional result. Verify a saved common archive reference with the actual
   archive verifier, including its existing snapshot/index/object checks.
3. Read the current head, descriptor and full catalogue again. Changed revisions,
   descriptor pins, listing digests or candidate records refuse the whole result.
4. Re-read successfully inspected jobs and require matching saved pins, identity
   and outcome. Read the head once more after those job reads. Changes refuse.

Legacy non-common candidates remain explicitly labelled. Missing or corrupt job
evidence returns `jobStatus: UNRESOLVED`; a missing common report remains
`NOT_LISTED_AT_BOUNDARY`. Failed archive verification remains `UNRESOLVED`.
Those are not assertions that no job or root ever existed. Cancellation refuses
the entire inspection; it is not converted into an ordinary missing record.

A common candidate remains unresolved if its saved job lacks a version-two
original boot/group identity, lacks a recorded worker-success observation, or its
archive cannot be verified. Saved-record verification still does not prove the
current daemon has no accepted request, the source writer is fenced, or the
historical outcome was independently observed. No original acknowledgement or
missing evidence is recreated. Reads do not reserve another candidate, invoke
source work or republish an archive.

## Output and limits

Every result is `QUARANTINE_ONLY`. History completeness, monotonic history,
current tenant authority, host-loss proof, daemon-request accounting, writer
fencing, archive admission, cleanup, execution, publication and action authority
are false. Zero unresolved common candidates is an observation of the available
saved evidence, not a completion or reopening grant.

Head/catalogue boundary stability is not an atomic provider snapshot. The call
has a five-minute cancellation budget and existing per-operation bounds. It does
not renew a lease, assert provider immutability, establish an independently held
epoch floor or fall back to an older head/cache. All original provider and
physical host-loss requirements remain.

## Verification

Composition tests use the existing intercepted-SDK-command S3 fixture and an
explicit archive-verifier double. They exercise valid stored job/service/result
pairing, missing/corrupt jobs, missing reports, unavailable roots, head/catalogue/
job drift, a late head change during final job reads, higher epoch floor and
cancellation. They assert no writes or invented authority. Existing archive
crypto tests are a separate regression gate; the composition tests are not real
S3/KMS or native cold-process/whole-host-loss evidence.

The [reader provider policy](recovery-reader-provider-policy.md) is still a local
review artifact. Actual provider validation, independent credentials/custody,
native integration of this composition and source-host-off recovery remain open.
