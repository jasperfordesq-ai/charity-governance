# Authenticated document archive index

Decision: 17 October 2026, under delegated product engineering authority.

The index joins document-byte archive receipts to the existing recovery inventory
hash contract and the exact database-dump digest. It is an authenticated inventory
component, not a complete usable backup, a database capture or a restore permit.
See [document byte candidates](document-byte-backup.md).

## Reconciliation before authentication

The builder takes the complete supplied Document rows, whole-bucket object
inventory, exact archive receipts and explicit source/set scope. It computes the
same document identity, metadata binding, object-key and inventory hashes used
by `verify-document-recovery.mjs`. Those five functions now share one runtime
implementation; the existing offline manifest contract and domains are unchanged.

Every document needs its own archive receipt, including when two rows reference
one source object. Its archive context must match organisation/document, set,
release, database digest, canonical metadata binding, bytes digest/length and
data key. Its fixed S3 key and non-null version are retained. Duplicate documents,
duplicate receipts, duplicate source object keys, missing objects, orphan source
objects, mismatched bytes and unsupported identifiers refuse the entire build.
Do not drop unsupported records to obtain a passing index. Orphans require a
future explicitly modelled archive path; they cannot silently disappear.

An empty pair of supplied inventories can produce an explicit empty index.
That does not relax the older exercise verifier's non-empty fixture requirements
or establish that the actual source is empty. Inputs are bounded to 5,000 records,
the existing 10 MB per-object limit and a 16 MB serialized index ceiling. Metadata
and object timestamps must be canonical UTC and within the existing 60-minute
skew ceiling. This is an equality/skew check, not proof of a consistent snapshot.

The index stores routing IDs, hashes, counts, timestamps and archive references.
It omits original file paths, names, MIME strings and document contents. Its
routing metadata can still identify records; storage must remain restricted.

## Authentication and recovery trust

Sealing performs full source-row reconciliation again. A caller cannot submit a
prebuilt index directly to the sealing operation. It snapshots inputs before any
await, canonicalises ordering, hashes the canonical index and authenticates a
purpose-separated message with KMS HMAC-SHA-256. Hashing before the MAC keeps the
KMS message below its 4,096-byte ceiling. Generation and verification use the
same domain and digest; there is no raw-message/digest ambiguity.

The explicit Ireland HMAC key must differ from the byte-encryption key and use
the same configured account. KMS enforces its HMAC key type/usage. The adapter
pins key, region and endpoint, requires explicit credentials, validates returned
key/algorithm/MAC size or `MacValid`, permits one attempt and has a 15-second outer
deadline. It does not discover keys, provision grants or export secret MAC keys.
Deployment must also keep the HMAC key distinct from the S3 SSE key and enforce
separate writer/verifier permissions; this module cannot prove those IAM facts.

Opening requires independently trusted expected scope and the exact envelope
digest. It rejects noncanonical JSON, extra fields, changed source/set scope,
wrong digest, altered archive references and failed MAC verification. The
envelope digest can later be the existing recovery exercise's
`source.objectBackupManifestSha256`; the exercise report is produced after
restoration, avoiding a circular digest dependency.

A valid old MAC does not establish the latest set or current retention/disposal
authority. Expected scope/digest must come from independently maintained recovery
authority, never solely from this object. No mutable latest pointer, publication
adapter or complete-set success marker is introduced here. Opening supplies
verified archive references; it does not fetch bytes, write restored files, grant
disclosure, repeat a purge or reopen the application.

## Proof and remaining work

The [database byte archive](database-byte-backup.md) now encrypts existing
source-bound PostgreSQL dumps in authenticated chunks and opens them into
quarantine. Its native local restore passes; the full-platform CI branch must
be checked on its exact commit. Independent database/index publication and
common database/object capture are still open.
The [database S3 candidate adapter](database-backup-storage.md) now supplies
multipart/full-readback transport under synthetic tests; independent index and
complete-set publication remain open.

Tests cover complete reconciliation, shared source objects, explicit empty
inventories, limits, canonical ordering, mutation during async sealing, version
substitution, tenant/database/set/key changes and MAC failure. The integrated
synthetic test uses the real S3/KMS SDK byte adapters, clears the simulated primary
buffer, opens the authenticated index, requests the exact archived version and
decrypts the original bytes. Index HMAC SDK generation/verification is separately
tested with signed requests, wrong responses and stalled transports.

All transports use synthetic credentials and isolated handlers. They make no
real cloud requests. The inputs are supplied snapshots and receipts, not an
authenticated source-capture receipt. No full database dump is generated,
encrypted, published or restored by these functions.

Next: capture a consistent full database and object inventory under verified
writer closure; independently persist the encrypted database, document candidates
and authenticated index; prove exact readback and isolated full restoration;
reconcile independently current preservation/disposal authority before admission.
Then test actual provider custody, replacement secrets, old-writer exclusion,
physical source-host loss and safe reopening. A single authenticated index cannot
establish a daily RPO or retention/erasure guarantee.

Primary references checked 17 October 2026:

- [AWS KMS GenerateMac](https://docs.aws.amazon.com/kms/latest/APIReference/API_GenerateMac.html):
  HMAC keys, bounded messages and digest handling.
- [AWS KMS VerifyMac](https://docs.aws.amazon.com/kms/latest/APIReference/API_VerifyMac.html):
  exact key/message/algorithm verification and its integrity proof limits.
