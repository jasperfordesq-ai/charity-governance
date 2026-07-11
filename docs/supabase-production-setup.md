# Supabase Production Setup

CharityPilot stores document files in a private Supabase Storage bucket. The API keeps the Supabase service role key server-side and proxies authenticated downloads from `/api/v1/documents/:id/download`; provider URLs, object paths, and storage capabilities are never returned to the browser.

Do not commit Supabase project URLs, service role keys, screenshots containing keys, or private bucket contents.

## Required Production Values

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Production Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side service role key stored only in the API secret store |
| `SUPABASE_STORAGE_BUCKET` | Private bucket name, normally `documents` |

## Project Setup

- [ ] Create a dedicated production Supabase project.
- [ ] Keep local, staging, and production projects separate.
- [ ] Store project ownership and billing owner outside git.
- [ ] Record the project reference in the production deployment system without exposing secrets.

Evidence:

| Field | Value |
| --- | --- |
| Project owner | |
| Evidence location | |

## Private Storage Bucket

- [ ] Create the bucket named by `SUPABASE_STORAGE_BUCKET`.
- [ ] Set the bucket to private.
- [ ] Do not create public read policies for document files.
- [ ] Confirm the API service role key can upload, download, and delete a non-sensitive probe object.
- [ ] Confirm anonymous public requests cannot fetch stored document paths directly.
- [ ] Run `npm run check:production:supabase -- --production-env-file=.env.production` from a trusted shell and record only redacted output.

Evidence:

| Field | Value |
| --- | --- |
| Bucket name | |
| Privacy evidence location | |

## Service Role Handling

- [ ] Store `SUPABASE_SERVICE_ROLE_KEY` only in the API secret store.
- [ ] Do not expose the service role key to the web app.
- [ ] Do not add the service role key to `NEXT_PUBLIC_*` variables.
- [ ] Rotate the service role key after any suspected exposure.
- [ ] Record the key rotation owner outside git.

Evidence:

| Field | Value |
| --- | --- |
| Secret store path | |
| Rotation owner | |

## Readiness Verification

After production secrets are configured and the API is deployed, run this against the actual deployed API origin from a trusted shell that can read `READINESS_API_KEY` without printing it:

```bash
curl -i \
  -H "x-charitypilot-readiness-key: $READINESS_API_KEY" \
  https://api.charitypilot.ie/api/v1/health/readiness
```

Expected when storage is ready:

```json
{
  "status": "ready",
  "timestamp": "2026-06-06T12:00:00.000Z",
  "checks": {
    "database": true,
    "billingConfigured": true,
    "emailConfigured": true,
    "storageConfigured": true,
    "storageBucketReachable": true
  }
}
```

Calling the same readiness URL without `x-charitypilot-readiness-key` should return `401` and must not expose dependency checks. Public uptime monitors that cannot send the internal header should use `/api/v1/health`.

If the production API uses a different hostname, run the same path on that hostname and record the actual URL in `docs/production-launch-checklist.md`.

## Document Flow Verification

- [ ] Sign in to the deployed production web app.
- [ ] Upload a small non-sensitive test document.
- [ ] Confirm the upload succeeds without exposing the raw bucket path publicly.
- [ ] Download the document through the app.
- [ ] Confirm the browser requests only the expected CharityPilot API origin and receives an attachment response with `Cache-Control: private, no-store`.
- [ ] Confirm the app does not receive or navigate to a Supabase URL, object path, or token-bearing query string.
- [ ] Suspend or revoke the test user's session during a deliberately delayed storage read in an isolated test environment and confirm the post-read session check denies the response. Use the automated reliability/E2E proof for launch evidence if a safe production delay cannot be introduced.
- [ ] If this document will be the mandatory non-vacuous recovery-rehearsal object, retain it through source backup, isolated restore, complete inventories, and reconciliation. Otherwise delete it through the normal authenticated application flow.

Executable private-bucket capability check:

```bash
npm run check:production:supabase -- --production-env-file=.env.production
```

Expected: the checker verifies a private bucket, service-role upload and authenticated download, anonymous direct-read denial, and probe cleanup. A failed cleanup or anonymous read success fails the check.

Evidence safety:

Do not store service-role keys, raw bucket object paths, private document contents, or token-bearing URLs in evidence systems. Record only redacted evidence such as the API route tested, timestamp, authenticated download result, anonymous-denial result, cleanup status, and non-sensitive test document metadata.

Evidence:

| Field | Value |
| --- | --- |
| QA run owner | |
| QA evidence location | |

## Backups, Restore Testing, And Retention

