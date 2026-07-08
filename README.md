# CharityPilot

Charity governance compliance platform for Irish registered charities. It
digitises the Charities Regulator (CRA) **Governance Code Compliance Record
Form** and the supporting governance registers, so a charity can track
compliance, board members, documents, deadlines, and sign-off in one place.

Created by **Jasper Ford**, the CharityPilot copyright and IP holder.
Commercial SaaS operations may be provided by Project Nexus Ltd. Two tiers:
**Essentials** and **Complete**, with a free trial.

[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

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

> **Full architecture map:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the complete,
> source-grounded system map — component diagram, the module/dependency graph (route
> groups → services → Prisma models), the 22-model data model, the request lifecycle and
> auth/session model, billing, document storage, the reminder scheduler, the governance
> domain, the frontend, and the config/two-gate model. Every non-trivial claim carries a
> `file:line` citation.

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
| `npm run launch:status` | Show where you are in the launch process and the next step |

---

## Testing

- **Unit tests** live beside the code (`apps/*/src/**/*.test.ts`, run with the
  built-in `node:test`). Run all of them with `npx turbo test`.
- **Production-tooling tests** validate the launch scripts: `npm run test:production-check`.
- **Local Docker smoke** boots the real containerised stack and exercises auth,
  document upload/download, and the web shell: `npm run test:local-docker:smoke`.
- **End-to-end (Playwright)** drives a real browser against the local Docker stack —
  register/verify/login, a compliance sign-off, document upload/download, deadlines,
  team invite/accept, and billing tier gating. One-time `npm run test:e2e:install`,
  then `npm run test:e2e` (stack must be up). See [`e2e/README.md`](e2e/README.md).

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

## Credits and Origins

CharityPilot was created by **Jasper Ford**, who is the copyright and IP holder
for the CharityPilot software and source code.

## License

License: AGPL v3 or later (`AGPL-3.0-or-later`).

This software is licensed under the **GNU Affero General Public License version
3 or later** (AGPL-3.0-or-later).

The AGPL requires that if you modify this software and let users interact with
it remotely through a computer network, you must offer those users access to the
complete corresponding source code of your modified version.

See [LICENSE](LICENSE) for the full AGPL text and [NOTICE](NOTICE) for the
CharityPilot attribution, additional terms, warranty disclaimers, source-code
notice, and AGPL Section 7 terms.

## UI Attribution Requirement

Under AGPL Section 7(b), all public deployments, modified versions, and
downstream interfaces based on CharityPilot must preserve clear attribution to
CharityPilot and Jasper Ford, together with a link to the public source
repository.

Interactive interfaces should keep attribution visible in an ordinary legal
notice path, such as the global footer and About page. The canonical wording is:

```text
Powered by CharityPilot
Created by Jasper Ford
Licensed under AGPL v3-or-later
Source: https://github.com/jasperfordesq-ai/charity-governance
```
