# CharityPilot Production Readiness Todo

Status marks reflect completed repository hardening work. Open items require real external evidence before CharityPilot can handle production charity data.

> **New here / not sure what to do next?** Read [`docs/LAUNCH-GUIDE.md`](docs/LAUNCH-GUIDE.md)
> first - it explains, in plain English, what is already done and the exact
> human steps (accounts, hosting, legal, security review) that remain.
> For one-person local use without Stripe, payments, public hosting, or
> production providers, run `npm run personal:ready`. It is the non-destructive
> local confidence gate. Do not run the default full E2E suite against a
> personal database you care about because it can reset tenant/app tables.

> **Current local status checked 2026-07-09:** `npm run launch:status -- --json`
> still reports `ENV_INCOMPLETE`: 9 of 28 production values are complete and 19
> production values still require real data in `.env.production` or the approved
> production secret store. The launch evidence ledger is now 9 of 87 checks
> complete from local/CI release-gate evidence, final signoffs remain 0 of 5
> approved, and the strict counted launch gates are 18 of 120 complete
> (15%). This strict percentage counts only production values, evidence checks,
> and final signoff roles; it is not a legal or business readiness claim.
> `approvedForLaunch` is false. Do not put real charity data into CharityPilot until those values,
> provider checks, deployed QA, legal/privacy review, external security review,
> backup/restore evidence, all 87 machine-readable launch evidence checks, and
> final signoffs are complete.
> `npm run launch:status` also surfaces the current launch evidence ledger count,
> `approvedForLaunch`, `finalSignoff`, and the next incomplete evidence checks so
> operators can continue from the first real missing proof without changing the
> strict final validator.
> `npm run launch:status -- --json` returns the same non-secret state as JSON for
> CI summaries, release handoffs, or operations dashboards.
> Missing production values are grouped by provider/source in that output:
> hosting/proxy, PostgreSQL, Stripe, Resend, Supabase, observability, and release image promotion.
> Release image promotion also requires GitHub `production` environment
> variables for `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_SUPABASE_URL` before
> `gh workflow run release-images.yml --ref master` can produce the
> `release-image-digests.env` artifact used by deploy preflight.
> If GitHub `production` is used as the deployment secret store, run
> `npm run check:production:github-secrets -- --environment=production` to
> prove the required secret names exist without reading their values.
> The JSON output also keeps the full source-grouped production value checklist
> visible after `.env.production` exists, while separately listing only the
> currently missing values. This is the handoff order for filling the real secret store.
> Strict launch-evidence JSON validation reports the next incomplete checklist
> items and evidence hints, so failing launch-gate output can drive an operator
> work queue without weakening the final validator.
> Local browser QA has current 2026-07-09 evidence from focused responsive route chunks across desktop/mobile and light/dark: public desktop 14/14, public mobile 14/14, dashboard desktop 12/12, and dashboard mobile 12/12. The full local accessibility suite passed 26/26 checks on 2026-07-09, including `/about` and both light and dark themes. Deployed production QA still remains open and must be rerun against the live HTTPS URLs.
> Deployed accessibility QA must be recorded in `browserQa.checks.accessibility-coverage`,
> cross-browser QA in `browserQa.checks.cross-browser-coverage`, and real iOS Safari device QA in
> `browserQa.checks.ios-safari-device-coverage`.
>
> **Repository gate posture:** build, lint, unit/integration tests,
> production-tooling tests, production validators, release workflows, Docker
> image promotion scripts, rollback tooling, secret scanning, SAST scanning, and
> launch evidence validation are wired in the repo. They must be rerun against
> the final release ref and real production configuration before launch. A full
> local `npm run release:ready` run is useful repository release-gate evidence,
> but it is not production launch approval because deployed QA, provider
> evidence, legal review, pentest, and final signoffs remain open.
> Rerun every release gate on the final release ref and record the exact command
> transcripts, commit SHA, workflow run, and digest manifest in the non-committed
> launch evidence ledger before treating the platform as ready for real charity data.
> The latest repository hardening on `master` constrains launch evidence references
> to approved hosts and the canonical GitHub repository, adds visible AGPL/source
> attribution and no-warranty surfaces, shares auth status/loading primitives, lets
> the evidence package be prepared before evidence is collected while requiring
> every checklist item to predate final signoff, and aligns the deploy-smoke evidence
> hints with the strict validator: `npm run deploy:production -- --production-env-file=.env.production`,
> `node scripts/smoke-production-deploy.mjs --production-env-file .env.production`,
> `Production deploy smoke passed`, and both canonical production origins. A later
> local `npm run release:ready` run passed on 2026-07-09 at commit
> `cf683f1`: security scan, lint, build, workspace tests, dependency audit,
> reliability ledger, and 95 Playwright E2E tests passed; `OVERALL: GREEN - repository release gates passed`. Subsequent release-gate hardening on
> `master` scopes failed Playwright cleanup to CharityPilot processes on Windows
> and runs npm/npx child gates without shell execution, so failed local E2E
> evidence collection is less likely to disturb unrelated processes or emit
> shell-argument deprecation warnings. This still does not replace deployed QA,
> real provider checks, legal/privacy review, pentest, or final production
> signoffs.

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
- [x] `npm run test:production-check` - passed locally on 2026-07-09 with 346/346 production-tooling checks.
- [x] `npm run build -w @charitypilot/shared`
- [x] `npm run build -w @charitypilot/api`
- [x] `npm run build -w @charitypilot/web`
- [x] `npm audit --omit=dev --audit-level=moderate`
- [ ] `npm run check:production -- --production-env-file=.env.production`
- [ ] Complete `docs/production-launch-checklist.md` with real launch evidence.
