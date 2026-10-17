# Original S3 capability custody

17 October 2026. Local integration with actual SDK signing/encryption and
synthetic S3/KMS/provider transports; no actual cloud provisioning or deployment.

## Original pair and scope

`S3CapabilityVault` implements the custody callback of
[the original working-capability probe](s3-capability-proof.md). Canonical
plaintext contains the exact original presigned PUT URL and multipart UploadId
in one authenticated encrypted envelope. No refresh or replacement is performed.
The presigned URL has one shared structural validator in the probe and vault:
exact installation/attempt, endpoint, fixed bucket/object, reviewed access-key
hash, region, SigV4 query shape, canonical date and900-second lifetime. Duplicate
or unexpected query parameters, alternate targets and credentials are refused.
The helper does not verify signatures or current validity. Actual SDK signature
and provider acceptance belong to the active probe; expired historical custody
remains readable. UploadId is opaque: the active original baseline establishes
its actual object association and continued existence.

Objects are separated by endpoint, region, access-key hash and probe digest:

```text
managed-maintenance/<installation>/<attempt>/s3-capability/<endpoint>/<region>/<access-key-hash>/<probe-digest>.json
```

This prevents different configured cohorts in one attempt colliding. The future
complete factory must verify every configured probe digest and credential scope.
Purpose `charitypilot-s3-capability-v1`, envelope `S3_CAPABILITY_ENVELOPE_V1`
and pin `S3_CAPABILITY_PIN_V1` remain distinct from signed-TUS/ordinary custody.
The custody digest also binds storage account/bucket, distinct data/SSE keys,
project, endpoint, region, reviewed key hash and probe digest. The authenticated
context additionally binds original attempt/plan/source/epoch, both capability
hashes, exact reference and plaintext byte length. No raw URL, UploadId or secret
S3 signing key is placed in the KMS encryption context or public evidence.

## Durable acknowledgement and reuse

The existing `EncryptedMaintenanceSecretStore` supplies bounded AES-256-GCM,
KMS wrapping, expected-owner SSE-KMS conditional publication and exact-version
readback. Retention returns the original pin only after metadata/body checks,
KMS unwrap, GCM authentication and exact original plaintext comparison. The
active probe performs no original presigned PUT or first original multipart
part until this callback returns. Its separate ordinary S3 baseline controls
may already have run; this does not imply zero provider-side residue.

Wrong references/versions/SSE keys/context/pins/ciphertext fail before releasing
secrets to the consumer. Fresh use reads the original exact version and supplies
the unchanged pair to the active refusal verifier. Unknown PUT/readback outcomes
consume the instance; no cleanup or automatic retry reconstructs acknowledgement.
GET/decrypt-only inspection reports decryptability and observed pin/hashes, with
`originalAcknowledgementReconstructed:false` and `actionAuthorized:false`.
Conditional writes alone do not prevent privileged deletion, delete-marker
replacement or cross-process retries: independent IAM/version retention and the
durable parent acquisition guard remain required. JavaScript string erasure is
not claimed; accessible key/plaintext buffers are cleared by the shared engine.

## Local evidence and remaining work

Both direct and gateway tests compose the actual SDK/HMAC fixture, baseline,
combined encryption/readback, reopened exact original pair and native refusal
verification. Fault tests cover target/query/lifetime substitution, context and
ciphertext tampering, wrong versions/SSE, lost committed publication/readback,
unknown-ACK inspection, cohort path separation and late key cancellation.
Ordinary and signed-TUS custody regression tests remain passing. Provider storage,
KMS and management are synthetic; this does not prove actual IAM or host loss.

Independent public original artifacts/pair inspection, complete configured
credential/endpoint factory, required parent barriers and native unknown-ACK
integration are next. Default protocol8 still has no S3 dispatch. Keep all wider
JWT/session, in-flight/control-plane/capture privilege, common capture,
independent current authority, full-app restore and actual supplier/host-loss/
guarded reopening requirements in the full goal.

## Primary contracts checked

- [AWS conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html):
  current-object preconditions and delete-marker/concurrency limits.
- [AWS KMS encryption context](https://docs.aws.amazon.com/kms/latest/developerguide/encrypt_context.html):
  authenticated context is visible in logs and must contain no sensitive plaintext.
