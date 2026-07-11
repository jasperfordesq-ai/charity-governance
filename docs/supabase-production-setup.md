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
- [ ] Delete the test document if the flow creates production data that should not remain.

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

- [ ] Enable managed database backups or point-in-time recovery for production PostgreSQL.
- [ ] Record the backup window and retention period outside git.
- [ ] Run a restore test before launch into an isolated, non-production restore target.
- [ ] Confirm the live production Supabase project was not overwritten or mutated by the restore rehearsal.
- [ ] Repeat restore testing quarterly.
- [ ] Confirm document storage retention aligns with the approved data retention policy.
- [ ] Record the retention policy reference in `docs/production-launch-checklist.md`.
- [ ] Record backup/PITR evidence in `supabaseStorage.checks.supabase-backups-enabled`.
- [ ] Record restore-test owner, restore date, recovery notes, isolated restore target, non-production restore target, and confirmation that the production project was not overwritten in `supabaseStorage.checks.supabase-restore-tested`.

Evidence:

| Field | Value |
| --- | --- |
| Backup policy location | |
| Isolated restore test location | |
| Non-production restore target reference | |
| Production-not-overwritten confirmation | |
| Retention policy location | |
