# Database-snapshot document metadata binding

17 October 2026. The source-bound PostgreSQL proof now computes a bounded
document metadata projection using the same exported snapshot as `pg_dump`.
The isolated restored database must reproduce it. Archived-set preparation and
verification require it to match the authenticated index's metadata; equal
document counts alone are insufficient.

## Capture and equality contract

The SQL lives inside `scripts/postgres-backup.mjs`, covered by that helper's
existing source/commit binding. It imports the validated exported snapshot in a
repeatable-read, read-only transaction, with `row_security=off`, a fixed
`pg_catalog` search path and a two-minute statement bound. It neither modifies
source records nor returns their values.

For the ordinary, unpartitioned `public.Document` relation, up to 5,000 rows:

1. Hash document ID, metadata binding (ID, organisation ID, storage path, byte
   count and MIME type), and object key using the existing v1 hash domains.
2. Form `[identityHash,metadataBindingHash,objectKeyHash,fileSize]` for each row.
   Order by identity hash using C collation, with no whitespace in JSON framing.
3. SHA-256 the UTF-8 bytes of `charitypilot:document-metadata-rows:v1`, a newline,
   and that JSON array. Explicit empty inventory hashes `[]`.

The shared JS `canonicalDocumentMetadataRowsSha256` implements the same new
domain over validated index metadata. Existing timestamp/XID inventory hashes,
index envelopes and database fingerprint hash domains remain unchanged.
Duplicate identities, invalid sizes, noncanonical hashes or excessive row counts
fail the JS projection. The SQL refuses null/invalid IDs, missing or excessive
paths/MIME types and out-of-range sizes before hashing; it never filters bad
rows to produce an apparently complete inventory.

The protected raw fingerprint report gains paired metadata count/hash fields.
The parser checks the count against the complete Document relation and requires
both fields. `source.documentMetadata` and `restored.documentMetadata` contain:

```text
format: charitypilot-document-metadata-rows/v1
rowCount: integer, 0..5000
rowsSha256: SHA-256
```

They enter the existing source fingerprint-report digest and dump binding.
Restored projection mismatch or missing counterpart fails comparison. No raw
IDs, paths, MIME values or document contents are added to the report. Digests
and counts remain restricted technical evidence, not anonymous public data.

The generic database proof can still describe databases without a qualifying
Document relation or above the archive's 5,000-document capacity; no projection
is reported in those cases. The archive coordinator refuses absent projection
evidence, including older reports without it. Those reports may still serve
their original database-proof purpose. There are no activated real cloud sets
to migrate from the earlier internal coordinator contract.

## Evidence and limits

The native PostgreSQL test executes the exact helper SQL against synthetic
multi-organisation records with Unicode, quotes, newlines, backslashes and
zero-byte metadata. A separate writer changes a storage path without changing
the row count. Importing the held snapshot matches the original JS digest;
current-state SQL matches the changed digest. Empty inventory is explicit and
invalid metadata is refused. The ordinary CI source-bound dump/restore proof
now also requires equal source/restored projection evidence, and runs the native
snapshot test. Inspect the exact hosted run before claiming it passed.

This binds metadata to the reported database snapshot; it does not freeze the
file store or prove source-report provenance. File contents may change at the
same path. Complete capture still needs a verified external-writer fence, whole
object inventory/readback and explicit reconciliation of orphan cleanup objects.
Independently current retention/disposal/hold/disclosure authority, trusted pins,
catalogue/custody, full application restore and provider/source-host-loss proof
remain required. Archive results stay `QUARANTINE_ONLY` with
`EXTERNAL_VERIFICATION_REQUIRED` consistency status.

Primary references checked 17 October 2026:

- [PostgreSQL snapshot import](https://www.postgresql.org/docs/16/sql-set-transaction.html).
- [Snapshot lifetime](https://www.postgresql.org/docs/16/functions-admin.html#FUNCTIONS-SNAPSHOT-SYNCHRONIZATION).
- [Built-in SHA-256](https://www.postgresql.org/docs/16/functions-binarystring.html).
