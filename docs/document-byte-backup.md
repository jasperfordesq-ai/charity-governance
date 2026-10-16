# Independent document byte archive candidates

The metadata/decision recovery envelopes do not contain the document's file
bytes. This component supplies encrypted immutable byte candidates separately
from the bounded intent journal. It is not connected to an API, scheduler,
automatic capture job, restore writer, disposal worker or live provider account.

## Scope and authentication

Each candidate binds the exact installation, backup-set UUID, organisation,
document, source release SHA, database-backup SHA, source metadata/object binding
SHA, byte count, byte SHA and explicit Ireland KMS key ARN. Context is canonical
and closed to extra fields. Set UUIDs are canonical lowercase. No title, original
filename, object path, case narrative, actor name or application secret is a
field in this envelope. IDs and hashes are still potentially identifying routing
metadata, not a claim of anonymisation.

The producer must obtain these facts from the quiesced source and existing
document/database inventory contract. This component does not authenticate that
source capture or create a consistent database snapshot. A caller inventing a
binding hash has not established provenance or completeness.

Seal the exact bytes with a fresh KMS-generated AES-256 data key, random12-byte
nonce and AES-GCM authentication. The dedicated document-backup AAD includes the
entire canonical context; the KMS encryption context has a distinct purpose from
the complaint/control envelopes. Only wrapped key, ciphertext, nonce and tag are
stored. Source buffers are copied before awaiting; owned transient plaintext/key
buffers are cleared. No claim is made to erase every SDK/engine/GC memory copy.

The byte ceiling imports the existing10 MB document-upload limit. Zero-byte
legacy objects are supported. JSON/base64 lengths and decoded sizes are bounded;
there is no archive decompression or document-content parsing.

Opening requires the exact expected context and envelope digest from a separately
authenticated backup-set manifest. Neither may be accepted solely from this
object. Check canonical structure, ciphertext length, KMS key/context, GCM tag,
plaintext size and SHA before returning bytes. Authentication failure clears
partial plaintext. Returned verified bytes belong to the caller and must remain
quarantined until current preservation/disposal/permission authority is reconciled.
This function writes no database or file and grants no disclosure or reopening.

## Provider boundaries

`KmsDocumentBackupKeys` pins the exact key ARN and Ireland endpoint, explicit
credentials, AES_256 generation and SYMMETRIC_DEFAULT decryption. Context contains
only the scoped routing IDs/digests/size, never reasons or filenames. No ambient
credential/key/endpoint fallback or key guessing is provided. Each SDK call has
one attempt, a15-second outer deadline and shorter connection timeout. Reject
wrong key/algorithm/size, clear returned SDK plaintext and clear late responses.
Historical keys require separately trusted explicit configuration; do not derive
an allowed key from an unauthenticated recovered object.

`S3DocumentByteBackups` pins Ireland, bucket owner, installation and two distinct
same-account keys: archive data encryption and S3 server encryption. These checks
are configuration consistency, not evidence of separate IAM administrators.
Every candidate has one fixed key derived from its set/document/source binding.
It uses conditional create-if-absent and full SHA-256 checksums, with SSE-KMS and
versioning metadata. It refuses conflict rather than overwrite or re-encrypt.

A successful publish requires exact-version readback, matching encryption/key,
version, checksum, length, canonical scope and body digest. Reads are bounded,
cancelled on deadline and destroy failed or late streams. Missing objects,
delete markers, unversioned objects and truncated/substituted bodies fail closed.
No absence is interpreted as an empty successful backup.

After a lost write acknowledgement, retain the originally sealed candidate and
digest. A fresh client may make a read-only observation of that exact digest;
it does not repeat the write or generate another key. An observation is not an
original commit acknowledgement or a completed current backup-set manifest.
Normal SDK retries and region redirects are disabled. There is no delete,
overwrite, bucket provisioning, head publication or automatic recovery action.

## Authenticated inventory connection

The [document archive index](document-backup-index.md) now reconciles complete
supplied metadata/object inventories with exact archive version receipts and
authenticates the index using a separate KMS HMAC key. Its per-document source
binding is the existing canonical metadata-binding hash. It still does not
capture a database, publish a complete set or authorise restored-file admission.

## Verification and remaining integration

Tests use real cryptography and SDK request signing with synthetic credentials
and injected isolated transports. Fresh clients recover after the simulated
primary buffer is cleared and a publish response is lost. They test the supported
size ceiling, scope/tag/digest substitution, canonical/extra-field refusal,
provider key faults, SDK-buffer clearing, late responses, version/encryption/
checksum/length refusals and stalled-stream cancellation. They make no real AWS
request and do not prove separate-host or independently administered custody.

Before activation, finish the consistent full database plus object capture,
complete inventory/manifest publication and verification, supported restore writer,
current-authority reconciliation, superseded/missing-copy quarantine and backup
retention/hold/erasure procedure. Publish no complete-set or daily-RPO claim from
one candidate. Do not silently omit legacy, unsupported or unresolved objects.
Storage versioning alone does not prove immutability against a privileged actor.

Real provider/IAM/key custody, rotated replacement secrets, source-host-off,
old-writer exclusion, independently fresh authority and safe reopening remain
required. Actual tenant backup policy/adoption and supplier spend/access are
separate from this implementation. No real data has been archived by it.

Primary references checked16 October2026:

- [Supabase backups](https://supabase.com/docs/guides/platform/backups): database
  backups exclude Storage API object bytes and custom-role passwords.
- [KMS data keys](https://docs.aws.amazon.com/kms/latest/APIReference/API_GenerateDataKey.html).
- [S3 conditional object writes](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html).

See also the existing document recovery manifest/verifier and
[managed recovery contract](managed-backend-maintenance.md). The byte archive
does not replace or advance the preservation/disposal authority journal.
