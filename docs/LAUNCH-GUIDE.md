# CharityPilot - Plain-English Launch Guide

*Last updated: 2026-07-12. This is the human-friendly companion to the dense
`docs/production-launch-checklist.md`. Read this one first.*

> **Not sure where you are?** Run `npm run launch:status` any time - it inspects
> your local setup and tells you the single next action to take.
> For CI, handoff notes, or an operations dashboard, run
> `npm run launch:status -- --json` to get the same missing-value and evidence
> ledger state as machine-readable JSON without exposing secret values.
> For one-person local use on this computer, run `npm run personal:ready`.
> That is a non-destructive local confidence gate; it does not replace deployed
> production evidence. Run destructive browser tests only through
> `npm run test:e2e`: its managed runner provisions and proves a separate
> disposable database and refuses personal targets. Never bypass it with direct
> Playwright or weakened identity guards.

---

## 1. Where the platform actually is right now

The codebase is substantially hardened, but launch readiness is not complete
until the final release gate, deployed browser QA, external provider evidence,
legal/privacy approval, and independent security review are all recorded.
As of 2026-07-09, the local platform audit shows strong automated coverage and
no obvious static route-level UI risks, but the release checks below must still
be rerun against the final production configuration:

`npm run launch:status` is the source of truth for the machine you are on. On
a fresh clone it reports `NO_ENV` until you run `npm run setup:production-env`;
on a partially configured production workstation it reports `ENV_INCOMPLETE`
and lists the remaining real provider/hosting values. The last partially
  configured handoff still had 18 counted production values needing real data,
  and its older env file additionally lacks the new `AUTH_RECOVERY_SECRET` and
  P1-07A database-compatibility marker.
  On the latest checked workstation, production values are `9 / 27` complete,
machine-readable launch evidence is `9 / 89` complete, final signoffs are
  `0 / 5`, the strict counted launch gates are `18 / 121` complete (`14.9%`),
and `approvedForLaunch` is `false`. That strict percentage only counts
production values, launch evidence checks, and final signoff roles; it is not a
legal, security, operations, or business readiness certification.
Local browser QA has current 2026-07-09 evidence from focused responsive route chunks across desktop/mobile and light/dark: public desktop 14/14, public mobile 14/14, dashboard desktop 12/12, and dashboard mobile 12/12. The full local accessibility suite passed 26/26 checks on 2026-07-09, including `/about` and both light and dark themes. Deployed production QA remains a launch gate
because localhost cannot prove DNS, TLS, cookies, CORS, storage downloads, or
live provider integration.
The machine-readable launch evidence file must also pass all
89 machine-readable launch evidence checks, including the GitHub production
environment and secret-store preflights, recovery-key rotation, isolated
authentication-email worker/anomaly-alert rehearsal, distinct deployed recovery
and post-reset Resend delivery, and deployed accessibility
transcript in `browserQa.checks.accessibility-coverage`, cross-browser
transcripts in `browserQa.checks.cross-browser-coverage`, and real-device or
cloud-device iOS Safari proof in `browserQa.checks.ios-safari-device-coverage`.
The new recovery proofs belong in
`secretsAndEnv.auth-recovery-secret-rotation-rehearsal`,
`jobs.auth-email-delivery-runtime`, `jobs.auth-delivery-anomaly-alert`, and
`billingAndEmail.password-recovery-resend-delivery`; each entry must satisfy the
distinct transcript requirements in the machine validator rather than relying
on one generic status note.
The deployed browser QA preflight transcript must be recorded in
`browserQa.checks.browser-qa-completed`, including
`npm run check:production:browser-qa-env` and
`Deployed browser QA environment preflight passed`.
The deployed browser evidence must also complete the Launch-Critical Route Inventory
in `docs/production-browser-qa.md`, proving every route in desktop, mobile, light-mode, and dark-mode evidence before launch signoff. Every browser QA
evidence slot must name the exact promoted `release.commitSha`:
`browserQa.checks.browser-qa-completed`, `browserQa.checks.desktop-coverage`,
`browserQa.checks.mobile-coverage`, `browserQa.checks.accessibility-coverage`,
`browserQa.checks.cross-browser-coverage`,
`browserQa.checks.ios-safari-device-coverage`, and
`browserQa.checks.critical-flows-covered`.
A local `npm run release:ready` run passed on 2026-07-09 at commit
`cf683f1`: security scan, lint, build, workspace tests, dependency audit,
reliability ledger, and 95 Playwright E2E tests passed; `OVERALL: GREEN - repository release gates passed`. Treat this as local release-gate evidence,
not as production launch approval.

