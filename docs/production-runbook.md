# CharityPilot Production Runbook

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

The production preflight command requires a real `.env.production` file or equivalent generated secret file at release time; do not commit that file to the repository.

## Environment

The API requires configured production values for database, Stripe, Resend, Supabase, and the frontend URL. `JWT_SECRET` must be at least 32 characters. Refresh tokens are opaque, stored hashed in `AuthSession`, and delivered only through HTTP-only cookies.

The web app requires `NEXT_PUBLIC_API_URL` pointing to the public HTTPS API origin. Configure the API `FRONTEND_URL` to the exact HTTPS web origin, or a comma-separated list of approved origins.

## Database

Apply migrations with:

```bash
npm run db:migrate:deploy -w @charitypilot/api
```

Use managed PostgreSQL backups with point-in-time recovery enabled. Confirm backup restore quarterly.

## Jobs

In production, the API does not run deadline reminders in-process unless `ENABLE_IN_PROCESS_JOBS=true`. Prefer a platform scheduler that runs:

```bash
npm run jobs:deadline-reminders -w @charitypilot/api
```

## Storage

Use a private Supabase Storage bucket. Documents are saved as storage paths and are opened through short-lived signed URLs from `/api/v1/documents/:id/download`.

## Incident Basics

Rotate `JWT_SECRET`, Supabase service role keys, Stripe secrets, and Resend keys after any suspected secret exposure. Password reset invalidates all active sessions for that user.

## Release Gate

Code readiness is not the full production gate. Do not launch with real charity data until hosting, DNS/TLS, secrets, backups, monitoring alerts, legal documents, and external security review are complete.
