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
- [ ] The deploy command's post-deploy public HTTPS smoke completed against the production web and API origins.
- [ ] `npm run deploy:rollback -- --production-env-file=.env.production --rollback-digest-file=release-image-digests.previous.env` rollback rehearsal completed against a previous signed digest manifest with post-deploy smoke evidence.
- [ ] `cosign signature verification` passed for all promoted image digests.
- [ ] The release workflow evidence identifies `.github/workflows/release-images.yml` and a release ref of `refs/heads/master` or `refs/tags/v*`.
- [ ] `npm run check:production:release-run -- --evidence-file=production-launch-evidence.json` verified the GitHub Actions run metadata and `release-image-digests` artifact through the GitHub API.
- [ ] Release image digest manifest artifact `release-image-digests.env` was downloaded from the signed release workflow and used as the promoted image source.
- [ ] The release manifest's web image build origins match the promoted production public origins.
- [ ] `npm run --silent check:production:evidence:template > production-launch-evidence.json` was used as the starting schema for the non-committed external launch evidence ledger.
- [ ] `npm run check:production:evidence -- --evidence-file=production-launch-evidence.json` passed against the machine-readable external launch evidence ledger.

Evidence:

| Field | Value |
| --- | --- |
| Owner | |
| Date | |
| Build identifier | |
| Release workflow run URL | |
| Release workflow file | `.github/workflows/release-images.yml` |
| Release git ref | |
| GitHub API release-run verification output | |
| Evidence location | |
| Digest-pinned image refs | |
| Web image build origins | |

## 2. Secrets And Environment

- [ ] Real production values were created from `.env.production.example`.
- [ ] `.env.production` or the platform-generated equivalent is excluded from git.
- [ ] `NODE_ENV=production` is set for the API, web app, and scheduled job runtime.
- [ ] `JWT_SECRET` is high entropy and at least 32 characters.
- [ ] `FRONTEND_URL=https://app.charitypilot.ie` and `NEXT_PUBLIC_API_URL=https://api.charitypilot.ie`.
- [ ] `SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL` use the same HTTPS Supabase project origin.
- [ ] `CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL` is set for Docker Compose and matches `NEXT_PUBLIC_API_URL`.
- [ ] `CHARITYPILOT_WEB_NEXT_PUBLIC_SUPABASE_URL` is set for Docker Compose and matches `NEXT_PUBLIC_SUPABASE_URL`.
- [ ] `AUTH_COOKIE_DOMAIN=.charitypilot.ie` covers the canonical web and API subdomains.
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

- [ ] Web app is deployed at `https://app.charitypilot.ie`.
- [ ] API is deployed at `https://api.charitypilot.ie`.
- [ ] DNS records are managed by the approved owner.
- [ ] TLS certificates are valid for the web and API origins.
- [ ] API CORS allows only the canonical `FRONTEND_URL` origin.
- [ ] Security headers are present on API responses.
- [ ] `npm run check:production:hosting -- --production-env-file=.env.production` completed from a trusted shell and recorded redacted evidence.

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
- [ ] `npm run check:production:database -- --production-env-file=.env.production --expect-operational-sentinel` completed from a trusted shell and recorded redacted backup/restore evidence.
- [ ] Managed backups or point-in-time recovery are enabled.
- [ ] Restore test evidence exists and has an owner.

Evidence:

| Field | Value |
| --- | --- |
| Migration output location | |
| Backup policy location | |
| Operational sentinel restore test location | |

## 5. Supabase Storage

- [ ] Supabase production project is separate from local or staging projects.
- [ ] `documents` bucket exists or `SUPABASE_STORAGE_BUCKET` points to the approved private bucket.
- [ ] Bucket is private.
- [ ] `npm run check:production:supabase -- --production-env-file=.env.production` completed from a trusted shell and recorded redacted evidence.
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

