# CharityPilot Agent Continuation Handoff

Last updated: 2026-07-10

This document exists so a new Codex, Claude, or other coding agent can continue the same CharityPilot production-completion goal without relying on chat memory or a pasted prompt.

## Active Full-Platform Remediation Audit

Before selecting production-completion work, read:

- `docs/platform-remediation-audit-2026-07-10.md`

That document is the authoritative human-maintained remediation ledger for the
2026-07-10 full-platform audit. It records the 669/1000 baseline, every confirmed
repository issue, the strict launch-evidence split, safety constraints, external
blockers, acceptance criteria, and the continuous inspect/fix/verify/commit/push
loop. Do not narrow the goal to the generated platform audit or stop because
local gates are green.

## 2026-07-10 Remediation Checkpoint

The detailed issue contract remains in
`docs/platform-remediation-audit-2026-07-10.md`. The current P0 checkpoint is:

- **P0-01 annual-reporting claim containment - `CI_VERIFIED`.** Commit
  `97f64b0285eb2d19489c062cda52134fda8f9a53` passed CI run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29073803773`.
  Local evidence was web `244 / 244`, shared `19 / 19`, web lint/build,
  generated-audit currency, and production tooling `396 / 396`. Named
  accountant/Irish-solicitor approval remains external.
- **P0-02 Resend acceptance/retry semantics - `CI_VERIFIED`.** Commit
  `fbd5ce4` passed CI run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29074651622`.
  Local evidence was focused email/degradation/reminder/auth/team/scheduler/
  idempotency tests `73 / 73`, full API `438 / 438`, API build, and production
  tooling `396 / 396`. A real accepted Resend send and verified production
  domain remain external launch evidence.
- **P0-03 duplicate Stripe subscription path - `CI_VERIFIED`.** Implementation
  commit `ce9a5ed9701776bb2a957da647b3620288be173b` plus the launch-counter and
  readiness-test repairs through `7ffc8f862d863f559365668c19550be00d0bb382`
  passed CI run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29077589143`.
  The repository now has a one-per-organisation
  `BillingCheckoutAttempt` lease/migration, attempt-bound Stripe idempotency and
  metadata, remote customer/subscription reconciliation, strict terminal-state
  restart rules, expired-session reconciliation, stale/superseded webhook
  protection, authoritative subscription re-retrieval, exact one-item/
  quantity-one price+interval validation, raw Stripe status/cancel scheduling,
  server-owned web capabilities, and a pinned Billing Portal configuration.
  Existing Stripe-managed subscriptions are portal-only; public copy no longer
  promises unverified proration or offers Checkout as a plan-change route.
  Focused API billing/idempotency verification is `50 / 50`; provider-checker
  verification is `13 / 13`; shared is `19 / 19`; web is `248 / 248`; web lint
  and production build pass; and the final full API suite is `454 / 454` after
  all P0-03 tests were integrated. Production tooling is `488 / 488`, the
  reliability report is green with `365 / 365` covered links, and the platform
  audit is current.
- **P0-04 compliance concurrency and immutable board approval -
  `CI_VERIFIED`.** Commit `e03b80a44150c384485b5e47e524b9ee60475f70`
  passed CI run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29082113651`.
  Compliance record/sign-off writes now use explicit
  revisions, serializable organisation locking, compare-and-swap updates,
  idempotent replay handling, and append-only full before/after history. Board
  approval is bound to a canonical immutable evidence snapshot and hash;
  approved-record changes invalidate the current pointer while retaining prior
  snapshots for tenant/year-scoped historical export and deliberate reapproval.
  Legacy approvals are truthfully invalidated rather than reconstructed from
  mutable deployment-time data. Current/approved exports verify freshness,
  tenant scope, row metadata and hashes and preserve CSP when opened through the
  authenticated browser client. The frontend serializes autosave, preserves
  newer drafts across old responses and failures, provides safe conflict
  reconciliation, guards dirty navigation, sequences principle loads, and
  never presents stale approval as current. Local evidence is API `477 / 477`,
  web `272 / 272`, shared `23 / 23`, production tooling `488 / 488`, local-Docker
  tooling `43 / 43`, reliability `374 / 374`, lint, production builds, Prisma
  generation/validation, security scans, zero-vulnerability dependency audits,
  refreshed generated audits, and a clean 14-migration deployment plus
  rollback-only trigger/constraint probes on a dedicated throwaway
  `charitypilot_ci` PostgreSQL container.
