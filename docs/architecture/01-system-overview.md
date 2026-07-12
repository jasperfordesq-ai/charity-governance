# System Overview

CharityPilot is a commercial SaaS that digitises the Irish Charities Regulator (CRA) Governance Code Compliance Record Form and its supporting governance registers, letting a charity track compliance, board members, documents, deadlines and sign-off in one place (`README.md:1-9`). It is a [Turborepo](https://turbo.build/) monorepo of three workspaces — a Fastify REST API, a Next.js web app, and a shared types/schemas package — deployed as containerised services backed by PostgreSQL and a small set of external providers (`README.md:15-26`).

## Workspaces

The repository root declares the workspace globs `packages/*` and `apps/*` (`package.json:4-7`), giving three published-internal packages:

| Workspace | Path | Package name | Responsibility | Key dependencies |
| --- | --- | --- | --- | --- |
| API | `apps/api` | `@charitypilot/api` | Fastify 5 REST API (TypeScript, ESM): routes, services, Prisma data access, in-process and standalone scheduled jobs | `fastify`, `@prisma/client`, `@supabase/supabase-js`, `stripe`, `resend`, `zod` (`apps/api/package.json:21-36`) |
| Web | `apps/web` | `@charitypilot/web` | Next.js 16 app-router web app (React 19, HeroUI, Tailwind 4): UI plus a server-side proxy/auth layer | `next`, `react`, `@heroui/react`, `axios` (`apps/web/package.json:12-22`) |
| Shared | `packages/shared` | `@charitypilot/shared` | Shared TypeScript types and Zod schemas consumed by both apps; built to `dist/` and imported as an ESM package | `zod` (`packages/shared/package.json:6-21`) |

Both apps depend on `@charitypilot/shared` via the `*` workspace version (`apps/api/package.json:22`, `apps/web/package.json:13`). The shared package is compiled first and exposed through its `exports` map pointing at `./dist/index.js` (`packages/shared/package.json:8-13`), which is why the Turborepo `build` task fans out from dependencies (`"dependsOn": ["^build"]`) before building each app (`turbo.json:26-29`).

The whole repo requires Node.js ≥ 22 and is pinned to `npm@11.11.0` (`package.json:45-48`).

## Runtime topology and default ports

The three runtime processes are the web app, the API, and PostgreSQL. Default ports (documented in the README and enforced by the compose files) are:

| Service | Default port | Source |
| --- | --- | --- |
| Fastify API | `3002` | `parsePort(process.env.PORT, 3002)` (`apps/api/src/server.ts:87`); `PORT: 3002` in compose (`compose.local.yml:51`, `compose.production.yml:36`); README (`README.md:26`) |
| Next.js web | `3003` | `next dev --webpack --port 3003` (`apps/web/package.json:6`); `PORT: 3003` in compose (`compose.local.yml:105`, `compose.production.yml:69`) |
| PostgreSQL | `5434` (host) → `5432` (container) | `127.0.0.1:5434:5432` (`compose.yml:23-24`); README (`README.md:26`) |

Those ports are the persistent development defaults only. Destructive
Playwright does not reuse them: `scripts/run-isolated-e2e.mjs` owns standalone
`compose.e2e.yml`, with fixed loopback ports `3302`, `3303`, and `55434`, a
positive allow-list image context, a UUID-bound PostgreSQL marker, an internal
bridge, tmpfs database/document storage, and a baked production web build in a
read-only image, with no host mount or persistent volume. Database, API, and
web remain only on that internal bridge;
a dedicated secretless, read-only TCP gateway resolves only their unique
reserved `.invalid.` aliases and alone joins a second
project-scoped non-attachable edge bridge and publishes the three loopback
ports. The runner validates one private Compose snapshot, the exact API
migration DSN, health/tmpfs bounds, and gateway topology before startup; then
attests the freshly built image IDs and exact live container isolation before
Playwright. It pins every build/runtime/cleanup call to a proven local Docker
endpoint and treats any exact-project cleanup residue as failure. The reset guard rejects
the development database and every implicit database URL.

The API binds to `0.0.0.0` by default (`apps/api/src/server.ts:88`) and logs `CharityPilot API running on http://${host}:${port}` once listening (`apps/api/src/server.ts:91-92`). It installs `SIGINT`/`SIGTERM` handlers for a guarded graceful shutdown via `app.close()` (`apps/api/src/server.ts:102-120`).

### Compiled personal-server topology

`compose.personal-server.yml` is a separate one-charity operating profile. It
does not publish the development ports above. Caddy is its only host-facing web
server and binds to `127.0.0.1:8080` by default. It routes `/api/v1/*` to the
compiled Fastify container and all other paths to the compiled Next.js
container. PostgreSQL and uploaded documents use personal-server-specific named
volumes; no source tree or dependency directory is mounted into the runtime.
PostgreSQL, Fastify and Next.js share one fixed `internal: true` application
bridge. Caddy alone also joins a second fixed edge bridge so Docker Desktop can
publish its loopback-only port without giving the application containers an
external route. Caddy discards incoming forwarding headers and supplies its own;
Fastify trusts only Caddy's exact internal-bridge address.
For the Tailscale TLS-termination hop, the validated configured HTTPS origin is
authoritative for Next.js refresh Origin headers, redirects and CSP; an internal
plain-HTTP request URL cannot downgrade the browser-facing URL.

The API still enforces organisation-scoped authorization, but the one-shot
initializer permits only an empty database and creates exactly one organisation,
one verified Owner and an active Complete entitlement. Routine start performs
neither migration nor seeding. Registration and provider-backed recovery/email
routes fail closed; director invitations and password recovery use explicit
fragment-only links. See [Personal Server Deployment on Windows](../personal-server-deployment.md).

### API process startup

The production entrypoint `apps/api/src/start.ts` defaults `NODE_ENV` to `production` and then dynamically imports `./server.js`; the `start` script runs `node dist/start.js`. In development the API runs directly under `tsx --watch` against `src/server.ts`. On boot, `server.ts` calls `validateRuntimeEnv()`: exact `personal-server` mode uses its local-appliance validator and every other production mode delegates to the strict public `validateProductionEnv()`. It then registers the error handler, security headers, cookies, browser-origin protection, global rate limit, multipart support, and Prisma plugin.

### API route surface

All routes are versioned under `/api/v1/*`, registered with per-domain prefixes (`apps/api/src/server.ts:70-81`): `auth`, `organisation`, `compliance`, `board-members`, `documents`, `deadlines`, `billing`, `export`, `dashboard`, `governance-registers`, `team`, and `health`. The container health checks probe `/api/v1/health` locally (`compose.local.yml:86`) and the authenticated `/api/v1/health/readiness` endpoint (with an `x-charitypilot-readiness-key` header) in production (`compose.production.yml:50-59`).

## How the web app reaches the API

The Next.js layer resolves the API base URL through two distinct paths in `apps/web/src/lib/api-config.ts`:

- **Browser-facing requests** use `getApiBaseUrl()`, driven by `NEXT_PUBLIC_API_URL` (`apps/web/src/lib/api-config.ts:10-28`). In production this must be an `https://` origin-only URL on the approved `charitypilot.ie` host (`apps/web/src/lib/api-config.ts:42-63`); in local Docker it is `http://localhost:3002` (`compose.local.yml:106`).
- **Server-side requests inside the web container** use `getServerApiBaseUrl()`, which prefers `CHARITYPILOT_INTERNAL_API_URL` and otherwise falls back to the public URL (`apps/web/src/lib/api-config.ts:30-40`). Locally this is set to the in-network service address `http://api:3002` (`compose.local.yml:107`), so the proxy reaches the API container directly over the Docker bridge network rather than via the host-published port.

The server-side caller is the web proxy in `apps/web/src/proxy.ts`. For protected app paths it forwards the auth cookies to the API's `/api/v1/auth/me` endpoint to validate the session, and on a stale access token attempts `/api/v1/auth/refresh`, propagating any rotated `Set-Cookie` headers back to the browser (`apps/web/src/proxy.ts:48-90`, `apps/web/src/proxy.ts:194-204`). The proxy also injects a per-request nonce and Content-Security-Policy and redirects unauthenticated users to `/login` (`apps/web/src/proxy.ts:176-205`). Its matcher excludes `api`, `_next` and static assets (`apps/web/src/proxy.ts:207-211`).

## External integrations

The API talks to four external systems. Each client is constructed lazily inside the relevant service, guarded by configured-secret checks so the API still boots when a provider is unconfigured (e.g. local development):

| Integration | Purpose | Where wired | Configuration |
| --- | --- | --- | --- |
| PostgreSQL (via Prisma) | Primary data store; all domain data | Prisma plugin registered on the Fastify instance (`apps/api/src/server.ts:66`); schema at `apps/api/prisma/schema.prisma` (`README.md:23`) | `DATABASE_URL` (`compose.local.yml:55`) |
| Supabase Storage | Private document bucket read only through the authenticated API byte proxy (production); local filesystem driver in dev | `createClient(url, serviceRoleKey)` remains server-only in `StorageService`; driver selected by `DOCUMENT_STORAGE_DRIVER` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET`; or `local` + `LOCAL_FILE_STORAGE_DIR` (`compose.local.yml:61-73`) |
| Stripe | Subscription billing (Essentials/Complete tiers), pinned customer portal, and webhooks | `new Stripe(secretKey)` in `BillingService.getStripe()` | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, four distinct `STRIPE_*_PRICE_ID` values, and `STRIPE_BILLING_PORTAL_CONFIGURATION_ID` |
| Resend | Transactional/notification email (e.g. deadline reminders) | `new Resend(process.env.RESEND_API_KEY)` in `EmailService` (`apps/api/src/services/email.service.ts:95`) | `RESEND_API_KEY`, `EMAIL_FROM` (`compose.local.yml:69-70`) |

When a secret is missing, the storage and billing services throw a `503` `AppError` (`STORAGE_NOT_CONFIGURED` / `BILLING_NOT_CONFIGURED`) rather than failing at startup (`apps/api/src/services/storage.service.ts:58-59`, `apps/api/src/services/billing.service.ts:93-94`). The full set of provider environment variables is also declared in Turborepo's `globalEnv` so caching is keyed on them (`turbo.json:3-24`).

## Scheduled jobs

CharityPilot runs scheduled work two ways depending on environment.

### In-process cron (development)

After the API binds the current recovery-key generation and starts listening,
`server.ts` starts the development reminder timer and, outside production, a
separate bounded five-second authentication-delivery loop. `startCronJobs`
short-circuits reminder work in production unless
`ENABLE_IN_PROCESS_JOBS === 'true'`; production Compose keeps that flag false.
The local authentication loop is never started in the public-production or
compiled personal-server runtime.

### Standalone job processes (production)

The standalone jobs live in `apps/api/src/jobs` and are exposed as npm `jobs:*`
scripts. The long-running scheduler and the reminder/cleanup one-shots also have
Compose services; authentication delivery has a direct one-shot entrypoint for
isolated rehearsal or an approved platform-scheduler replacement:

| Job entrypoint | npm script | Compose service | What it does |
| --- | --- | --- | --- |
| `production-scheduler.ts` | `jobs:production-scheduler` | `production-scheduler` (long-running) | Runs deadline reminders, document cleanup, and durable authentication-email delivery on independent recurring timers. Recovery links and post-reset notices use five-second polling by default; the scheduler also quarantines stale sends and performs bounded recovery-ledger cleanup. |
| `send-deadline-reminders.ts` | `jobs:deadline-reminders` | `deadline-reminders` (one-shot, `jobs` profile) | Builds a `DeadlineRemindersService` and calls `sendDueReminders()` once, exiting non-zero on failure (`apps/api/src/jobs/send-deadline-reminders.ts:9-26`); `compose.production.yml:126-150` |
| `cleanup-document-storage.ts` | `jobs:document-storage-cleanup` | `document-storage-cleanup` (one-shot, `jobs` profile) | Retries pending storage deletions via `DocumentService.retryPendingStorageDeletions()` using `StorageService.deleteFile()` (`apps/api/src/jobs/cleanup-document-storage.ts:18-23`); `compose.production.yml:152-177` |
| `process-auth-email-delivery.ts` | `jobs:auth-email-delivery` | no dedicated service; run from the selected API image for an isolated one-shot rehearsal | Validates the authentication-delivery env, verifies the bound recovery key, processes one bounded batch of recovery links/notices, quarantines stale claims, performs bounded cleanup, and exits non-zero on failure. |

Restricted operator jobs such as `jobs:recover-team-ownership`,
`jobs:reconcile-billing-authority`, and `jobs:rotate-auth-recovery-secret` are
deliberately not scheduled or exposed as public HTTP routes. They require
explicit authority, exact live-state evidence, dry runs, target-bound
confirmations, and database locks. See the [ownership
recovery](../team-ownership-recovery.md), [billing authority
reconciliation](../billing-authority-reconciliation.md), and [production
runbook](../production-runbook.md) rotation procedures.

The deadline-reminders and authentication-delivery paths read/write the database
and send email via Resend. Authentication delivery additionally requires the
versioned `AUTH_RECOVERY_SECRET`; the raw secret and derived token/rate material
never appear in logs. API and scheduler startup bind or verify the selected key
before accepting traffic or processing jobs. Every recovery/delivery transaction
then locks the singleton `AuthRecoveryControl` generation and rejects a blocked,
mismatched, or historically retired secret. Review-worthy terminal rows use durable count-only alert claims, so a
failed webhook or scheduler crash cannot erase operator follow-up. The
document-storage-cleanup path reads the database and
deletes from Supabase storage. All three recurring paths report sanitized
failures through `sendJobFailureAlert`, which posts to
`ERROR_ALERT_WEBHOOK_URL`. The `production-scheduler` service is always on,
while the reminder and cleanup one-shot services remain under the `jobs`
Compose profile.

## Component diagram

```mermaid
flowchart TD
    Browser["Browser (charity user)"]

    subgraph web["apps/web — Next.js 16 (port 3003)"]
        WebUI["React 19 / HeroUI UI"]
        Proxy["proxy.ts — auth + CSP proxy"]
    end

    subgraph api["apps/api — Fastify 5 API (port 3002)"]
        Routes["/api/v1/* routes"]
        Services["Services (billing, email, storage, document, deadlines)"]
        Cron["In-process cron (dev only)"]
    end

    subgraph jobs["apps/api/src/jobs — standalone job processes (production)"]
        Sched["production-scheduler"]
        DeadlineJob["send-deadline-reminders"]
        CleanupJob["cleanup-document-storage"]
    end

    DB[("PostgreSQL (port 5434) via Prisma")]
    Supabase["Supabase Storage (private bucket)"]
    Stripe["Stripe (billing)"]
    Resend["Resend (email)"]

    Browser -->|"HTTPS: NEXT_PUBLIC_API_URL"| Routes
    Browser -->|"HTTPS: page requests"| WebUI
    WebUI --> Proxy
    Proxy -->|"server-side: CHARITYPILOT_INTERNAL_API_URL (http://api:3002), validate session /auth/me, /auth/refresh"| Routes

    Routes --> Services
    Services -->|"SQL via Prisma client"| DB
    Services -->|"upload / authenticated byte reads / delete (REST)"| Supabase
    Services -->|"subscriptions + webhooks (REST)"| Stripe
    Services -->|"transactional email (REST)"| Resend

    Cron -->|"sendDueReminders (24h interval)"| Services
    Sched --> DeadlineJob
    Sched --> CleanupJob
    DeadlineJob -->|"read deadlines"| DB
    DeadlineJob -->|"send reminder email"| Resend
    CleanupJob -->|"read pending deletions"| DB
    CleanupJob -->|"delete files"| Supabase
```

## Cross-references

- [Module & Dependency Graph](02-module-dependency-graph.md) — how the route groups map to services and Prisma models.
- [Request Lifecycle, Middleware & Auth](04-request-lifecycle.md) — the Fastify plugin pipeline and session model.
- [Data Model Reference](03-data-model.md) — the Prisma/PostgreSQL schema behind the data store.
- [Frontend Architecture](09-frontend.md) — the Next.js app and its server-side proxy/auth layer.
- [Reminder Scheduler & Jobs](07-reminder-scheduler.md) — the in-process cron and standalone job processes in depth.
- [Configuration, Environment & the Two-Gate Model](10-config-and-env.md) — the env surface and the code-vs-launch gates.
