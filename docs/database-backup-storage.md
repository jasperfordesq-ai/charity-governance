# Independent database archive candidates in S3

17 October 2026. `S3DatabaseByteBackups` stores the encrypted bytes produced by
the [database archive codec](database-byte-backup.md). It is an internal,
installation-wide recovery component. There is no tenant-facing database-backup
download API, scheduler activation or real provider account connection here.

## Fixed scope and transport

Require explicit Ireland endpoint/region, credentials, expected bucket owner,
installation and distinct same-account data/SSE KMS key ARNs. The context's data
key must match configuration. A receipt contains exactly the sealer's full
encrypted SHA/count and plaintext database SHA. Snapshot those values before
awaiting provider IO. Historical data and SSE keys require independently trusted
historical configuration; never select keys from an unauthenticated object.

The fixed key is
`business-data/<installation>/<set UUID>/database/<database identity SHA>.bin`.
It does not contain a database password, title, original path or tenant narrative.
Routing identifiers remain potentially identifying metadata. Storage and IAM
must remain restricted. No public ACL is requested.

Use one sequential multipart upload with 16 MiB parts and a shorter final part.
The codec's 64 GiB plaintext ceiling plus framing fits within 4,097 parts; no
whole-dump memory buffer is used. The final size is checked against canonical
header/framing arithmetic and the exact sealer receipt. Invalid scope/header or
an accidental plaintext dump refuses before the first provider write. Other
later failures can leave an incomplete multipart upload.

The shared streaming structural inspector checks canonical header, context,
ordered frame lengths, exact EOF and whole archive SHA/count. It does not unwrap
keys, verify GCM tags or establish source-capture provenance. Its expected receipt
must come from a successful sealer or authenticated recovery-set authority.
KMS/GCM verification still occurs before plaintext restore admission.

## Completion and exact readback

Each part carries its SHA-256 checksum and requires matching returned checksum,
bounded quoted ETag and exact SSE-KMS key. Consecutive part numbers and the full
parts list are supplied at completion, with exact `MpuObjectSize` and
`IfNoneMatch: *`. There is no overwrite or automatic write retry.

Use S3's COMPOSITE SHA-256 for the multipart protocol: hash the binary part
digests in order, encode base64 and append the part count. This is separate from
the sealer's full-byte SHA-256. Validate the returned composite/type and encryption
metadata. The real SDK handles errors embedded in HTTP 200 completion responses;
the client is configured for one attempt.

Successful publication also requires reading the returned exact version, not
just receiving a completion response. Readback requires non-null version,
expected version when supplied, no delete marker, exact SSE key/count/checksum
type and recomputed composite checksum. The stream's entire SHA, canonical scope
and framing must match the original receipt. Provider metadata alone is not
authority to replace the expected full-byte digest.

The returned observation is `kind: EXACT_VERSION_READBACK`, with a nested
`artifact`, object key, version and `compositeChecksumSha256`. Pass its `artifact`
as a future read expectation. This observation does not assert an original write
acknowledgement, latest recovery-set authority or a complete usable backup set.

## Unknown responses and bounded failure

After a lost completion acknowledgement, retain the original expected context,
artifact receipt and fixed object key. A fresh client can observe the candidate
read-only. It must match the original bytes. A failed/missing read remains
unavailable or uncertain; it is not an empty successful backup or permission to
erase, overwrite, generate a replacement candidate or recreate a lost receipt.

One-shot streams are owned by the call and destroyed on cancellation/failure.
Read targets must be new private encrypted staging destinations; discard any
partial target after failure. Rejected and late GET bodies are destroyed,
including when the transport ignores abort. Request deadlines are 60 seconds,
with 180 seconds for completion; idle streaming is bounded to 60 seconds with
activity refresh, and the entire operation has a 45-minute bound. Multipart part
copies remain independent of the reused accumulator until a request settles.

There is no abort/delete/list/resume API, bucket provisioning, latest-head write
or manifest publication. A failed attempt can leave billable incomplete parts.
Before activation, provide durable attempt/candidate tracking and an explicitly
reviewed incomplete-upload cleanup/lifecycle procedure. Never treat that as
authority to purge committed archives. Conditional creation/versioning does not
prove immunity to privileged provider administrators or deletion actors.

## Verification and next integration

Tests use real SDK signing, synthetic credentials and isolated transports. A
17 MiB encrypted fixture crosses a multipart boundary; its simulated primary
bytes are cleared, a completion response is lost, a fresh client observes the
original version, and KMS/GCM decoding recovers the original plaintext digest.
Other tests exercise successful exact readback, conditional conflict, part and
composite faults, embedded completion errors, source/metadata substitution,
scope/receipt mutation, cancellation, stalled/late bodies and completion timeout.
These are transport/model proofs, not real AWS custody or host-loss evidence.

The prior codec commit's hosted full source-bound PostgreSQL restore step passed;
that does not activate this provider adapter. The new exact commit still needs
its own CI evidence. No real database or customer records have been uploaded by
these tests.

Next: independently persist the authenticated document index and a complete-set
manifest binding database/object versions, source capture, current authority and
key identities. Compose common capture under verified writer closure; provide
isolated full restore and fresh preservation/disposal/session/secret checks.
Actual resources, IAM/custody, source-host-off, old-writer exclusion, safe reopening
and tenant backup-retention adoption remain required. This component alone does
not establish an RPO/RTO or erasure guarantee.

Primary references checked 17 October 2026:

- [CreateMultipartUpload](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateMultipartUpload.html).
- [UploadPart](https://docs.aws.amazon.com/AmazonS3/latest/API/API_UploadPart.html).
- [CompleteMultipartUpload](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html):
  conditional completion, exact object size and embedded errors.
- [S3 checksum guide](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html):
  full-object and composite checksums.