| Check | Result |
| --- | --- |
| TypeScript build (shared + API + web) | Must pass for the release ref |
| Lint | Must pass for the release ref |
| Unit tests (API, web, shared) | Must pass for the release ref |
| Production-tooling tests | The final P1-07A local gate passed 827 checks with 0 failures and 2 expected Windows symbolic-link privilege skips (829 total) on 2026-07-12; the final local managed disposable E2E gate also passed 113/113 runner contracts and 105/105 browser scenarios in 7.6m with clean isolated teardown; exact-pushed-SHA GitHub CI and managed E2E runs remain separate pending publication gates |
| Prisma schema validation | Must pass for the release ref |
| Secret scan + SAST scan | Must pass for the release ref |
| `npm audit` (production deps, moderate+) | Must show no moderate-or-higher production vulnerabilities |
| `npm ci` reproducible install | Must pass on the release build machine |
| Full app boots in Docker (db + API + web), migrates, seeds, serves | Must be proven for the release candidate |

The core security model is already in place: HTTP-only cookie auth,
hashed rotating refresh sessions, role guards, private document storage with
authenticated API-proxy downloads and post-read session revalidation, security
headers + CSP, rate limiting, browser-origin protection,
and strict production environment validation that refuses to start with
placeholder secrets.

## 2. Why you can't "just press deploy" - and that's by design

The platform deliberately separates **two gates**:

1. **Code gate** - "is the software correct and safe?" -> *implemented, but rerun for the final release ref.*
2. **Launch gate** - "is it actually running on real infrastructure, with real
   payment/email providers, legal cover, and an independent security sign-off?"
   -> *This is what's left, and almost none of it is code.*

The launch gate needs **real-world accounts, money, a domain, and human
decisions**. An AI agent cannot create your company's Stripe account, buy your
domain, hire a penetration-testing firm, or sign off as the legally accountable
owner. **That is the work that remains, and it is yours (with help).** The good
news: it's a finite, ordered checklist, laid out below.

> **Warning:** Do not put real charity data into the platform until every step below is done.
> The platform's own tooling is built to *reject* fake/placeholder
> launch evidence, so there are no shortcuts here - nor should there be, given
> this handles charity governance records.

---

## 3. The remaining steps, in order

Each step lists: **what it is**, **why it matters**, **what you need**, and
**roughly how much effort/cost**.

### Step 1 - Buy/confirm the domain  `charitypilot.ie`
- **What:** Own the web address. The code is hard-wired to only accept
  `charitypilot.ie` (and its subdomains) as approved production hosts.
- **Why:** TLS certificates, cookies, CORS, and email all key off this domain.
- **You need:** A domain registrar account; the domain registered to you/your company.
- **Effort/cost:** ~30 min, ~EUR20-40/year.

### Step 2 - Create the production provider accounts
You need four external services. Create the **production/live** versions
(separate from any test accounts):

| Provider | Used for | What to create | Rough cost |
| --- | --- | --- | --- |
| **Supabase** | Private file storage for documents | A production project + a **private** bucket named `documents` | Free tier to start; paid as you grow |
| **Stripe** | Subscription billing | Live-mode account (needs business verification), 4 prices: Essentials monthly/yearly, Complete monthly/yearly | % per transaction |
| **Resend** | Transactional email (verify, reset, reminders) | Account + **verified sender domain** for `noreply@charitypilot.ie` | Free tier to start |
| **Error alerts** | Incident notifications | An HTTPS webhook URL (e.g. Slack incoming webhook, or a monitoring tool) | Free-low |

- **Effort:** Half a day spread over a few days (Stripe verification + DNS
  records for Resend can take 24-72h to propagate).
