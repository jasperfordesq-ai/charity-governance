# Production Operations Readiness Implementation Plan

> **Historical implementation plan:** retained for design and delivery
> provenance. It does not override the current launch guide, production runbook,
> remediation ledger or generated audit.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the repository-side production operations readiness pack that turns the remaining launch blockers into concrete evidence requirements, templates, and operator checklists.

**Architecture:** This is a documentation and configuration-template slice. The production env template stays mechanically tied to `scripts/check-production.mjs`, while the launch checklist becomes the top-level evidence ledger and links out to Supabase, browser QA, and the existing runbook.

**Tech Stack:** Node.js 22, npm workspaces, Turbo, Fastify API, Next.js web app, Prisma/PostgreSQL, Supabase Storage, Stripe, Resend, Markdown documentation.

---

## File Structure

- Create `.env.production.example`: production-only env template with deliberately invalid `REPLACE_ME` values so the production preflight fails until real secrets are supplied outside git.
- Create `docs/production-launch-checklist.md`: top-level evidence ledger for launch signoff, with open checkboxes and evidence fields for each operational area.
- Create `docs/supabase-production-setup.md`: Supabase production setup guide for private document storage, service role handling, bucket verification, backups, restore testing, and retention evidence.
- Create `docs/production-browser-qa.md`: deployed HTTPS browser QA checklist for desktop and mobile flows.
- Modify `docs/production-runbook.md`: link the new artifacts, clarify release evidence flow, and keep the preflight command pointed at a real `.env.production` file.
- Modify `PRODUCTION_TODO.md`: keep the concise status tracker open, but point each remaining blocker at the new evidence docs.

The implementation should not change runtime behavior, test code, package scripts, dependency versions, or CI configuration.

---

### Task 1: Add Production Env Template

**Files:**
- Create: `.env.production.example`

- [ ] **Step 1: Create the production-only env template**

Create `.env.production.example` with this exact content:

```dotenv
# =============================================================================
# CharityPilot - Production Environment Template
# Copy this file to a secret manager or an untracked .env.production file.
# Never commit real production secrets.
# =============================================================================

# Runtime
NODE_ENV=production
PORT=3002
HOST=0.0.0.0

# Database
# Use the managed production PostgreSQL connection string.
DATABASE_URL=REPLACE_ME_PRODUCTION_POSTGRES_URL

# Auth
# Generate at least 32 characters of high-entropy random data.
JWT_SECRET=REPLACE_ME_RANDOM_SECRET_AT_LEAST_32_CHARACTERS
JWT_EXPIRY=15m
REFRESH_TOKEN_TTL_DAYS=7

# Public origins
# FRONTEND_URL is used for CORS, CSRF origin checks, email links, and Stripe redirects.
# Use a comma-separated list only when more than one production web origin is approved.
FRONTEND_URL=https://REPLACE_ME_PUBLIC_WEB_ORIGIN.example
API_URL=https://REPLACE_ME_PUBLIC_API_ORIGIN.example
# Leave blank for single-host deployments. Set only when web and API hosts share a parent cookie domain.
AUTH_COOKIE_DOMAIN=

# Stripe
# Use live-mode keys and the four live price IDs used by checkout.
STRIPE_SECRET_KEY=REPLACE_ME_STRIPE_LIVE_SECRET_KEY
STRIPE_WEBHOOK_SECRET=REPLACE_ME_STRIPE_LIVE_WEBHOOK_SECRET
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=REPLACE_ME_STRIPE_LIVE_PUBLISHABLE_KEY
STRIPE_ESSENTIALS_MONTHLY_PRICE_ID=REPLACE_ME_STRIPE_ESSENTIALS_MONTHLY_PRICE_ID
STRIPE_ESSENTIALS_YEARLY_PRICE_ID=REPLACE_ME_STRIPE_ESSENTIALS_YEARLY_PRICE_ID
STRIPE_COMPLETE_MONTHLY_PRICE_ID=REPLACE_ME_STRIPE_COMPLETE_MONTHLY_PRICE_ID
STRIPE_COMPLETE_YEARLY_PRICE_ID=REPLACE_ME_STRIPE_COMPLETE_YEARLY_PRICE_ID

# Resend
RESEND_API_KEY=REPLACE_ME_RESEND_PRODUCTION_API_KEY
EMAIL_FROM=noreply@charitypilot.ie

# Supabase Storage
# SUPABASE_STORAGE_BUCKET must be private. The API issues signed download URLs.
SUPABASE_URL=https://REPLACE_ME_SUPABASE_PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=REPLACE_ME_SUPABASE_SERVICE_ROLE_KEY
SUPABASE_STORAGE_BUCKET=documents

# Next.js public vars
NEXT_PUBLIC_API_URL=https://REPLACE_ME_PUBLIC_API_ORIGIN.example

# Scheduler
# Keep false when production reminders are run by a platform scheduler.
ENABLE_IN_PROCESS_JOBS=false

# Demo seed
# Production must not seed demo workspaces.
SEED_DEMO_WORKSPACE=false
DEMO_PASSWORD=
```

