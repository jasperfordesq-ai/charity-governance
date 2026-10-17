# Original signed resumable-upload proof

17 October 2026. `SupabaseSignedResumableUploadProof` adds the missing active
signed-TUS probe. It is an internal component with synthetic transport tests;
the default protocol7 coordinator does **not yet dispatch it**. No actual
supplier token, session, key, upload or disposal action was used.

## Source and implementation decisions

[Supabase's resumable guide](https://supabase.com/docs/guides/storage/uploads/resumable-uploads)
documents signed upload tokens in `x-signature`. At reviewed Storage revision
`c826a70ac6e6f56d3e6033ccb164fb1ff5282570`, the
[route registration](https://github.com/supabase/storage/blob/c826a70ac6e6f56d3e6033ccb164fb1ff5282570/src/http/routes/tus/index.ts)
puts signed routes under `/sign`, separately from ordinary JWT upload routes.
The [lifecycle](https://github.com/supabase/storage/blob/c826a70ac6e6f56d3e6033ccb164fb1ff5282570/src/http/routes/tus/lifecycle.ts)
verifies `x-signature` against the upload object and upload scope and generates
signed Location URLs with that suffix. Signed HEAD also verifies the signature
before reaching the ordinary public HEAD branch.

Consequently the component sends actual signed POST/PATCH requests to the
canonical direct Storage hostname at `/storage/v1/upload/resumable/sign`.
Each signed request uses the reviewed publishable gateway key and exact
`x-signature`, with no bearer or retained privileged-control key fallback.
Private bucket/object reads, token issuance and ordinary HEAD inspection use
the separate retained control credential.

For state readback after old-token refusal, the component derives the ordinary
HEAD alias for the **same decoded upload ID**. This follows the reviewed route
and ID implementation, but still requires actual supplier validation before
activation. A failed signed HEAD alone is never counted as upload refusal.
Configured source/image identifiers are declarations, not hosted attestation.

## Original baseline and secret custody

Only the fixed private `charitypilot-recovery-resumable-probes` bucket and
three attempt-scoped synthetic paths are allowed. The future parent must assign
a distinct child attempt so these paths cannot collide with ordinary probes.
PATH_V1 and FILE_VERSION_V1 IDs are checked against exact signed routes,
bucket/object/version, origin and canonical encoding; unsigned or cross-target
locations, query strings, fragments, userinfo and alternate ports refuse.

The probe issues an old token through the explicit provider endpoint. The
existing `StorageSignedUploadIssuer` verifies the actual asymmetric signature,
algorithm, pinned public key/kid, exact object, upload scope, upsert=true and
bounded current lifetime. Previous/current issuer identities must differ. This
proves local cryptographic association, not that Auth management metadata owns
the hosted Storage issuer.

Before sending the original6MiB chunk, a required callback must acknowledge
**both** the exact token and exact signed Location under a separate
`SIGNED_RESUMABLE_CREDENTIAL_PIN_V1`. The pin binds reference, custody digest,
version, encrypted-body SHA/length and both plaintext hashes. Ordinary signed
token and ordinary resumable-location pins cannot substitute for it.

The callback now has a [combined encrypted implementation](signed-resumable-credential-custody.md)
with purpose separation and exact-version decrypted readback. Independent public
baseline/report retention and parent barriers remain required. The probe cannot
establish actual independent provider custody from an arbitrary callback or a
synthetic transport test.

After acknowledged custody, the baseline sends6MiB of a6MiB+1 upload, checks
the exact original offset/length/live explicit expiry and absence of a completed
object. The public baseline contains hashes, issuer proof and pin, never raw
token or resource URL. Secrets remain ephemeral strings during the operation;
no JavaScript string zeroisation is claimed. Outbound tracing must redact
`x-signature`, keys and resource URLs before real-provider use.

## Actual refusal and controls

Verification requires the same saved reference, token, signature proof and
signed Location. It inspects original state, completes a fresh current-issuer
signed control upload, then sends the final one-byte PATCH with the original
old token at the original offset. A second fresh current-issuer upload and
content readback follow. Old offset must remain unchanged and its completed
object absent. Both original upload expiry and token expiry must still have
at least60seconds remaining at the negative request's provider time.

Only400/401/403 with recognised signature/access error evidence count.
JSON codes are restricted;400 allows only InvalidJWT/InvalidSignature. Reviewed
TUS errors may return the rendered message rather than JSON, so a small exact
plaintext allowlist handles invalid signature/JWT and signature/access denial.
Missing-header, expired-token, arbitrary400/401/403,404/410,409 and server errors
remain unresolved. The upstream
[error definitions](https://github.com/supabase/storage/blob/c826a70ac6e6f56d3e6033ccb164fb1ff5282570/src/internal/errors/codes.ts)
and lifecycle renderer informed that boundary; an unknown response never falls
back to a wider acceptance rule.

The closed observation schema and pair check require original baseline SHA,
configuration, credential pin SHA, token/location hashes, issuer fingerprint,
chronology and original lifetime. Recomputed observation digests cannot bypass
cross-artifact checks. Reports explicitly cover one original reviewed signed
TUS capability; global signed/resumable revocation, issuer verification,
hosted attestation, drained writes, storage quiescence and action authority are
all false.

## Bounded execution and verification scope

Both ordinary and signed TUS probes use `BoundedStorageProbeTransport`, extracted
without changing ordinary protocol7 evidence formats/digests. It preserves the
explicit HTTPS origin, error-on-redirect, no retry,32-request budget,
15-second request and180-second operation deadlines, cancellation, current
provider Date,32KiB decoded response bound and late-response disposal.
Each probe phase is consumed before dispatch. An unknown custody or mutation
outcome cannot retry that instance, terminate, delete or clean up its residue.
Only the future durable parent guard can prevent another instance from
creating a replacement session; this component does not invent that authority.

Synthetic tests exercise both ID formats, working old baseline and current
controls, exact original final PATCH, continued old acceptance, side effects,
failed controls, invalid refusal classes, issuer/path/scope substitutions,
lost/mismatched/late custody, cancellation, missing original dependencies and
forged report digest/association/chronology. Ordinary protocol7 regression and
the real local PostgreSQL exercise test compatibility of the transport
extraction; they do not demonstrate signed-TUS parent integration.

Combined encrypted custody now composes locally. Next implement original evidence publication,
then require signed-TUS in the default coordinator. Keep S3/other sessions,
in-flight/control-plane/capture credentials, actual supplier issuer/release,
common DB/files capture, independent current preservation/disposal authority,
full application quarantine restore and provider/source-host-off/reopening
proof in the full goal.