- **Step-by-step guides:** [`docs/billing-and-email-setup.md`](billing-and-email-setup.md)
  (Stripe's four prices, keys, and webhook; Resend domain + key) and
  [`docs/supabase-production-setup.md`](supabase-production-setup.md) (private
  storage bucket). After filling the values, `npm run check:production:providers`
  and `npm run check:production:supabase` verify them for you.

### Step 3 - Provision the production database
- **What:** A managed PostgreSQL database (e.g. Supabase Postgres, Neon, RDS).
- **Why:** Stores all governance data. Production connections must use exact
  lowercase `sslmode=verify-full` plus
  `target_session_attrs=read-write`, and the service must provide managed
  backups with point-in-time recovery.
- **You need:** The managed DB + its connection string (kept secret).
- **Effort/cost:** ~1 hour; free tier to start, paid as you grow.

### Step 4 - Choose where the app runs (hosting)
- **What:** A Linux host (or platform) that can run Docker Compose, OR a
  container platform. The repo ships production `Dockerfile`s and
  `compose.production.yml`, plus a GitHub Actions workflow that builds signed
  images.
- **Why:** Somewhere for the API, web app, and the scheduled-jobs service to live.
- **You need:** A server/host + DNS pointing `app.charitypilot.ie` (web app) and
  `api.charitypilot.ie` (API) at it, with valid TLS certificates.
- **Effort/cost:** Half a day to a day; ~EUR10-40/month for a small VPS to start.
- **This is the step most worth getting a developer/DevOps person to pair on** if
  you're not comfortable - it's the highest-skill part.

- **Preparing a fresh server is scripted.** On a new Ubuntu/Debian VPS, run
  `sudo bash scripts/provision-server.sh` - it installs Docker + the Compose
  plugin and opens the firewall for SSH, HTTP, and HTTPS (it allows SSH before
  enabling the firewall, so you won't lock yourself out). Review it first; it
  makes system-level changes.

- **TLS is now turnkey by default.** You no longer have to hand-configure certificates. The
  repo ships the default reverse proxy overlay (`compose.production-tls.yml` +
  `caddy/Caddyfile`) that obtains and renews HTTPS certificates automatically via
  Let's Encrypt. Once you have a server and DNS:
  1. Point DNS `A` records for `app.charitypilot.ie` **and** `api.charitypilot.ie` at
     your server's public IP; open ports 80 and 443.
  2. In `.env.production`, set `CADDY_ACME_EMAIL` (for Let's Encrypt) and
     `TRUSTED_PROXY_ADDRESSES` (so the API trusts the proxy's forwarded client IPs).
  3. Bring up the stack with the proxy overlay:
     ```bash
     npm run deploy:production -- --production-env-file=.env.production --backup-output-dir=/mnt/encrypted/charitypilot/p107a-cutover
     ```
  Caddy terminates HTTPS for both domains and proxies to the internal containers;
  certificates are issued and renewed with no further action. You still need the
  server and DNS, but the certificate/proxy complexity is handled for you. (If you
  use a managed load balancer or platform TLS instead, run the deploy command
  with `--no-tls-proxy` and keep equivalent TLS evidence in the launch ledger.)

### Step 5 - Fill in the real secrets
- **Start with one command** - it creates `.env.production` for you and
  auto-generates the random secrets you'd otherwise have to craft by hand
  (`JWT_SECRET`, `READINESS_API_KEY`, `AUTH_RECOVERY_SECRET`), setting the current
  `CHARITYPILOT_DATABASE_COMPATIBILITY=p107a-password-recovery-v1`, and leaving clearly-marked placeholders for
  the values only you can provide:
  ```bash
  npm run setup:production-env
  ```
  It prints exactly which values you still need and where each comes from.
  If `.env.production` already exists, this command correctly refuses to
  overwrite it. Do not use `--force` on a file containing reviewed values.
  Instead, add a newly generated independent canonical 32-64-byte
  `AUTH_RECOVERY_SECRET` through the approved secret-store procedure and update
  the non-secret compatibility marker separately; never paste the secret into
  chat, logs, source control, or launch evidence.
- **Then** open `.env.production` and resolve every value reported by
  `npm run launch:status`: replace remaining `REPLACE_ME` placeholders, fill
  the real provider values from Steps 1-4, and correct any drifted TLS/cookie
  settings. **Never commit this file** (it's already gitignored).
- **Then verify it** (these commands check your config without launching):
  ```bash
  npm run check:production -- --production-env-file=.env.production
  npm run check:production:providers -- --production-env-file=.env.production
  npm run check:production:supabase -- --production-env-file=.env.production
  npm run check:production:hosting -- --production-env-file=.env.production
  npm run check:production:database -- --production-env-file=.env.production --capture-source-identity --json --expected-release-commit-sha=PROMOTED_RELEASE_COMMIT_SHA
  npm run check:production:database -- --production-env-file=.env.production --recovery-set-id=RECOVERY_SET_ID --expected-source-database-identity-sha256=EXTERNAL_SHA256 --expected-release-commit-sha=PROMOTED_RELEASE_COMMIT_SHA --backup-output-dir=/mnt/encrypted/charitypilot/recovery/RECOVERY_SET_ID --keep-backup --json
  npm run launch:status -- --json
  npm run check:production:document-recovery -- --help
  npm run check:production:observability -- --production-env-file=.env.production
  ```
- The document-recovery command is an offline reconciliation gate. Obtain every
  `--expected-*` value and the production `Document` count from the independent
  read-only source capture; never copy those values from the recovery manifest
  being checked. Copy `productionLaunchCommands.documentRecovery` from the
  launch-status JSON and replace every `EXTERNAL_*` placeholder; that command is
  generated from all 30 mandatory verifier binding flags, and omitting one is a
  usage error. Database backup/PITR alone cannot satisfy document-object recovery
  evidence.
- Replace `PROMOTED_RELEASE_COMMIT_SHA` in both database commands with the
  promoted lowercase full 40-character commit SHA. Preserve the first command's
  redacted JSON immutably before running the second command. Use its
  `sourceDatabaseIdentitySha256` as the second command's expected
  identity, use a unique recovery-set directory, and retain the dump and proof
  report outside git. The example path does not prove encryption: separately
  record the approved encrypted filesystem, access controls, off-host custody,
  retention, and deletion evidence. Both database commands are read-only against production;
  the restore target is created and destroyed internally and cannot target the
  production connection.
- Read the database proof limitations literally. It binds the covered public
  schema and all application rows within explicit workload bounds, but
  `--no-owner --no-privileges` excludes PostgreSQL role ownership, grants, and
  default privileges. Sequence runtime state is non-MVCC, so the checker fails
  unless there are zero public sequences, identity columns, and `nextval`
  defaults. Preserve separate provider/operator evidence for those excluded
  recovery controls.
- The report also records its exact certified schema scope and the one approved
  digest-pinned PostgreSQL tools image. It does not certify non-public schemas,
  extension membership, comments/security labels, or database-level objects;
  large objects must be absent. The dump has a pre-enforced 64 GiB ceiling, and
  final launch approval rejects a proof older than 24 hours.
- If GitHub `production` is the approved secret store for deploys, also run:
  ```bash
  npm run check:production:github-secrets -- --environment=production
  ```
  This confirms the required production secret names exist without reading or
  printing secret values. Add `--json` to either GitHub check when an evidence
  dashboard needs machine-readable missing-name status without provider values.
  It does not replace the provider checks above.
- **Why:** These catch misconfiguration (wrong keys, public bucket, missing TLS)
  before real data is at risk.
- **Effort:** A couple of hours, iterating until all checks pass.

### Step 6 - Deploy
- **What:** Rehearse the exact signed images against a recent isolated production restore, then let the fail-closed deploy command stop the old runtime, create and restore-verify a protected backup, run migration alone, probe migration history, prepare/reconcile reminder cutover state, and only then start the signed runtime.
  ```bash
gh variable set NEXT_PUBLIC_API_URL --env production --repo jasperfordesq-ai/charity-governance --body "https://api.charitypilot.ie"
  gh variable set DOCUMENT_STORAGE_RECOVERY_DATABASE_HOST_ALLOWLIST --env production --repo jasperfordesq-ai/charity-governance --body "<managed-postgres-hostname>"
  npm run check:production:github-env -- --environment=production
  gh workflow run release-images.yml --ref master
  gh run watch RELEASE_RUN_ID --exit-status
  npm run deploy:preflight -- --production-env-file=.env.production
  npm run deploy:production -- --production-env-file=.env.production --backup-output-dir=/mnt/encrypted/charitypilot/p107a-cutover
  ```
- **Current known GitHub environment blocker (refreshed 2026-07-12):** only
  `JWT_SECRET` and `READINESS_API_KEY` are present. The protected secret store
  still lacks `AUTH_RECOVERY_SECRET` plus the six provider/operator secret
  names. Rerun
  `npm run check:production:github-secrets -- --environment=production`, then
  set the non-secret `DOCUMENT_STORAGE_RECOVERY_DATABASE_HOST_ALLOWLIST` variable
  after selecting the real managed database hostname, and rerun
  `npm run check:production:github-env -- --environment=production`. Only the
  canonical public API origin is exposed to the web image; the recovery
  allowlist remains server/operator configuration. Supabase remains in the API
  secret source and must not be added as a public web variable.
- **Why:** The GitHub `production` environment variable lets the release workflow
  build the web image for the real API origin. The workflow then
  uploads `release-image-digests.env`; copy its digest-pinned image values and
  `CHARITYPILOT_WEB_BUILD_*` metadata (currently
  `CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL`) into `.env.production` before
  preflight.
  The preflight verifies signed, digest-pinned images and renders the compose
  file. Do not run the standalone migration command against production and do
  not use raw `docker compose up`: the deploy command must take the old API,
  web, scheduler, jobs, and proxy down before the breaking migration. It keeps
  failures in maintenance mode, blocks startup on unresolved reminder-provider
  ambiguity, requires roll-forward unless the database is explicitly restored
  before an older image is selected, and then runs a public HTTPS smoke test
  automatically.
- **Effort:** ~1 hour first time. Full details in `docs/production-runbook.md`.

### Step 7 - Approve the legal documents
- **What:** Have your privacy policy, terms of service, and data-retention policy
  reviewed and approved for production; publish a support / data-deletion contact.
- **Why:** You're handling other charities' personal and governance data -
  this is a legal requirement (GDPR), not optional.
- **You need:** Sign-off from whoever is accountable (and ideally a solicitor's
  glance for a commercial SaaS handling this data).
- **Effort:** Variable; start early, it often gates everything else.

### Step 8 - Browser QA on the live site
- **What:** Walk through `docs/production-browser-qa.md` against the **deployed**
  `https://app.charitypilot.ie` on desktop and mobile: sign up, log in, upload a
  document, download it, log out, trigger an error.
- **Why:** Proves real DNS/TLS/cookies/CORS/storage work - localhost can't prove this.
- **Effort:** ~half a day.

### Step 9 - External penetration test
- **What:** Hire an independent security firm to test the live system before real
  charity data goes in. Fix (or formally accept) any critical/high findings.
- **Why:** This is the single most important gate for handling sensitive data,
  and it must be independent (not me, not you self-assessing).
- **You need:** A reputable pentest provider; budget.
- **Effort/cost:** 1-3 weeks lead time; typically low-thousands EUR for a focused
  SaaS test.

### Step 10 - Final sign-off
- **What:** Record real evidence in `docs/production-launch-checklist.md` and the
  machine-readable `.charitypilot-launch-evidence/production-launch-evidence.json`, with five named approvals:
  **engineering, operations, security, legal/compliance, and business**.
- **Why:** A deliberate multi-role launch gate so no single person launches alone.
- **Effort:** ~1 hour once everything above is done.

---

## 4. What to do *first* (if you do nothing else this week)

1. **Buy the domain** (Step 1) - everything depends on it.
2. **Start Stripe business verification** (Step 2) - it has the longest lead time.
3. **Start the legal review** (Step 7) - also long lead time.
4. **Start talking to a pentest firm** (Step 9) - book it early.

These four have external waiting periods, so kicking them off now means the
hands-on technical steps (4, 5, 6) aren't blocked later.

## 5. Where to get help

Steps 4, 5, and 6 (hosting, secrets, deploy) are the most technical. If you want
to do them yourself, `docs/production-runbook.md` is the exact command-by-command
guide. If you'd rather hand them to a developer, this guide + the runbook give
them everything they need to finish in a day or two.