- **P0-05 destructive E2E isolation - `CI_VERIFIED`.** The repository now
  supplies a managed, UUID-bound disposable E2E stack and fail-closed database
  identity/reset contract. Database, API, and web stay internal-only while a dedicated
  secretless, read-only fixed-route TCP gateway alone publishes the runner's
  loopback ports; its absolute `.invalid.` routes map only to unique internal
  aliases. API builds the shared app image once and web reuses it. The runner
  executes one private validated Compose snapshot and attests immutable built
  image IDs plus exact live container isolation before Playwright. The complete
  gate passed `113 / 113` isolation contracts and `96 / 96` live Playwright
  tests in `9.6m` (`25.0m` for the full fresh-build/test/verified-teardown
  command) against the real disposable PostgreSQL instance and baked production
  web runtime. Exact-project teardown left no Docker/private-state residue and
  preserved the personal web/API/database container IDs. Remote worker seams
  now prove suite-lease presence, reset proves same-session ownership, and the
  outer janitor runs only after exact POSIX group absence; native-Windows remote
  destructive mode is explicitly rejected. The run also exposed and repaired a
  production-relevant shared-proxy-IP `/auth/me` throttle: credential limiting
  is layered with a coarse IP ceiling, authentication/limiting/origin checks use
  one Bearer parser, and the bounded web proxy accepts exact `200`, refreshes or
  redirects only on explicit `401`, and strictly validates both rotation or
  deletion cookies. Wider evidence is API `488 / 488`, web `295 / 295`, shared
  `23 / 23`, production tooling `512 / 512`, local-Docker tooling `44 / 44`,
  reliability `374 / 374`, root lint/build, security scans across `497` files, and zero
  dependency vulnerabilities. The complete slice is published as commit
  `e9f63038a5e8fe0c0680dcc015566dff2525a56b`; CI run `29116192805` and E2E run
  `29116192729` both completed successfully for that exact SHA, with the latter
  passing `96 / 96` Playwright tests in `3.2m`. Release-promotion and deployed
  browser proof remain separate P0-09/launch gates.
- **P0-06 deadline calendar and recurrence integrity - `LOCALLY_VERIFIED`.**
  Strict civil-date helpers replace JavaScript month overflow and cover every
  month-end class, leap years, Europe/Dublin DST boundaries, Irish public
  holidays, and Companies Act working-day adjustment. Generated deadlines now
  carry source/input fingerprints, stable rule identity, versions, provenance,
  supersession links, and immutable history; changed inputs create a new
  incomplete successor and revoked confirmations remove the current occurrence
  without deleting history. Company/CRO rules require explicit confirmed facts,
  while contradictions, impossible chronology, future actual events, and unsafe
  date ranges fail closed. Manual due-date/reopen changes advance reminder
  schedule identity, generated occurrences allow only one-way atomic completion,
  and reminder history stores immutable occurrence snapshots. Generated
  completion now requires an explicit irreversible confirmation, current lists
  traverse every API page, and organisation/manual-deadline writes reject stale
  `updatedAt` versions rather than overwriting newer governance facts. The scheduler
  pages all current eligible rows, sends separately to every verified owner,
  revalidates recipient/subscription/occurrence under a proven lock order,
  expires stale pre-I/O reservations atomically, marks `SENDING` before provider
  I/O, and quarantines every crash, timeout, 409, 5xx, malformed, boolean, or
  unknown provider outcome as `UNCERTAIN`. Acceptance-confirmed and
  unknown-acknowledged reconciliation remain dedupe suppressors; only immutable
  proof that the provider never accepted/created the original message permits a
  fresh token/key. The scheduler awaits active work during bounded shutdown, and
  deploy releases residual reservations, quarantines residual provider I/O, and
  blocks startup on unresolved ambiguity. The migration conservatively
  quarantines all legacy reminder states without fabricating provider/timing
  evidence, preserves exact annual-report id/completion/log identity, and fails
  closed on range, tenant, generated-row, AGM-evidence, duplicate, and id-collision
  ambiguity. A real PostgreSQL historical-upgrade fixture exercises eleven
  fail-closed scenarios in CI and release-image publication. Full API/web/shared
  suites are green (`545 / 545`, `313 / 313`, `35 / 35`), Prisma validates, and a
  disposable PostgreSQL 16 proof passed fresh/upgrade migrations, constraint and
  concurrency probes. A non-UTC (`America/Los_Angeles`) live application-path
  probe also proves the fixed civil-date claim binds and snapshots
  `2030-01-15` unchanged. Root lint/build, production tooling `544 / 544`,
  local-Docker contracts `44 / 44`, E2E safety contracts `113 / 113`, security
  scans across `545` staged files, zero-vulnerability dependency audits, generated-audit currency, and
  reliability linkage `396 / 396` is green. A focused managed browser run
  passed the Organisation contrast and migrated-profile save regressions, then
  the complete managed gate passed `113 / 113` isolation contracts and `97 / 97`
  Playwright tests with verified teardown. This is local working-tree proof;
  publish the implementation and obtain exact-SHA CI/E2E
  before changing this item to `CI_VERIFIED`; professional rule review remains
  external launch evidence.

P0-03 is not live-provider proof. Before production enablement, the billing
owner must inventory and reconcile Stripe customer/subscription history,
confirm at most one non-terminal subscription per organisation/customer,
expire every legacy open subscription-mode Checkout session created before the
attempt-bound release, prove the exact pinned portal/price/product/cancellation
policy, and exercise purchase, duplicate-click, portal change, cancellation,
terminal restart, and webhook retry/order against the promoted release. Keep
that redacted evidence outside Git.