- [ ] Enable managed database backups or point-in-time recovery for production PostgreSQL and record its owner, schedule, retention, RPO, and RTO outside git.
- [ ] Configure a separate encrypted, versioned backup of the actual document object bytes in an approved independent destination. Supabase database backups include Storage metadata but not the stored objects: https://supabase.com/docs/guides/platform/backups.
- [ ] Retain at least one approved non-sensitive QA document/object through the source backup, isolated database/object restore, complete inventory capture, and reconciliation. The v1 verifier rejects a zero-document exercise; never introduce real charity data merely to satisfy that requirement. After evidence finalization, remove the QA document only through the normal authenticated deletion flow and allow the audited deletion lifecycle to reach `PROCESSED`.
- [ ] Do not treat the Supabase S3 compatibility layer as object versioning. Supabase documents that S3 bucket versioning is not supported and deleted objects cannot be restored through that feature: https://supabase.com/docs/guides/storage/s3/compatibility.
- [ ] Record the document-object backup schedule, owner, retention, RPO, RTO, last-success monitoring, failure alerting, and secure deletion behavior outside git.
- [ ] Run a joint PostgreSQL-metadata and document-object restore before launch into isolated, non-production database and object-storage targets.
- [ ] Reconcile every restored live `Document` metadata row to the independently captured object-backup inventory by object key, byte length, and SHA-256; require zero missing, unexpected/orphan, metadata-mismatched, size-mismatched, or checksum-mismatched objects.
- [ ] Capture the complete `DocumentStorageDeletion` and append-only `DocumentStorageDeletionRecovery` inventories in the same database transaction as each source/restored `Document` inventory. Require exact history parity, zero pending/dead-letter rows at certification, and no provider-object residue for processed deletion paths.
- [ ] Bind the source database snapshot/dump digest, source object-backup manifest digest, expected production document/object counts, restored inventories, and the reconciliation report to one recovery-set identifier.
- [ ] Export complete source/restored database envelopes with provider-approved, read-only external tooling. Each envelope includes exercise/recovery-set IDs, `inventoryScope: "complete-document-and-storage-deletion-tables"`, exact document/deletion/recovery-event counts, one database capture transaction ID, and all three complete row arrays. Export source/restored object envelopes with `inventoryScope: "complete-whole-bucket"`, exact object count/bytes, and every object row. Then use `npm run prepare:production:document-recovery-manifest -- build` to create the ignored/external v1 manifest without connecting to Supabase or writing raw identifiers, paths, object bytes, credentials, or signed URLs into the manifest.
- [ ] Confirm the recovery set is within the current fail-closed certification ceiling: no more than 5,000 documents, no object over 10 MiB, and no generated manifest over 16 MiB. A larger production set is an external launch blocker until a reviewed streaming/paginated v2 contract exists; do not sample or truncate it.
- [ ] Obtain named operator evidence that the live production database and Supabase object store were not overwritten or mutated and that restore credentials were scoped only to isolated targets. The offline verifier records and consistency-checks these attestations but cannot authenticate them or the external source provenance.
- [ ] Repeat restore testing quarterly.
- [ ] Confirm document storage retention aligns with the approved data retention policy.
- [ ] Record the retention policy reference in `docs/production-launch-checklist.md`.
- [ ] Record document-object-byte backup evidence—not PostgreSQL backup/PITR evidence—in `supabaseStorage.checks.supabase-backups-enabled`.
- [ ] Record the verifier-bound joint recovery summary, owner, restore date, recovery notes, isolated targets, attestation-recorded fields, `sourceProvenanceExternallyVerified: false`, and the external evidence supporting both production-not-overwritten claims in `supabaseStorage.checks.supabase-restore-tested`.

The operator workflow is deliberately offline. Generate a safe placeholder with `npm run prepare:production:document-recovery-manifest -- template --output-file=.charitypilot-launch-evidence/document-recovery-build-input.json --json`; complete it from immutable provider/operator evidence; export `charitypilot-document-metadata-inventory-export` and `charitypilot-document-object-inventory-export` envelopes for both `source` and `restored`; then run the `build` command documented in `docs/production-runbook.md`. The helper validates and bounds every export, canonicalizes document/deletion/recovery-event identity and lifecycle bindings plus object-key/inventory digests, requires exact source/restored reconciliation, and writes one owner-only manifest without overwrite. Retain the original exports, object-backup manifest, database dump, source-capture report, generation output, and provider custody evidence outside git before running the independent verifier.

The document manifest database identity and the standalone database restore proof identity are intentionally different contracts. Do not compare them for equality: cross-bind the exercises using the same recovery-set identifier and database dump SHA-256.

Evidence:

| Field | Value |
| --- | --- |
| Backup policy location | |
| Document-object backup manifest location | |
| Versioned source/restored inventory export locations | |
| V1 manifest generation result and schema location | `scripts/charitypilot-document-recovery-manifest-v1.schema.json` |
| Source database snapshot/dump SHA-256 | |
| Source object-backup manifest SHA-256 | |
| Isolated restore test location | |
| Non-production restore target reference | |
| Reconciliation report location and SHA-256 | |
| Production database/object-store not-overwritten confirmation | |
| Retention policy location | |
