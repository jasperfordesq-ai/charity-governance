# Supabase recovery candidate capture

17 October 2026. `SupabaseRecoveryCapture` supplies an internal source reader for
the planned managed recovery worker. It has no route, scheduler or operator
activation. It does not replace the application storage driver or change the
private VM/personal-server profile.

## Scope and credentials

Explicit configuration binds installation, project reference and bucket. The
only origin is `https://<projectRef>.supabase.co`; arbitrary origins, redirects,
environment credential lookup, public/download links and transformed images are
not supported. The configuration digest includes those source identities.

This new managed path accepts an explicitly supplied modern server secret key
and sends it only on `apikey`, following current provider guidance. It does not
treat that key as a JWT or send a fabricated Bearer identity. Existing application
credentials are not changed. Prefix validation does not prove the actual
credential privilege, project ownership, source region or complete visibility.
Those require independent registry/provider evidence before activation.

The implementation performs read operations, but the supplied server credential
is privileged and may permit writes outside this code. It must remain in a
separately controlled recovery component. Actual issuance, permissions and
delivery are not established by the synthetic tests and are not authorised by
constructing this component. There is no key creation, rotation, deletion or
Management API call.

## Capture sequence

1. Read the exact bucket and require `public=false` and matching ID.
2. Recursively list every folder in the supplied credential's view, with explicit
   100-item pages, offsets and name ordering. A full page requires another page.
   Validate file/folder shapes, identities, metadata sizes and timestamps.
3. Read each original file through the provider's authenticated object endpoint,
   check declared/observed size and MIME, compute full SHA-256, and invoke a
   trusted internal consumer. That consumer can seal and publish an encrypted
   candidate using the existing separate archive adapters. Await it, reject
   mutation of the source buffer, and clear plaintext after return or failure.
4. Re-enumerate and compare the complete supplied view, read every file again and
   compare its SHA, then repeat bucket/inventory checks before returning a result.

This uses the installed SDK's documented bucket/list/object route conventions;
file reads use neither public links nor a guessed provider version. Requests
carry cache-control headers, but provider/cache freshness still needs real proof.
HTTP failures, missing paths and permission errors never become empty inventory.
No source upload, delete, move, signed-link generation or retry is implemented.

Bounds are 5,000 files, 5,000 folders, 32 path levels, 2,048-character paths,
255-character segments, 30,000 HTTP requests, 1 MiB JSON responses and the existing
10 MiB per-file limit. Zero-byte files are explicit. Dot/traversal, separators,
control characters, percent-encoded ambiguity and malformed UTF-16 are refused,
not silently normalised or omitted. Metadata inventories are sorted in code
before comparison. Each request has a 15-second bound; capture has a one-hour
bound and caller cancellation. Late provider bodies are cancelled, including
after a lost observation deadline. Provider error bodies/credentials are not
included in errors. The trusted consumer receives cancellation and must honour
it; an ignored asynchronous cancellation cannot make the capture succeed.

## Result and proof boundary

```text
kind: SUPABASE_CANDIDATE_CAPTURE
restoreMode: QUARANTINE_ONLY
captureConsistency: EXTERNAL_VERIFICATION_REQUIRED
visibility: SUPPLIED_CREDENTIAL_VIEW_ONLY
```

The result includes source configuration/inventory digests, observation times,
validated file metadata and `{fileUrl,bytes,sha256}` rows for the archive index.
It proves successful repeated reads within the declared view. It does not prove
unfiltered project visibility, a common database/object snapshot, a durable global
writer fence, historical versions or complete provider erasure. A writer could
change bytes and change them back between observations. Service suspension and
PostgreSQL LOGIN closure alone do not exclude Supabase API/S3 credentials,
control-plane operations, direct SQL or an already-dispatched external write.
The existing maintenance component therefore still keeps wholeBackendQuiesced
false. Do not use this result to bypass that unresolved gate.

Any consumer-side partial encrypted candidates remain incomplete after an error;
do not publish a complete set from them. Durable pending/catalogue tracking and
cleanup remain required before activation. Orphan objects need separate cleanup/
disposal reconciliation; do not drop them to make the document index fit. Full
snapshot metadata/index comparison, current independent authority, actual
provider custody, isolated application restore and source-host-off/reopening
proof remain in the full goal.

## Verification

Synthetic HTTP tests cover recursive traversal, exactly full pages, duplicate
pages, source changes, invalid paths, bucket visibility, denial/rate limits,
zero-byte files, size refusal, stalled/late bodies and callback cancellation.
The existing signed S3/KMS archive-set fixture now uses this reader to supply
plaintext to the real codec and candidate transport, then prepares/verifies the
index/root with fresh archive clients. It still uses a synthetic database/report
fixture; it is not a real Supabase, full common-capture or host-loss test. No
account, key, grant or actual cloud data transfer occurred.

Primary references checked 17 October 2026:

- [Private bucket listing and folder entries](https://supabase.com/docs/reference/javascript/file-buckets-list).
- [Bucket details](https://supabase.com/docs/reference/javascript/file-buckets-getbucket).
- [Private file download](https://supabase.com/docs/reference/javascript/file-buckets-download).
- [Server API keys](https://supabase.com/docs/guides/getting-started/api-keys).
- [Separate S3 credential paths](https://supabase.com/docs/guides/storage/s3/authentication).