## Project

- Workspace: `C:\platforms\htdocs\CharityPilot`
- Canonical GitHub repository: `https://github.com/jasperfordesq-ai/charity-governance`
- Default branch: `master`
- Branch policy from the user: work on `master`; do not create feature branches unless explicitly told otherwise.
- Commit policy: commit and push completed work to `origin/master` in small verified increments.

## Current Launch State

Run this first in a fresh session:

```powershell
git status --short --branch
npm run launch:status -- --json
npm run audit:platform:check
node scripts/platform-completion-audit.mjs --json
```

Local personal-use safety before heavy work:

- `npm run personal:ready` is the non-destructive local confidence gate for one-person use on this computer without Stripe, payments, public hosting, or production providers.
- It checks local Docker boot/login/document storage, PostgreSQL backup and restore verification, local document-storage backup, and a personal browser smoke with billing safely disabled when Stripe is absent.
- `npm run test:e2e` owns a separate disposable stack and refuses ambient or
  personal database targets. Do not bypass that runner with direct Playwright or
  weaken its identity checks; the suite intentionally resets only its proven
  disposable tenant/app tables.
- This local safety gate does not replace production provider, deployed HTTPS, legal, pentest, backup/restore, or final signoff evidence.

Known current state from `npm run launch:status -- --json` on 2026-07-10:

- Phase: `ENV_INCOMPLETE`
- `.env.production` exists but still has 20 values needing real production data.
- Production values complete: `9 / 29`.
- Launch evidence ledger exists at `.charitypilot-launch-evidence/production-launch-evidence.json`.
- Machine-readable launch evidence completion: `9 / 87`.
- Strict counted launch gates: `18 / 121` complete (`14.9%`), counting only production values, launch evidence checks, and final signoff roles.
- `approvedForLaunch`: `false`
- Final signoffs approved: `0 / 5`
- Real charity data remains blocked.
- Full-platform audit baseline captured on 2026-07-10 at
  `8809bac3a897afe6078df82142097c3fcc924e8f`; the remediation score was
  `669 / 1000`, while the strict launch-gate score remained `18 / 120`.
- GitHub CI for that audit baseline passed:
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29068890047`.
- Latest verified release-gate hardening commit captured by this handoff:
  `cb78eb85bb0127150ad448037b5d03b8060869bf`.
- GitHub CI for that commit passed:
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29021018683`.
- Most recent local production-tooling gate captured by this handoff:
  `npm run test:production-check` passed with `544 / 544` checks on
  2026-07-10. Older `494 / 494`, `488 / 488`, `396 / 396`, `352 / 352`,
  `338 / 338`, and `339 / 339` entries in the verification chronology below are historical
  counts from earlier commits, not the current gate size.
- This handoff may be committed by a later docs-only refresh commit. Treat
  `npm run launch:status -- --json` and its `repositoryState.headSha` as the
  live source of truth for the current checkout before collecting evidence.
- The generated platform audit intentionally keeps repository clean/synced state
  live-only; run `npm run launch:status -- --json` and inspect
  `repositoryState` from the release checkout before collecting launch evidence.
- Fresh public DNS/HTTPS spot check on 2026-07-09 found both canonical
  production hosts unresolved from this workstation:
  `app.charitypilot.ie` and `api.charitypilot.ie`.
- GitHub `production` environment variables currently include
  `NEXT_PUBLIC_API_URL=https://api.charitypilot.ie`, but
  `NEXT_PUBLIC_SUPABASE_URL` is still missing because the real Supabase project
  ref has not been provided.
- `npm run check:production:github-env -- --environment=production` now verifies
  the release-image GitHub environment without reading secret values; the latest
  live run failed only because `NEXT_PUBLIC_SUPABASE_URL` is missing.
- `npm run check:production:github-secrets -- --environment=production` now
  verifies required GitHub `production` secret names without reading secret
  values when GitHub is the approved deployment secret store.
- GitHub `production` environment secrets currently include the generated
  non-provider entries `JWT_SECRET` and `READINESS_API_KEY`. The live
  `check:production:github-secrets` run on 2026-07-09 still fails with six
  missing provider/operator secrets: `DATABASE_URL`, `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and
  `ERROR_ALERT_WEBHOOK_URL`.

The 19 missing production values are:

- `TRUSTED_PROXY_ADDRESSES`
- `DATABASE_URL`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- `STRIPE_ESSENTIALS_MONTHLY_PRICE_ID`
- `STRIPE_ESSENTIALS_YEARLY_PRICE_ID`
- `STRIPE_COMPLETE_MONTHLY_PRICE_ID`
- `STRIPE_COMPLETE_YEARLY_PRICE_ID`
- `RESEND_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ERROR_ALERT_WEBHOOK_URL`
- `NEXT_PUBLIC_SUPABASE_URL`
- `CHARITYPILOT_WEB_NEXT_PUBLIC_SUPABASE_URL`
- `CHARITYPILOT_API_IMAGE`
- `CHARITYPILOT_WEB_IMAGE`
- `CHARITYPILOT_MIGRATION_IMAGE`
- `CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_SUPABASE_URL`

For release image promotion, `npm run launch:status` now also exposes the
GitHub `production` environment variables required before `gh workflow run
release-images.yml --ref master` can produce the `release-image-digests.env`
artifact:

- `NEXT_PUBLIC_API_URL=https://api.charitypilot.ie`
- `NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co` (replace `<project-ref>` before running `release-images.yml`)

