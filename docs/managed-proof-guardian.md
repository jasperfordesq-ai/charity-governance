## 17 October: kernel containment capability verified on the private VM

Read [kernel containment probe](managed-proof-kernel-containment.md). A non-root
systemd/cgroup-v2 probe kills a fresh service main, verifies its detached child
stops, and preserves a separate control service. This is OS-mechanism evidence,
not yet real guardian/capture integration, daemon fencing or host-loss proof.
The managed executor will require verified kernel containment before activation;
existing personal/public profile gates remain unchanged. Full goal stays active.

# Live IPC guardian for imported-proof workers

17 October 2026. Internal managed source runner; no deployed supervisor service or restored execution lease.

## Ownership and execution

After the original source-job descriptor acknowledgement, the parent starts a fixed guardian with private inherited stdin/stdout/stderr and IPC. The guardian starts exactly one fixed proof worker. The worker's synchronous Docker/helper operations cannot block the guardian's parent-loss event loop. The guardian holds the runtime ChildProcess handle; no PID is recovered from metadata or used to restart a job.

The guardian has independent process lifetime on both platforms and is configured with its Windows console hidden. Node documents [detached process and inherited IPC behaviour](https://nodejs.org/api/child_process.html#optionsdetached). The initial Windows parent-loss test failed with detachment disabled; enabling it passed the controlled abrupt-parent-kill comparison. That result does not establish every possible host/process containment case.

The original caller timeout is forwarded through an explicitly overwritten internal setting, strictly bounded to the same 50 ms–20 minute range; ambient copies cannot select a different deadline. Normal cancellation sends a narrow IPC cancel message and waits for guardian close. IPC disconnect or malformed control messages cancel the owned worker. Before starting the worker, the guardian checks the live channel, bounded startup input and original UUID. The actual worker retains strict input/source/snapshot/proof guards. Production stdin cannot choose a worker path or command. Static dependency fixtures use a synthetic Docker worker for acceptance tests.

The guardian aborts its worker supervisor, waits for owned terminal state, then attempts original exact-job container reconciliation through the existing verified local daemon boundary. A successful reply requires the original worker exit/acknowledgement, no cancellation/parent loss and no residual job containers. Cancellation and parent loss stay UNRESOLVED even when cleanup observes absence. Default production guardian writes no terminal receipt or replacement journal entry; the original parent is still the only live candidate-custody caller.

## Evidence

Real Docker tests cover normal cancellation and abrupt SIGKILL of the calling fixture process while a workload is running and the worker is blocked in a real synchronous Docker exec client (a tmpfs marker confirms entry). A surviving guardian stops its worker, removes the exact job workload and records a test-only count/flag receipt in a protected temporary workspace. Another running job survives. Test metadata never grants execution, publication or action permission. Standalone guardian execution without original inherited IPC refuses before work.

The same existing CI Docker command now includes these cases. The full native database/source/encryption/journal gate verifies the fixed production guardian and worker path. Release-specific counts and failures are in the private checkpoint.

## Remaining gates

This proves loss of the calling parent while the guardian survives, after a synthetic container creation is independently observed. It does not prove simultaneous guardian/parent death, saved-PID kernel identity, cgroup/job-object containment, supervisor ownership after restart, pending daemon creates, complete orphan accounting or source-host loss. Unknown termination remains unresolved; no old descriptor grants another worker or cleanup lease.

Trusted real provider/IAM/root-key/epoch/current-authority and whole application host-off recovery/replacement/reopening remain required. The previous unexplained early source refusal and unattributed scratch resource uncertainty remain open, separately from the Windows detachment issue resolved in this test. The full delegated product/Confluence goal stays active.
