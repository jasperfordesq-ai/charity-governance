## 17 October: fixed kernel-contained launcher is the runner default

Read [contained runner](managed-proof-contained-runner.md). The original helper
runner now requires non-root Linux systemd containment by default, exact executor
source bytes, original service custody acknowledgement, actual successful service
exit and an empty original cgroup. The cross-platform SQL fixture explicitly uses
INTERNAL_IPC_PROOF and reports kernelContained=false. Live Linux synthetic tests
cover success, denied acknowledgement, cancellation, guardian loss, unknown launch
acknowledgement and refusal to adopt an existing unit. Genuine contained SQL and
independent provider/source-host-off recovery remain open; the full goal is active.

## 17 October: original-job service binding and custody

Read [service identity custody](managed-proof-service-custody.md). A fresh guardian
identity is now recorded against the exact protected job baseline and input
before work. The original candidate session exposes one-shot immutable service
custody; fresh discovery reads it without recreating an execution acknowledgement.
Real Linux guardian tests now use the protected local job binding. The production
systemd launcher and genuine capture activation remain required. Full delegated
product, provider/current-authority and source-host-loss scope remains active.

# Private connection to a systemd proof guardian

17 October 2026. Internal Linux transport for the managed source-executor integration. The original capture runner still uses inherited IPC; this transport has not been activated or deployed as its replacement.

## Ownership and release of work

The parent creates a fresh owned mode-0700 temporary directory and mode-0600 Unix socket, accepts one connection only and keeps it open for the job lifetime. There is no TCP listener or persisted credential payload. Node documents [Unix socket IPC and crash-path cleanup](https://nodejs.org/api/net.html#ipc-support). A crashed parent may leave its socket directory for bounded inspection; the pathname never becomes a new execution lease.

The service connects only from a non-root Linux operator with the expected private socket ownership. Its HELLO carries the current systemd invocation, exact job unit, UID and main PID. The parent reads the service manager and current kernel membership, then offers an immutable binding to the original caller's mandatory acknowledgement callback. The binding includes job, unit, invocation, current main PID and start timestamp, release SHA and a digest of the exact already-copied input. The callback must return exactly true. The manager identity is re-read after the asynchronous acknowledgement and before any input/environment is sent. Both sides require the input job to match the unit job. Unknown identities, duplicate frames, missing acknowledgement, oversized frames, unsafe runtime environment overrides, timeout and channel loss refuse rather than replay.

The actual guardian supports this transport through its fixed `--systemd-socket` entry point. Its worker path remains fixed in production. Input and environment travel through the private live socket; they are not placed in service-manager command arguments or receipts. The guardian retains its owned worker handle, bounded timeout, terminal-before-reconciliation ordering and unresolved cancellation semantics. The socket reply acknowledges only the guardian protocol: a future production launcher must also verify actual service termination and original cgroup emptiness. It must not equate a socket reply with whole-job success.

## Executable evidence

`managed-proof-channel.native.test.mjs` explicitly opts into a non-root Linux host with an existing systemd user manager using `CHARITYPILOT_TEST_SYSTEMD_CHANNEL=1`. It launches bounded fresh transient services using the actual guardian implementation and a synthetic no-Docker worker. Its cleanup targets only freshly proposed names and protected test directories. Default CI does not silently pretend to run this host capability gate.

Four cohorts are checked against an independently running control service:

- The manager identity is acknowledged, the worker completes, the guardian replies and the service exits successfully.
- A refused identity acknowledgement never starts the worker and never produces a success reply.
- Killing the actual parent closes the socket; the guardian stops its owned worker and records an unresolved test receipt.
- Killing the guardian main through the manager stops the worker through cgroup containment, produces no success reply and leaves the original cgroup empty.

All cohorts require the separate service's original invocation to survive. Synthetic identity receipts, cleanup callbacks and worker paths belong only to the source fixtures. The test release SHA is a deliberate fixture value; its receipt is not real provider custody or an execution authorization. Exact source-bundle hashes, host/test results and diagnostic history are in the private checkpoint.

The existing Windows IPC Docker cancellation/parent-loss tests are retained. During this refactor they caught a receipt regression: explicit cancellation was incorrectly reported as parent disconnection. The IPC adapter now preserves that distinction; a later real disconnect remains sticky. The exact live Docker regression passes after the fix.

## Next required integration

Bind the fresh unit/invocation observation to the original source-job descriptor and independently acknowledged custody before releasing genuine capture work. Add a fixed production service launcher, bounded resource/runtime configuration, service termination and cgroup-empty observation, unknown-launch cleanup, and genuine source/SQL proof through that path. The current callback seam is not a substitute for those obligations.

The Docker daemon is outside this cgroup. Pending daemon requests, restart/orphan ownership, complete resource accounting, real independent provider/key/current-preservation authority and actual source-host-off recovery/reopening remain open. Earlier unexplained source refusal and unattributed scratch-volume uncertainty remain separate. Existing personal-server installers, update/recovery wrappers, support scope, tenant adoption and public-production gates are unchanged. The full multi-organisation/optional-Confluence goal remains active.