Validate those non-secret GitHub `production` environment variables before
running the image workflow:

```powershell
npm run check:production:github-env -- --environment=production
```

## Non-Negotiable Product Posture

Do not claim CharityPilot is legally guaranteed, "100% legally bombproof", or a substitute for legal advice.

Correct posture:

- review-ready;
- source-cited;
- evidence-led;
- difficult to misuse;
- clear that solicitor, governance, privacy, accounting, safeguarding, employment, and other professional review may be required.

## What Has Been Achieved

### UI/UX and Product Surface

- Full UI/UX revamp has been carried across the main P0 flows:
  - marketing;
  - auth;
  - dashboard;
  - compliance overview;
  - compliance principle detail;
  - documents;
  - deadlines;
  - board;
  - registers;
  - regulator;
  - organisation;
  - team;
  - billing;
  - export;
  - loading, error, empty, disabled, and not-found states.
- Light and dark mode support is present across the app.
- Route files have been decomposed: no route page remains over 450 lines according to the platform audit.
- P0 dashboard routes now use extracted panels, workflow hooks, and shared primitives rather than large monolithic route files.
- Shared UI primitives are in place for:
  - loading states;
  - empty states;
  - error states;
  - locked-feature states;
  - review warnings;
  - inline status;
  - save status;
  - source references;
  - file upload;
  - form alerts;
  - action buttons.
- HeroUI controls are now used for key binary/choice/input surfaces:
  - switches;
  - checkboxes;
  - radio groups;
  - buttons;
  - inputs;
  - file upload.
- Lucide icons have replaced route-local inline SVGs across the main route chrome and key actions.
- Pricing page metadata is ASCII-safe and pricing feature/comparison icons use `lucide-react` directly.
- Marketing blog search uses the shared empty-state primitive for no-result filters; marketing landing signal tiles use shared status panel styling; dashboard annual regulator summary, summary cards, progress cards, deadline lists, and board-alert cards use shared status panel styling; compliance overview summary, principle cards, and detail standard editor cards use shared status panel styling; compliance standard autosave, organisation profile saving, governance register saving, document vault mutations, export board sign-off, and board/deadline/team mutations use the shared save-status primitive; export controls and board-approval panels use shared status panel styling; billing checkout and portal handoffs use shared visible status; billing current-plan summary and plan prices use shared/flat panel treatment instead of nested route-local cards; team permission-denied messages use shared permission hints instead of route-local hidden or bespoke status markup.
- Dashboard mobile navigation has explicit ARIA controls, Escape handling, focus recovery, and focus trapping.
- Breadcrumbs and principle labels are source-backed and meaningful.

### Compliance and Legal-Readiness Model

- Irish compliance source metadata was refreshed against official sources on 2026-07-09.
- The matrix includes source metadata, last-checked dates, professional-review flags, and commencement status.
- The product includes explicit not-yet-commenced monitoring rows for relevant Charities (Amendment) Act 2024 provisions.
- Conditional obligation profile facts were added for:
  - staff/workers;
  - volunteers;
  - public fundraising;
  - child-facing services/safeguarding;
  - personal-data processing/GDPR;
  - premises/events;
  - public-sector context;
  - processors.
- Conditional obligation prompts now surface through documents, deadlines, registers, regulator, export, and organisation workflows.
- Export readiness is broader than missing explanations:
  - missing standard records;
  - missing actions;
  - missing evidence;
  - missing explanations;
  - missing conditional-profile facts;
  - profile-triggered professional-review prompts.
- API-rendered exports include:
  - source/professional-review appendix;
  - not-legal-advice/non-certificate disclaimer;
  - source counts;
  - professional-review flags;
  - not-yet-commenced monitoring metadata.

### Backend, Security, and Reliability

- Tenant isolation, auth/session guards, role guards, plan gates, validation, redaction, document privacy, and billing degradation are covered by tests and tooling.
- Browser auth moved away from localStorage and into HTTP-only cookies.
- Refresh sessions are hashed, revocable, and rotating.
- Password reset and verification tokens are hashed before storage.
- Logout and server-side refresh revocation exist.
- Identifier-aware throttles exist for:
  - email;
  - reset/verify token;
  - refresh token;
  - bearer/access-cookie credentials.
- Stripe customer reconciliation was added:
  - organisation-scoped idempotency key;
  - metadata verification before checkout/portal reuse;
  - stale or wrong-organisation IDs repaired through metadata reconciliation.
