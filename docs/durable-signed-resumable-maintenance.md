# Required original signed TUS maintenance

> **17 October protocol9 S3 integration:** The default coordinator now requires
> explicit S3 mode evidence, an original S3_BASELINED head acknowledgement before
> shutdown, and a fresh paired S3 report before OBSERVED_CLOSED. Saved inspection
> never repeats S3 probes or backfills ACKs. Both modes pass native PostgreSQL
> integration with synthetic providers. See [required S3 maintenance](durable-s3-maintenance.md).


17 October 2026. Default internal `ManagedBackendMaintenance` now uses protocol8
and requires `ManagedSignedResumableUploadEvidence` as its tenth component.
Protocol1–7 plan hashes refuse before dispatch. Source integration and synthetic
tests do not activate a supplier account, upload, key change or public job/route.

## One signing configuration and a distinct child attempt

The factory derives its public registry from the already validated
`ManagedSignedUploadEvidence` component, with the fixed resumable probe bucket
and explicit upload-ID format. It validates the supplied original control/gateway
secrets, installation/project/capture identity and vault/evidence targets. The
parent requires the exact same signed-component configuration digest; a separate
or substituted signing registry cannot silently enter the workflow.

Static factory configuration enters the parent plan. Each original parent
attempt/plan/source/epoch plus that factory digest derives a distinct
application-defined UUIDv8 child ID under `CHARITYPILOT_SIGNED_TUS_CHILD_V1`.
This avoids collision with ordinary TUS sessions and binds every parent
dimension. Identity derivation performs no I/O and grants no execution or
acknowledgement authority.

## Original artifacts and parent barrier

`S3SignedResumableUploadEvidence` publishes separate original
`signed-resumable-baseline.json` and `signed-resumable-observation.json` artifacts
under that exact child. Both have closed canonical schemas and an8192-byte
bound. Existing write/signed/ordinary-TUS/cohort namespaces and limits are
unchanged. Explicit Ireland storage credentials, owner/SSE/checksum, conditional
creation and exact-version body/hash/metadata readback remain required.

The baseline must match the exact child binding, probe/custody digests and
previous issuer ID/kid/fingerprint. The original report must match baseline SHA,
original credential-pin SHA, token/location hashes, configuration, issuer,
chronology and both original lifetimes. Recomputed report digests cannot bypass
those pair checks. No report can be published from an absent/substituted original
baseline or from a mere management-key observation.

The parent state sequence now includes:

```text
READY -> ATTEMPTED -> BASELINED -> WRITE_BASELINED -> SIGNED_BASELINED
 -> RESUMABLE_BASELINED -> SIGNED_RESUMABLE_BASELINED -> OBSERVED_CLOSED
```

After every earlier original baseline, the factory runs the actual signed probe
with [combined encrypted custody](signed-resumable-credential-custody.md), publishes
and reads back its original public baseline. The parent then conditionally
publishes that original pin, requires exact head readback, and reads/validates
the baseline again before any service/database/storage/signing-key shutdown.
The head remains8192bytes. Wrong phase/attempt/revision/kind or a repeated
transition refuses without another PUT.

After existing writer closure and ordinary capability checks, the factory
decrypts the **original** token/location pair, executes the original signed PATCH
refusal with bracketing current-issuer controls, and acknowledges its original
report. Only then can final conditional completion record
`signedResumableObservationPin` and `signedResumableProofDigest` (the report's
closed observation digest), together with every earlier required pin/digest.
Missing evidence or a still-working old signed capability prevents completion.

Unknown save/head/report outcomes remain unknown. No retry, missing-report
publication, upload replacement, cleanup, compensation or reopening follows.
Shared low-level control parsing preserves narrower historical states; protocol8
execution/completed-state inspection requires all new dependencies. No old state
is implicitly upgraded to protocol8 evidence.

## Original-only inspection

Fresh inspection reads exact original public baseline/report versions, validates
their schemas/scope/pair and compares the original observation digest with the
parent head. It performs no signed TUS POST/PATCH, token issuance, KMS unwrap,
secret retention or artifact/head PUT. It never reconstructs a missing original
report after an uncertain command.

`recordedSignedResumablePatchRefusalObserved` describes retained evidence;
`freshSignedResumablePatchRefusalObserved` remains false. Parent head revision
must remain unchanged across inspection. Other existing fresh metadata/read
observations retain their separate scope.

## Verification and remaining goal

Integrated API tests exercise the actual factory/probe/encrypted vault/artifact
store/head components through synthetic provider transports. They cover original
success, lost secret/baseline/readback/head/report ACKs, continued signed upload
after management revocation, invalid completed dependencies, recomputed report
forgeries, old-plan rejection, guarded transitions and pure child identity.

The disposable local TLS PostgreSQL exercise now has29 scenarios, including the
six signed-TUS cases. It uses real role/password/session fencing with actual
default coordinator components and synthetic supplier HTTP/SDK transports.
Fresh retry/inspection leave artifact counts and control versions unchanged and
do not execute upload/KMS mutations. Explicit fixture-only resolution following
uncertain failures is not product compensation or authority.

The evidence covers one original reviewed signed TUS capability plus the earlier
scoped checks. Global signed/resumable revocation, hosted issuer/release
attestation, drained writes, whole-backend quiescence, tenant authority,
source-host fencing, credential rotation and reopening/action authority remain
false. Actual supplier IAM/key custody, OS-process restart and physical host-loss
proof remain open.

Continue S3/other sessions, in-flight/control-plane/retained capture least
privilege, actual supplier issuer/material/release and exclusion proof before
common DB/files capture. Preserve orphan/pending-cleanup and current
preservation/disposal authority, independent catalogue, full application
quarantine restore/replacement identities/epochs and actual provider/source-host-
off/guarded reopening proof in the full goal.
