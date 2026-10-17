# Original S3 capability and feature-exclusion probe

17 October 2026. `SupabaseS3CapabilityProof` implements actual SDK-signed S3
requests, an original presigned PUT and an original multipart upload through
synthetic HTTP transports. It supports separate DIRECT and GATEWAY scopes.
It is not yet dispatched by the default protocol8 parent. No real supplier
credential, resource, upload, part or feature setting was used or changed.

## Source-driven boundary

[Supabase S3 authentication](https://supabase.com/docs/guides/storage/s3/authentication)
distinguishes generated full-access S3 keys from JWT/session-token credentials
with RLS. This component accepts one explicitly reviewed generated S3 access-key
pair; JWT/session credentials remain separate coverage. The direct Storage host
and public gateway host are distinct configured scopes, never interchangeable
after an original capability has been minted.

[Supabase compatibility](https://supabase.com/docs/guides/storage/s3/compatibility)
documents SigV4 presigning and interoperability with REST objects. It also says
Supabase Storage does not provide S3 bucket versioning. Do not confuse the source
storage's capabilities with the independent AWS evidence store's exact-version
custody and retention requirements.

At reviewed Storage revision `c826a70ac6e6f56d3e6033ccb164fb1ff5282570`,
[S3 route registration](https://github.com/supabase/storage/blob/c826a70ac6e6f56d3e6033ccb164fb1ff5282570/src/http/routes/s3/index.ts)
installs the per-tenant feature hook before signature authentication.
[That hook](https://github.com/supabase/storage/blob/c826a70ac6e6f56d3e6033ccb164fb1ff5282570/src/http/plugins/tenant-feature.ts)
returns403 with code `FeatureNotEnabled` when S3 is disabled. The
[S3 error formatter](https://github.com/supabase/storage/blob/c826a70ac6e6f56d3e6033ccb164fb1ff5282570/src/http/routes/s3/error-handler.ts)
and XML middleware give that response a native S3 error envelope.

Consequently the probe requires403, XML content type, actual SDK-decoded
`Code:FeatureNotEnabled`, matching exception name and HTTP metadata, and fresh
provider Date. Generic AccessDenied, signature/token errors, missing objects or
uploads, conflicts, server failures, redirects, proxy error headers and non-XML
responses remain unresolved. Feature exclusion is not credential deletion.
The reviewed source is not an attestation of the hosted supplier's release.

## Working original baseline

Only the fixed private `charitypilot-recovery-s3-probes` bucket and exact
installation/attempt paths are permitted. Explicit key hashes, endpoint profile,
project, region and declared release bind the configuration. There is no
ambient credential chain, arbitrary endpoint/bucket/key, retry, region redirect
or session refresh.

The AWS SDK performs real SigV4 signing. Its custom request handler routes the
signed HTTP request through the existing bounded fetch transport, preserving
actual request headers, path, query and fixed payload. Response bytes are bounded
before SDK XML decoding. The added `@aws-sdk/s3-request-presigner` dependency is
pinned to3.1143.0, matching the existing S3 SDK; no other locked package version
changed.

The baseline verifies private REST bucket state and absent synthetic objects,
then performs working S3 create/read/update/read/delete operations. It mints a
900-second presigned PUT with unsigned payload and initiates the original
multipart upload. Before the original URL is used or first part uploaded, a
required callback must acknowledge both exact URL and exact UploadId under
`S3_CAPABILITY_PIN_V1`, binding their hashes, reference, custody digest and
encrypted-body version/hash/length.

The callback remains a contract: its real purpose-separated encrypted store,
exact-version decrypted acknowledgement and independent publication are next.
An arbitrary callback receipt is not proof of independent custody.

After acknowledgement, the original presigned PUT works, and a5MiB original
part is uploaded and listed with its exact part number/ETag/size. A separate
control multipart upload completes and its object bytes are read through REST.
The original remains incomplete. AWS's
[multipart initiation](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateMultipartUpload.html)
and [completion API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html)
inform this original-ID/part-list contract. An HTTP200 containing a completion
error cannot prove successful completion.

## Feature-disabled verification

Verification uses the original saved URL, UploadId and original reviewed key.
It confirms original public baseline/pin hashes, exact target/endpoint/region/
credential scope and live presigned lifetime before dispatch. Working retained
REST uploads/readbacks bracket the negative batch, because S3 is intentionally
disabled and cannot serve as its own successful post-disable control.

All eight ordered operations must return the specific native feature denial:

1. S3 read of the original standard object.
2. S3 create at the exact absent synthetic target.
3. S3 update of the original standard object.
4. S3 delete of the original standard object.
5. New multipart initiation at the exact synthetic target.
6. Part upload against the original UploadId.
7. Completion of the original saved part list.
8. PUT through the exact original presigned URL.

Standard/presigned object bytes must remain unchanged; original multipart and
denied-create objects must remain absent. No completion is inferred from an
expired/missing original multipart session: the observation concerns the S3
feature hook, not revocation or draining of that session. Unexpected acceptance
or side effects leave the original attempt/residue unresolved without cleanup.

Closed baseline/report schemas and pair checks bind configuration, attempt,
credential, original encrypted pin, prefix/object hashes, complete ordered
operation set and provider chronology within original presigned expiry. Public
results contain no raw URL, UploadId or secret key. Outbound tracing must redact
authorization, presigned query strings and upload identifiers before activation.

## Evidence limits and next work

Both endpoint profiles are exercised locally, with independent HMAC verification
of actual SDK signatures and actual original-URL reuse. Tests cover feature-specific
refusals, continued acceptance, side effects, broken controls, wrong response
classes, scope/capability substitutions, forged digests, expiry, HTTP200 multipart
errors, lost/late custody and late HTTP creation responses after cancellation.
The bounded transport retains32-request/180-second operation and15-second request
limits, no redirects/retries and32KiB response bounds. SDK clients are destroyed and retained response buffers are cleared when work
ends; SDK internal key-cache or JavaScript string erasure is not claimed.

Coverage is one reviewed S3 key and its original capabilities at one configured
endpoint per probe. `s3CredentialsRevoked`, `presignedCapabilitiesRevoked`,
`multipartUploadsDrained`, `inFlightWritesDrained`, `providerReleaseAttested`,
`wholeStorageQuiesced` and `actionAuthorized` remain false. Provider transports
are synthetic; there is no actual supplier/IAM/host-loss or S3-parent proof.

Next implement combined encrypted custody and public original artifacts, then a
complete configured credential/endpoint factory and required parent barriers.
Retain JWT/session and other capability coverage, in-flight/control-plane/capture
least privilege, common capture, orphan/pending-cleanup and independent current
authority, full application restore and actual provider/source-host-off/reopening
proof in the unchanged full goal.

## Already-disabled installations

This active component requires a working baseline and must not enable S3 or
issue new credentials merely to manufacture one. The future complete parent
policy needs a separate explicit current-feature-exclusion observation for
already-disabled installations, bound to both endpoint profiles and the reviewed
provider route/release. Current disabled state cannot establish historical
never-enabled status, past key revocation or original-capability refusal. No
such historical inference or empty-credential exemption is implemented here.

The separate [current feature-boundary component](s3-current-feature-boundary-proof.md) is now locally implemented with synthetic tests. Complete parent mode selection and fresh post-closure enforcement remain open. This does not waive original-working evidence when applicable.

## Original encrypted capability custody

The [combined original URL/UploadId vault](s3-capability-custody.md) is now locally implemented and composed with the real SDK probe through synthetic transports. The probe shares exact target/lifetime validation with custody. Original public artifacts, complete cohort factory and parent integration remain open; earlier next-work references to encrypted custody are superseded by this addendum.

[Original public artifact publication and pair inspection](s3-capability-public-evidence.md) are now locally implemented. These supersede earlier next-work references to public evidence; full configured factory/parent integration and actual supplier proof remain outstanding.
