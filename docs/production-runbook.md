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
```

The production preflight command requires a real `.env.production` file or equivalent generated secret file at release time. Do not commit that file to the repository. Use `.env.production.example` only as a template; it is expected to fail preflight until real values replace the placeholders.

## Published Image Promotion

Production Docker promotion must use digest-pinned GHCR image references from the signed release workflow output:

```bash
CHARITYPILOT_API_IMAGE=ghcr.io/jasperfordesq-ai/charity-governance-api@sha256:<api-digest>
CHARITYPILOT_WEB_IMAGE=ghcr.io/jasperfordesq-ai/charity-governance-web@sha256:<web-digest>
CHARITYPILOT_MIGRATION_IMAGE=ghcr.io/jasperfordesq-ai/charity-governance-migrations@sha256:<migration-digest>
npm run deploy:preflight -- --production-env-file=.env.production
```

The deploy preflight validates the selected production env file, renders `compose.production.yml`, and runs `cosign verify` against the API, web, and migration image digests. Do not deploy mutable image tags such as `:latest`, `:sha-*`, or semantic version tags; promote only `@sha256:` image references that pass signature verification.

## Environment

The API requires configured production values for database, Stripe, Resend, Supabase, and the frontend URL. `JWT_SECRET` must be at least 32 characters. Refresh tokens are opaque, stored hashed in `AuthSession`, and delivered only through HTTP-only cookies.

The web app requires `NEXT_PUBLIC_API_URL` pointing to the public HTTPS API origin and `NEXT_PUBLIC_SUPABASE_URL` pointing to the same Supabase project origin as `SUPABASE_URL`. Docker Compose also requires `CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL` and `CHARITYPILOT_WEB_NEXT_PUBLIC_SUPABASE_URL` for the web runtime. `CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL` must match `NEXT_PUBLIC_API_URL`, and `CHARITYPILOT_WEB_NEXT_PUBLIC_SUPABASE_URL` must match `NEXT_PUBLIC_SUPABASE_URL`. Keep all four public origin values in the selected production env file, export them before running Compose, or pass the env file with `docker compose --env-file .env.production`.

Configure the API `FRONTEND_URL` to the exact HTTPS web origin, or a comma-separated list of approved production origins.

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

The scheduled job must receive the same production secret source that passed preflight. If the platform invokes the npm script as written, materialize a non-committed env file for the API job runtime from the approved production secrets, or inject equivalent environment variables and invoke the built job entrypoint directly.

Record scheduler ownership and test-run evidence in `docs/production-launch-checklist.md`.

## Storage

Use a private Supabase Storage bucket. Documents are saved as storage paths and are opened through short-lived signed URLs from `/api/v1/documents/:id/download`.

Follow `docs/supabase-production-setup.md` before launch. Public monitoring can check `/api/v1/health`; detailed dependency readiness at `/api/v1/health/readiness` must include the internal `x-charitypilot-readiness-key` header. Confirm the keyed readiness response reports `storageConfigured: true` and `storageBucketReachable: true`.

## Browser QA

Run `docs/production-browser-qa.md` against the deployed HTTPS production URL and supported mobile devices. Localhost QA does not prove production DNS, TLS, cookies, CORS, security headers, storage downloads, or live provider integrations.

## Incident Basics

Rotate `JWT_SECRET`, Supabase service role keys, Stripe secrets, and Resend keys after any suspected secret exposure. Password reset invalidates all active sessions for that user.

## Release Gate

Code readiness is not the full production gate. Do not launch with real charity data until hosting, DNS/TLS, secrets, backups, monitoring alerts, legal documents, deployed browser QA, and external security review are complete and recorded in `docs/production-launch-checklist.md`.
