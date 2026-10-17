# Encrypted PostgreSQL archive bytes

17 October 2026. This component encrypts a previously captured PostgreSQL
custom-format dump and restores its bytes to isolated quarantine. It reuses the
existing source-bound `postgres-backup.mjs prove-restore` contract. It does not
introduce another database snapshot mechanism, run migrations or reopen services.
The source proof's ownership/ACL/database-level configuration exclusions and
unsupported-sequence/schema refusals remain. Replacement roles, grants and host
secrets require their separate guarded provisioning and verification paths.

## Binary format and scope

The source context binds installation, new archive-set UUID, source release SHA,
source database identity, capture-report SHA, exact plaintext dump SHA/count and
explicit Ireland KMS key ARN. A report's capture-exercise identifier is retained
inside that report; a new archive-set UUID does not recreate that earlier ID.
The database identity here is the existing PostgreSQL source-proof identity,
not an inferred provider/project inventory digest. Keep those identities distinct
when composing the later complete recovery-set manifest.

Wire encoding:

1. ASCII `CHARITYPILOT_DATABASE_BYTES_V1` followed by LF.
2. Four-byte unsigned big-endian canonical header length, at most 16 KiB.
3. Canonical UTF-8 JSON: format 1, context, canonical base64 wrapped key,
   eight-byte random nonce prefix and `chunkBytes: 1048576`.
4. Repeated frames: four-byte plaintext length, that many ciphertext bytes,
   and a 16-byte authentication tag. Every non-final frame is exactly 1 MiB;
   the final frame has exactly the remaining expected plaintext length.

Use a fresh KMS-generated AES-256 data key for every archive. Each frame uses
AES-GCM with a 12-byte nonce made from the file's eight-byte prefix and four-byte
frame ordinal. Additional authenticated data includes the entire binary header,
ordinal and frame length. This binds sequence, file scope and framing; frames
cannot be reordered or transplanted between archives. The ordinal is bounded by
the existing 64 GiB dump ceiling: at most 65,536 frames. Chunking avoids crossing
GCM's single-invocation plaintext limit. There is no gzip/tar decompression or SQL
execution in the byte codec.

All inputs use one-shot binary Node streams, with input chunks at most 1 MiB.
The held-descriptor file reader in the native proof supplies 64 KiB chunks.
Copy borrowed bytes before an async boundary. Owned encryption plaintext buffers
and data keys are cleared. Memory use is bounded by a few chunks, not dump size.
The 64 GiB boundary is validated; the tests do not process a 64 GiB fixture.

Sealing checks exact size, plaintext SHA and `PGDMP` signature before returning
a success receipt. The receipt carries encrypted SHA/count and plaintext SHA.
A custom-format signature is not proof of a valid or complete database; the
existing capture/restore tool and native restored-database checks provide that
separate evidence.

## Quarantine and failure handling

Opening requires independently trusted expected context and archive SHA, never
just values read from the recovered header. Validate strict canonical header,
bounded lengths, exact scope and returned KMS key. Authenticate each entire frame
before its plaintext reaches quarantine. Then require exact EOF, full encrypted
SHA, full plaintext SHA/count and dump signature before returning success.

The output MUST be a new, private, isolated quarantine destination. Do not pass
a live database restore pipe, application upload, public object or existing file.
Cancellation, malformed/tampered/truncated/appended input, wrong scope/key/hash,
broken output and a 45-minute operation deadline destroy the owned streams.
Previously authenticated frames may already be in quarantine after a later
failure; the caller must discard the entire partial destination. Only a success
receipt permits the next isolated restore check. It does not permit production
admission, disclosure, disposal or reopening. The codec cannot enforce a caller's
filesystem ACL or erase every SDK/engine/OS memory copy.

`KmsDatabaseBackupKeys` uses a distinct database-backup purpose and the exact
source/capture/byte context. It pins explicit key/region/endpoint/credentials,
AES_256 generation and SYMMETRIC_DEFAULT unwrap, with one attempt, bounded SDK
transport and a 15-second outer deadline. Wrong key/algorithm/blob/DEK sizes are
refused; rejected and late SDK plaintext is cleared. The caller clears copied
owned DEKs. Historical keys require separately trusted configuration. No key,
alias, credential or endpoint discovery occurs.

## Verification

Unit tests exercise a multi-frame 2 MiB binary fixture, scope/digest/ciphertext
tampering, reordered frames, malformed lengths/headers, truncation, appended
bytes, stalled-stream cancellation, output faults, caller-buffer mutation during
unwrap, size boundaries, invalid key responses and late SDK response clearing.

The native test uses signed SDK requests with synthetic credentials and isolated
KMS handlers. Its local branch creates an unprivileged, read-only, network-none
PostgreSQL fixture with tmpfs data, captures an actual custom dump, removes the
source container and its own plaintext file, decrypts the encrypted archive into
a new private directory, and restores/query-checks a second isolated PostgreSQL.
All Docker children pass the existing verified-local-engine boundary. It removes
only its uniquely named containers and verified temporary directory.

CI runs the same archive test immediately after its existing full source-bound
capture/restore proof. That branch requires the report, independently supplied
source identity and exact CI commit, holds report/dump descriptors, checks the
dump digest through encryption and restores the decrypted dump using the existing
strict verifier with operational sentinels. CI refuses to fall back to the local
small fixture. Local synthetic success is not evidence that this CI branch has
run; inspect the exact commit's hosted step before claiming that result.

## Remaining integration

The [S3 candidate adapter](database-backup-storage.md) now streams multipart
archives with conditional completion and full exact-version readback. Its
synthetic SDK tests cover unknown completion and fresh-client recovery. It is
not activated against a real account or complete-set producer.

No actual KMS account call, S3 database/index publication or complete managed
capture job is activated. Database/object capture still needs verified writer
closure and a common consistency boundary; the database snapshot alone cannot
freeze an external object store. Complete independently authenticated set
publication/readback, supported private quarantine storage and full isolated
restoration remain required.

Restored data contains historical sessions and decisions. Independently current
preservation/disposal authority, replacement secrets, restored-session revocation,
old-writer exclusion and guarded reopening must pass before application startup.
Actual provider/IAM/key custody, source-host-off and tenant backup-retention
adoption remain separate gates. A successful local archive does not establish
independent custody, an RPO/RTO guarantee or erasure of all copies.

References checked 17 October 2026:

- [NIST SP 800-38D](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf),
  GCM invocation bounds and nonce uniqueness.
- [AWS KMS GenerateDataKey](https://docs.aws.amazon.com/kms/latest/APIReference/API_GenerateDataKey.html),
  fresh data keys, wrapping and encryption context.