- [ ] **Step 2: Verify the template deliberately fails production preflight**

Run:

```bash
npm run check:production -- --production-env-file=.env.production.example
```

Expected: FAIL with multiple `is missing or still contains a placeholder value` issues. The failure is correct because the file is a template, not a secret file.

- [ ] **Step 3: Confirm the template is not mistaken for a launch pass**

Run:

```bash
rg -n "Production preflight passed|launch complete|production ready" .env.production.example
```

Expected: no matches.

- [ ] **Step 4: Commit**

Run:

```bash
git add .env.production.example
git commit -m "docs: add production env template"
```

Expected: commit succeeds with only `.env.production.example` staged.

---

### Task 2: Add Launch Evidence Checklist

**Files:**
- Create: `docs/production-launch-checklist.md`

- [ ] **Step 1: Create the launch checklist**

Create `docs/production-launch-checklist.md` with this exact content:

```markdown
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

Evidence:

| Field | Value |
| --- | --- |
| Owner | |
| Date | |
| Build identifier | |
| Evidence location | |

## 2. Secrets And Environment

- [ ] Real production values were created from `.env.production.example`.
- [ ] `.env.production` or the platform-generated equivalent is excluded from git.
- [ ] `JWT_SECRET` is high entropy and at least 32 characters.
- [ ] `FRONTEND_URL`, `API_URL`, and `NEXT_PUBLIC_API_URL` use HTTPS public origins.
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
- [ ] API readiness endpoint reports `storageConfigured: true`.
- [ ] API readiness endpoint reports `storageBucketReachable: true`.
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
- [ ] Uptime or readiness monitoring checks `/api/v1/health/readiness`.
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
```

- [ ] **Step 2: Check that the checklist does not claim completion**

Run:

```bash
rg -n "\\| .* \\| Complete \\||\\[x\\]" docs/production-launch-checklist.md
```

Expected: no matches.

- [ ] **Step 3: Check required references are present**

Run:

```bash
rg -n ".env.production.example|docs/supabase-production-setup.md|docs/production-browser-qa.md|/api/v1/health/readiness|external penetration test" docs/production-launch-checklist.md
```

Expected: matches for each phrase.

- [ ] **Step 4: Commit**

Run:

```bash
git add docs/production-launch-checklist.md
git commit -m "docs: add production launch checklist"
```

Expected: commit succeeds with only `docs/production-launch-checklist.md` staged.

---

### Task 3: Add Supabase Production Setup Guide

**Files:**
- Create: `docs/supabase-production-setup.md`

- [ ] **Step 1: Create the Supabase setup guide**

Create `docs/supabase-production-setup.md` with this exact content:

```markdown
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
```

- [ ] **Step 2: Check guide covers storage readiness fields**

Run:

```bash
rg -n "SUPABASE_SERVICE_ROLE_KEY|SUPABASE_STORAGE_BUCKET|storageBucketReachable|signed URL|restore test|retention" docs/supabase-production-setup.md
```

Expected: matches for each phrase.

- [ ] **Step 3: Commit**

Run:

```bash
git add docs/supabase-production-setup.md
git commit -m "docs: add Supabase production setup guide"
```

Expected: commit succeeds with only `docs/supabase-production-setup.md` staged.

---

### Task 4: Add Deployed Browser QA Checklist

**Files:**
- Create: `docs/production-browser-qa.md`

- [ ] **Step 1: Create the browser QA checklist**

Create `docs/production-browser-qa.md` with this exact content:

