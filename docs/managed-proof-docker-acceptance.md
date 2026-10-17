# Managed proof Docker cancellation acceptance

17 October 2026. Disposable local workloads only; no live deployment, provider access or tenant data change.

## Observed cancellation and controls

The new native Docker test starts the actual Node process supervisor with a fixed synthetic worker. That worker creates a container using the original verified local Linux Docker boundary and pinned tools image, then remains alive. After readiness, the test cancels the supervisor and verifies terminal worker state. The Docker daemon workload is still running: killing a client process does not constitute container cleanup.

The actual exact-job reconciler then removes that job's workload and rechecks absence. A separate running workload with another job UUID survives, providing the positive control for scope separation. Workloads have no network, no published ports or bind mounts, a read-only root filesystem and a 1 MiB temporary data mount. They carry fresh test-only names/labels and bounded lifetimes. Cleanup uses only exact known fixture IDs.

A second test supplies an ordered two-container listing with real Docker inspection and deletion operations. One container is valid and the later member has an invalid tool name. Both remain running after refusal. A unit regression first demonstrated that the previous sequential inspect/remove loop deleted the first member before refusing the second. The implementation now validates the entire listed batch before its first removal. Removal failure can still leave a partial outcome; this is not an atomic Docker transaction.

## Image-volume correction

The first test caught the pinned PostgreSQL image's default anonymous PGDATA volume, even with a read-only container root. The fixture now masks it with temporary storage instead of accepting persistent test debris. The actual source/fingerprint, dump-descriptor and restore-loader proof clients use the same exported temporary-mount constant. Dry-run tests verify all five client invocations use it and that the isolated PostgreSQL restore server retains its existing 4 GiB temporary data capacity. No persistent server or recovery volume is deleted or replaced by this change.

The first failed fixture run's positively attributed scratch volumes were checked against observed fixture/Docker events, exact metadata and no attachments before removal. Resource attribution and any unresolved inventory are recorded privately. No prune or removal of unattributed resources is part of this test or operator workflow.

## Commands and CI

`npm run test:managed-proof-process` requires the digest-pinned tools image already installed and the original local Linux engine boundary. It does not pull an image, accept arbitrary commands or use a remote Docker daemon. CI runs it after the existing real managed database test, which already supplies that image. Existing gates remain enabled.

## Limits

The synthetic worker is cancelled while the supervisor is alive and its Docker creation has been acknowledged. This does not prove supervisor-death ownership, saved-PID identity, a still-pending Docker creation, all orphan resources, provider process termination or actual source-host loss. Supported exclusive supervisor ownership, crash/orphan/daemon-request reconciliation and partial-artifact handling remain required. Independent provider/root-key/current-authority and full application recovery/admission gates remain open. The full delegated goal stays active.

## Unexpected source failures

A root-acknowledgement fault test must not hide an earlier helper refusal behind
missing-file cleanup. The synthetic harness now preserves the first bounded
source failure for its assertion. The worker supplies at most 4 KiB of the
original helper's already redacted failure excerpt on its private stderr pipe;
the supervisor discards diagnostics by default and retains its generic error.
An explicit test observer can collect bounded stderr, receives an owned copy
that is cleared afterward, and fails closed if the observer itself fails.
No production diagnostic sink or external log export is enabled by this change.
