# CharityPilot

Charity governance compliance platform for Irish registered charities. It
digitises the Charities Regulator (CRA) **Governance Code Compliance Record
Form** and the supporting governance registers, so a charity can track
compliance, board members, documents, deadlines, and sign-off in one place.

Commercial SaaS by Project Nexus Ltd. Two tiers: **Essentials** and **Complete**,
with a free trial.

---

## Architecture

A [Turborepo](https://turbo.build/) monorepo with three workspaces:

| Workspace | Path | What it is |
| --- | --- | --- |
| `@charitypilot/api` | `apps/api` | Fastify 5 REST API (TypeScript, ESM) |
| `@charitypilot/web` | `apps/web` | Next.js 16 web app (React 19, HeroUI, Tailwind 4) |
| `@charitypilot/shared` | `packages/shared` | Shared types + Zod schemas |

- **Database:** PostgreSQL via Prisma (`apps/api/prisma/schema.prisma`)
- **Auth:** HTTP-only cookie sessions, hashed rotating refresh tokens, role guards
- **Billing:** Stripe · **Email:** Resend · **Document storage:** Supabase (private bucket, signed URLs) or local filesystem for dev
- **Default ports:** API `3002` · Web `3003` · PostgreSQL `5434`

## Repository layout

```
apps/api          Fastify API (routes, services, middleware, prisma, jobs)
apps/web          Next.js web app (app router, components, lib)
packages/shared   Shared types and Zod schemas
scripts/          Operational tooling (production checks, deploy, env setup, backups)
docs/             Launch guide, runbook, QA, security review, Supabase setup
compose*.yml      Docker Compose: local dev stack and production stack
```

---

## Local development

**Prerequisites:** Node.js ≥ 22 and npm. Docker Desktop is optional but is the
fastest way to run the full stack.

### Option A — Docker (everything, one command)

Runs PostgreSQL + API + web together, applies migrations, and seeds a local
admin account:

```bash
docker compose -f compose.yml -f compose.local.yml up
```

Then open <http://localhost:3003>. Sign in with the seeded local admin:

- **Email:** `admin@charitypilot.local`
- **Password:** `LocalAdmin123!`

To run the same flow as an automated end-to-end smoke test:

```bash
npm run test:local-docker:smoke
```

### Option B — Run directly on your machine

1. Start a PostgreSQL 16 instance on port `5434` (or update `DATABASE_URL`).
2. Copy the env template and adjust if needed:
   ```bash
   cp .env.example .env
   ```
   The defaults use local filesystem document storage and seed a local admin, so
   no external accounts are required for development.
3. Install, generate the Prisma client, migrate, and start the dev servers:
   ```bash
   npm install
   npm run db:generate -w @charitypilot/api
   npm run db:migrate -w @charitypilot/api
   npm run dev
   ```

The API runs on <http://localhost:3002> and the web app on
<http://localhost:3003>.

---

## Common commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Start API + web in watch mode |
| `npm run build` | Build all workspaces |
| `npm run lint` | Lint |
| `npm test` | Unit tests + production-tooling tests + local Docker check |
| `npx turbo test` | Just the unit tests (fast) |
| `npm run db:migrate -w @charitypilot/api` | Apply database migrations |
| `npm run db:seed -w @charitypilot/api` | Seed reference/demo data |
| `npm run security:scan` | Secret + static analysis scan |

---

## Testing

- **Unit tests** live beside the code (`apps/*/src/**/*.test.ts`, run with the
  built-in `node:test`). Run all of them with `npx turbo test`.
- **Production-tooling tests** validate the launch scripts: `npm run test:production-check`.
- **Local Docker smoke** boots the real containerised stack and exercises auth,
  document upload/download, and the web shell: `npm run test:local-docker:smoke`.

---

## Going to production

Production launch is intentionally **not** a single command — it depends on
real accounts, infrastructure, legal sign-off, and an external security review.

- **Start here:** [`docs/LAUNCH-GUIDE.md`](docs/LAUNCH-GUIDE.md) — a plain-English,
  step-by-step path (domain, provider accounts, hosting, secrets, deploy, legal,
  QA, pentest, sign-off) with effort/cost notes.
- **Generate your production env file:** `npm run setup:production-env` creates
  `.env.production`, auto-fills the random secrets, and tells you what else to fill.
- **Operator runbook (commands):** [`docs/production-runbook.md`](docs/production-runbook.md)
- **Launch evidence checklist:** [`docs/production-launch-checklist.md`](docs/production-launch-checklist.md)
- **Internal security review:** [`docs/SECURITY-REVIEW.md`](docs/SECURITY-REVIEW.md)
- **Status tracker:** [`PRODUCTION_TODO.md`](PRODUCTION_TODO.md)

Before promoting a build, the release gate is:

```bash
npm ci
npm run db:generate -w @charitypilot/api
npx prisma validate --schema apps/api/prisma/schema.prisma
npm run lint
npm run test
npm run build
npm audit --omit=dev --audit-level=moderate
```

---

## Source control

Canonical repository:
<https://github.com/jasperfordesq-ai/charity-governance>
