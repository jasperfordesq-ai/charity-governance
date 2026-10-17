# Combined signed resumable credential custody

17 October 2026. `S3SignedResumableCredentialVault` implements the required
combined-custody callback for the [original signed TUS probe](signed-resumable-upload-proof.md).
The probe and vault compose locally with actual encryption and synthetic
provider transports. Default maintenance-parent dispatch, independent public
baseline/report retention and actual supplier custody remain open.

## Exact original pair

The vault stores one canonical JSON plaintext containing the **original token
and original signed upload Location together**. Their separate SHA values and
total plaintext byte length enter the authenticated context. Retention validates
both supplied hashes, exact fixed synthetic bucket/object/attempt, signed route,
selected upload-ID format, canonical token encoding, upload scope, upsert and
bounded token lifetime. The vault checks token structure and scope; the active
probe separately verifies its signature and current lifetime against the
reviewed issuer. Historical ciphertext remains readable after token expiry.

The encrypted object is at:

```text
managed-maintenance/<installation>/<attempt>/signed-resumable-credential.json
```

Purpose `charitypilot-signed-resumable-credential-v1`, envelope
`SIGNED_RESUMABLE_CREDENTIAL_ENVELOPE_V1` and public pin
`SIGNED_RESUMABLE_CREDENTIAL_PIN_V1` are distinct from ordinary signed-token
and resumable-location custody. Ordinary pins/envelopes cannot substitute.

AES-256-GCM uses a random12-byte nonce and16-byte tag. The canonical context is
AAD and also supplies the KMS encryption context: original maintenance
attempt/plan/source/epoch, installation, custody/probe digests, exact data key,
reference, token/location hashes and byte length. The plaintext token and URL
never enter KMS context or the public pin/observation.

## Save and acknowledge

Explicit S3/KMS credentials and fixed Ireland endpoints are required. Data-key
and storage SSE keys are distinct and belong to the configured account. A single
conditional `If-None-Match: *` publication uses SSE-KMS, exact expected owner and
body checksum. Its ACK is followed by **exact-version** metadata/body/pin readback,
KMS unwrap, GCM authentication, plaintext scope/hash validation and exact original
plaintext comparison. Only then does `retain()` return its original pin. The
signed probe sends no initial chunk before that acknowledgement.

Unknown PUT/readback outcomes consume the instance. Another retain conflicts
with the existing current object; inspection does not retry publication or
reconstruct the missing original execution acknowledgement. External delete
markers, privileged object replacement and cross-process retries still require
independent IAM/version-retention and the original durable parent attempt guard.
Conditional publication alone does not prove those controls.

## Fresh use and inspection

`withCredential(originalPin, originalReference, consumer)` reads that exact
version, authenticates the original context and supplies the original token and
Location together to the active verifier. Wrong references, versions, keys,
lengths, hashes, context or ciphertext fail before the consumer is invoked.
There is no token refresh, upload recreation, cleanup or automatic retry.

`inspect()` reads/decrypts only, optionally observing the current object where
the original acknowledgement is unknown. It returns the observed pin/hashes and
decryptability, with `originalAcknowledgementReconstructed:false` and
`actionAuthorized:false`. It makes no TUS/management/evidence-publication request.
Decryptability is not a claim that an expired token works, or that an operation
may resume from an uncertain result.

## Shared engine and proof limits

`EncryptedMaintenanceSecretStore` contains the shared bounded AES-GCM/KMS/S3
mechanics. Its policies are trusted internal source, never input supplied by an
API, job or tenant. Ordinary `S3ResumableLocationVault` now delegates to it while
retaining the original purpose, object path, context, envelope/pin formats and
configuration digest. Existing ordinary vault/probe/factory/default-parent
tests and native PostgreSQL scenarios exercise that compatibility.

Both wrappers retain180-second outer and15-second SDK/read bounds, cancellation,
late key/body disposal, canonical bounded32KiB encrypted bodies, exact-version
reads and buffer zeroisation. Consumer-created JavaScript strings cannot be
zeroised; no such erasure is claimed. Outbound tracing must redact credentials
and resource URLs before any real-provider activation.

New synthetic tests compose actual probe+vault for both ID formats, decrypt the
original pair through a fresh vault, execute actual original signed PATCH
refusal through the synthetic Storage transport, test expired historical data,
tampered context/ciphertext/pins, wrong metadata/reference, lost committed ACKs
and late KMS plaintext. AWS/KMS/Storage transports are synthetic. This is not
actual supplier IAM, locked version retention, independent key custody,
process restart, physical host loss or whole-backend quiescence proof.

Next publish the original signed-TUS public baseline/report with closed pair
checks and read-only saved-report inspection, then require their original pins
and digest in the maintenance parent before revocation/completion. Continue
S3/other sessions, in-flight/control-plane/capture least privilege, common
capture, independent current authority, full application restore and actual
provider/source-host-off/reopening proof under the unchanged full goal.
