# CharityPilot Production Launch Checklist

Use this checklist as the top-level launch evidence ledger. Keep every item open until the named production evidence exists outside git or in the deployment system. Do not record secret values in this document.

## Evidence Rules

- Record owners, dates, command output locations, ticket links, deployment links, or report references.
- Keep screenshots, private reports, and secrets out of the repository.
- Run all checks against the deployed HTTPS production URL, not localhost.
- Treat a passing code release gate as necessary but not sufficient for launch.

## Launch Summary

| Area | Required evidence | Status |
| --- | --- | --- |
| Release gate | Command output for all release checks | Open |
| Secrets and env | Passing preflight against real secret source | Open |
| Hosting and DNS/TLS | Public web/API URLs with valid TLS | Open |
| Database | Production migration and backup evidence | Open |
| Supabase storage | Private bucket and signed URL verification | Open |
| Jobs | Scheduler or explicit in-process job decision | Open |
| Billing and email | Live Stripe webhook and Resend send evidence | Open |
| Observability | Alert destination and test alert evidence | Open |
| Legal and compliance | Approved production policies and owner signoff | Open |
| Browser QA | Desktop and mobile deployed QA run | Open |
| Security review | External penetration test report reference | Open |

## 1. Release Gate

- [ ] `npm ci` completed on the release build machine.
- [ ] `npm run db:generate -w @charitypilot/api` completed.
- [ ] `npx prisma validate --schema apps/api/prisma/schema.prisma` completed.
- [ ] `npm run lint` completed.
- [ ] `npm run test` completed.
- [ ] `npm run build -w @charitypilot/shared` completed.
- [ ] `npm run build -w @charitypilot/api` completed.
- [ ] `npm run build -w @charitypilot/web` completed.
- [ ] `npm audit --omit=dev --audit-level=moderate` completed with no moderate-or-higher production vulnerabilities.
- [ ] `npm run check:production -- --production-env-file=.env.production` completed against the real production secret source.
- [ ] `npm run deploy:preflight -- --production-env-file=.env.production` completed with digest-pinned API, web, and migration images.
- [ ] `npm run deploy:production -- --production-env-file=.env.production` completed on the production Docker host.
- [ ] `cosign signature verification` passed for all promoted image digests.
- [ ] Release image digest manifest artifact `release-image-digests.env` was downloaded from the signed release workflow and used as the promoted image source.

Evidence:

| Field | Value |
| --- | --- |
| Owner | |
| Date | |
| Build identifier | |
| Evidence location | |
| Digest-pinned image refs | |

## 2. Secrets And Environment

- [ ] Real production values were created from `.env.production.example`.
- [ ] `.env.production` or the platform-generated equivalent is excluded from git.
- [ ] `NODE_ENV=production` is set for the API, web app, and scheduled job runtime.
- [ ] `JWT_SECRET` is high entropy and at least 32 characters.
- [ ] `FRONTEND_URL` and `NEXT_PUBLIC_API_URL` use HTTPS public origins.
- [ ] `SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL` use the same HTTPS Supabase project origin.
- [ ] `CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL` is set for Docker Compose and matches `NEXT_PUBLIC_API_URL`.
- [ ] `CHARITYPILOT_WEB_NEXT_PUBLIC_SUPABASE_URL` is set for Docker Compose and matches `NEXT_PUBLIC_SUPABASE_URL`.
- [ ] `AUTH_COOKIE_DOMAIN` matches the deployed cookie scope or is intentionally unset for a single-host deployment.
- [ ] Stripe keys are live-mode production keys.
- [ ] Resend sender domain is verified for production sending.
- [ ] Supabase service role key is stored only in the API secret store.

Evidence:

| Field | Value |
| --- | --- |
| Secret store path | |
| Preflight output location | |
| Rotation owner | |

## 3. Hosting, DNS, And TLS

- [ ] Web app is deployed at the approved public HTTPS origin.
- [ ] API is deployed at the approved public HTTPS origin.
- [ ] DNS records are managed by the approved owner.
- [ ] TLS certificates are valid for the web and API origins.
- [ ] API CORS allows only the approved `FRONTEND_URL` origin list.
- [ ] Security headers are present on API responses.

Evidence:

| Field | Value |
| --- | --- |
| Web URL | |
| API URL | |
| DNS owner | |
| TLS evidence location | |

