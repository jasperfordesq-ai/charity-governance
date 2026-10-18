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
