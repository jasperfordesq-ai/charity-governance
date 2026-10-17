# Encrypted custody for an original signed-upload credential

17 October 2026. `S3SignedUploadCredentialVault` implements encrypted retention
and controlled use of the original token needed by the
[signed-upload probe](supabase-signed-upload-proof.md). It is internal and not
called by default maintenance protocol5. No real AWS resource, permission or
credential was provisioned or used for these model tests.

## Binding and encryption

Configuration requires explicit installation, exact maintenance attempt/plan/
source/epoch, probe digest, bucket/account and distinct data-encryption and
S3 SSE-KMS key ARNs in Ireland. Storage and KMS credentials are supplied
separately. SDKs pin HTTPS endpoints, single attempts and no S3 region redirect;
there is no ambient endpoint, credential, key lookup or alias fallback.

A fresh AES-256 data key from KMS encrypts the bounded opaque token with AES-GCM,
a random12-byte nonce and16-byte authentication tag. The complete canonical
context is authenticated as AAD, including the maintenance binding, custody
target digest, probe digest, reference UUID, token hash/length and exact data key.
KMS GenerateDataKey/Decrypt use purpose-separated encryption context:
`charitypilot-signed-upload-credential-v1`. No raw token enters that context.
This follows the existing repository's envelope pattern, using Node crypto and
AWS KMS rather than a new cryptographic primitive.

Ciphertext, wrapped key, nonce/tag and non-secret binding metadata are stored in:

`managed-maintenance/<installation>/<attempt>/signed-upload-credential.json`

Only one current object may be created conditionally with `If-None-Match:*`.
The expected bucket owner, SSE-KMS key and full body checksum are explicit.
No create-bucket, overwrite, delete, retry or replacement path exists.

## Acknowledgement and exact readback

`retain()` acknowledges a credential reference/hash/version pin only after:

1. KMS returns the exact expected key and valid data-key material.
2. Conditional S3 creation returns a version and expected encryption metadata.
3. GET of that exact version matches the pin's body hash/length and closed
   canonical envelope/context.
4. KMS unwrap with the original context succeeds, GCM authentication passes,
   and decrypted bytes match the original token.

The pin contains reference, custody digest, exact version, encrypted-body SHA/
length and token SHA. It contains no token, signed URL, data key or wrapped key.
Tokens are bounded to8192bytes and encrypted envelopes to32KiB. KMS wrapped blobs
are bounded to6144bytes; nonce/tag/plaintext/ciphertext lengths are checked.

Every S3/KMS request is raced against a15-second deadline, under a180-second
outer operation/caller signal. Late KMS plaintext is cleared and late S3 bodies
destroyed. Data-key/temporary plaintext buffers are cleared on success/failure;
consumer-held plaintext buffers are cleared on abort too. JavaScript strings or
consumer-created copies cannot be reliably erased by this component and must
stay within the controlled internal callback. No raw credential should be logged.

## Fresh use and uncertain retention

`withCredential(pin, reference, consumer)` reads only the exact pinned version,
checks the expected custody target/context and decrypts before invoking the
consumer with the original credential and cancellation signal. It issues no
replacement capability and changes no source document or parent phase. Consumer
code is a trusted internal boundary; it must not log, return or export the token.

After an unknown PUT/readback result, the instance remains consumed. A fresh
retain cannot replace an existing current object. `inspect()` may read and
decrypt the current object to report an **observed** pin/reference/hash, with
`originalAcknowledgementReconstructed=false` and `actionAuthorized=false`.
It never writes, guesses an original ACK or advances a lost parent barrier.
Read-only here includes KMS Decrypt and its provider audit, not just S3 GET.

Conditional creation does not exclude external deletion, delete-marker recreation
or privileged replay. Exact pins preserve version identity; independent IAM,
version retention/key custody and parent attempt protection still need actual
provider evidence. SSE-KMS alone is not independent credential custody.

## Signed baseline format2 integration

The signed probe's callback now requires the full encrypted credential pin.
Format2 baselines bind that pin to the reference and verified original token
hash; format1 reference-only baselines cannot enter active refusal verification.
The report links the ciphertext pin's SHA through the original baseline.

The implemented composition is:

```ts
const baseline = await probe.baseline((value, signal) => vault.retain(value, signal));
// Persist and authenticate the baseline separately before any revocation.
const saved = JSON.parse(baseline.body);
const report = await freshVault.withCredential(
  saved.credentialPin, saved.credentialReference,
  (credential, signal) => freshProbe.verifyRefusal(
    baseline.body, baseline.sha256, credential, signal,
  ),
);
```

The [signed evidence store](signed-upload-evidence-custody.md) now provides
separate original baseline/report publication and exact-version readback. Parent
head pin barriers and matching issuer promotion/revocation dispatch are still
required. Actual management-key/release
association, resumable/S3/in-flight/control-plane/capture-key exclusion, common
capture, current authority, full restore and provider/host-loss/reopening proof
remain open. Encrypted retention does not authorise use, extend token expiry,
establish disposal authority or make a missing original outcome known.

## Verification

Real local AES-GCM plus AWS SDK command models cover exact-version decrypted
readback, fresh-instance loading, no plaintext in stored bodies/receipts, key
buffer clearing, recomputed-pin context/tag/wrapped-key tampering, lost ACK and
read-only discovery, scope/reference/metadata rejection, maximum8192-byte token,
malformed/late key material, late S3 bodies and pinned SDK configuration. The
signed probe composes with the actual vault class and owned EC tokens through
synthetic AWS and Storage transports. No real signing or custody provider was
tested, and no physical-host-loss or OS-process restart is implied.

Primary references checked17October2026:

- [KMS encryption context](https://docs.aws.amazon.com/kms/latest/developerguide/encrypt_context.html):
  context is authenticated but non-secret and may appear in CloudTrail.
- [KMS Decrypt](https://docs.aws.amazon.com/kms/latest/APIReference/API_Decrypt.html):
  exact original encryption context is required.
- [S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html):
  conditional creation checks the current version, including delete-marker rules.