```markdown
# Production Browser QA

Run this checklist against the deployed HTTPS production URL. Localhost testing does not verify production DNS, TLS, cookies, CORS, headers, storage downloads, or live provider integrations.

Do not use real charity records for launch QA. Use an approved non-sensitive test workspace and remove test documents after the run when required by policy.

## QA Run

| Field | Value |
| --- | --- |
| Web URL | |
| API URL | |
| Run owner | |
| Run date | |
| Evidence location | |

## Browser Matrix

| Platform | Browser | Result | Notes |
| --- | --- | --- | --- |
| Desktop | Chrome stable | Open | |
| Desktop | Edge stable | Open | |
| Desktop | Firefox stable | Open | |
| Desktop | Safari stable, if available | Open | |
| Mobile | iOS Safari | Open | |
| Mobile | Android Chrome | Open | |

## Network And Security Basics

- [ ] Web URL loads over HTTPS with a valid certificate.
- [ ] API URL loads over HTTPS with a valid certificate.
- [ ] Visiting `/api/v1/health` returns `status: ok`.
- [ ] Visiting `/api/v1/health/readiness` returns `status: ready` before launch.
- [ ] API responses include `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, and `Content-Security-Policy`.
- [ ] Production API responses include `Strict-Transport-Security`.
- [ ] Cross-origin API requests succeed only from approved frontend origins.

## Marketing And Public Pages

- [ ] Home page loads without console errors.
- [ ] Pricing or billing entry points render the expected production plans.
- [ ] Navigation links work on desktop and mobile.
- [ ] Page metadata and titles are production appropriate.
- [ ] Error and not-found states are understandable and do not expose server internals.

## Authentication

- [ ] Register flow creates an account for the approved test workspace.
- [ ] Login succeeds with the test user.
- [ ] Auth cookies are `HttpOnly`.
- [ ] Auth cookies are `Secure`.
- [ ] Auth cookies use the intended domain scope.
- [ ] Logout clears the access and refresh cookies.
- [ ] Password reset request submits successfully.
- [ ] Password reset email link points to the production frontend origin.

## Dashboard And Governance Workflows

- [ ] Dashboard loads after login.
- [ ] Organisation data pages load without unauthorized data exposure.
- [ ] Governance registers can be viewed.
- [ ] Deadlines can be viewed.
- [ ] Owner or administrator-only actions are not visible or fail safely for lower-privilege users.
- [ ] API errors show user-safe messages.

## Documents

- [ ] Upload a small non-sensitive test document.
- [ ] Uploaded document appears in the relevant document list.
- [ ] Download opens through the app route and a short-lived signed URL.
- [ ] Direct public access to the underlying storage path fails.
- [ ] Delete or clean up the test document when the QA run is complete.

## Billing

- [ ] Checkout entry points are disabled or safe when Stripe is not configured for the environment being tested.
- [ ] With live production Stripe configured, checkout uses live products and prices.
- [ ] Stripe webhook delivery is visible in the Stripe dashboard or deployment logs.
- [ ] Billing errors do not expose secret values or raw provider payloads to users.

## Email

- [ ] Email verification, if enabled in the tested flow, uses the production frontend origin.
- [ ] Password reset emails send from the approved `EMAIL_FROM` address.
- [ ] Email failures are logged for operators without exposing secrets in the browser.

## Mobile Usability

- [ ] Login form fits without horizontal scrolling.
- [ ] Dashboard navigation is usable on narrow screens.
- [ ] Document upload controls are reachable on supported mobile browsers.
- [ ] Buttons and links remain tappable without overlap.

## Exit Criteria

- [ ] No critical or high-severity browser QA defects remain open.
- [ ] Remaining medium or low defects have an owner and launch decision.
- [ ] `docs/production-launch-checklist.md` has the browser QA evidence reference.
```

- [ ] **Step 2: Check deployed-only language is present**

Run:

```bash
rg -n "deployed HTTPS production URL|Localhost testing does not verify|/api/v1/health/readiness|HttpOnly|signed URL" docs/production-browser-qa.md
```

Expected: matches for each phrase.

- [ ] **Step 3: Commit**

Run:

```bash
git add docs/production-browser-qa.md
git commit -m "docs: add production browser QA checklist"
```

Expected: commit succeeds with only `docs/production-browser-qa.md` staged.

---

### Task 5: Wire Runbook And Production Status Tracker

**Files:**
- Modify: `docs/production-runbook.md`
- Modify: `PRODUCTION_TODO.md`

- [ ] **Step 1: Replace the runbook with the linked operator guide**

Replace `docs/production-runbook.md` with this exact content:

```markdown
# CharityPilot Production Runbook

This runbook is the short operator guide for release promotion. The full launch evidence ledger is `docs/production-launch-checklist.md`.

## Production Evidence Artifacts

