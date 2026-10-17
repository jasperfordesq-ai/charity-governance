## 17 October: native Docker cancellation and batch preflight

Read [Docker cancellation acceptance](managed-proof-docker-acceptance.md). Actual
worker cancellation leaves a daemon workload; exact-job reconciliation removes
it while another job survives. Every batch member is now validated before any
removal. Proof clients mask the image's unused anonymous data volume with bounded
temporary storage. Supervisor-death ownership, pending daemon requests, complete
orphan reconciliation and independent provider/host-loss gates remain open.

## 17 October: original-request source-job custody

Read [source job custody](managed-source-job-custody.md). Local job descriptors
now receive original-ACK-gated conditional custody before worker start, with a
separate immutable job namespace and exact observation pairing. Fresh discovery
learns job IDs/local pins from original candidate custody without replay or
reconstructed execution ACKs. Real provider/host-loss and supervisor ownership/
crash/orphan/daemon-request acceptance remain open; the full goal stays active.

## 17 October: original-bound local proof-job records

Read [protected job records](managed-proof-job-records.md). The original ACKed
common request now supplies frozen binding/pin/release context. The runner saves
exclusive readback-verified baseline and result observations; fresh read-only
handles verify exact pins and workspace identity without execution or repair.
Trusted restart catalogue/ownership, actual orphan/Docker crash acceptance and
independent provider/source-host-loss/current-authority gates remain open.

# Managed imported-proof worker supervision

17 October 2026. Internal runner used by the synthetic common native capture. No live activation or new operator recovery command.

## Execution contract

The runner starts a fixed worker file at the canonical checkout location with an explicit working directory and no shell. Database credentials stay in the worker environment; the bounded snapshot/argument/job envelope uses stdin. Ambient Node injection options are excluded. The original source-hashed helper still validates source identity, committed source, snapshot, protected files, capacity, isolated restore and artifact publication. Ordinary helper commands retain their existing behaviour.

Each invocation owns a fresh UUID job scope. All proof tools and the isolated restore container receive that label through the helper's internal imported-proof entry point. The scope is lexical to the dedicated worker call and is cleared in finally; no CLI/environment option grants this scope.

The supervisor bounds input, stdout, stderr and runtime. Success requires both actual worker exit and the exact successful acknowledgement, with no stderr. Cancellation, deadline, diagnostic flood, invalid acknowledgement, spawn/nonzero errors and uncertain termination all fail closed. Raw diagnostics and credentials are not returned. The supervisor does not turn a recovered observation into a new execution or publication grant.

On cancellation Windows uses taskkill /T /F against the currently owned live worker; Linux uses a separate process group and group termination. It waits for close/termination acknowledgement with a finite fallback; inability to establish terminal state remains unresolved. Killing the supervisor itself is a different crash case, not covered by this in-process finally path.

After the worker outcome, reconciliation uses the original verified local Docker boundary for every command. It filters only this invocation's job and proof labels, bounds the listing, inspects each full container ID and exact labels/name, and removes only those validated IDs. It repeats the listing afterward. Source containers, aliases, mismatched labels/IDs and malformed/oversized catalogues are refused. Residue after an otherwise successful worker also invalidates success. An absent listing is an observation of this job's containers, not proof that all provider work or in-flight daemon requests have ceased.

## Evidence and remaining work

Focused tests use actual Node workers for exit, cancellation, nested descendant termination, deadlines and output floods, plus synthetic Docker responses for exact-ID reconciliation and refusal paths. The combined native gate calls this runner for the genuine full database dump/isolated restore and original crypto/archive/journal flow against synthetic provider transports. The exact-release result is recorded in the ignored checkpoint.

The runner is not yet a supported production supervisor service: durable job receipts, restart ownership, supervisor death/orphan reconciliation, complete crash-safe container/remote-request lifecycle and a policy for retained partial artifacts remain required. Real independent provider/IAM/root-key custody, source-host-loss recovery, current preservation/disposal authority and guarded application reopening also remain open. The full delegated goal stays active.

Sources: Node documents [process exit versus stdio close and process groups](https://nodejs.org/api/child_process.html); Microsoft documents [taskkill's tree option](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill); Docker documents [label filters for container listings](https://docs.docker.com/reference/cli/docker/container/ls/). These contracts inform implementation, not a claim of provider or crash acceptance.
