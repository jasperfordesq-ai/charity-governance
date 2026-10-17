# Original daemon intent custody component

17 October 2026. The default kernel-contained COMMON_CANDIDATE source path now
requires original custody acknowledgement before helper daemon mutations. The
internal IPC and standalone proof paths remain explicitly outside this guarantee.
Actual independent provider/host-loss acceptance remains open; exact native
execution results are recorded privately.

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

## Credentialless dispatch barrier

The original parent holds the cloud custody interface and a private, job/input/
release-bound Unix socket. A protected descriptor contains only its per-job
capability, never provider credentials. The fixed helper uses a short-lived
minimal-environment client because its Docker dispatch is synchronous. That
client requires exact ownership/modes/path, original scope, a fresh nonce and
matching acknowledgement bytes. It has no transport/profile/command selector.

The required barrier is bound into the worker input and service input digest.
The helper retains its built-in-only import boundary. The fixed, exact-source
worker supplies the internal acknowledgement callback and owns the custody-client
import; no callback, module or command is selectable through operator JSON or CLI
flags. This keeps standalone helper implementation authority confined to its
own source file while the contained path additionally verifies all ten modules.
Missing descriptors, refusal or unknown ACK stop before dispatch. An uncertain
intent ACK permanently prevents subsequent helper mutation attempts. Header and
each local intent are flushed before their custody request. Original success
also requires the channel's acknowledged count to match the completed local
request catalogue. Saved records never recreate that live context.

The helper receives only reviewed OS fields and its explicit source database
credential; cloud/recovery/signing credentials stay out of its environment.
Ambient Docker is validated before filtering. The actual executor source guard
now pins ten modules, including both new dispatch-affecting modules. Original
channel metadata binds the gate directory's identity without storing its
capability, permitting exact attribution by the synthetic fault-test owner.
That metadata grants no operator cleanup or recovered execution permission.

## Remaining integration gates

1. Verify the exact-release source/helper/channel composition with actual Linux
   source/SQL and lost header/intent ACKs. Preserve the difference between
   synthetic custody outside a source process and real independent providers.
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