- `.env.production.example` - production env template for the secret manager or untracked `.env.production` file.
- `docs/production-launch-checklist.md` - top-level launch evidence checklist and final signoff.
- `docs/supabase-production-setup.md` - Supabase private storage, backup, restore, and retention evidence guide.
- `docs/production-browser-qa.md` - deployed HTTPS desktop and mobile browser QA checklist.
- `PRODUCTION_TODO.md` - concise project status tracker.

## Required Release Checks

Run these before promoting a build:

```bash
npm ci
npm run db:generate -w @charitypilot/api
npx prisma validate --schema apps/api/prisma/schema.prisma
npm run lint
npm run test
npm run build -w @charitypilot/shared
npm run build -w @charitypilot/api
npm run build -w @charitypilot/web
npm audit --omit=dev --audit-level=moderate
npm run check:production -- --production-env-file=.env.production
```

The production preflight command requires a real `.env.production` file or equivalent generated secret file at release time. Do not commit that file to the repository. Use `.env.production.example` only as a template; it is expected to fail preflight until real values replace the placeholders.

## Environment

The API requires configured production values for database, Stripe, Resend, Supabase, and the frontend URL. `JWT_SECRET` must be at least 32 characters. Refresh tokens are opaque, stored hashed in `AuthSession`, and delivered only through HTTP-only cookies.

The web app requires `NEXT_PUBLIC_API_URL` pointing to the public HTTPS API origin. Configure the API `FRONTEND_URL` to the exact HTTPS web origin, or a comma-separated list of approved production origins.

Set `AUTH_COOKIE_DOMAIN` only when the deployed web and API hosts need a shared parent cookie domain. Leave it unset for single-host deployments.

## Database

Apply migrations with:

```bash
npm run db:migrate:deploy -w @charitypilot/api
```

Use managed PostgreSQL backups with point-in-time recovery enabled. Confirm backup restore quarterly and record the evidence in `docs/production-launch-checklist.md`.

## Jobs

In production, the API does not run deadline reminders in-process unless `ENABLE_IN_PROCESS_JOBS=true`. Prefer a platform scheduler that runs:

```bash
npm run jobs:deadline-reminders -w @charitypilot/api
```

Record scheduler ownership and test-run evidence in `docs/production-launch-checklist.md`.

## Storage

Use a private Supabase Storage bucket. Documents are saved as storage paths and are opened through short-lived signed URLs from `/api/v1/documents/:id/download`.

Follow `docs/supabase-production-setup.md` before launch. Confirm `/api/v1/health/readiness` reports `storageConfigured: true` and `storageBucketReachable: true`.

## Browser QA

Run `docs/production-browser-qa.md` against the deployed HTTPS production URL and supported mobile devices. Localhost QA does not prove production DNS, TLS, cookies, CORS, security headers, storage downloads, or live provider integrations.

## Incident Basics

Rotate `JWT_SECRET`, Supabase service role keys, Stripe secrets, and Resend keys after any suspected secret exposure. Password reset invalidates all active sessions for that user.

## Release Gate

Code readiness is not the full production gate. Do not launch with real charity data until hosting, DNS/TLS, secrets, backups, monitoring alerts, legal documents, deployed browser QA, and external security review are complete and recorded in `docs/production-launch-checklist.md`.
```

- [ ] **Step 2: Replace the production status tracker with linked open blockers**

Replace `PRODUCTION_TODO.md` with this exact content:

```markdown
# CharityPilot Production Readiness Todo

Status marks reflect completed repository hardening work. Open items require real external evidence before CharityPilot can handle production charity data.

## Security and Auth

- [x] Move browser authentication away from `localStorage` and into HTTP-only cookies.
- [x] Replace stateless refresh JWTs with hashed, revocable, rotating refresh sessions.
- [x] Hash password reset and email verification tokens before storage.
- [x] Add logout and server-side refresh token revocation.
- [x] Add role guards for administrator and owner-only mutations.
- [x] Stop leaking unexpected server error messages in production.
- [x] Add security headers and Content Security Policy.
- [ ] Complete external penetration test before handling real charity data; record report and remediation evidence in `docs/production-launch-checklist.md`.

## Data and Documents

- [x] Keep document files private and retrieve them through signed download URLs.
- [x] Validate linked governance standards before creating document evidence links.
- [x] Restrict document mutations to owners/admins.
- [ ] Configure production Supabase project, private bucket, backups, restore testing, and retention policy using `docs/supabase-production-setup.md`.

## Build, Release, and Operations

