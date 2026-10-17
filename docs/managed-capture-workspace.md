## 17 October: original-bound local proof-job records

Read [protected job records](managed-proof-job-records.md). The original ACKed
common request now supplies frozen binding/pin/release context. The runner saves
exclusive readback-verified baseline and result observations; fresh read-only
handles verify exact pins and workspace identity without execution or repair.
Trusted restart catalogue/ownership, actual orphan/Docker crash acceptance and
independent provider/source-host-loss/current-authority gates remain open.

# Protected managed-capture workspace

17 October 2026. Internal source component; no deployed service or operator recovery command is introduced.

The managed common native capture now reads the actual full-proof database dump through a bounded verified stream, seals it through the existing authenticated encryption implementation into a private ciphertext file, then streams the verified ciphertext into the existing exact-version custody service. It no longer buffers that complete dump in memory. Small bounded JSON reports remain buffered; the separate diagnostic correlation dump retains its existing 16 MiB bound.

## Filesystem and stream contract

- The caller supplies an absolute, canonical, already private directory outside the checkout. The factory verifies existing parent permissions and creates a fresh private child; it never broadens or rewrites the existing parent ACL.
- Linux requires operator ownership and modes 0700/0600. Windows uses the existing bounded ACL helper, with hidden child processes and capped diagnostics. Directory identities and canonical paths are rechecked. Filenames are bounded portable basenames; device names, traversal and symlinks are refused.
- Actual producer files are pinned by descriptor identity after protection. Reads verify identity, exact length and SHA-256, including checks after streaming and access verification. A successful read is an observation, not recovery or publication permission.
- Source reads and ciphertext writes use 64 KiB chunks/backpressure. Ciphertext creation is exclusive and attempted once per filename, including failed attempts. Completion requires finished writes, flush, exact count/hash and a protected file pin. Its subsequent upload source independently hashes the actual file bytes.
- Cancellation and close release owned streams/descriptors, including an opened reader that was never consumed. Failed or incomplete artifacts remain for supervised diagnosis; this component never deletes, overwrites, retries publication or admits an application.

Node's [file-handle close contract](https://nodejs.org/api/fs.html#filehandleclose) waits for pending operations. The implementation uses the documented [Writable lifecycle](https://nodejs.org/api/stream.html#class-streamwritable) for writes, flush and destruction. Healthy completed ciphertext streams have explicit completion tracking rather than treating automatic destruction as failure.

## Evidence and limits

Workspace unit tests cover successful verified transfer, changed source, unopened-stream cleanup, abort/partial retention, one-shot failed completion, length/hash refusal, directory substitution, checkout boundary names beginning with two dots, and symlink refusal. Windows skips the symlink case because elevated symbolic-link privilege is not assumed; Linux exercises it.

The combined native gate uses real TLS PostgreSQL, the original full source/isolated-restore helper, actual encryption/custody/archive/journal classes, and synthetic SDK storage/KMS transports. It retains success and lost request/report/root acknowledgement cases. Before fresh reconciliation, source artifacts and ciphertext are removed and the snapshot holder is disconnected. The main database and test process remain alive; this is not real source-host-loss or independent provider proof.

Still required: supported production process supervision and cancellation of the complete helper/container cohort, durable job receipts and crash/orphan reconciliation, independently current authority and trust-root/key custody, actual provider/IAM/writer mapping, and full source-process/host-off recovery and guarded reopening. This module supplies protected bounded file I/O only. It neither creates a restart/resume interface nor closes the full product goal.