- Duplicate-subscription prevention now adds a serializable
  `BillingCheckoutAttempt` lease, customer-wide provider subscription checks,
  attempt-bound webhook validation, authoritative Stripe re-retrieval, exact
  price/interval/quantity enforcement, and a pinned safe portal policy. Checkout
  is restricted to first purchase or provider-confirmed terminal restart;
  Stripe-managed changes are portal-only.
- Document storage paths include UUIDs to avoid same-millisecond filename collisions.
- Document file privacy is preserved through private storage and signed download URLs.
- Document metadata responses do not expose internal storage object keys.
- Production error handling redacts sensitive values.
- Alert webhook and production checker transcript redaction is in place.
- Backup/restore helper transcript redaction is in place.

### Production and Launch Tooling

- Canonical production origins are aligned:
  - web: `https://app.charitypilot.ie`
  - API: `https://api.charitypilot.ie`
- Production deploy defaults include `compose.production.yml` plus `compose.production-tls.yml`.
- A `--no-tls-proxy` escape hatch exists for managed platform TLS.
- Caddy/TLS runbook, environment template, smoke checks, evidence validators, and release workflow all align around the canonical hostnames.
- Release workflow builds and publishes digest-pinned runtime/migration images.
- Deploy preflight validates digest-pinned images and web build-origin metadata.
- Production deploy and rollback scripts run preflight and public HTTPS smoke checks.
- Launch status output groups missing production values by source:
  - hosting/proxy;
  - PostgreSQL;
  - Stripe;
  - Resend;
  - Supabase;
  - observability;
  - release image promotion.
- Launch status has JSON output for operator dashboards and handoffs.
- Launch status exposes both read-only launch-evidence progress commands and strict launch-evidence validation commands, including JSON variants.
- Launch status exposes the deployed browser QA command set for responsive, accessibility, cross-browser, and iOS Safari evidence collection.
- Launch status exposes the full production check, provider, deploy, rollback, release-run evidence, and final evidence validation command sequence.
- Launch status exposes the final signoff role list, solicitor/governance/privacy review, external pentest, release binding, and review-ready legal posture.
- Launch status keeps the full source-grouped production value checklist visible after `.env.production` exists, while separately listing the currently missing values.
- Strict launch-evidence JSON validation includes the next incomplete checklist items and evidence hints so failing launch-gate output can drive operator work queues.
- Production launch evidence initializes outside the repo root in `.charitypilot-launch-evidence/`.
- Launch evidence status has read-only progress output and strict final validation.
- The platform audit generator records launch evidence state and falls back to direct `.git` metadata reads if shelling out to git is unavailable.
- Release E2E timeout handling is limited to the exact spawned child process
  tree, escalates a stuck POSIX child after a bounded grace period, and keeps
  signal handlers active while the runner tears down and verifies its exact
  pinned-daemon Compose project. It never scans for or stops unrelated Node/npm
  processes on a shared workstation; failed cleanup makes the gate red and
  retains the private recovery inputs.
- Release readiness child gates resolve `npm` and `npx` through explicit Node
  CLI entrypoints on Windows instead of shell execution, keeping launch
  evidence transcripts free of shell-argument deprecation warnings.
- Responsive/accessibility route QA now fails fast when protected-route
  navigation hits a 500, a Next.js/runtime overlay, a login redirect, or a
  browser JavaScript page error while resolving the compliance principle detail
  route. This keeps deployed/browser-QA evidence actionable instead of ending in
  a vague missing-selector timeout.

### Launch Evidence Hardening

The launch evidence model has been tightened substantially:

- Evidence references must use HTTPS URLs on approved hosts.
- Approved references are limited to `*.charitypilot.ie` or the canonical GitHub repository.
- GitHub evidence must point to `github.com/jasperfordesq-ai/charity-governance`.
- Signed URLs and token-bearing query strings are rejected.
- Evidence descriptions and references reject raw secret-looking values.
- Evidence file path errors are redacted.
- Pentest evidence must bind to the promoted `release.commitSha`.
- Deployed browser QA evidence must bind to the promoted `release.commitSha`.
- Final signoff evidence must bind to the promoted `release.commitSha`.
- Final signoff requires five roles:
  - engineering;
  - operations;
  - security;
  - legal/compliance;
  - business.
- Legal/compliance evidence must include solicitor/governance/privacy review.
- Browser QA evidence requires:
  - deployed responsive coverage;
  - deployed accessibility coverage;
  - cross-browser coverage;
  - real iOS Safari or cloud-device proof;
  - full route inventory across desktop/mobile and light/dark.
- Supabase evidence requires private bucket, signed URL behavior, backup/PITR evidence, restore-test owner/date/recovery notes, isolated restore target, non-production restore target, and confirmation that the production project was not overwritten.
- Billing/email evidence requires Stripe webhook event proof, webhook-secret secret-store proof, Resend accepted-send proof, and production email-link origin proof.
- Evidence chronology now allows the package to be prepared before evidence is collected, while requiring every checklist evidence entry to be captured no later than `finalSignoff.approvedAt`.
- Deploy-smoke evidence hints now match the strict validator:

```powershell
npm run deploy:production -- --production-env-file=.env.production --backup-output-dir=/secure/charitypilot/cutovers
node scripts/smoke-production-deploy.mjs --production-env-file .env.production
Production deploy smoke passed
https://app.charitypilot.ie
https://api.charitypilot.ie
```

## Recent Verification Evidence

Recently successful checks in this workstream:

- `npm run test:e2e`
  - Passed locally on 2026-07-10 for P0-06 with `113 / 113` isolation contracts
    and `97 / 97` live Playwright tests in `7.0m`; the cached production-image,
    attestation, readiness, test, and verified-teardown command took `11.6m`
    against the UUID-marked disposable PostgreSQL instance. A preceding focused
    managed run also passed the Organisation contrast and migrated-profile save
    regressions. Exact teardown left no runner Docker/private-state residue or
    personal-stack drift. Exact-SHA GitHub evidence remains pending for P0-06.
- `npm test`
  - Passed on 2026-07-10 with API `520 / 520`, web `311 / 311`, shared
    `35 / 35`, production tooling `512 / 512`, and local-Docker tooling
    `44 / 44`.
- `npm run reliability:report -- --write`
  - Passed on 2026-07-10 with `383 / 383` covered guarantees linked to passing
    test titles. Static linkage alone is not browser execution; separate E2E run
    `29116192729` supplies exact-SHA execution for P0-05. P0-09 remains open for
    release-promotion, deployed-browser, and live repository-protection proof.
- `npm run build`, `npm run security:scan`, and both dependency audits
  - Passed on 2026-07-10; all workspaces built, `545` staged files passed secret/SAST
    scans, and both audits reported zero vulnerabilities.
- `node --test apps/api/dist/tests/billing-subscription-integrity.test.js apps/api/dist/tests/billing-reliability.test.js apps/api/dist/tests/billing-reminders-hardening.test.js apps/api/dist/tests/idempotency-reliability.test.js`
  - Passed on 2026-07-10 with `50 / 50` focused P0-03 billing tests.
- `node --test scripts/check-production-providers.test.mjs`
  - Passed on 2026-07-10 with `13 / 13` provider-contract tests covering exact
    prices/product grouping, pinned portal policy, webhook events, and Resend
    domain verification.
- `npm test -w @charitypilot/web`
  - Passed on 2026-07-10 with `248 / 248` tests for the P0-03 checkpoint.
- `npm test -w @charitypilot/shared`
  - Passed on 2026-07-10 with `19 / 19` tests for the P0-03 checkpoint.
- `npm run lint -w @charitypilot/web` and `npm run build -w @charitypilot/web`
  - Passed on 2026-07-10 for the capability-driven billing UI and truthful copy.
- `npm test -w @charitypilot/api`
  - Passed on 2026-07-10 with `454 / 454` tests after all final P0-03 focused
    regressions were integrated.
- `npm run test:production-check`
  - Passed on 2026-07-10 with `488 / 488` production-tooling tests.
- `npm run reliability:report -- --write`
  - Passed on 2026-07-10 with API `454 / 454`, web `248 / 248`, and `365 / 365`
    covered-guarantee links resolved.
- `npm run audit:platform:check`
  - Passed on 2026-07-10; `docs/platform-completion-audit.md` is current.
- `gh run watch 29077589143 --exit-status`
  - Passed on 2026-07-10 for the complete P0-03 implementation and CI-repair
    chain through `7ffc8f862d863f559365668c19550be00d0bb382`.
- `gh run watch 29074651622 --exit-status`
  - Passed on 2026-07-10 for P0-02 commit `fbd5ce4`.
- `gh run watch 29073803773 --exit-status`
  - Passed on 2026-07-10 for P0-01 commit
    `97f64b0285eb2d19489c062cda52134fda8f9a53`.

- Historical direct responsive Playwright proof passed on 2026-07-09 after the
  compliance-detail resolver was hardened. Its old boolean reset command is
  intentionally omitted and retired; repeat only through `npm run test:e2e` or
  the managed focused responsive scripts.
- `node --test scripts/check-local-docker.test.mjs`
  - Passed on 2026-07-09 with 38/38 local Docker and browser-QA wiring checks.
- `npm run test:production-check`
  - Passed on 2026-07-09 with 352/352 production-tooling checks during the
    latest handoff refresh.
  - Historical count; the current local production-tooling gate is 512/512.
- `npm run audit:platform:check`
  - Passed on 2026-07-09 after the same browser-QA diagnostic hardening.
- `node scripts/platform-completion-audit.mjs --json`
  - Read-only machine-readable audit output for route, backend, launch,
    compliance, and next-action handoff automation; it must not rewrite
    `docs/platform-completion-audit.md`.
- `gh run watch 29021018683 --exit-status`
  - Passed on 2026-07-09 for commit `cb78eb8`.
  - Covered CI security scan, Prisma validation/migration, PostgreSQL
    backup/restore, lint, tests, reliability ledger, local Docker smoke,
    workspace builds, Docker image builds/smokes, scheduled-job smoke, and
    dependency audit after no-shell release gate execution hardening.
