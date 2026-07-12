# CharityPilot

CharityPilot is the **Charity Governance Platform**, currently in early
development for Irish registered charities. It digitises the Charities Regulator
(CRA) **Governance Code Compliance Record Form** and the supporting governance
registers, so a charity can track compliance, board members, documents,
deadlines, and sign-off in one place.

Created by **Jasper Ford**, the CharityPilot copyright and IP holder.
**hOUR Timebank CLG (Ireland)** is an official contributor to the platform.
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
- **Billing:** Stripe · **Email:** Resend · **Document storage:** Supabase private bucket behind an authenticated API byte proxy, or local filesystem for dev
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

## Private personal server on Windows

For one charity using a Windows computer as a small private server, use the
compiled `personal-server` profile rather than the source-mounted development
stack. Windows is the host; it does not need IIS or Windows Server. Docker
Desktop runs these services:

- **Caddy** is the only front-door web server and the only container with a
  host port (`127.0.0.1:8080` by default).
- **Next.js** serves the compiled website and application pages.
- **Fastify** serves `/api/v1/*`.
- **PostgreSQL** stores accounts and governance records; a separate persistent
  volume stores uploaded documents.

Caddy routes `/api/v1/*` to Fastify and everything else to Next.js, so browsers
use one exact origin. Normal start reuses compiled images and persistent data;
it does not compile pages, watch Windows files, migrate, or seed demo data.

The first-install helper creates one empty charity workspace, one verified
Owner and local Complete access. It prints a generated Owner password once
without storing that password in `.env.personal-server`:

```powershell
npm run personal:server:init -- --owner-email=owner@example.org --owner-name="Owner Name" --organisation-name="Charity Name" --origin=http://localhost:8080
```

For access by other directors, configure the profile with the exact private
Tailscale HTTPS origin instead of the loopback origin, then point Tailscale
Serve at Caddy. Do not forward a router port or use Tailscale Funnel.

The complete installation, private-access, account, backup, recovery, update,
security and VM-migration runbook is
[`docs/personal-server-deployment.md`](docs/personal-server-deployment.md).

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

For one-person local use without Stripe, Supabase, Resend, public hosting, or
payments, run the personal local readiness gate before entering records you care
about:

```bash
npm run personal:ready
```

That command checks local boot/login/document storage, verifies a PostgreSQL
backup can be restored, copies local document storage into backups, and runs a
non-destructive browser pass over the core pages. See
[`docs/personal-local-use.md`](docs/personal-local-use.md).

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
| `npm run personal:ready` | Local personal-use readiness gate; no live payments or production providers |
| `npm run personal:server:init -- --help` | Show safe first-install options for the compiled private server |
| `npm run personal:server:start` | Start the compiled private server without migration or seeding |
| `npm run personal:server:status` | Show private-server health and the newest completed recovery-set name in the default backup root |
| `npm run personal:server:backup` | Create a matched database-and-document recovery set |
| `npm run personal:server:update` | Back up, build, migrate and restart during a deliberate maintenance window |
| `npm run personal:server:stop` | Gracefully stop services without deleting persistent volumes |
| `npm run personal:server:reset-link -- --email=name@example.org` | Issue a one-hour private password-reset link for one active account |
| `npm run personal:server:reset-password -- --email=name@example.org` | Emergency fallback: set a generated replacement password and revoke that account's sessions |
| `npm run test:personal-server` | Validate the private profile and operator safety contracts without starting Docker |
| `npm run launch:status` | Show where you are in the launch process and the next step |

---

## Testing

- **Unit tests** live beside the code (`apps/*/src/**/*.test.ts`, run with the
  built-in `node:test`). Run all of them with `npx turbo test`.
- **Production-tooling tests** validate the launch scripts: `npm run test:production-check`.
- **Local Docker smoke** boots the real containerised stack and exercises auth,
  document upload/download, and the web shell: `npm run test:local-docker:smoke`.
- **End-to-end (Playwright)** drives a real browser against a runner-owned,
  standalone Docker stack —
  register/verify/login, a compliance sign-off, document upload/download, deadlines,
  team invite/accept, and billing tier gating. One-time `npm run test:e2e:install`,
  then `npm run test:e2e`. The managed runner creates a standalone UUID-bound
  database behind dedicated loopback ports, validates the exact migration DSN
  and an immutable private snapshot of the isolated Compose model before
  startup, stores database/document data in exact bounded tmpfs mounts, and
  serves a baked production web build from the read-only runner image.
  Database, API, and web containers remain solely on an internal bridge with
  unique reserved `.invalid` aliases; a minimal secretless TCP gateway uses
  only those absolute names, is the only dual-homed service, and is the only
  loopback-port publisher. Before any browser reset, the runner attests the
  freshly built image IDs and the exact live container labels, images,
  networks, publications, mounts, and security settings. The runner tears down and verifies its exact
  project-scoped resources through the pinned local daemon. A teardown failure
  makes the run red and preserves
  the private recovery inputs; it never falls back to, layers over, or resets
  the personal local database. See
  [`e2e/README.md`](e2e/README.md).

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

**hOUR Timebank CLG (Ireland)** is officially recognised as a contributor to
CharityPilot. See [CONTRIBUTORS.md](CONTRIBUTORS.md) and [NOTICE](NOTICE) for the
canonical contributor and attribution records.

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
CharityPilot, Jasper Ford, and hOUR Timebank CLG (Ireland), together with a link
to the public source repository.

Interactive interfaces should keep attribution visible in an ordinary legal
notice path, such as the global footer and About page. The canonical wording is:

```text
Powered by CharityPilot
Created by Jasper Ford
Contributor: hOUR Timebank CLG (Ireland)
Licensed under AGPL v3-or-later
Source: https://github.com/jasperfordesq-ai/charity-governance
```
