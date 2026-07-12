# Dependency Inventory

This is a reference for CharityPilot's **production** runtime dependencies and the
`overrides` pins in the root `package.json`. Dev-only tooling (TypeScript, Turbo,
ESLint, tsx, Prisma CLI, Playwright, type packages) is omitted except where noted.

Versions below were rechecked against the workspace manifests on 2026-07-12;
each `package.json` and the lockfile remain the authoritative specifications.

## How dependencies are organised

CharityPilot is a Turborepo with three workspaces (`apps/api`, `apps/web`,
`packages/shared`). `@charitypilot/shared` is an internal workspace dependency of
both apps (`"@charitypilot/shared": "*"`). The root `package.json` carries no
runtime dependencies — only the shared `overrides` block (below) and the dev
toolchain (`turbo`, `typescript`).

## `apps/api` — Fastify REST API (`apps/api/package.json:21-36`)

| Package | Range | Purpose |
| --- | --- | --- |
| `@charitypilot/shared` | `*` | Internal Zod schemas + shared types. |
| `fastify` | `^5.8.5` | HTTP server framework. |
| `fastify-plugin` | `^5.0.0` | Author encapsulation-aware Fastify plugins (e.g. the Prisma plugin). |
| `@fastify/cookie` | `^11.0.2` | Parse/set the auth cookies (access + refresh). |
| `@fastify/cors` | `^11.0.0` | CORS support (the API also enforces a stricter browser-origin guard). |
| `@fastify/multipart` | `^9.0.0` | Multipart parsing for document uploads. |
| `@fastify/rate-limit` | `^10.2.0` | Global + per-route rate limiting (e.g. auth routes 5/min). |
| `@prisma/client` | `6.19.3` | Generated Prisma client / data access. Pinned exact to match the `prisma` CLI. |
| `@supabase/supabase-js` | `^2.49.0` | Server-side Supabase Storage client for a private document bucket; document bytes are proxied through authenticated API routes. |
| `stripe` | `^17.7.0` | Stripe billing: checkout, customer portal, webhook verification. |
| `resend` | `^4.5.0` | Transactional email (verification, invites, deadline reminders). |
| `bcryptjs` | `^3.0.2` | Password hashing (cost 12). |
| `jsonwebtoken` | `^9.0.2` | Sign/verify the access-token JWT. |
| `zod` | `^3.24.0` | Request validation (shared schemas). |

## `apps/web` — Next.js web app (`apps/web/package.json:12-22`)

| Package | Range | Purpose |
| --- | --- | --- |
| `@charitypilot/shared` | `*` | Internal Zod schemas + shared types (mirrors API contracts). |
| `next` | `^16.3.0-canary.14` | App-router framework + the server-side proxy/auth layer. |
| `react` / `react-dom` | `^19.1.0` | UI runtime. |
| `@heroui/react` | `^2.7.0` | Component library (React Aria + Tailwind). |
| `@heroui/theme` | `^2.4.0` | HeroUI theming tokens (light/dark). |
| `framer-motion` | `^12.6.0` | Animations/transitions used by HeroUI and the UI. |
| `lucide-react` | `^1.23.0` | Application icon set used by navigation, actions and status UI. |
| `axios` | `^1.16.0` | Browser API client (`apps/web/src/lib/api.ts`), with single-flight refresh. |
| `postcss` | `^8.5.14` | CSS pipeline for Tailwind (also see the override pin below). |

## `packages/shared` — types + schemas (`packages/shared/package.json:20-22`)

| Package | Range | Purpose |
| --- | --- | --- |
| `zod` | `^3.24.0` | The single source of truth for request/response validation, consumed by both apps. |

## `overrides` pins (`package.json:51-57`)

The root `overrides` block forces specific **transitive** dependency versions
across the whole install tree. Every pin here is a security/audit remediation —
they exist to pull deep transitive packages up to patched versions so
`npm audit --omit=dev --audit-level=moderate` (the release gate's audit step)
stays clean. They are exact versions on purpose: a caret range would let npm
resolve back down to a vulnerable version.

| Override | Pinned to | Rationale (evidence) |
| --- | --- | --- |
| `form-data` | `4.0.6` | Remediates the `form-data` advisory **GHSA-hmw2-7cc7-3qxx** (unsafe random boundary). Pinned in commit `930e19f` (`fix(deps): pin form-data to 4.0.6 to remediate GHSA-hmw2-7cc7-3qxx`); the same work shipped on the merged `fix/form-data-advisory-and-launch-guide` branch. |
| `fast-uri` | `3.1.2` | Audit-advisory remediation, added in commit `416ce5f` (`fix: resolve production audit advisories`). `fast-uri` is a transitive dep via Fastify's JSON schema/validation stack. |
| `qs` | `6.15.2` | Audit-advisory remediation, commit `416ce5f`. `qs` is a common transitive query-string parser. |
| `ws` | `8.21.0` | Audit-advisory remediation, commit `416ce5f`. `ws` is a transitive WebSocket dep. |
| `postcss` | `8.5.14` | Added during production hardening (commit `ac1f84d`, `Harden platform for production readiness`). Keeps the transitive `postcss` aligned with the patched line the web app pins directly. |

> **When changing an override:** re-run the release-gate audit
> (`npm audit --omit=dev --audit-level=moderate`) and `npm run build`. Removing a
> pin is only safe once every dependency that pulled in the vulnerable version has
> moved past it on its own.

## Related

- [Configuration, Environment & the Two-Gate Model](architecture/10-config-and-env.md) — the code-gate audit step that these pins keep green.
- [`docs/SECURITY-REVIEW.md`](SECURITY-REVIEW.md) — the internal security review.
