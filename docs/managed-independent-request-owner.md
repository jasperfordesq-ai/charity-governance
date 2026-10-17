# Independent daemon request owner acceptance

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
and before that intent's response. The record binds original candidate/job/service,
header and intent version pins, local intent bytes, and declared owner source,
input digest, boot, unit, invocation, UID, process start and control group.
Cross-boot/UID/source identity, source PID/invocation reuse, source group ancestry,
invalid scope and unknown/secret fields refuse. These are declared-identity
checks; the live adapter must independently verify actual kernel identity and
resource boundaries before calling the custody method.

The owner uses a separate conditional baseline scope:
`SHA256(CHARITYPILOT_DAEMON_OWNER_CUSTODY_V1 + newline + candidateId + newline + sequence)`.
Only ordinals 1 through 64 are valid. Concurrent, invalid, late, failed or unknown
ACK attempts consume the original writer. Fresh reads cannot revive it or replace
the proposed owner. The frozen parent context checks closed head/window before
and after retaining the record. No raw arguments, environment or credentials are
retained in this schema.

Cold daemon discovery now checks 65 request scopes and 64 owner scopes, with
bounded before/after listings and exact pair/version validation. It reports owner
pins/counts separately. A missing binding stays missing; a saved binding always
reports `independentOwnerDispatchVerified: false`. Neither presence nor absence
closes pending requests or proves historical completeness. `inspectOwner` can
inspect one exact binding but cannot reconstruct its original acknowledgement.

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
