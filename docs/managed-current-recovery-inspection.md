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

## Read-only diagnostic command

After building the API, run from its package directory:

```sh
node dist/jobs/inspect-managed-recovery.js --stdin
```

The equivalent package command is `npm run jobs:inspect-managed-recovery --
--stdin`. This reads one UTF-8 JSON document from standard input until EOF,
bounded to 16 KiB. It requires exactly:

- `archive`: the existing seven-field archive configuration (`installationId`,
  `bucket`, `accountId`, `storageKeyArn`, `dataKeyArn`, `indexMacKeyArn`,
  `rootMacKeyArn`). Four distinct Ireland keys and existing strict schemas apply.
- `control`: `installationId`, `bucket`, `accountId`, `kmsKeyArn`. Its
  installation must match the archive. A separate control bucket/account remains
  possible, subject to explicitly reviewed reader access.
- `minimumEpoch`: the separately trusted positive integer epoch floor.
- `credentials`: explicit `accessKeyId`, `secretAccessKey`, and optional
  `sessionToken`. Use the independently held, reviewed recovery reader identity.

Supply this through an approved protected input mechanism. Never put credentials
in command arguments, committed JSON, shell history or a shared transcript. The
command neither selects an ambient AWS profile nor falls back to environment
credentials, local pins, older heads or another endpoint. It fixes SDK endpoints
to AWS S3/KMS in `eu-west-1`, disables SDK retries/region redirects and closes its
clients on completion or refusal. Input chunk buffers are cleared; JavaScript credential
strings are not promised securely erased from memory.

Output is an allowlisted diagnostic summary: recorded source/epoch/head/plan bindings,
candidate and verified-root counts, per-common-candidate status, and false
authority flags. It does not print credential objects, provider error bodies,
archive contents, document inventories or saved service process identities.
Keep the summary private because operational identifiers remain confidential.
The recorded source is the original plan's release, not attestation of the tool
currently executing. `runningToolReleaseVerified` remains false; verify the
diagnostic tool's exact source/build separately before real provider acceptance.

Exit `0` means at least one available common archive was verified and none of
the observed common attempts was unresolved. Exit `2` means unresolved common
evidence or no verified common archive. Exit `1` means refused configuration,
scope, read or verification. None of these statuses certifies readiness,
complete history, real host-loss recovery, authority to restore or permission to
reopen. The command is a read-only diagnostic, not a supported restore workflow.

No AWS resources or grants are created. Running it against a real account needs
the already approved provider configuration, reader access and budget; SDK reads
can incur provider charges. The local policy generator supports one scoped
bucket/account; it does not silently grant a second control-bucket identity.

## Command verification

Tests cover output minimisation, unresolved and empty outcomes, inconsistent
counts/authority refusal, mandatory explicit credentials/floor/configuration,
and endpoint/local-pin injection. Actual child-command tests reject oversized
or malformed input without secret echo even when ambient credentials exist.
Positive command composition uses an internal test dependency; there is no CLI
test-mode or caller-selected transport. Real AWS command execution remains a
provider acceptance gate.

## Library verification

Composition tests use the existing intercepted-SDK-command S3 fixture and an
explicit archive-verifier double. They exercise valid stored job/service/result
pairing, missing/corrupt jobs, missing reports, unavailable roots, head/catalogue/
job drift, a late head change during final job reads, higher epoch floor and
cancellation. They assert no writes or invented authority. Existing archive
crypto tests are a separate regression gate; the composition tests are not real
S3/KMS or native cold-process/whole-host-loss evidence.

The [reader provider policy](recovery-reader-provider-policy.md) is still a local
review artifact. Actual provider validation, independent credentials/custody,
source-host-off recovery remain open. The separate synthetic keeper cohort now
also exercises this composition with original control custody and actual archive
crypto after source exit; exact native execution and proof limits are recorded
privately. That same-host volatile test does not close the real provider gate.
