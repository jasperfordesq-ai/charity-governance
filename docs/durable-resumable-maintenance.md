# Required configured-credential TUS maintenance

17 October 2026. Protocol7 introduced the ordinary TUS component. The default
coordinator now uses [protocol8](durable-signed-resumable-maintenance.md) and requires `ManagedResumableUploadEvidence` as its ninth
component. Its configured credential set must exactly match the storage writer
registry. The static factory digest enters the parent plan; protocol1–6 plans
refuse before dispatch. No public route/job, actual supplier activation or
deployment was added.

## Required parent transition

The original independent head now supports:

```text
READY -> ATTEMPTED -> BASELINED -> WRITE_BASELINED -> SIGNED_BASELINED
      -> RESUMABLE_BASELINED -> SIGNED_RESUMABLE_BASELINED -> OBSERVED_CLOSED
```

After the original read/write/signed baselines, the coordinator retains the
[complete configured TUS baseline manifest](managed-resumable-credential-cohort.md).
`recordResumableBaselinePin()` requires the exact original attempt/revision at
SIGNED_BASELINED, publishes the manifest pin by conditional replacement/readback,
then the coordinator re-reads and validates that original manifest and all child
baselines before any service/database/storage shutdown. The head stays bounded
to8192bytes; the128KiB manifest body is not embedded in it.

A lost location/child baseline/manifest/head ACK never starts shutdown. A later
observation of a committed state is not a fresh execution grant. Wrong attempt,
revision, kind, premature phase or repeated TUS transition refuses before PUT.

## Closure and original report

Existing service suspension, database role/password fencing, reviewed storage
credential/path closure and previous signing-key revocation remain required.
The coordinator then executes the existing original read/write/signed checks
and the actual TUS PATCH refusal for **every configured retired modern secret**,
using each exact original encrypted location and saved baseline.

Only complete configured-set success acknowledges the original TUS report
manifest. The final conditional head records its pin and
`resumableProofDigest`, which is the **root report artifact SHA**, plus every
previous baseline/report dependency and metadata digest. Missing TUS evidence
or a still-working credential prevents parent completion. Unknown report/final
head outcomes never trigger retry, reconstruction, cleanup or reopening.

Shared low-level control parsing retains historical unsigned/signed-only states
for their original narrow evidence. Protocol7 execution and completed-state
inspection require the new TUS dependencies; no old state becomes protocol7
acceptance through an implicit migration or backfill.

## Fresh inspection

Inspection reads the original TUS manifest and child versions through
`observeBaseline()`/`observeObservation()` and compares the retained root report
SHA with the original final-head digest. It never invokes `verifyRefusal()`.
No TUS session creation, PATCH, KMS unwrap, evidence PUT or missing-report
publication is allowed. Original/fresh result flags remain distinct:

- `recordedResumableCredentialCohortRefusalsObserved` describes saved evidence.
- `freshResumableCredentialCohortRefusalsObserved` is always false.

The final head revision must match the revision read before inspection. Source
read refusals remain separately observed through their existing GET-only path.

## Local verification

The integrated API fixture exercises two configured credentials with actual
factory/probe/AES-GCM vault/child evidence/manifest/head components. Its TUS
authentication follows the existing storage credential-deletion state. Metadata
closure with a deliberately still-working upload prevents success. Tests also
cover lost location/child/aggregate/head/report ACKs, missing final dependencies,
old-plan rejection and no-mutating fresh inspection.

The disposable local TLS PostgreSQL exercise uses real database role/password/
session fencing and default coordinator/provider-control/proof components, with
synthetic supplier HTTP/SDK transports. Its23 scenarios include all new TUS
baseline/report loss points and continued upload acceptance despite metadata
closure. Explicit fixture-only resolution after partial failures is separate
from product inspection and is not automatic compensation. Fresh retry and
inspection preserve artifact counts and control versions and perform no active
upload/KMS/write work.

This is not actual supplier IAM/key custody, a hosted release, an OS-process
restart or physical-host-loss proof. It observes one original TUS session per
configured modern secret. Signed-TUS tokens, other sessions, S3, in-flight and
control-plane actors remain open. Global revocation, drained writes, hosted
attestation, backend quiescence, tenant authority, source-host fencing,
credential rotation, reopening and action authority stay false.

Next establish those missing capability/exclusion mechanisms before common
database/files capture; retain orphan/pending-cleanup authority, independent
catalogue/current preservation-disposal authority, full application quarantine
restore/replacement identities/epochs, and actual provider/source-host-off/
guarded reopening proof. Product engineering does not adopt a tenant policy or
authorise a real supplier key change, purge or resource purchase.
