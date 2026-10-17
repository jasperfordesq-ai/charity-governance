# Durable current-disabled S3 evidence

17 October 2026. Local source with synthetic provider and evidence storage.

`ManagedS3CurrentFeatureEvidence` implements explicit CURRENT_DISABLED mode for
an installation where S3 is already off. It does not enable S3, issue credentials
or infer historical never-enabled status from an empty key registry. The mode
accepts no retired-key list. It requires the actual metadata adapter scope,
fixed installation/project/region/control and declared provider source/image,
plus exact independent storage configuration. Its configuration digest binds
all those settings, including the metadata adapter configuration digest.

## Required original PRE and fresh POST

Baseline performs the existing active PRE_CLOSURE feature probe: paired metadata
snapshots, exact configured pre-closure API-key inventory, S3 disabled and sixteen
native refusals across DIRECT/GATEWAY with private REST canaries/readback. The
canonical baseline embeds that complete original probe artifact. Conditional
expected-owner SSE-KMS publication and exact-version readback must acknowledge
it before a pin is returned. The parent must durably record that original pin
before closing writers. This component does not acquire the parent or close it.

Post verification first reads and validates the original baseline. Only then
may the fresh POST_CLOSURE probe run. It requires capture-only metadata and
legacy/S3 disabled before issuing its new stage-specific canaries. Successful
POST evidence is paired with the exact original baseline hash, maintenance
binding and configuration, then conditionally published/read back. PRE/POST
metadata state hashes may differ because actual closure changes key/legacy
state; metadata configuration identity must remain the same. Each probe requires
its own before/after state stability. PRE is never accepted as POST.

Both records must preserve their actual timing. The PRE probe ends before its
baseline timestamp; the POST probe begins after that timestamp and ends before
the final observation timestamp. Each outer timestamp may trail its contained
probe by at most60seconds. These are recorded observation times, not independent
hosted release/clock attestation. Historical saved evidence remains readable.

## Exact public versions and uncertain outcomes

Canonical closed artifacts and pins are bounded to16384bytes, with keys:

```text
managed-maintenance/<installation>/<attempt>/s3-current-feature-baseline.json
managed-maintenance/<installation>/<attempt>/s3-current-feature-observation.json
```

The existing artifact store retains its conditional/checksum/SSE/account/version
checks. Existing namespaces and limits are unchanged. Missing original baseline,
wrong scope/version, invalid report, one stale endpoint or unclosed metadata
refuses completion. Unknown committed publication/readback consumes the instance;
there is no automatic repeat, cleanup, missing-ACK reconstruction or overwrite.
New instances encountering existing canaries remain unresolved. Durable original
parent acquisition and independent IAM/version retention remain required.

Fresh saved-pair inspection uses exact-version public GETs and pure static
scope validation. It does not call metadata/provider routes, generate/decrypt
keys, issue credentials, create canaries or publish records. Public means
capability-free evidence, not anonymous/public-bucket disclosure.

## Explicit limits and next integration

Every report keeps original-working baseline, historical never-enabled,
credential-inventory completeness, key/presigned revocation, multipart/in-flight
drainage, unknown multipart-effect exclusion, provider attestation,
control-plane exclusion, global quiescence, reconstructed acknowledgement,
saved-report execution authority and action authority explicitly false.
Current unauthenticated route coverage cannot replace originally working
capability testing when that working mode is required.

Eight new tests compose actual metadata and feature-probe implementations with
synthetic HTTP/storage, pre/post policy state, durable readback and historical
GET-only inspection. They cover wrong mode/scope, one stale endpoint, missing
baseline, unknown ACKs, forged stage/pair/timing/authority, wrong stored versions
and late ACK after cancellation. Existing raw feature tests reuse an extracted
fixture with unchanged assertions.

Next: explicit common selection between this mode and the configured working
S3 cohort, followed by mandatory coordinator acquisition/baseline/closure/fresh
report barriers and native unknown-ACK cases. Default protocol8 has no S3
dispatch yet. Preserve all JWT/session, in-flight/control-plane/capture privilege,
common capture, independent catalogue/current preservation/disposal authority,
full application restore and actual provider/source-host-loss/guarded reopening
requirements in the full goal.

The [common explicit mode selector](managed-s3-maintenance-evidence.md) now binds this branch to actual storage configuration and exposes the shared attempt interface. Mandatory coordinator/control-head integration remains next.
