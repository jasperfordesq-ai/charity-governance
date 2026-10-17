## 17 October: native Docker cancellation and batch preflight

Read [Docker cancellation acceptance](managed-proof-docker-acceptance.md). Actual
worker cancellation leaves a daemon workload; exact-job reconciliation removes
it while another job survives. Every batch member is now validated before any
removal. Proof clients mask the image's unused anonymous data volume with bounded
temporary storage. Supervisor-death ownership, pending daemon requests, complete
orphan reconciliation and independent provider/host-loss gates remain open.

# Original-request source-job custody and discovery

17 October 2026. Provider-backed implementation exercised with synthetic SDK transports and native SQL capture. Actual independent cloud custody and host-loss acceptance remain open.

## Ordering and authority

The original candidate request must receive its conditional-write/exact-readback acknowledgement before the source callback gets a frozen job-custody interface. It exposes only one job request and one observation under that candidate. Calls check the original closed head and window signal; session closure revokes the live interface. Saved reads never recreate it.

The source runner first creates and verifies its protected local baseline, then reserves that exact descriptor in the original journal's storage before starting the worker. Unknown descriptor acknowledgement stops before the supervisor call. The live runner can save its local worker outcome and exact pin to the job observation; unknown result acknowledgement stops the caller while preserving discoverable stored evidence. Neither outcome repairs or publishes the common final root.

## Immutable storage contract

Job records use `managed-maintenance/<installation>/<attempt>/capture-job/<SHA256(candidateId)>/baseline.json` and `observation.json`. This is a separate bounded namespace; existing candidate request/report paths and formats remain unchanged. The implementation reuses conditional creation, exact version reads, expected bucket owner, checksum and SSE-KMS verification with the original storage configuration. No new provider resource or permission is created here.

The strict baseline envelope commits the exact original candidate request pin and full binding digest, plus the local baseline bytes and pin. The local record holds only job UUID, original scope/release/workspace/snapshot/argument hashes, UTC and false authority flags. An observation commits the exact job baseline version and the exact local worker result. Job ID, local baseline hash/count and all scope/release references must match. Unknown fields, authority flags, mismatched bytes/pins or substituted source scope refuse before accepted storage.

## Fresh discovery

A fresh journal first verifies the original candidate request, then derives the job namespace from its learned binding. It needs no supplied job UUID or local result pin. A bounded two-object listing is checked before and after exact-version reads; keys, owner, checksum, encryption, ETag, sizes, envelope and pair references must match. Missing baseline refuses. An observation not listed at the boundary is reported as such, with REQUESTED_ONLY state, not as proof of complete history or that the worker never ran.

Discovery returns the original local pins for protected-file inspection and reports originalAcknowledgementReconstructed, executionAuthorized, publicationAuthorized and actionAuthorized as false. It creates no replacement job, retries no source operation and kills no process. Its original binding comes from the caller's verified candidate catalogue; no current tenant policy or independent history completeness is inferred from that metadata.

## Evidence and remaining gates

SDK tests cover original-ACK gating, descriptor/result ACK loss after storage, fresh reads without writes/key generation, scope/source/secret/authority refusal, one-shot pair enforcement and invalid catalogue objects. The retained parent interface refuses writes after its original call ends. The native cohort includes success, lost common/root/request acknowledgements, and lost source-job descriptor ACK. Fresh clients learn IDs and local pins from the original candidate and job records before inspecting the local workspace; no caller-memory pins are supplied. The native lost-job-ACK case checks that full proof artifacts, encryption keys and final root are absent.

The cloud backend and KMS are still in-process synthetic transports; the main SQL/test process remains alive. Trusted real provider/IAM/immutable custody, supervisor ownership and process identity, actual Docker cancellation/supervisor-death and in-flight daemon-request reconciliation, source-host-off recovery with separately held roots/keys/epoch floor, current preservation/disposal authority and guarded application reopening remain required. This is not a supported production restart command or whole-goal completion.
