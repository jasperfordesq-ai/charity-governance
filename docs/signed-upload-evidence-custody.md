# Durable signed-upload baseline and refusal evidence

17 October 2026. `S3SignedUploadEvidence` retains the original signed-upload
baseline and report as separate version-pinned artifacts. It composes with the
[signed probe](supabase-signed-upload-proof.md) and
[encrypted credential vault](signed-upload-credential-vault.md). It is an internal
component; default maintenance protocol5 does not call it yet.

## Publication and inspection

The caller supplies an exact installation, maintenance attempt/plan/source/epoch,
probe digest, encrypted-credential custody digest and explicit independent S3
target/account/key/credentials. The SDK pins the Ireland HTTPS endpoint, one
attempt and no region redirects. This component does not provision resources,
permissions or keys, and the local tests use SDK command models.

Two fixed keys are used under the installation and attempt:

```text
managed-maintenance/<installation>/<attempt>/signed-baseline.json
managed-maintenance/<installation>/<attempt>/signed-observation.json
```

Each publication requires conditional creation, the expected bucket owner,
explicit SSE-KMS key and body checksum. A version pin is acknowledged only after
GET of that exact version returns matching encryption metadata, bytes, hash and
canonical closed evidence. Both artifacts are limited to8192bytes. Each storage
stage is bounded to15seconds, including readback; caller cancellation propagates.
Late response streams are destroyed and cannot resume publication acknowledgement.

One instance consumes each publication operation before validation or I/O. A
fresh instance cannot overwrite an existing current artifact. Lost PUT or
readback acknowledgement is unresolved: there is no retry, replacement, listing,
current-version fallback or guessed version. The parent still must durably
acknowledge the returned baseline pin before any revocation, and the report pin
before recording that original outcome.

`observeBaseline()` and `observeObservation()` require exact saved pins. They
only read S3; they cannot issue a Storage token, decrypt a credential, perform an
active upload test, revoke a key or reconstruct missing history. Historical
reports remain readable after the token expires, but the timestamps must show
that the original refusal occurred with at least60seconds left on that token.

## Evidence checks

The shared `signed-upload-evidence-contract.ts` is used by the original probe
and custody component. It requires format2 with an encrypted credential pin,
matching reference/token hash, canonical ISO times and bounded token lifetime.

A report is accepted only if it matches the original baseline SHA, configured
probe digest, encrypted-pin body hash, token hash and issuer fingerprint. Its
observation digest is recomputed. Refusal status/code pairs are restricted to
the signed probe's reviewed meanings, excluding expiry, generic failures and
outages. Provider/client time consistency and the original capability's lifetime
are checked. Recomputed digests do not bypass these cross-artifact checks.

Both schemas are closed: extra raw token/URL fields and claims of global
revocation, drained writes, provider attestation or action authority are rejected.
These hashes provide binding/integrity, not independent truth or authenticity
against a writer who can forge all artifacts. The active probe, trusted parent,
independent identity/permissions and actual supplier evidence remain necessary.

Conditional creation checks the current version. External deletion, delete-marker
recreation and privileged replay are not excluded by this code. Independent IAM,
version retention, original parent pins and actual custody proof remain required.
SSE-KMS metadata alone does not prove independent custody.

## Local verification and remaining integration

SDK models test exact-version publication/readback, fresh read-only inspection,
compound substitutions with recomputed hashes, scope/custody mismatch, lost PUT
and readback ACKs, metadata/content/version tampering, bounded late responses,
canonical byte limits and closed schemas. The real local AES-GCM vault and actual
signed-probe classes compose with synthetic AWS/Storage transports: encrypted
original token, published baseline, saved-baseline refusal, published report,
fresh read-only inspection. These are fresh component instances, not an OS-process
restart, real cloud provider or physical-host-loss test.

Next integration must add original signed artifact pins to the parent barriers
and establish the actual supported issuer promotion/revocation mechanism. Auth
key metadata is not proof of the Storage URL-signing issuer. Actual issuer/key/
hosted-release association, resumable/S3 and in-flight/control-plane exclusion,
common capture, current preservation/disposal authority, full application restore
and provider/source-host-off/reopening evidence remain open.

Official S3 references checked17October2026:

- [Conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)
  describes current-version checks and delete-marker behaviour.
- [Retrieving exact versions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/RetrievingObjectVersions.html)
  distinguishes an explicit version ID from a current-object GET.
