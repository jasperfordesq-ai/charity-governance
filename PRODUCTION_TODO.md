# CharityPilot Production Readiness Todo

Status marks reflect completed repository hardening work. Open items require real external evidence before CharityPilot can handle production charity data.

> **New here / not sure what to do next?** Read [`docs/LAUNCH-GUIDE.md`](docs/LAUNCH-GUIDE.md)
> first - it explains, in plain English, what is already done and the exact
> human steps (accounts, hosting, legal, security review) that remain.

> **Current local status checked 2026-07-08:** `npm run launch:status -- --json`
> still reports `ENV_INCOMPLETE`: 1 of 24 production values is complete and 23
> production values still require real data in `.env.production` or the approved
> production secret store. The launch evidence ledger is now 9 of 85 checks
> complete from local/CI release-gate evidence, final signoffs remain 0 of 5
> approved, and the strict counted launch gates are 10 of 114 complete
> (8.8%). This strict percentage counts only production values, evidence checks,
> and final signoff roles; it is not a legal or business readiness claim.
> `approvedForLaunch` is false. Do not put real charity data into CharityPilot until those values,
> provider checks, deployed QA, legal/privacy review, external security review,
> backup/restore evidence, all 85 machine-readable launch evidence checks, and
> final signoffs are complete.
> `npm run launch:status` also surfaces the current launch evidence ledger count,
> `approvedForLaunch`, `finalSignoff`, and the next incomplete evidence checks so
> operators can continue from the first real missing proof without changing the
> strict final validator.
> `npm run launch:status -- --json` returns the same non-secret state as JSON for
> CI summaries, release handoffs, or operations dashboards.
> Missing production values are grouped by provider/source in that output:
> hosting/proxy, PostgreSQL, Stripe, Resend, Supabase, observability, and release image promotion.
> This is the handoff order for filling the real secret store.
> Local responsive browser QA completed cleanly on 2026-07-08 as four focused route chunks across desktop/mobile and light/dark: public desktop 13/13, public mobile 13/13, dashboard desktop 12/12, and dashboard mobile 12/12. Local accessibility QA also passed 16/16 on the local stack, but deployed production QA still remains open and must be rerun against the live HTTPS URLs.
> Deployed accessibility QA must be recorded in `browserQa.checks.accessibility-coverage`,
> cross-browser QA in `browserQa.checks.cross-browser-coverage`, and real iOS Safari device QA in
> `browserQa.checks.ios-safari-device-coverage`.
>
> **Repository gate posture:** build, lint, unit/integration tests,
> production-tooling tests, production validators, release workflows, Docker
> image promotion scripts, rollback tooling, secret scanning, SAST scanning, and
> launch evidence validation are wired in the repo. They must be rerun against
> the final release ref and real production configuration before launch. A
> selected-gate `npm run release:ready -- --no-e2e` run is useful for local
> operator checks, but it is not a full release-ready result because deployed
> E2E, provider evidence, legal review, pentest, and final signoffs remain open.
> Rerun every release gate on the final release ref and record the exact command
> transcripts, commit SHA, workflow run, and digest manifest in the non-committed
> launch evidence ledger before treating the platform as ready for real charity data.
> The latest repository hardening on `master` constrains launch evidence references
> to approved hosts and the canonical GitHub repository, adds visible AGPL/source
> attribution and no-warranty surfaces, shares auth status/loading primitives, lets
> the evidence package be prepared before evidence is collected while requiring
> every checklist item to predate final signoff, and aligns the deploy-smoke evidence
> hint with the actual `node scripts/smoke-production-deploy.mjs` command. A local
> `npm run release:ready -- --no-e2e` run passed on 2026-07-08 at commit
> `73e8484`: security scan, lint, build, workspace tests, dependency audit, and
> reliability ledger passed; only Playwright E2E was skipped. This still does not
> replace deployed QA, real provider checks, legal/privacy review, pentest, or
> final production signoffs.

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
- [x] `npm run test:production-check` - passed locally on 2026-07-08 with 299/299 production-tooling checks.
- [x] `npm run build -w @charitypilot/shared`
- [x] `npm run build -w @charitypilot/api`
- [x] `npm run build -w @charitypilot/web`
- [x] `npm audit --omit=dev --audit-level=moderate`
- [ ] `npm run check:production -- --production-env-file=.env.production`
- [ ] Complete `docs/production-launch-checklist.md` with real launch evidence.
