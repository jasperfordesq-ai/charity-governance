# Authenticated archived recovery sets

17 October 2026. `ArchivedRecoverySets` joins the stored database archive,
document index, document candidates and original PostgreSQL source report into
one authenticated root. This is an internal recovery component. It introduces no
public API, scheduled capture, account provisioning or live application restore.

## Durable preparation and publication

1. Stage the encrypted database/document candidates, authenticated document index
   and original source report using the fixed storage transports. Retain original
   expected digests before attempting a write. Unknown responses are reconciled
   read-only against those digests; do not automatically repeat the write.
2. `prepare` fetches the exact staged versions, verifies the index MAC and reported
   source bindings, then fetches/decrypt-checks the database and every indexed
   document. It clears checked plaintext and returns a sealed root body plus an
   independently retainable pin. It does not write the root.
3. Retain the pin in independently trusted custody and call `stagePrepared`.
   This conditionally writes the authenticated body to `prepared-root.json` and
   requires exact-version readback and MAC verification. If the response is lost,
   `observePrepared(pin)` obtains its observed version read-only. No final root
   has been written at this stage. The preparation is restricted evidence, not
   an application-ready backup or authority to restore.
4. Call `publishPrepared(pin, preparedVersionId)`. It reads and authenticates
   that exact durable preparation before its one-shot final-root conditional
   write and exact-version/MAC readback. It no longer accepts an in-memory body
   as the publication source. Afterwards `verifySet` independently fetches and
   decrypt-checks the declared set using fresh clients.

If the root write response is lost, use the original pin with `verifySet`.
That path performs no write, data-key generation or signing. It reports an
observed readable archive; it does not recreate an original acknowledgement.
If an earlier metadata response is lost, use `S3BackupManifests.observe` with the
original target/digest to obtain its observed version before preparing the root.

There is no mutable latest pointer. A pin contains the expected root SHA and
scope. Bootstrap bucket/account/key configuration and the pin must come from
separately trusted custody, not solely from the recovered root itself. Durable
catalogue/discovery and real custody procedures remain required for activation.
Storing the preparation beside the final root protects against source-process
loss, not compromise or loss of the archive account or all trusted pins. Actual
archive IAM must prevent deletion/overwrite of both keys by application writers.
An unknown write is reconciled by observation; duplicate staging is refused.

## Root contract

The canonical closed envelope contains a manifest and a 32-byte base64 MAC.
The manifest binds:

- Installation/set UUID/source release, strong PostgreSQL source-proof identity,
  object-store identity, capture-report hash and capture inventory timestamps/XID.
- Database context and full encrypted digest/count, plaintext digest, exact
  object key/version, composite checksum and fixed V1 16 MiB multipart layout.
- Exact version/key/digest/count for the source report and authenticated index.
- Declared document/object counts and their existing inventory hashes.
- Explicit bucket/owner and four distinct same-account Ireland KMS key ARNs:
  data encryption, S3 encryption, index MAC and root MAC.

The root MAC authenticates a purpose-separated digest. The index and root use
different signing domains and distinct keys. A shared bounded KMS transport
preserves the existing index interface while keeping the purpose whitelist,
exact message bytes, key, algorithm and returned-size checks. It never discovers
keys or credentials. The shared key-ARN parser also rejects trailing whitespace.

Current roots always carry:

```text
restoreMode: QUARANTINE_ONLY
captureConsistency: EXTERNAL_VERIFICATION_REQUIRED
```

`ARCHIVED_SET_VERIFIED` means the declared references were fetched, authenticated
and decrypted successfully. It does not mean the source inventory was captured
under a common external-writer fence, a PostgreSQL application was restored, the
set is the latest, or startup/disclosure/disposal is permitted.

## Source-report and stream checks

Preserve the source report's exact original bytes, including its formatting and
capture-exercise identifier. Its SHA must match both database and index context.
Check the reported source identity, release/helper binding, read-only exported
snapshot, dump SHA/count/rehash, capacity/isolated-restore claims and zero reported
comparison mismatches. The unpartitioned public Document row count must match
the index. Unsupported or inconsistent inputs fail closed.

