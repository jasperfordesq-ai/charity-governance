# Read-role common candidate protocol

18 October 2026. The explicit format-10 maintenance plan now uses
`captureReadRoleCommonQuarantined`. Legacy capture entry points continue to
refuse that plan. The new candidate binding is format 4, and its original request
uses `MANAGED_READ_ROLE_COMMON_CANDIDATE_REQUEST_V1`.

## Original execution

The coordinator checks the exact closed control revision, attempt, source,
epoch, plan bootstrap and capture-authorization digest. The request also binds
capture, SQL privilege, metadata-window, journal and archive configuration
digests. The original conditional request write and exact readback must succeed
before entering the source or either live capture interval.

The shared source context hashes the complete versioned binding and original
request pin. Job/service/daemon custody accepts both strict common-binding
versions without stripping the new authorization fields. The original SDK outcome
transfer keeps its live-issuer and one-shot requirements.

After the joined read-role capture completes, the coordinator prepares and stages
the archive, saves the original prepared-root reference in the candidate report,
then attempts final root publication and independent read-only verification.
A lost request acknowledgement never starts source work. Lost report or root
acknowledgements preserve discoverable evidence and provide no automatic retry,
repair, admission or recovered execution acknowledgement.

## Strict stored evidence

The new report uses `MANAGED_QUARANTINED_READ_ROLE_COMMON_CANDIDATE`. It includes
the strict JWT capture record, declared configuration, original SQL privilege
window, metadata window, exported snapshot and prepared archive reference.
Validation checks the nested catalogue observation digest, exact role/database,
configuration digests, both Storage relations, source/epoch, file inventory and
archive identity. Legacy server-key records are not coerced into this shape.

Current discovery binds format-4 authorization to the format-10 plan preimage.
It refuses a substituted authorization or legacy capture baseline under that
plan. Read-only catalogue, source-job and root inspection retain their previous
no-replay, no-ACK-reconstruction and quarantine semantics.

## Proof boundaries

This implements the versioned source/journal/archive path. Appropriate native
source, dump/restore and SDK custody tests are still required for each source
revision; a passing schema or in-process mock does not prove those layers.
Exact executed evidence is recorded in the private handoff.

Provider signing-key currency, actual Storage role/project/database/release,
unfiltered RLS visibility, retained privileged canary/control credentials,
issuer/session/in-flight/control-plane fencing and independent physical-host-loss
recovery remain separate requirements. Their flags stay false. No route, provider
grant, tenant policy, real purge or reopening is enabled by this protocol.

## Executed synthetic verification — 18 October 2026

The exact native cohort passed the format-4 path with the canonical committed
source helper, real TLS PostgreSQL snapshot import/dump/isolated restore,
SDK encryption/MAC/exact-version archive custody, original prepared-root
reference, and fresh read-only source-job/root discovery. Success, root ACK
loss, report ACK loss, request ACK loss and job ACK loss were exercised. A
missing request ACK never entered the source; unknown later ACKs did not grant
repair or replay.

The separate-process cohort also passed with actual contained source services
and retained SDK outcome receivers. The five read-role captures were then
inspected by a fresh read-only process: two verified quarantined roots and three
unresolved outcomes, with no new writes or data keys. Existing legacy caller
SIGKILL coverage was retained; this does not claim a separate format-4 caller
SIGKILL test or physical host-loss demonstration. Selected fixture containers
and containment units were absent at the final gate.

These observations use synthetic HTTP and SDK provider transports. They prove
the bounded engineering path, not actual supplier IAM, current independent
authority, hosted token/key/release identity or usable independent host recovery.
Exact revisions, durations, logs, CI and deployed-state distinctions are recorded
in the ignored private handoff.

## 18 October integration update

Plan 12 now uses [candidate format 5 and original-record cold discovery](managed-retired-control-common-candidate.md). This supersedes earlier pending-integration notes above. Plan 11 remains refused. Actual native format-5 execution and provider/current-authority/host-loss acceptance remain open.
