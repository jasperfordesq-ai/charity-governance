## 18 October: mandatory managed mutation routing

COMMON_CANDIDATE kernel-contained restore proofs route mutating Docker requests
through the fixed independent user service. There is no direct-dispatch fallback.
The original parent checks the exact private input against its acknowledged
intent, source SHA, source input digest and protected descriptor, then verifies
the actual worker command, invocation and separate cgroup before OWNER ACK.
The private input travels over stdin and the protected local socket; saved
custody artifacts retain only its digest. An original outcome writer must ACK
the worker's result before the source can account its response.

Unknown launch or ACK prevents retry and final success. The parent waits up to
95 seconds for its original owner groups before closing the outcome gate;
each command is capped at 90 seconds and its output at one MiB. Only complete
original request/outcome accounting allows automatic container reconciliation.
Resetting terminal metadata of an originally owned unit grants no Docker
cleanup, replay or queue resolution. Read-only daemon probes remain separate.

This integrates source and owner lifetimes while the custody parent lives. It
does not prove custody-parent loss, provider IAM, independent physical host-loss
recovery, tenant authority or public-production readiness. Release-specific
native evidence and failure limits are recorded privately.

# Independent daemon request owner acceptance

## 18 October: ordered owner-outcome transport

The existing private channel supports a nonce-bound OUTCOME after the original
OWNER acknowledgement and before the source response. It checks the original
local owner byte pin and input digest, and accepts only one outcome for that
ordinal. The original parent may require an acknowledged outcome before source
response accounting; packets cannot choose or downgrade this requirement. In
that mode the response must match the acknowledged outcome's exact intent pin,
status, signal, transport-error and already-absent fields before its callback.
The callback must return an observation pin with no dispatch, queue-resolution
or action authority. Failed or unknown ACK consumes the channel. Fresh saved
reads do not recreate it.

The synthetic service probe now sends outcomes through this channel after source
context closure, including both SDK readback-ACK loss and original wire-ACK loss
after storage. The test parent still holds the writer and credentials. The actual
fixed worker and its source binding are now exercised as described below. Product
helper routing, custody-parent-loss outcome transfer and provider/host-loss proof
remain separate unfinished gates. Exact execution results are private.

## Fixed worker service acceptance

The fixed stdin worker validates original intent/arguments/storage and its actual
Linux user-service identity. All eleven executor modules, including the worker,
must match the exact canonical commit. Unbound startup refuses before dispatch.
Original OWNER ACK precedes execution; original OUTCOME ACK precedes returning
private output. Broken output pipes cannot trigger a repeated request.

The opt-in native probe launches that actual worker from the source caller using
a separate transient service. A protected socket forwards bounded input to its
stdin without a payload file, command-line credential or service environment.
Only fixed synthetic arguments and an empty credential environment are accepted
by that test caller. Successful client output is compared by exact hash/count.
Caller-loss cases stop the original caller group while the owner is executing;
the remaining parent retains the original outcome through its SDK writer.
OWNER-ACK loss must prevent dispatch; OUTCOME-ACK loss retains inspectable bytes.

[systemd-run](https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html)
documents service-manager ownership and `--pipe` forwarding. The worker service
uses pipe mode without `RemainAfterExit`; original cgroup observations and
retained outcome evidence remain distinct from queue finality. Actual native
results, including any failure, belong in the private checkpoint.

The product source helper still uses its existing dispatch path. The actual
worker acceptance probe does not connect every product mutation to this owner,
survive loss of the custody parent, establish provider IAM, or prove host-loss
recovery. Those remain required integration/acceptance work.

17 October 2026. This is a fixed synthetic acceptance probe for the next managed
request-owner implementation. It does not change the production imported-proof
dispatch path or resolve any saved pending request.

## Engineering choice and basis

Use a separately managed Linux user service for request ownership, outside the
calling source service's recursive control group. Its lifetime must be independent
of the calling client. Retain its original invocation/boot/source/request identity
before dispatch; preserve uncertainty if that owner is lost.