## 4. Database And Migrations

- [ ] Production PostgreSQL database is provisioned.
- [ ] Production `DATABASE_URL` is present only in the secret store.
- [ ] `npm run db:migrate:deploy -w @charitypilot/api` completed against production.
- [ ] Managed backups or point-in-time recovery are enabled.
- [ ] Restore test evidence exists and has an owner.

Evidence:

| Field | Value |
| --- | --- |
| Migration output location | |
| Backup policy location | |
| Restore test location | |

## 5. Supabase Storage

- [ ] Supabase production project is separate from local or staging projects.
- [ ] `documents` bucket exists or `SUPABASE_STORAGE_BUCKET` points to the approved private bucket.
- [ ] Bucket is private.
- [ ] API readiness endpoint reports `storageConfigured: true` when called with `x-charitypilot-readiness-key`.
- [ ] API readiness endpoint reports `storageBucketReachable: true` when called with `x-charitypilot-readiness-key`.
- [ ] Document upload and signed download are verified through the deployed app.

Evidence:

| Field | Value |
| --- | --- |
| Setup guide | `docs/supabase-production-setup.md` |
| Readiness output location | |
| Document QA evidence location | |

## 6. Jobs

- [ ] Production reminder scheduling is owned by the platform scheduler or explicitly enabled with `ENABLE_IN_PROCESS_JOBS=true`.
- [ ] If using the scheduler, it runs `npm run jobs:deadline-reminders -w @charitypilot/api`.
- [ ] The scheduler receives the same production secret source that passed preflight, either as injected environment variables or as a non-committed env file materialized for the job runtime.
- [ ] Scheduler logs and failure alerts are available.

Evidence:

| Field | Value |
| --- | --- |
| Scheduler owner | |
| Schedule definition location | |
| Test run output location | |

## 7. Billing And Email

- [ ] Stripe live products and prices match the four expected price IDs.
- [ ] Stripe webhook points to the deployed API webhook endpoint.
- [ ] Stripe webhook signing secret matches `STRIPE_WEBHOOK_SECRET`.
- [ ] Resend API key can send from `EMAIL_FROM`.
- [ ] Password reset and verification email links point to the production frontend origin.

Evidence:

| Field | Value |
| --- | --- |
| Stripe evidence location | |
| Resend evidence location | |
| Test message location | |

## 8. Observability And Incidents

- [ ] API logs are captured by the production platform.
- [ ] Web logs or platform events are captured.
- [ ] Error alert destination is configured and tested.
- [ ] Public uptime monitoring checks `/api/v1/health`.
- [ ] Internal readiness monitoring checks `/api/v1/health/readiness` with `x-charitypilot-readiness-key`.
- [ ] Incident owner and escalation path are recorded outside git.

Evidence:

| Field | Value |
| --- | --- |
| Alert destination | |
| Test alert output location | |
| Incident owner | |

## 9. Legal And Compliance

- [ ] Privacy policy is approved for production.
- [ ] Terms or service agreement is approved for production.
- [ ] Data retention policy is approved for production.
- [ ] Support and data deletion contact path is published.

Evidence:

| Field | Value |
| --- | --- |
| Policy location | |
| Approver | |
| Approval date | |

## 10. Browser QA

- [ ] `docs/production-browser-qa.md` has been completed against the deployed production URL.
- [ ] Desktop browser coverage is recorded.
- [ ] Mobile browser coverage is recorded.
- [ ] Auth, dashboard, billing, document upload, signed download, logout, and error states are covered.

Evidence:

| Field | Value |
| --- | --- |
| QA run owner | |
| QA date | |
| QA evidence location | |

## 11. External Security Review

- [ ] External penetration test is complete before handling real charity data.
- [ ] Critical and high findings are remediated or formally accepted by the accountable owner.
- [ ] Retest evidence exists for fixed findings.
- [ ] Report reference is stored outside git.

Evidence:

| Field | Value |
| --- | --- |
| Testing provider | |
| Report reference | |
| Remediation evidence location | |

## Final Signoff

| Role | Name | Date | Evidence reference |
| --- | --- | --- | --- |
| Engineering owner | | | |
| Operations owner | | | |
| Security owner | | | |
| Business owner | | | |
