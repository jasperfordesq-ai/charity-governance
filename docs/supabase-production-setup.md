# Supabase Production Setup

CharityPilot stores document files in a private Supabase Storage bucket. The API uses the Supabase service role key server-side and returns short-lived signed download URLs from `/api/v1/documents/:id/download`.

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
- [ ] Confirm the API service role key can upload, delete, and create signed URLs.
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
- [ ] Confirm the downloaded URL is a signed URL and expires after the storage service default of about 1 hour / 3600 seconds.
- [ ] Delete the test document if the flow creates production data that should not remain.

Executable expiry check:

```bash
SIGNED_URL="<redacted signed URL>"
curl -I "$SIGNED_URL"
sleep 3700
curl -I "$SIGNED_URL"
```

Expected: the first request succeeds, and the second request fails because the signed URL has expired.

Evidence safety:

Do not store full signed URLs, signed query tokens, raw bucket object paths, or private document contents in evidence systems. Record only redacted evidence such as the route tested, timestamp, expiry result, cleanup status, and non-sensitive test document metadata.

Evidence:

| Field | Value |
| --- | --- |
| QA run owner | |
| QA evidence location | |

## Backups, Restore Testing, And Retention

- [ ] Enable managed database backups or point-in-time recovery for production PostgreSQL.
- [ ] Record the backup window and retention period outside git.
- [ ] Run a restore test before launch.
- [ ] Repeat restore testing quarterly.
- [ ] Confirm document storage retention aligns with the approved data retention policy.
- [ ] Record the retention policy reference in `docs/production-launch-checklist.md`.

Evidence:

| Field | Value |
| --- | --- |
| Backup policy location | |
| Restore test location | |
| Retention policy location | |