- `gh run watch 29020485769 --exit-status`
  - Passed on 2026-07-09 for commit `11b0f5b`.
  - Covered CI security scan, Prisma validation/migration, PostgreSQL
    backup/restore, lint, tests, reliability ledger, local Docker smoke,
    workspace builds, Docker image builds/smokes, scheduled-job smoke, and
    dependency audit after repo-scoped failed E2E cleanup hardening.
- `gh run watch 29012705817 --exit-status`
  - Passed on 2026-07-09 for commit `0d29887`.
  - Covered CI security scan, Prisma validation/migration, PostgreSQL
    backup/restore, lint, tests, reliability ledger, local Docker smoke,
    workspace builds, Docker image builds/smokes, scheduled-job smoke, and
    dependency audit after release-ready stack reachability timeout hardening.
- `gh run watch 29010531551 --exit-status`
  - Passed on 2026-07-09 for commit `7c182f3`.
  - Covered CI security scan, Prisma validation/migration, PostgreSQL
    backup/restore, lint, tests, reliability ledger, local Docker smoke,
    workspace builds, Docker image builds/smokes, scheduled-job smoke, and
    dependency audit after the live-only platform-audit repository-state
    hardening.
- `gh run watch 29001831333 --exit-status`
  - Passed on 2026-07-09 for commit `786d7ff`.
  - Covered CI security scan, Prisma validation/migration, PostgreSQL
    backup/restore, lint, tests, reliability ledger, local Docker smoke,
    workspace builds, Docker image builds/smokes, and dependency audit.
- `npm run test -w @charitypilot/web`
  - Passed on 2026-07-09 with 232 web tests after compliance navigation
    confirmation copy/timer-guard hardening.
- Historical direct compliance Playwright proof passed on 2026-07-09 with both
  journeys green. Its direct reset invocation is retired; repeat with
  `npm run test:e2e -- tests/compliance.spec.ts` through the isolated runner.
- `npm run lint -w @charitypilot/web`
  - Passed on 2026-07-09 after the same changes.
- `npm run build -w @charitypilot/web`
  - Passed on 2026-07-09 after the same changes.
- `npm run audit:platform:check`
  - Passed on 2026-07-09 after the same changes.
- `npm run test:production-check`
  - Passed on 2026-07-09 with 338/338 production-tooling checks passing after
    the same changes and the GitHub production environment evidence gate.
    Historical count; the current local production-tooling gate is 512/512.

- `npm test -w @charitypilot/web`
  - 220 web tests passed after public attribution, shared auth status icons, and shared auth loading-state polish.
- `npm run lint -w @charitypilot/web`
  - Passed after the same auth/public trust-surface work.
- `npm run release:ready`
  - Passed on 2026-07-09 at commit `cf683f1` in the latest full local release-gate run recorded by this handoff.
  - Security scan, lint, build, workspace tests, dependency audit, reliability ledger, and 95 Playwright E2E tests passed.
  - Final summary included `OVERALL: GREEN - repository release gates passed`.
- `npm run test:production-check`
  - Passed on 2026-07-09 with 338/338 production-tooling checks passing.
  - Covers production validators, launch evidence validation, provider checker contracts, deployment tooling, backup/restore tooling, and CI/release workflow guards.
  - Historical count; the current local production-tooling gate is 512/512.
- `npm run lint -w @charitypilot/web`
  - Passed after the shared blog empty-state and compliance save-status primitive cleanup.
- `npm run build -w @charitypilot/web`
  - Passed after the same shared-state cleanup.
- `npm run test:production-check`
  - Passed again with 338/338 production-tooling checks after launch-evidence, release-ready, continuation-doc, and GitHub secret-store checker hardening.
  - Historical count; the current local production-tooling gate is 512/512.
- Focused launch-evidence tests
  - Passed after the evidence hardening updates.
- Web wiring tests
  - Passed after the pricing/icon polish.
- `npm run audit:platform`
  - Passed.
- `npm run launch:status -- --json`
  - Passed and still reports the real blockers.

Important limitation:

Local/repo checks do not prove production launch readiness. They must be rerun against the final production config and live HTTPS deployment.

## What Is Left To Do

### External Launch Blockers

These require human/operator/provider access and must not be faked:

1. Fill real production secrets/provider values in `.env.production` or an approved secret store.
2. Configure production hosting, DNS, TLS, reverse proxy, and public HTTPS smoke evidence.
3. Prove PostgreSQL production backup and restore before real charity data.
4. Prove Supabase production private bucket, signed URL behavior, backup, and restore.
5. Configure Stripe live products/prices/webhook.
6. Configure Resend sender domain and live email evidence.
7. Configure observability:
   - logs;
   - uptime checks;
   - readiness checks;
   - alert routing;
   - incident owner;
   - backup owner;
   - escalation path;
   - test alert.
