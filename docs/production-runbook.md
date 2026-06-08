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
npm run deploy:preflight -- --production-env-file=.env.production
docker compose --env-file .env.production -f compose.production.yml config --quiet
npm run deploy:production -- --production-env-file=.env.production
npm run check:production:hosting -- --production-env-file=.env.production
npm run check:production:database -- --production-env-file=.env.production --expect-operational-sentinel
npm run check:production:supabase -- --production-env-file=.env.production
npm run check:production:providers -- --production-env-file=.env.production
npm run check:production:observability -- --production-env-file=.env.production
npm run --silent check:production:evidence:template > production-launch-evidence.json
npm run check:production:release-run -- --evidence-file=production-launch-evidence.json
npm run check:production:evidence -- --evidence-file=production-launch-evidence.json
```

The production preflight command requires a real `.env.production` file or equivalent generated secret file at release time. Do not commit that file to the repository. Use `.env.production.example` only as a template; it is expected to fail preflight until real values replace the placeholders.

## Published Image Promotion

Production Docker promotion must use digest-pinned GHCR image references from the signed release workflow output. Download the release-image-digests artifact from the release workflow run and copy the values from `release-image-digests.env` into the approved production secret source:

```bash
CHARITYPILOT_API_IMAGE=ghcr.io/jasperfordesq-ai/charity-governance-api@sha256:<api-digest>
CHARITYPILOT_WEB_IMAGE=ghcr.io/jasperfordesq-ai/charity-governance-web@sha256:<web-digest>
CHARITYPILOT_MIGRATION_IMAGE=ghcr.io/jasperfordesq-ai/charity-governance-migrations@sha256:<migration-digest>
CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL=https://api.charitypilot.ie
CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
npm run deploy:preflight -- --production-env-file=.env.production
npm run deploy:production -- --production-env-file=.env.production
```

The deploy preflight validates the selected production env file, confirms the promoted web image build origins match `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_SUPABASE_URL`, renders `compose.production.yml`, and runs `cosign verify` against the API, web, and migration image digests. Do not deploy mutable image tags such as `:latest`, `:sha-*`, or semantic version tags; promote only `@sha256:` image references that pass signature verification.

The production deploy command runs the same preflight first, then executes `docker compose --env-file .env.production -f compose.production.yml up --wait --wait-timeout 180 -d`, then runs a post-deploy public HTTPS smoke against the configured web and API origins. The smoke checks the public web root, API health, approved-origin CORS, unauthenticated readiness protection, keyed readiness, and required security headers. Use `--dry-run` to print the preflight, compose, and post-deploy public HTTPS smoke commands without deploying.

For a bad digest promotion, download the previous signed `release-image-digests.env` artifact as `release-image-digests.previous.env` and run:

```bash
npm run deploy:rollback -- --production-env-file=.env.production --rollback-digest-file=release-image-digests.previous.env
```

Rollback reuses the production deploy path: the command validates that the rollback manifest contains only digest-pinned API, web, and migration images plus the web build-origin metadata, writes a temporary merged env file with the rollback image refs overlaid onto the selected production env file, runs the same preflight, Docker Compose wait, and post-deploy public HTTPS smoke, then removes the temporary env file. Use `--dry-run` to print the delegated deploy path before changing running containers.

## Environment

The API requires configured production values for database, Stripe, Resend, Supabase, and the frontend URL. `JWT_SECRET` must be at least 32 characters. Refresh tokens are opaque, stored hashed in `AuthSession`, and delivered only through HTTP-only cookies.

The web app requires `NEXT_PUBLIC_API_URL` pointing to the public HTTPS API origin and `NEXT_PUBLIC_SUPABASE_URL` pointing to the same Supabase project origin as `SUPABASE_URL`. Docker Compose also requires `CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL` and `CHARITYPILOT_WEB_NEXT_PUBLIC_SUPABASE_URL` for the web runtime. `CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL` must match `NEXT_PUBLIC_API_URL`, and `CHARITYPILOT_WEB_NEXT_PUBLIC_SUPABASE_URL` must match `NEXT_PUBLIC_SUPABASE_URL`. Keep all four public origin values in the selected production env file, export them before running Compose, or pass the env file with `docker compose --env-file .env.production`.

Configure the API `FRONTEND_URL` to the exact HTTPS web origin, or a comma-separated list of approved production origins.

Set `AUTH_COOKIE_DOMAIN` only when the deployed web and API hosts need a shared parent cookie domain. Leave it unset for single-host deployments.

## Hosting, DNS, And TLS

Run `npm run check:production:hosting -- --production-env-file=.env.production` before launch. The checker verifies the configured production web and API origins are origin-only HTTPS CharityPilot hosts, resolve through public DNS, present authorized TLS certificates with enough remaining lifetime, respond over HTTPS, and include baseline security headers. Record the redacted output in the launch evidence ledger.

## Database

Apply migrations with:

```bash
npm run db:migrate:deploy -w @charitypilot/api
```

Use managed PostgreSQL backups with point-in-time recovery enabled. Confirm backup restore quarterly and record the evidence in `docs/production-launch-checklist.md`.

Run `npm run check:production:database -- --production-env-file=.env.production --expect-operational-sentinel` before launch from a trusted shell with Docker available, after seeding the restore sentinel through the approved operational process. The checker takes a temporary custom-format dump from the production `DATABASE_URL`, restores it into a disposable local PostgreSQL container, verifies the critical application tables, governance reference data, and representative organisation, user, document, compliance, storage deletion, and Stripe webhook sentinel rows, then removes the temporary dump by default. Do not store retained dumps in evidence systems.

## Jobs

In production, the API container does not run scheduled jobs in-process. The default Docker Compose stack runs a separate `production-scheduler` service, and the `jobs` profile exposes one-shot reminder and cleanup commands for rehearsal or platform scheduler integrations:

```bash
node dist/jobs/production-scheduler.js
node dist/jobs/send-deadline-reminders.js
node dist/jobs/cleanup-document-storage.js
```

The scheduled job runtime must receive the same production secret source that passed preflight. For Docker Compose, `production-scheduler` must be running after deploy, and the `deadline-reminders` and `document-storage-cleanup` profile jobs must have recorded successful test-run evidence. If a platform scheduler replaces Compose scheduling, materialize a non-committed env file for the API job runtime from the approved production secrets, or inject equivalent environment variables and invoke the built job entrypoints directly.

Record scheduler ownership, command coverage for all three job entrypoints, log capture, and failure-alert evidence in `docs/production-launch-checklist.md`.

## Storage

Use a private Supabase Storage bucket. Documents are saved as storage paths and are opened through short-lived signed URLs from `/api/v1/documents/:id/download`.

Follow `docs/supabase-production-setup.md` before launch. Public monitoring can check `/api/v1/health`; detailed dependency readiness at `/api/v1/health/readiness` must include the internal `x-charitypilot-readiness-key` header. Confirm the keyed readiness response reports `storageConfigured: true` and `storageBucketReachable: true`.

Run `npm run check:production:supabase -- --production-env-file=.env.production` from a trusted shell that can read the production Supabase service role key. The checker verifies the configured bucket is private, uploads a tiny non-sensitive probe object, creates a short signed URL, confirms anonymous direct access to the object is denied, and deletes the probe. Output is redacted and must not be used to store service role keys, object paths, or signed URL tokens.

## Browser QA

Run `docs/production-browser-qa.md` against the deployed HTTPS production URL and supported mobile devices. Localhost QA does not prove production DNS, TLS, cookies, CORS, security headers, storage downloads, or live provider integrations.

## Incident Basics

Rotate `JWT_SECRET`, Supabase service role keys, Stripe secrets, and Resend keys after any suspected secret exposure. Password reset invalidates all active sessions for that user.

Run `npm run check:production:observability -- --production-env-file=.env.production` before launch from a trusted shell. The checker verifies `ERROR_ALERT_WEBHOOK_URL` is an HTTPS public destination, resolves through public DNS, accepts the same sanitized JSON payload shape used by API and job error alerts, and keeps the secret webhook URL out of output. Confirm the received alert in the external incident system and record the redacted evidence reference in the launch ledger.

## Billing And Email

Run `npm run check:production:providers -- --production-env-file=.env.production` from a trusted shell before launch. The checker verifies the four configured Stripe price IDs exist as active live recurring prices, confirms an enabled live Stripe webhook endpoint targets `/api/v1/billing/webhooks` on the configured production API origin, and confirms the Resend sender domain from `EMAIL_FROM` is verified. Output is redacted and must not be used to store Stripe or Resend secrets.

## Release Gate

Code readiness is not the full production gate. Do not launch with real charity data until hosting, DNS/TLS, secrets, backups, monitoring alerts, legal documents, deployed browser QA, and external security review are complete and recorded in `docs/production-launch-checklist.md`.

Before launch, materialize a non-committed `production-launch-evidence.json` file from the external evidence ledger. Start from `npm run --silent check:production:evidence:template > production-launch-evidence.json`, replace every placeholder from external evidence systems, run `npm run check:production:release-run -- --evidence-file=production-launch-evidence.json` to verify the referenced GitHub Actions release run and `release-image-digests` artifact through the GitHub API, record that redacted command output, and then run `npm run check:production:evidence -- --evidence-file=production-launch-evidence.json`. The validator requires all launch checklist areas, every machine-readable checklist check, dated external evidence references, final signoff, and separate `finalSignoff.approvals` entries for engineering, operations, security, and business owners. It also requires a `release` block binding the evidence to the promoted commit SHA, GitHub Actions release workflow run URL, `.github/workflows/release-images.yml`, a release ref of `refs/heads/master` or `refs/tags/v*`, digest-pinned API/web/migration image refs, and web image build origins from `release-image-digests.env`. It rejects placeholders, local URLs, and raw secret-looking values so evidence capture does not accidentally become secret storage.
