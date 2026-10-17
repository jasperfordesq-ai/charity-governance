# Signed-upload parent barrier contract

17 October 2026. The independent installation head now supports a
`SIGNED_BASELINED` transition. This is the required head primitive for signed
workflow integration; default coordinator protocol5 does not enter it yet.
There is no new route, job, provider dispatch, credential grant or deployment.

## State and retained evidence

The signed path is:

```text
READY -> ATTEMPTED -> BASELINED -> WRITE_BASELINED
      -> SIGNED_BASELINED -> OBSERVED_CLOSED
```

`recordSignedBaselinePin(attempt, revision, pin)` requires the exact current
attempt and revision at `WRITE_BASELINED`. Its conditional head replacement and
readback acknowledge the signed BASELINE pin. Earlier phases cannot contain
signed pins; the signed phase must also retain the original read/write baselines.

Completion from `SIGNED_BASELINED` requires the original read report, standard
write report pin/digest and signed report pin/digest. Pin kinds are enforced. A
signed digest or report cannot be added to an unsigned completion. A completed
signed head with a missing pin, read/write dependency or signed digest refuses.
The existing8192-byte bound on the complete head remains enforced before PUT.

A lost transition ACK does not authorise shutdown from a later observation.
Repeated baseline transitions and a fresh coordinator acquisition refuse the
already-consumed attempt. Inspection cannot publish a missing report or guess
the original command outcome. Existing unsigned protocol5 heads remain readable
for their narrower evidence scope; they are not signed-upload evidence.

## Trust and integration boundary

The head retains pins and digests, not the full signed artifact or raw token.
The trusted parent must publish/read the actual
[signed artifacts](signed-upload-evidence-custody.md), validate their configured
scope and exact pair, acknowledge this head transition, re-read/validate the
original saved baseline, and only then perform the matching supported issuer
change. The head component alone cannot prove the contents of a supplied pin.

`SupabaseSignedUploadProof.assertBaseline(raw, expectedCustodyDigest)` supplies
pure original-evidence validation for that integration. It verifies canonical
body/hash/byte bounds, maintenance binding, configured probe digest and previous
issuer ID/kid/fingerprint, payload hashes, original lifetime, future-time bound
and expected encrypted-credential target. It does not decrypt a token, validate
a signature anew or make a provider request; active refusal verification retains
those separate checks.

Before activation, coordinator integration must bind signed factory/issuer
configuration into a new plan version, require this barrier before shutdown,
retain the actual report pin/digest at completion, and inspect only original
signed evidence without issuing active signed uploads. Actual supplier
issuer/material/hosted-release association is still required: Auth metadata
revocation is not sufficient evidence of Storage URL-token revocation.

Tests use the actual head component with synthetic conditional S3 transports.
They exercise successful pin retention/completion, missing-report dependencies,
wrong kind/attempt/revision and premature phase rejection, committed-but-lost
head ACK, fresh acquisition refusal and malformed retained states. Pure baseline
checks reject recomputed issuer/payload/attempt/custody substitutions without I/O.
No actual supplier, physical-host-loss or deployment result is claimed.