[Docker's run documentation](https://docs.docker.com/engine/containers/run/)
describes container execution separately from client attachment. A stopped client
does not constitute a general daemon request fence. The
[systemd-run source documentation](https://github.com/systemd/systemd/blob/main/man/systemd-run.xml)
describes service-manager execution and retained service metadata with
`RemainAfterExit`; that facility supplies an observable original unit boundary.
Neither document proves application-level queue finality or independent recovery.

## Executable probe

`scripts/managed-daemon-owner-probe.test.mjs` runs its live portion only on Linux
with `CHARITYPILOT_TEST_DAEMON_OWNER=1`. The fixture accepts no arbitrary command,
credential, endpoint, image or tenant data. It uses the already approved local
Docker boundary, pinned PostgreSQL tools image, a fixed short sleep/marker command,
no network, no published ports, read-only root, explicit PGDATA tmpfs, dropped
capabilities and bounded container/service resources. The probe and the existing
ten executor modules must exactly match canonical committed source.

The original test scope creates exclusive synced request and owner-ready records.
It checks actual unit invocation, separate groups, UID, no-new-privileges and
kernel resource caps before issuing a one-shot permit bound to their byte hashes.
It waits for the exact original container to be running before stopping the
caller. The owner must remain the same live invocation. In caller-loss mode it
then retains the original client response after that loss. In owner-loss mode it
must remain unresolved and must not invent a response.

Cleanup applies only to newly proposed test units and the original pinned test
container ID with matching name/image/nonce, after stopping the owned units.
Unexpected failures preserve the protected scope. It does not sweep old units,
containers, volumes or historical request records.

## Remaining integration and acceptance

The original job context now exposes `bindDaemonOwner`. It can conditionally
retain one owner-readiness record only after the original intent acknowledgement
and before that intent's response. Current header/intent metadata and exact-version
reads must still match the original acknowledged pins at this observation boundary;
an old version's continued availability alone is insufficient. This is not an
atomic provider lease. The record binds original candidate/job/service,
header and intent version pins, local intent bytes, and declared owner source,
input digest, boot, unit, invocation, UID, process start and control group.
Cross-boot/UID/source identity, source PID/invocation reuse, source group ancestry,
invalid scope and unknown/secret fields refuse. These are declared-identity
checks; the live adapter must independently verify actual kernel identity and
resource boundaries before calling the custody method.

The owner uses a separate conditional baseline/outcome scope:
`SHA256(CHARITYPILOT_DAEMON_OWNER_CUSTODY_V1 + newline + candidateId + newline + sequence)`.
Only ordinals 1 through 64 are valid. Concurrent, invalid, late, failed or unknown
ACK attempts consume the original writer. Fresh reads cannot revive it or replace
the proposed owner. The frozen parent context checks closed head/window before
and after retaining the record. No raw arguments, environment or credentials are
retained in this schema.

An original acknowledged owner can issue one process-local outcome writer before
the source response, while its source context is still live. The frozen writer
can retain one exact owner outcome after source-context closure. It expires after
120 seconds of monotonic elapsed time, is explicitly revocable and consumes its
only attempt before validation or provider I/O. Revocation after an accepted PUT
denies acknowledgement and retry while preserving any stored evidence. Outcomes
bind original owner/intent versions, local byte pins and owner input digest, with
status, signal and output hashes/counts; raw output and credentials are refused.
Saved reads cannot issue a replacement writer. This is an in-process evidence
capability, not scoped provider IAM, cross-process secret transport or a dispatch
permission. The adapter must still observe its original wire OWNER ACK before
issuing the writer and releasing execution.

Cold daemon discovery now checks 65 request scopes and 64 owner scopes, with
bounded before/after listings and exact pair/version validation. It reports owner
binding and outcome pins/counts separately. Each scope permits at most two objects
and requests at most three listing entries to detect overflow. An owner outcome
does not replace the source response/end accounting. A missing binding stays missing; a saved binding always
reports `independentOwnerDispatchVerified: false`. Neither presence nor absence
closes pending requests or proves historical completeness. `inspectOwner` can
inspect one exact binding but cannot reconstruct its original acknowledgement.

## OWNER transport and live verification

The private custody channel/client now support a nonce-bound `OWNER` record after
the corresponding intent and before its response. Only the original parent can
choose owner-required accounting; packets cannot negotiate or downgrade it.
In that mode a response without an original OWNER ACK is refused. The record's
stored pin still grants no execution authority, and the channel alone cannot
fence a caller that dispatches directly to Docker. The fixed service adapter must
prevent release until its original OWNER ACK is received.

`verifyIndependentDaemonOwner` checks a fresh service-manager identity and actual
process command line, boot, UID, no-new-privileges, cgroup membership and resource
caps. It rechecks the original source invocation, exact owner input digest and
separate group. The original parent supplies the expected command line; it cannot
come from the peer. Production verification permits only the reserved fixed owner
worker entry point, which is not implemented yet. The synthetic probe is allowed
only by an explicit internal synthetic option. Verification is an observation,
not a permanent kernel lease or queue-finality guarantee.

The live probe now joins this check, the actual original owner-binding API and a
synthetic signed SDK backend. Both pre- and post-storage live observations must
pass before the owner receives its release permit. Lost original channel ACK
after stored owner bytes must leave the independent service undispatched; fresh
inspection must find the saved binding without recreating the ACK. Caller-loss
and owner-loss still test actual Docker execution. The fixture accepts no tenant
data or selectable command; API credentials remain in the original test parent.
Its SDK custody is in-process and synthetic, with no independent provider claim.
The test parent issues the original outcome writer before release, closes its
source API context after stopping the calling service, and then retains the
owner's original result. A separate fault accepts the outcome PUT but loses its
readback ACK: retry is refused and a fresh reader can still inspect the saved
outcome without reconstructing the ACK. Owner loss revokes the unused writer.
The credential holder remains the test parent; loss of that parent and actual
owner-process outcome transfer remain untested and unimplemented.

The real source helper still dispatches its Docker clients in the source worker.
This probe is evidence about a feasible lifetime boundary, not completed product
request ownership. Integration must bind the original independent owner to each
original remotely acknowledged intent before dispatch, retain its result through
caller loss, and prevent retries or replacement owners after unknown ACK. A
client's definite response remains distinct from complete daemon queue/resource
accounting and current preservation/disposal authority.

Independent provider custody, owner/guardian/source-host loss, trusted restart
discovery, protected secret transport, safe archive admission and physical
host-off/replacement proof remain required. Every probe result denies pending
request resolution, cleanup authority, production integration and host-loss proof.
Exact results and remaining work belong in the private continuation checkpoint.