8. Complete solicitor/governance/privacy review.
9. Complete external penetration test.
10. Remediate or formally accept pentest findings.
11. Complete deployed browser QA and accessibility checks.
12. Complete all 87 machine-readable launch evidence checks.
13. Complete final engineering, operations, security, legal/compliance, and business signoffs.

### Launch Evidence Still Open

The evidence ledger is currently `9 / 87`. Those completed checks are local/CI
release-gate basics only; they do not replace real production env validation,
digest-pinned deployment, public HTTPS smoke, rollback, provider, backup/restore,
deployed browser QA, legal, pentest, or final signoff evidence.

The first incomplete evidence checks currently reported by
`npm run launch:status -- --json` are:

- `releaseGate.check-production`
- `releaseGate.github-environment`
- `releaseGate.github-secret-store`
- `releaseGate.deploy-preflight`
- `releaseGate.deploy-production`
- `releaseGate.deploy-smoke`

Do not fill these with local or fake evidence. They need final real production
configuration, GitHub production environment, digest-pinned deployment, and
public HTTPS smoke evidence tied to the promoted release. Re-run launch status
before acting; this ordered list changes as evidence is completed.

### Deployed Browser QA Still Open

Local browser/accessibility checks have been run previously, but deployed production QA remains open.

Required deployed QA must cover:

- public/auth routes;
- dashboard routes;
- desktop;
- mobile;
- light mode;
- dark mode;
- auth flow;
- dashboard flow;
- billing flow;
- document upload;
- signed download;
- logout;
- error states;
- accessibility;
- cross-browser;
- real iOS Safari or cloud-device iOS Safari.

### Legal/Compliance Still Open

The product is review-ready but not legally signed off.

Still required:

- production privacy policy approval;
- terms/service agreement approval;
- retention policy approval;
- support/data deletion contact publication;
- named solicitor review;
- named governance review;
- named privacy review;
- review dates and evidence references outside git.

## Recommended Next Agent Workflow

1. Confirm the baseline:

```powershell
git status --short --branch
git log --oneline -5
npm run launch:status -- --json
```

2. If no real production/provider access is available, continue repo-side closure only:

- search for stale command drift;
- tighten validators;
- improve launch evidence clarity;
- strengthen runbooks;
- run focused tests;
- commit and push.

3. If production/provider access is available, work through this order:

```powershell
npm run check:production -- --production-env-file=.env.production
npm run check:production:github-env -- --environment=production
npm run check:production:github-secrets -- --environment=production
npm run check:production:hosting -- --production-env-file=.env.production
npm run check:production:database -- --production-env-file=.env.production --expect-operational-sentinel
npm run check:production:supabase -- --production-env-file=.env.production
npm run check:production:providers -- --production-env-file=.env.production
npm run check:production:observability -- --production-env-file=.env.production
npm run deploy:preflight -- --production-env-file=.env.production
npm run deploy:production -- --production-env-file=.env.production --backup-output-dir=/secure/charitypilot/cutovers
npm run deploy:rollback -- --production-env-file=.env.production --rollback-digest-file=release-image-digests.previous.env --schema-compatibility-attestation-file=/secure/schema-compatibility-attestation.json --backup-output-dir=/secure/charitypilot/rollback-cutovers
npm run check:production:evidence -- --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json
```

4. For deployed browser QA, use the commands and evidence slots in:

- `docs/production-browser-qa.md`
- `docs/production-launch-checklist.md`
- `.charitypilot-launch-evidence/production-launch-evidence.json`

5. Commit only repo changes. Do not commit:

- `.env.production`;
- real secrets;
- production launch evidence JSON;
- screenshots with sensitive data;
- pentest reports;
- legal review reports;
- provider credentials;
- backup dumps.

## Percentage Remaining

Strict launch evidence metric:

- `78 / 87` machine-readable launch checks remain.
- Strict counted launch gates are `18 / 121` complete, so `103 / 121`
  counted gates remain. This is an operator progress metric only, not a legal,
  security, operations, or business readiness certification.
- Strict launch evidence is still mostly incomplete because the remaining checks
  include the real production environment, deploy, rollback, provider,
  backup/restore, deployed QA, legal, pentest, and final signoff gates.
- Final signoffs remain `0 / 5`.
- Production values remain `9 / 29` complete, with 20 real provider/hosting/image-promotion values still missing.

Whole-goal estimate:

- Repo-side engineering and UI polish are substantially advanced.
- Actual production launch readiness is still dominated by external provider setup, deployed evidence, legal/privacy/governance review, external security review, backup/restore proof, and final signoffs.
- Evidence-based estimate: about 65-70% of the overall production-completion goal remains, even though the codebase itself is much further along.

Repo-side-only estimate:

- About 10-15% remains, mostly defects that may be discovered by live QA, security review, or production provider checks.

## Final Rule For Future Agents

Do not redefine success around passing local tests. CharityPilot is not launch-ready until the real production environment, live providers, deployed QA, legal/compliance review, external security review, backup/restore evidence, all 87 launch evidence checks, and all five final signoffs are complete and recorded.