These are consistency checks over reported evidence. A signed JSON claim does
not establish its provenance or re-execute the capture proof. Common source
capture must still compare actual database metadata and whole object inventory
under verified writer closure. The source proof's documented exclusions remain.

Database verification streams S3 bytes through the GCM decoder into a clearing
discard sink. The successful storage-read cleanup preserves a finished
PassThrough's unread bytes until the decoder consumes them; cancellation still
destroys failed bridges. Document plaintext is checked then cleared individually.
The operation is bounded to one hour; existing storage/key/codec timeouts also
apply. Missing/corrupt objects or unavailable keys fail the set verification.

## Metadata transport

`S3BackupManifests` permits exactly four fixed candidates per set:
`source-report.json` (up to 32 MiB), `index.json` (16 MiB),
`prepared-root.json` (1 MiB), and `root.json` (1 MiB).
It requires explicit Ireland endpoint/credentials/bucket owner/SSE key, private
JSON delivery, create-if-absent, full SHA checksum, versioned exact readback and
bounded UTF-8 decoding. Source-report formatting is preserved. Index/root JSON
must be compact canonical envelopes; their semantic/MAC checks belong to the
coordinator. No head update, delete, resume or automatic retry is supplied.

The report/index/root expose routing identifiers, hashes, technical source
metadata and counts. They are restricted technical evidence, not anonymous or
public reports. S3 server encryption and actual IAM/key custody must be verified
before storing real records.
SDK client overrides are trusted test boundaries. They must not be selectable
through a request, recovered object or operator endpoint string.

## Verification and remaining work

Synthetic tests exercise the default coordinator through actual signed S3/KMS
SDK requests with isolated transports. They stage the report, index and encrypted
bytes, clear primary fixture buffers, prepare/stage/publish a root, lose its write
response and verify all artifacts with fresh clients without another write.
They also lose the preparation response, discard its source body/clients,
observe it with fresh clients and publish from its exact stored version. Missing
preparations, substituted versions/MACs and duplicate writes fail closed.
They cover root MAC tampering, count mismatch, key/domain separation, whitespace,
caller mutation, bad metadata, timeout/late-body cleanup and the quarantine bridge.
They do not contact a real account or supply independent provider/host-loss proof.
The native PostgreSQL codec proof remains separate from this synthetic set model.

Before activation, finish the actual common-capture worker and metadata/object
cross-check, independent pin/catalogue/discovery tracking, incomplete-upload cleanup,
supported private quarantine filesystem and isolated full-application restore.
The 17 October source check corrected an earlier suspected purge-stub gap:
`DocumentPurgeClaim_dispatch_fn` atomically records the audit and cleanup job and
deletes the Document row. No later migration replaces that dispatcher. The
separate audit history is not a retained Document row requiring a file receipt.
Keep the index's missing-file refusal. A pending cleanup can instead leave an
orphan object after the row is gone; common capture must classify that through
the separate disposal/cleanup authority, without silently omitting the object.
Do not recreate erased bytes or drop rows to pass counts. Authority for old
backup copies and suppression on restore remain required. Unknown history stays
uncertain. This source observation is not evidence of a real disposal outcome.

Independently current preservation/disposal/disclosure authority, replacement
roles/secrets, restored-session revocation, old-writer exclusion and guarded
reopening remain separate mandatory checks. Real provider resources/IAM/key
custody, physical source-host-off and tenant policy adoption remain open. No
RPO/RTO, erasure guarantee, reviewer sign-off or launch readiness is asserted.

Primary references checked 17 October 2026:

- [S3 PutObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html).
- [S3 GetObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html).
- [S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html):
  create-if-absent applies to the current key; a delete marker can permit another
  write. Application checks therefore do not replace archive IAM protections.
- [KMS VerifyMac](https://docs.aws.amazon.com/kms/latest/APIReference/API_VerifyMac.html).
