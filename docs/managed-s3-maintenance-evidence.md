# Explicit S3 maintenance mode selection

> **17 October protocol9 S3 integration:** The default coordinator now requires
> explicit S3 mode evidence, an original S3_BASELINED head acknowledgement before
> shutdown, and a fresh paired S3 report before OBSERVED_CLOSED. Saved inspection
> never repeats S3 probes or backfills ACKs. Both modes pass native PostgreSQL
> integration with synthetic providers. See [required S3 maintenance](durable-s3-maintenance.md).


17 October 2026. Local source and synthetic workflows only.

`ManagedS3MaintenanceEvidence` is the common source-defined entry point for two
explicit S3 proof modes. There is no AUTO, omitted-mode default, environment
heuristic, empty-registry exemption or fallback after a failed probe.

| Mode | Required evidence | Secrets and custody |
| --- | --- | --- |
| WORKING_CAPABILITIES | Every configured reviewed key at DIRECT and GATEWAY, original working signed/presigned/multipart controls and paired original reports | Exact configured signing keys, retained control, original encrypted-capability custody and KMS |
| CURRENT_DISABLED | Original PRE and fresh POST current-feature observations at both endpoints with exact metadata and retained REST controls | Retained control only; signing vault/KMS inputs must be explicitly null and only the independent manifest client is accepted |

These modes describe different proof limits. Current route refusal does not
establish historical key revocation or replace required original working
capabilities. Selection is a declared plan input, not a fresh observation that
S3 is actually off. That state must be demonstrated by the selected probe.

## Bind the actual control

Construction takes the actual `SupabaseStorageWriterControl`, reads its pure
scope/configuration getters and validates installation, project, region and
capture-key identity against the selected branch. The common configuration digest
binds the selected mode, complete metadata configuration digest and branch digest.
The coordinator must include it in the maintenance plan. The explicit storage
assertion also compares the metadata configuration digest, so identical visible
scope with a different writer registry cannot silently share a plan.

No constructor request contacts a provider or independent store. Strict branch
schemas reject unknown fields, wrong secrets, missing/duplicate keys and unknown
modes. CURRENT_DISABLED rejects unused signing custody, KMS or extra SDK clients
rather than silently ignoring them. A working-mode failure is never retried as
a current-disabled probe.

## Common attempt interface

`forAttempt(originalBinding)` exposes a frozen mode-specific interface:

- `baseline()` obtains the selected branch's original acknowledged public pin.
- `observeBaseline(pin)` reads original evidence only.
- `verifyRefusal(originalPin)` performs the selected branch's active fresh proof,
  original-pair publication/readback and returns its exact observation pin/digest.
- `observeObservation(pin, originalPin)` reads saved paired evidence only. It
  returns recorded coverage and explicitly marks fresh coverage false.

Coverage strings remain distinct. Both modes preserve false flags for complete
issuer inventory, hosted release attestation, global storage quiescence,
reconstructed acknowledgement, saved-report execution authority and action
authority. Successful fresh coverage is not full backend closure. Original
branch consumption, cancellation, uncertain-outcome and no-backfill rules remain
in force; the wrapper introduces no retry, acquisition or reopening path.

Six new tests execute both complete workflows through actual proof classes and
synthetic transports, verify GET-only saved inspection, reject unknown/disguised
modes and extra current-mode inputs, bind changed metadata configuration despite
identical visible scope, and prove a failed working scope has no fallback.

## Required coordinator integration

Default coordinator remains protocol8 and does not dispatch S3 yet. The next
source change must add a mandatory S3 component, bind its common configuration
digest into a new plan protocol, compare the actual metadata scope/digest, and
record an original S3 baseline pin through the independent control's conditional
head transition after signed-TUS baselining and BEFORE provider suspension or
writer changes. Unknown acknowledgement must prevent all closure dispatch.

After closure, require the selected fresh S3 observation and its exact original
pin/report digest before OBSERVED_CLOSED. Extend saved inspection to re-read the
original paired S3 public artifacts, marking fresh S3 proof false. Reject old
protocol/missing-pin downgrades; extend real PostgreSQL parent compatibility and
unknown-ACK tests. Do not make S3 optional or add a route that bypasses its barrier.
Keep every other proof requirement and explicit global authority limit intact.

Actual provider/IAM, JWT/session and other-capability exclusion, in-flight and
control-plane/capture privilege, common capture, independent current preservation
and disposal authority, full application restore, provider/source-host-loss and
guarded reopening remain in the full goal.
