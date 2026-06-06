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

After production secrets are configured and the API is deployed, run this against the actual deployed API origin:

```bash
curl -i https://api.charitypilot.ie/api/v1/health/readiness
```

Expected when storage is ready:

```json
{
  "status": "ready",
  "checks": {
    "database": true,
    "billingConfigured": true,
    "emailConfigured": true,
    "storageConfigured": true,
    "storageBucketReachable": true
  }
}
```

If the production API uses a different hostname, run the same path on that hostname and record the actual URL in `docs/production-launch-checklist.md`.

## Document Flow Verification

- [ ] Sign in to the deployed production web app.
- [ ] Upload a small non-sensitive test document.
- [ ] Confirm the upload succeeds without exposing the raw bucket path publicly.
- [ ] Download the document through the app.
- [ ] Confirm the downloaded URL is a signed URL and expires.
- [ ] Delete the test document if the flow creates production data that should not remain.

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
