# Original-job service identity and custody

17 October 2026. Internal managed source integration. No provider resources or permissions, tenant policy, actual risk status or deployment changed.

## Original local binding

After creating the original protected `proof-job.request.json`, the live job handle can bind exactly one current service identity. It verifies the unit/job/release, invocation, positive operator/main-PID/start identity and false authority fields. The supplied input must contain the exact original job UUID, argument hash and domain-separated snapshot hash; the identity must contain that exact input digest. Neither arguments, snapshot payload nor database credentials are copied into the binding.

The one-shot `proof-job.service.json` links the exact original request pin to the identity from the private channel. It uses the existing protected exclusive-write, flush, digest/count readback and directory-identity path. A malformed first attempt cannot be retried on the original handle. A binding cannot be added after an outcome attempt. Read-only inspection requires its separately retained exact pin and the original baseline/scope; a saved identity is metadata, never a process-kill selector or replacement execution lease.

The actual Linux service-channel fixture now uses this local job implementation and verifies its readback before returning the channel acknowledgement. Denying that acknowledgement still prevents worker start even though the binding was durably written. Parent and guardian loss continue to produce no success acknowledgement; the separate control service survives.

## Independently addressable custody

The live original candidate session exposes `bindService` alongside job reserve and observation. It checks the current closed head and window before and after custody. Its source-job object permits a service write only after the original descriptor acknowledgement, once, and before any outcome attempt. Closing the original session removes the live descriptor acknowledgement. A new reader cannot recreate it.

Service records reuse the existing conditional, exact-version, expected-owner, checksum and SSE-KMS artifact store. They use the `capture-job` namespace with a separate domain-separated scope digest `SHA256(CHARITYPILOT_SOURCE_JOB_SERVICE_V1 + newline + candidateId)` and one `baseline.json`. The original two-object request/result namespace and formats remain unchanged. The strict service envelope links the exact original cloud job version and local request pin, job/release and full candidate binding. It accepts no secret or authority fields. This adds no provider resource or inferred IAM grant.

Fresh job discovery derives both namespaces from the verified original candidate, performs bounded listings before and after exact-version reads, validates current ETags/counts/pairs and returns local/cloud service pins plus saved identity. Unexpected service objects, unstable boundaries, changed bytes, mismatched original versions or substitutions refuse. A missing service is reported only as NOT_LISTED_AT_BOUNDARY. A service stored before an acknowledgement was lost remains inspectable; discovery does not reconstruct that acknowledgement, start/retry a worker, publish a root or prove complete history/current authority.

## Evidence and next integration

Source tests cover durable local readback, altered input/job/scope/unit/process/authority refusal, one-shot and terminal-order enforcement, original cloud descriptor gating, lost service acknowledgement after storage, read-only fresh discovery, no key generation and unexpected catalogue objects. Real non-root Linux service tests exercise the local binding before the actual guardian receives synthetic work, with success, denied acknowledgement, parent loss and guardian loss. Cloud custody tests use synthetic SDK transports; they are separate evidence and do not imply a live independent cloud service or full host-loss proof.

The production capture runner still selects inherited IPC. Its next required path is a fixed systemd launcher whose identity callback records the local service binding, obtains the original cloud service acknowledgement and only then returns true to the private channel. Completion must also require actual service terminal state and an empty original cgroup. Unknown launch/stop/ACK outcomes remain unresolved without replay. Genuine source SQL/capture through that path, pending daemon requests/orphan accounting, real independent custody/key/current preservation authority and whole source-host-off recovery/reopening remain open. The earlier unexplained source refusal and unattributed scratch-volume uncertainty are preserved. Full multi-organisation/optional-Confluence scope remains active.