- [ ] Production job scheduling is owned by the Docker Compose `production-scheduler` service or an explicitly approved platform scheduler replacement.
- [ ] The deployed scheduler command is `node dist/jobs/production-scheduler.js`.
- [ ] Reminder job test evidence covers `node dist/jobs/send-deadline-reminders.js`.
- [ ] Document storage cleanup test evidence covers `node dist/jobs/cleanup-document-storage.js`.
- [ ] The scheduler and one-shot job runtimes receive the same production secret source that passed preflight, either as injected environment variables or as a non-committed env file materialized for the job runtime.
- [ ] Scheduler and job logs are captured.
- [ ] Failure alerts are tested for both `deadline-reminders` and `document-storage-cleanup`.

Evidence:

| Field | Value |
| --- | --- |
| Scheduler owner | |
| Scheduler service evidence location | |
| Reminder job test output location | |
| Cleanup job test output location | |
| Failure alert evidence location | |

## 7. Billing And Email

- [ ] Stripe live products and prices match the four expected price IDs.
- [ ] Stripe webhook points to the deployed API webhook endpoint and is subscribed to `checkout.session.completed`, `customer.subscription.updated`, and `customer.subscription.deleted`.
- [ ] Stripe webhook signing secret matches `STRIPE_WEBHOOK_SECRET` in the production secret store without recording the raw secret.
- [ ] Resend API key can send from `EMAIL_FROM`, with an accepted message id or equivalent provider delivery reference recorded outside git.
- [ ] Password reset and verification email links point to the production frontend origin.
- [ ] `npm run check:production:providers -- --production-env-file=.env.production` completed from a trusted shell and recorded redacted evidence.

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
- [ ] `npm run check:production:observability -- --production-env-file=.env.production` completed from a trusted shell and the received test alert was confirmed in the incident system.
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
- [ ] Solicitor, governance, and privacy review confirms the production wording remains review-ready, source-cited, and clear that CharityPilot is not a substitute for legal advice.
- [ ] Machine-readable launch evidence includes the approved privacy policy, terms/service agreement, data-retention policy, support/data-deletion contact, and `legalAndCompliance.checks.solicitor-governance-privacy-review` evidence.

Evidence:

| Field | Value |
| --- | --- |
| Policy location | |
| Approver | |
| Approval date | |

## 10. Browser QA

- [ ] `docs/production-browser-qa.md` has been completed against the deployed production URL.
- [ ] Machine-readable launch evidence includes deployed `npm run test:e2e:responsive` command output with `E2E_DEPLOYED_QA=true`, canonical web/API URLs, and secret-store owner credential references.
- [ ] Machine-readable launch evidence includes deployed `npm run test:e2e -- tests/accessibility.spec.ts` command output with the same deployed QA environment.
- [ ] Desktop browser coverage is recorded with deployed responsive-smoke evidence for the desktop light/dark route matrix.
- [ ] Mobile browser coverage is recorded with deployed responsive-smoke evidence for the mobile light/dark route matrix.
- [ ] Auth, dashboard, billing, document upload, signed download, logout, and error states are covered in `docs/production-browser-qa.md` and the machine-readable launch evidence.

Evidence:

| Field | Value |
| --- | --- |
| QA run owner | |
| QA date | |
| QA evidence location | |

## 11. External Security Review

- [ ] External penetration test is complete before handling real charity data, with the testing provider recorded.
- [ ] Critical and high findings are remediated or formally accepted by the accountable owner.
- [ ] Retest evidence exists for fixed findings.
- [ ] Report reference is stored outside git and referenced in the machine-readable launch evidence.

Evidence:

| Field | Value |
| --- | --- |
| Testing provider | |
| Report reference | |
| Remediation evidence location | |

## Final Signoff

The machine-readable `production-launch-evidence.json` must include a `finalSignoff.approvals` object with separate `engineering`, `operations`, `security`, `legalCompliance`, and `business` approvals. Each role approval must have `status: "approved"`, an owner, an ISO `approvedAt` timestamp, and non-secret external evidence references.

| Role | Name | Date | Evidence reference |
| --- | --- | --- | --- |
| Engineering owner | | | |
| Operations owner | | | |
| Security owner | | | |
| Legal/compliance owner | | | |
| Business owner | | | |
