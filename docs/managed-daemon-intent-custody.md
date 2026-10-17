# Original daemon intent custody component

17 October 2026. Provider-backed source component with synthetic SDK tests. The
fixed source helper does **not yet invoke this barrier**. Local daemon request
accounting remains its active path; independent pre-dispatch custody is not yet
an operational guarantee.

## Original write path

The original common-candidate context now exposes `reserveDaemonHeader` and
`reserveDaemonIntent` beside its existing job methods. Each checks the original
closed head and window signal before and after the call. The job implementation
requires its originally acknowledged descriptor and service, no attempted job
outcome, and a version-two original boot/group binding. Saved inspection cannot
recreate that acknowledgement. Closing the context revokes these methods.

The new `ManagedDaemonIntentCustody` verifies the original job/service envelopes
and exact pins. It accepts the existing local header V2 and chained intent V2
records as bounded byte/hash artifacts. Header job/input must match the original
service. Intents must match job, sequence, previous local digest and header image.
Storage plan V2 checks require explicit PGDATA tmpfs, unique allowlisted targets,
bounded approved tmpfs options, hashed bind sources and readonly backup/CA binds.
Unknown fields, raw arguments/credentials and unsafe storage shapes refuse.
An image digest in preserved evidence is not independent approval to run it.

Header and each of at most 64 intents use conditional creation and exact-version
readback with expected owner, SHA-256 and SSE-KMS. The existing `capture-job`
namespace is reused with a new domain-separated scope:

`SHA256(CHARITYPILOT_DAEMON_INTENT_CUSTODY_V1 + newline + candidateId + newline + sequence)`

Sequence zero is the header. Each scope contains only `baseline.json`. The
envelope binds candidate digest, original job/service pins and header custody
pin. Existing job/service/candidate paths and envelopes are unchanged.

Writes are serial and one-shot. Invalid/failed/lost acknowledgements or concurrent
calls consume the live component; they do not permit retrying the original
intent. Scope is checked again after asynchronous reads/writes. Returned pins
cannot mutate its private acknowledged state. Snapshots of input records prevent
changes during an asynchronous save from changing the accepted local chain.

## Saved reads and proof limits

Read methods verify exact original envelope context, header and an explicitly
selected ordinal/expected previous digest. They can discover stored header/intent
pins without a live producer acknowledgement. The constructor still needs the
original verified job/service envelopes and pins; this component does not yet
implement complete unknown-ordinal catalogue discovery or wire it into the
current recovery inspector.

Every read/write result denies dispatch/action authority. A saved intent is not
a daemon response, resolution, full inventory, cancellation fence or replay
permission. This component does not forward Docker requests or own their later
completion. Source compromise, rollback protection, real IAM/immutable custody,
physical host-loss recovery and current tenant authority are not established.

## Next integration gates

1. Wire the fixed helper's original local header/intent into an authenticated,
   credentialless barrier to the original context; require its original custody
   acknowledgement before actual daemon dispatch. Do not put cloud credentials
   in the helper or infer permission from a saved record.
2. Bind and retain original responses/end accounting separately; make unknown
   dispatch/completion remain unresolved after caller/guardian/host loss. Complete
   the independently surviving owner or proven daemon-side fence before closure.
3. Implement fresh complete bounded discovery under original candidate/job
   custody, without local process-memory pins or invented acknowledgements.
4. Run genuine SQL/restore, original ACK-loss/concurrency/cancellation, source
   caller kill, independent provider/host-off and guarded recovery tests. Do not
   call local or synthetic SDK tests activation or provider acceptance.

The API test cohort covers original service gating, canonical scope/chain,
immutable persistence, cold read methods, unknown ACK without retry, revocation
during reads, concurrency, unsafe/secret input refusal and the 64-intent bound.
Exact results and remaining work are recorded in the private checkpoint.
