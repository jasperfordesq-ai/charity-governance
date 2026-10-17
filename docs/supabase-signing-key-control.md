# Reviewed Supabase signing-key control

17 October 2026. `SupabaseSigningKeyControl` is an internal provider primitive
for revoking an exact reviewed set of **previously used** signing keys. It is
called by [maintenance protocol6](durable-signed-upload-maintenance.md) and has
no public route, command or job. Real activation requires actual provider/issuer
association evidence and appropriate provider authority. No actual provider key was accessed or changed.

## Scope and decision

Configuration binds installation, exact project reference, provider organisation,
EU region and a complete reviewed key registry of 2–32 entries. Each entry names
an exact UUID, algorithm, public-material fingerprint (null for non-exported
HS256 material) and disposition:

- RETAIN_CURRENT: exactly one existing asymmetric in-use key.
- REVOKE_PREVIOUS: one or more exact keys expected to be previously used.
- ALREADY_REVOKED: existing historical keys expected to stay revoked.

Duplicate IDs and duplicate asymmetric material are refused. A same-material key
under another ID is not accepted as a fresh retained issuer. The configuration
is copied and sorted before hashing. Actual credentials are explicit and excluded
from observations. No key creation, legacy import, promotion, current-key rotation,
deletion, secret export or reopening operation is implemented.

This chooses bounded revocation of named old issuers, under software-owner
engineering delegation. It does not adopt a customer's retention policy or
authorise a real project-wide user-session interruption.

## Provider contract and ordering

Only `https://api.supabase.com/v1/projects/<ref>` is used:

1. GET the project and require the exact organisation, region and healthy identity.
2. GET `/config/auth/signing-keys`. Require the complete reviewed key set, exact
   algorithms/material and expected initial statuses. Unknown keys, standby
   states, missing keys and mismatched material stop before mutation.
3. PATCH each reviewed previous UUID with only `{"status":"revoked"}`. Check
   the returned ID, algorithm, material and revoked status.
4. After each response, re-read project and registry. Require the exact intermediate
   state: earlier targets revoked, remaining targets previously used, retained
   current key still in use and historical revoked keys unchanged.
5. Require two complete matching fresh snapshots of the final reviewed state.

Each instance allows one revocation attempt. Partial/unknown outcomes stop without
retry or compensation. A fresh instance refuses an already partially revoked
initial state instead of finishing it. A separate durable parent guard is still
required when a failed first request left all initial statuses unchanged.
`observeRevoked()` makes GET requests only and never recreates an original ACK.

Public key material is validated with Node's public-key parser and an RFC7638
fingerprint projection. ES256 requires a valid P-256 point. RS256 requires a
2048–4096-bit RSA key with exponent65537. Only verification metadata is accepted;
private fields or symmetric-key exports are rejected. A supplied public `kid`
must match the reviewed provider UUID. Unsupported algorithms refuse rather
than downgrade. Provider JSON is bounded to256KiB, requests to128 and10seconds
each, with a180-second outer deadline. Responses are not retried or redirected;
late/stalled bodies are cancelled and temporary JSON buffers cleared. Failures
omit raw provider bodies and tokens.

## Evidence limits: Auth keys and Storage capabilities

The result says `configuredSigningKeysObservedRevoked=true` with exact reviewed
metadata, observation time and digest. Its scope is management signing-key state.
It explicitly keeps `storageTokenIssuerVerified`, `signedCapabilitiesRevoked`,
`inFlightWritesDrained`, `wholeStorageQuiesced` and `actionAuthorized` false.

The reviewed upstream Storage source obtains `urlSigningKey` when issuing upload
tokens and separately obtains verification material when checking them. That is
a reason to verify the actual issued token and provider release, not to assume
an Auth signing-key change necessarily closes every Storage capability. The
repository's master branch is not evidence of the version running at a supplier.

Current official guidance also distinguishes rotation from revocation: rotation
alone can leave previous non-expired tokens trusted. It documents signed upload
URL validity separately from API-key lifetime. Waiting for a token's nominal
expiry is not proof that an already accepted request or background commit drained.

Actual issuer identification and positive/negative signed-upload and resumable
tests, independently retained original evidence, source-bound parent dispatch,
in-flight handling and control-plane exclusion remain required. External provider
actors can race or undo status changes; this primitive has no provider-wide CAS
or lease and cannot exclude them. The retained privileged control key also still
needs a least-privilege/exclusion design before claiming a common capture fence.

## Verification

Synthetic HTTP tests cover exact project/registry scope, retained current key,
wrong/public/private key material, real local EC/RSA parsing, weak RSA refusal,
legacy metadata without secret export, partial multi-key failure, lost ACK,
stale response, read-only reconciliation, request deadlines and late-body cleanup.
These do not demonstrate real Supabase acceptance or signed-token rejection.

Primary sources checked on17October2026:

- [Management API contract](https://github.com/supabase/supabase/blob/master/apps/docs/spec/api_v1_openapi.json):
  signing-key list/update endpoints and response/status schemas.
- [JWT signing keys](https://supabase.com/docs/guides/auth/signing-keys):
  separate rotation/revocation and product verification/cache boundaries.
- [Storage issuer and verifier source](https://github.com/supabase/storage/blob/master/src/storage/object.ts):
  `signUploadObjectUrl` and `verifyObjectSignature`.
- [Signed upload URLs](https://supabase.com/docs/reference/javascript/file-buckets-createsigneduploadurl)
  and [resumable uploads](https://supabase.com/docs/guides/storage/uploads/resumable-uploads).
