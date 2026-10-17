# Issuer-matched synthetic signed-upload evidence

17 October 2026. `StorageSignedUploadIssuer` and `SupabaseSignedUploadProof`
implement cryptographic association and an active positive/negative test of one
issued synthetic signed-upload capability. They are internal components required
by [maintenance protocol6](durable-signed-upload-maintenance.md). No public command, route, job, real provider
key operation or deployment activates them.

## Reviewed profile

Only the fixed `charitypilot-recovery-signed-probes` bucket is accepted. Paths
are generated as `charitypilot-recovery-signed-probe/<installation>/<attempt>/`
with `old.txt` and `control.txt`. Payloads are fixed synthetic initial/update text,
not caller data or governance records. Creation requires absence and no upsert.
Signed tests explicitly use upsert only on these created probe objects.

Configuration binds project, installation, declared provider source/image,
separate fingerprinted modern secret control and publishable gateway keys,
previous/current public issuer profiles, and exact maintenance binding. The two
issuers must have different IDs, token kids and public material. The static
digest excludes the per-attempt plan binding to avoid circular plan hashes.
Provider release values are declared inputs, not attestations of hosted code.

Each issuer profile explicitly names both a management key UUID and the token's
expected `kid`; they are not assumed to be identical. Public material is validated
by the existing EC/RSA public-key parser/fingerprint checks. Token verification
uses `jsonwebtoken` with exactly ES256 or RS256 and the pinned public key, never
a kid-selected remote URL, embedded key, shared secret or algorithm fallback.

The current profile accepts compact, canonical base64url JSON with a closed
header and explicit `scope=upload`, exact bucket/path, `upsert=true`, issued/expiry
times and optional owner/nbf. It rejects ambiguous JSON, unsupported headers,
download/role-bearing/unscoped legacy tokens, unknown kids, wrong signatures or
paths, HMAC confusion and short/expired or greater-than-two-hour lifetimes.
Unsupported legacy/provider dialects remain unresolved; these components do not
claim to close them. No header or payload claim alone counts as signature proof.

## Baseline and secret custody

1. Check the private bucket and require the old target absent. Create only that
   synthetic initial object and verify its bytes with the control key.
2. Ask the fixed provider endpoint to issue an upsert signed-upload URL. Validate
   the returned relative path/query and token agreement. Construct all subsequent
   request URLs locally; never follow an arbitrary returned URL.
3. Verify the issued token cryptographically against the reviewed previous issuer.
4. Pass its raw token/hash to an explicit `RetainSignedUploadCredential` callback.
   Require an acknowledged opaque UUID reference and matching token hash.
5. Use the token to write the different update payload with the publishable
   gateway key; verify bytes, reset to initial through the control key and verify
   again. Check bucket health.

The format2 baseline contains a credential reference and encrypted version pin,
token hash/verified issuer
identity/times, configuration/maintenance binding and payload hashes. It never
returns the raw token, signed URL or error message. A later instance receives
the original credential separately by matching reference; it does not mint a
replacement for the original capability.

The [encrypted credential vault](signed-upload-credential-vault.md) now implements
that callback with conditional ciphertext publication and exact-version decrypted
readback. Format2 requires its pin to match the reference/token hash; earlier
reference-only format1 cannot enter active refusal verification. Real activation
still needs actual independent IAM/key/retention custody plus independently
acknowledged baseline publication and parent-head binding before revocation.
Do not place the token in plaintext
heads, reports, logs, emails or backup manifests. Outbound tracing must redact
the provider-required token query before activation.

## Refusal with working signed controls

Validate the canonical original baseline/hash, exact current binding, credential
reference, payloads and original token before any provider call. Require its
target still to contain the known initial bytes. Create a separate absent control
target and obtain a new signed token matching the reviewed retained issuer.

Use that new token successfully before and after attempting the original token.
Check actual changed bytes after each positive write and reset the control object
as part of the successful test cycle. The original target must remain unchanged
after refusal. A denial that nevertheless changes it, or an old token still
accepted by the service, is failure; no compensating reset hides that result.

Accept only bounded JSON signature/access error codes: HTTP400 InvalidJWT or
InvalidSignature, or reviewed HTTP401/403 signature/access codes. Arbitrary400,
outages, rate limits, conflicts and ExpiredToken cannot establish refusal.
HTTP Date must be within60seconds of the local clock, and the original signed
expiry must remain at least60seconds beyond the refusal response's provider
clock. Nominal expiry therefore cannot stand in for the tested result.
The check does not attribute refusal solely to revocation or attest every
internal provider clock.

Results report `testedSignedUploadRefusalObserved` and
`issuedTokenSignatureMatched`, the original token/baseline hashes, refusal code
and provider time. `storageTokenIssuerVerified`, `managementKeyAssociationVerified`
and `providerReleaseAttested` remain false: a verified public signature is not
yet proof that the declared management UUID is the supplier's revocable Storage
issuer or that the declared source release is running. Global capability, drain,
quiescence and action-authority flags remain false too.

## Uncertainty and limits

Each instance permits one baseline attempt and one active verification attempt.
Any unknown write, token issuance or custody acknowledgement stops it. No retry,
new baseline, guessed token reference, failure compensation or cleanup follows.
A late custody response after abort cannot resume a network mutation.
Successful checks retain two bounded synthetic objects; partial checks retain
their actual state. GET-only `inspect()` reports ABSENT/INITIAL/UPDATED/UNEXPECTED
without object bytes and never recreates original outcomes.

Requests are bounded to64 per operation,32KiB response bodies and10seconds each,
with a180-second outer race including custody. These bounds and cancellation do
not establish that an already accepted provider operation drained.

Local EC signatures and synthetic HTTP tests cover working original capability,
fresh retained-issuer signed controls, wrong-signature/claim/algorithm/issuer/path,
outage/expiry/side-effect refusal, token omission from evidence, scope/reference
substitution, unknown/late custody ACK, provider clock uncertainty and read-only
inspection. They are not actual Supabase acceptance, provider-custody, resumed
TUS/S3 or source-host-loss proof.

Next bind the actual provider management key/material and release, retain tokens
and original artifacts independently, and integrate the matching revocation and
dispatch barriers. Add resumable/S3 and in-flight/control-plane/least-privilege
proof before claiming a common database/file capture fence. All full restoration,
current authority, catalogue and provider/physical-host-loss/reopening gates remain.

Primary source contracts checked17October2026:

- [Storage SDK upload/sign endpoints](https://github.com/supabase/storage-js/blob/main/src/packages/StorageFileApi.ts).
- [Storage issuer/verifier](https://github.com/supabase/storage/blob/master/src/storage/object.ts)
  and [signed-token scopes](https://github.com/supabase/storage/blob/master/src/internal/auth/jwt.ts).
- [Provider error codes](https://github.com/supabase/storage/blob/master/src/internal/errors/codes.ts).
- [Signing-material selection](https://github.com/supabase/storage/blob/master/src/internal/database/tenant.ts).

Those upstream branches explain the tested contract; they do not attest a hosted
supplier release or prove that all historically issued capabilities match it.