- [x] Replace deprecated `next lint` script with ESLint flat config.
- [x] Add a deterministic Next production server entrypoint.
- [x] Add CI for lint, build, tests, Prisma validation, and dependency audit.
- [x] Add Docker build scaffolding for API and web.
- [x] Disable in-process reminder scheduling in production unless explicitly enabled.
- [ ] Provision production hosting, DNS/TLS, secrets, observability alerts, and runbook ownership; record evidence in `docs/production-launch-checklist.md`.

## Product Polish

- [x] Remove hardcoded demo credentials from the login screen.
- [x] Make demo seeding opt-in.
- [x] Fix auth error handling to use API error payloads.
- [x] Remove duplicate register-page shell inside the shared auth layout.
- [ ] Run `docs/production-browser-qa.md` against the deployed production URL and supported mobile devices.

## Verification

- [x] `npm run lint`
- [x] `npm run test`
- [x] `npm run test:production-check`
- [x] `npm run build -w @charitypilot/shared`
- [x] `npm run build -w @charitypilot/api`
- [x] `npm run build -w @charitypilot/web`
- [x] `npm audit --omit=dev --audit-level=moderate`
- [ ] `npm run check:production -- --production-env-file=.env.production`
- [ ] Complete `docs/production-launch-checklist.md` with real launch evidence.
```

- [ ] **Step 3: Check cross-document links**

Run:

```bash
rg -n ".env.production.example|production-launch-checklist|supabase-production-setup|production-browser-qa|/api/v1/health/readiness" docs/production-runbook.md PRODUCTION_TODO.md
```

Expected: matches in the runbook and production status tracker.

- [ ] **Step 4: Check the real preflight command still points to `.env.production`**

Run:

```bash
rg -n "npm run check:production -- --production-env-file=.env.production" docs/production-runbook.md PRODUCTION_TODO.md
```

Expected: matches in both files.

- [ ] **Step 5: Commit**

Run:

```bash
git add docs/production-runbook.md PRODUCTION_TODO.md
git commit -m "docs: wire production operations evidence"
```

Expected: commit succeeds with only `docs/production-runbook.md` and `PRODUCTION_TODO.md` staged.

---

### Task 6: Final Verification

**Files:**
- Verify: `.env.production.example`
- Verify: `docs/production-launch-checklist.md`
- Verify: `docs/supabase-production-setup.md`
- Verify: `docs/production-browser-qa.md`
- Verify: `docs/production-runbook.md`
- Verify: `PRODUCTION_TODO.md`

- [ ] **Step 1: Confirm the production template fails as expected**

Run:

```bash
npm run check:production -- --production-env-file=.env.production.example
```

Expected: FAIL because `.env.production.example` contains `REPLACE_ME` template values. Record the issue count in the final implementation summary.

- [ ] **Step 2: Confirm local env example still fails as expected**

Run:

```bash
npm run check:production -- --production-env-file=.env.example
```

Expected: FAIL because `.env.example` is local-development oriented and contains localhost or placeholder values.

- [ ] **Step 3: Run the production preflight unit tests**

Run:

```bash
npm run test:production-check
```

Expected: PASS.

- [ ] **Step 4: Run production dependency audit**

Run:

```bash
npm audit --omit=dev --audit-level=moderate
```

Expected: PASS with no moderate-or-higher production vulnerabilities.

- [ ] **Step 5: Confirm all new artifacts are linked**

Run:

```bash
rg -n ".env.production.example|production-launch-checklist|supabase-production-setup|production-browser-qa" docs PRODUCTION_TODO.md .env.production.example
```

Expected: matches in the runbook, launch checklist, status tracker, and relevant new docs.

- [ ] **Step 6: Confirm no generated docs claim launch completion**

Run:

```bash
rg -n "launch complete|production ready|ready for real charity data|\\[x\\].*(penetration|Supabase|hosting|browser QA|check:production)" docs/production-launch-checklist.md docs/supabase-production-setup.md docs/production-browser-qa.md docs/production-runbook.md PRODUCTION_TODO.md
```

Expected: no matches that claim external production evidence is complete. Existing `[x]` repository-hardening rows in `PRODUCTION_TODO.md` are acceptable only when they do not mention the open external evidence areas in the regex.

- [ ] **Step 7: Check git status**

Run:

```bash
git status --short --branch
```

Expected: clean working tree, with `master` ahead of `origin/master` by the new documentation commits.

- [ ] **Step 8: Final implementation summary**

Report:

- Files created and modified.
- Verification commands and pass/fail results.
- That `.env.production.example` and `.env.example` failed preflight intentionally.
- That the overall production readiness goal remains incomplete until the launch checklist has real external evidence.

Do not mark the production readiness goal complete after this slice.
