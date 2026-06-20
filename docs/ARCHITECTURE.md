# CharityPilot Architecture Map

CharityPilot is a commercial SaaS that digitises the Irish Charities Regulator (CRA)
Governance Code Compliance Record Form and its supporting governance registers. It is a
[Turborepo](https://turbo.build/) monorepo of three workspaces — a Fastify 5 REST API
(`apps/api`), a Next.js 16 web app (`apps/web`), and a shared Zod-schema/types package
(`packages/shared`) — backed by PostgreSQL (via Prisma) and a small set of external
providers (Supabase Storage, Stripe, Resend).

This document is the **entry point** to the architecture map. Each section below is a
focused, source-grounded reference under [`docs/architecture/`](architecture/). Every
non-trivial claim in those documents carries a `file:line` citation and was
independently fact-checked; the diagrams are GitHub-renderable Mermaid.

> **Verification:** the map was written and fact-checked against commit `7fcd404` on
> 2026-06-20. 638 code citations and all inter-document links were validated
> mechanically (file exists, line in range, link resolves). If you change the code,
> re-run the same checks before trusting a citation.

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
    Services -->|"upload / signed URLs / delete (REST)"| Supabase
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

_The full narrative for this diagram — workspaces, ports, integrations and the jobs
path — is in [System Overview](architecture/01-system-overview.md)._

## The map

| # | Document | What it covers |
|---|---|---|
| 1 | [System Overview](architecture/01-system-overview.md) | Workspaces, runtime topology and ports, how the web app reaches the API, external integrations, the scheduled-jobs path, and the component diagram. |
| 2 | [Module & Dependency Graph](architecture/02-module-dependency-graph.md) | The 12 route groups → 16 services → 22 Prisma models, per-group endpoint/service/model/guard table, the `@charitypilot/shared` boundary, and cross-module coupling. |
| 3 | [Data Model Reference](architecture/03-data-model.md) | All 22 Prisma models, key fields, relations, enums, the `organisationId` tenant-isolation pattern, composite unique constraints, indexes and cascade behaviour. |
| 4 | [Request Lifecycle, Middleware & Auth](architecture/04-request-lifecycle.md) | The Fastify plugin/middleware pipeline in order, and the auth/session model (cookie JWT access token + hashed rotating refresh sessions). |
| 5 | [Billing & Subscription Flow](architecture/05-billing.md) | Stripe tiers and price IDs, checkout/portal, webhook handling and idempotency, the subscription status model, and feature gating. |
| 6 | [Document Storage Flow](architecture/06-document-storage.md) | Supabase private bucket vs local filesystem driver, signed URLs, upload/download, and the deletion-reconciliation model. |
| 7 | [Reminder Scheduler & Jobs](architecture/07-reminder-scheduler.md) | In-process cron vs standalone jobs, the reminder logic, catch-up on missed runs, dedup keying and at-least-once semantics. |
| 8 | [Governance Domain Model](architecture/08-governance-domain.md) | Principles → standards → compliance records → sign-off, plus the conflict/risk/complaint/fundraising/annual-report/financial-control registers. |
| 9 | [Frontend Architecture](architecture/09-frontend.md) | App-router route groups, the API client and same-origin proxy, auth/session handling and single-flight refresh, and client-side plan gating. |
| 10 | [Configuration, Environment & the Two-Gate Model](architecture/10-config-and-env.md) | The full env-var surface, what `validateProductionEnv` enforces, and the code-gate vs launch-gate model. |

> **Dependency inventory:** [`docs/DEPENDENCIES.md`](DEPENDENCIES.md) lists the
> production dependencies per workspace and the rationale behind each `overrides`
> security pin.

## Running the stack and the tests

- **Local stack (one command):** `docker compose -f compose.yml -f compose.local.yml up`
  boots PostgreSQL + API + web, applies migrations, and seeds a local admin. See the
  [README](../README.md#local-development) for the seeded credentials and direct-run
  option.
- **Unit tests** (Node's built-in `node:test`, compiled first): `npx turbo test`.
- **Local Docker smoke** (boots the real stack and exercises auth + document
  upload/download): `npm run test:local-docker:smoke`.
- **End-to-end browser tests** (Playwright against the local Docker stack):
  see [`e2e/README.md`](../e2e/README.md) and `npm run test:e2e`.

## The two-gate model

CharityPilot separates a self-contained **code gate** from an external **launch gate**:

- **Gate 1 — code gate (in this repo, fully automated):** `npm run lint`, `npx turbo test`,
  `npm run build`, `npm audit --omit=dev`, and the Docker smoke in
  [`.github/workflows/ci.yml`](../.github/workflows/ci.yml). This is what every commit on
  a branch keeps green.
- **Gate 2 — launch gate (external, not code):** real domains, provider accounts, secrets,
  hosting, legal sign-off and an external pentest. This is **out of scope for the codebase**
  and is documented — not duplicated — in [`docs/LAUNCH-GUIDE.md`](LAUNCH-GUIDE.md) and the
  [`docs/production-runbook.md`](production-runbook.md).

See [Configuration, Environment & the Two-Gate Model](architecture/10-config-and-env.md)
for the full breakdown.
