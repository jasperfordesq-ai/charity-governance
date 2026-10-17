# Encrypted custody of an original resumable location

17 October 2026. `S3ResumableLocationVault` retains the original upload location
needed by the [TUS probe](supabase-resumable-upload-proof.md). The probe and vault
share one strict target validator. Default maintenance protocol6 does not call
either resumable component yet; no real cloud resource, permission or upload was
created for these local tests.

## Purpose and exact target

The vault uses the existing signed-token vault's bounded AES-GCM/KMS envelope
pattern with separate purpose, kind and object identity. Its KMS encryption
context and GCM AAD bind `charitypilot-resumable-location-v1`, exact installation,
maintenance attempt/plan/source/epoch, probe/custody digests, data-key ARN,
reference, location SHA and byte length. The raw URI is never in KMS context.

The custody digest also binds the exact supplier project and upload ID format.
Both retention and authenticated decryption must validate the location: exact
direct-storage HTTPS origin, canonical bounded URI and base64url, fixed synthetic
bucket and original `old.txt` path for that installation/attempt, and lowercase
UUID in the configured PATH_V1 or FILE_VERSION_V1 format. Control slots and other
projects/attempts/objects refuse. The shared validator also checks its slot at
runtime rather than relying on the TypeScript type.

The signed-token vault, its purpose, schema and existing persisted format remain
unchanged. A signed-token envelope/pin is not accepted as resumable custody.

## Encrypted retention and readback

Configuration requires explicit Ireland S3/KMS HTTPS targets, account, distinct
data-encryption/SSE key ARNs, credentials, project, format and acquired attempt.
No ambient key/endpoint/credential lookup, redirect or retry is used. KMS generates
a fresh AES-256 data key; a fresh12-byte nonce and16-byte GCM tag protect the URI.
Only ciphertext, wrapped data key and non-secret context are stored in:

`managed-maintenance/<installation>/<attempt>/resumable-location.json`

Conditional creation includes expected owner, explicit SSE-KMS and checksum.
`retain()` acknowledges the location reference/hash and version pin only after
exact-version GET, canonical envelope/context/body verification, KMS unwrap with
the original context, GCM authentication, exact target validation and full
plaintext equality with the original input. Pins contain no raw URL or data key.

URI plaintext is bounded to2048bytes and the encrypted envelope to32KiB. Wrapped
keys and cipher parameters are bounded. Per-request15-second and outer180-second
deadlines propagate caller cancellation. Late KMS plaintext is cleared; late
storage bodies are destroyed. Temporary key/plaintext buffers are cleared on
success, failure or abort. JavaScript strings and consumer-created copies cannot
be reliably erased and must stay inside the trusted internal callback.

## Original use and unknown acknowledgement

`withLocation(pin, reference, consumer)` loads only the exact pinned version,
decrypts and validates before passing the original location to the trusted
consumer. It does not create a new upload, issue a credential, publish a report
or advance a parent phase. The consumer must not log, return or export the URL.

An uncertain PUT/readback consumes the instance. A fresh retain conflicts with
an existing current object. `inspect()` may read/decrypt to return an observed
pin and location hash, but always reports original acknowledgement reconstruction
and action authority false. No current-version observation becomes the original
parent ACK. Inspection performs S3 GET and KMS Decrypt, including their provider
audit effects, and makes no TUS request.

Conditional creation does not prevent privileged deletion/delete-marker
recreation/replay. Actual IAM, retained versions, independent key custody and
the parent's one-attempt guard still need provider evidence. SSE-KMS metadata is
not proof of independence or permission to change a real supplier resource.

## Local evidence and remaining work

Tests compose the actual vault and TUS probe through synthetic AWS/Storage
transports using real local AES-GCM: both ID formats, encrypted original URI,
decrypted readback before ACK, fresh-instance use of the same unfinished upload,
and no URI in stored ciphertext/public evidence. Additional cases cover wrong
target/scope/reference/metadata, context/tag/wrapped-key/ciphertext/purpose
substitution with recomputed public pin hashes, lost PUT ACK, read-only discovery,
temporary-key clearing and late KMS responses.

These are fresh component instances, not an OS-process restart, real supplier,
native database, deployment or physical-host-loss result. Independent original
[TUS baseline/report publication and pair validation](resumable-upload-evidence-custody.md)
are now implemented. Required parent pin barriers and factory/coordinator integration
remain next. Signed TUS, other credentials/sessions, S3, in-flight/
control-plane exclusion, common capture, current authority, full restore and
actual provider/source-host-off/reopening proof remain open.

The envelope follows the previously reviewed
[KMS encryption-context contract](https://docs.aws.amazon.com/kms/latest/developerguide/encrypt_context.html)
and [conditional S3 creation contract](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html).
Neither contract establishes the actual independent provider configuration.
