# Durable signed-upload maintenance integration

17 October 2026. The default internal `ManagedBackendMaintenance` coordinator
now uses protocol6. Its required eighth component, `ManagedSignedUploadEvidence`,
binds the reviewed issuer registry, original-token vault, signed evidence store
and signing metadata control into the plan. Protocol1–5 plans cannot dispatch
this workflow. No application route, scheduled job, real provider activation or
deployment was added.

## Static scope and acquired attempts

The factory validates public key material, modern control/publishable credentials,
installation/project/capture-key scope and exact previous/current signing IDs,
algorithms and fingerprints. Exactly one configured previous issuer is revoked;
the retained asymmetric current issuer must already be in use. Standby creation,
promotion, broad legacy/HMAC support and automatic retries are not implemented.
Registry inputs are parsed/copied, and provider access does not occur during
plan construction. The static digest excludes the acquired attempt to avoid a
circular plan hash. Actual probe/vault/store objects receive that original
attempt/plan/source/epoch only after acquisition.

## Required execution order

1. Acquire the original independent attempt and retain the read baseline.
2. Publish/read the standard-write baseline and acknowledge its head pin.
3. Execute the scoped signed-upload baseline, retaining its original credential
   through the encrypted vault before the positive signed upload.
4. Publish/read the original signed baseline, acknowledge `SIGNED_BASELINED`
   with its exact version pin, and re-read/validate it against configured issuer,
   payload, attempt and encrypted custody.
5. Suspend reviewed services, close database writers, invalidate passwords and
   close the reviewed standard storage access paths. Revoke only the configured
   previous signing metadata key, retaining the reviewed current key.
6. Test read/write refusals. Load the exact pinned original signed credential,
   verify its signature/scope/lifetime, and test its refusal bracketed by working
   current-issuer signed uploads. Publish the original signed report.
7. Observe service/database/storage/signing metadata and retain the original
   read report, write report pin/digest and signed report pin/digest in the
   conditional final head. Signed completion requires the signing observation
   digest as well as all earlier dependencies.

No shutdown occurs after an unacknowledged credential, baseline publication or
head transition. An uncertain command/report/final-head outcome remains consumed.
There is no compensation, cleanup, issuer retry, old-attempt takeover or reopening.

## Fresh inspection

Inspection reads the original version-pinned signed baseline/report and validates
their configured scope and pair. It never unwraps the credential, generates a
key, issues a token, uploads a signed test, publishes an artifact or reconstructs
missing original history. Metadata observation uses GETs. Existing fresh read
probes remain distinct from recorded write and signed results.

`recordedTestedSignedUploadRefusalObserved` concerns the original saved report;
`freshSignedUploadRefusalObserved` is always false. Missing report pins remain
missing even if a fresh metadata read shows the key revoked. The original final
digest must match the retained report. Inspection refuses if the control head
moves while evidence is being read.

## Proof limits

This tests one reviewed synthetic capability. Provider release details in the
registry are declarations, not hosted attestation. The actual supplier's Storage
URL-signing key association and hosted implementation still need verification.
Management metadata alone never proves refusal: the workflow fails when the old
token remains accepted. Global capability revocation, drained writes, provider
attestation, whole-backend quiescence, current tenant authority, source-host
fencing, credential rotation and reopening/action authority remain false.

Actual supplier IAM/retention/key custody, issuer association, resumable/S3 and
in-flight/control-plane/retained-control exclusion, common database/files capture,
current preservation/disposal authority, full application restore, repeated
epochs and actual provider/source-host-off/guarded reopening proof remain open.
Product implementation does not create a tenant retention decision or grant
permission for a real supplier key change or purge.

## Verification

The API tests compose the actual signed factory, issuer validator, probe, AES-GCM
vault, evidence store, signing metadata control and installation head using
synthetic AWS/Storage/management transports. They cover original-token refusal,
continued acceptance despite metadata revocation, lost credential/baseline/head/
signing/report ACKs, no-mutating inspection and older-plan rejection.

The disposable TLS PostgreSQL exercise additionally uses real database role,
password and session fencing with the default coordinator and signed components.
Only the supplier transports are synthetic. Explicit fixture-only cleanup of
partial cases is separate from production commands and inspection. Fresh
component instances do not imply an OS-process restart or physical-host-loss
exercise, and this evidence is not a live-provider or deployment result.

Source reference checked17October2026:
[Supabase Auth signing keys](https://supabase.com/docs/guides/auth/signing-keys)
distinguishes rotation from revocation and describes discovery caching. Its Auth
contract is not treated as a hosted Storage URL-token attestation.

Supporting contracts: [parent barrier](signed-upload-parent-barrier.md),
[artifact custody](signed-upload-evidence-custody.md),
[encrypted credential custody](signed-upload-credential-vault.md).
