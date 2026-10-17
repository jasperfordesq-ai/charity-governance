# Original S3 public evidence

17 October 2026. Local implementation with synthetic provider/evidence storage.

`S3CapabilityEvidence` stores the exact original working S3 baseline and its
paired native feature-refusal report. It uses the existing conditional,
exact-version `S3MaintenanceArtifactStore`; no alternate uploader or executor is
introduced. Canonical closed report parsing rejects unknown fields, changed
coverage/authority, bad digests, noncanonical JSON and oversized bodies.

## Scope and original association

Publication checks the probe digest, reviewed credential ID, capability custody
digest and original maintenance attempt/plan/source/epoch. The report must match
the original baseline hash, probe digest, credential and encrypted-capability pin.
Exact ordered refusal coverage and original capture/expiry chronology remain
required. These checks preserve original association; they are not proof of
provider identity, actual IAM, all credentials or complete storage quiescence.

Each scope uses this independent-store key:

```text
managed-maintenance/<installation>/<attempt>/s3-capability/<scope-digest>/baseline.json
managed-maintenance/<installation>/<attempt>/s3-capability/<scope-digest>/observation.json
```

The scope digest binds the independent storage configuration, probe digest,
credential ID and custody digest. The exact original maintenance binding is in
the baseline and the attempt directory. Different same-attempt scopes cannot
collide. The generic store accepts a SHA scope digest only for this source-defined
namespace; every existing namespace retains its original object names/limits.
Public means capability-free evidence, not anonymous or public-bucket access.

## Publication and inspection

A conditional SSE-KMS write sets expected account owner and body checksum.
Only exact-version metadata/body readback and canonical scope/pair validation
return a pin. Unknown committed write or readback outcomes consume the operation;
there is no overwrite, guessed pin, replacement or automatic retry. The parent
must durably record the original acknowledged baseline before closing writers.
Neither a fresh object nor a successful inspection reconstructs a missing
parent acknowledgement or authorises execution/reopening.

Fresh baseline/report inspection uses exact-version GETs only. It does not
unwrap capabilities, use KMS, contact the provider, create uploads, alter keys or
publish evidence. The report preserves explicit false flags for credential and
presigned revocation, multipart/in-flight drainage, provider attestation,
whole-storage quiescence and action authority. Historical observations are not
fresh refusal proof and cannot supply current tenant disposal authority.

## Verification and continuation

Both endpoint workflows compose the actual SDK/HMAC probe, original encrypted
URL/UploadId custody, baseline publication, original-pair verification and report
publication/readback. Additional tests reject wrong scope/attempt/custody/key,
recomputed report substitutions, omitted/reordered/refused-operation changes,
wrong version/SSE/deleted/corrupted objects, unknown write/readback ACKs and late
publication after cancellation. Fresh inspection makes no provider/secret-store
calls. Storage/provider/KMS transports remain synthetic; actual IAM/version
retention and cross-process original-attempt acquisition remain required.

Next is the complete configured S3 credential/endpoint factory, selecting working
original-capability versus already-disabled current-feature evidence, with
mandatory fresh postclosure observations and coordinator barriers. Default
protocol8 has no S3 dispatch yet. Preserve all wider JWT/session, in-flight,
control-plane/capture-privilege, common database/files capture, independent
catalogue/current preservation-disposal authority, full application restore,
actual provider/source-host-loss and guarded reopening requirements.

## Configured working cohort addendum

The [working-mode cohort factory](managed-s3-capability-cohort.md) now composes every configured credential at both endpoints and conditionally stores complete original manifests. Durable already-disabled mode, common parent integration and actual provider proof remain open.
