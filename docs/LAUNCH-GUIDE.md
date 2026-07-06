# CharityPilot - Plain-English Launch Guide

*Last updated: 2026-07-06. This is the human-friendly companion to the dense
`docs/production-launch-checklist.md`. Read this one first.*

> **Not sure where you are?** Run `npm run launch:status` any time - it inspects
> your local setup and tells you the single next action to take.

---

## 1. Where the platform actually is right now

The codebase is substantially hardened, but launch readiness is not complete
until the final release gate, deployed browser QA, external provider evidence,
legal/privacy approval, and independent security review are all recorded.
As of 2026-07-06, the local platform audit shows strong automated coverage and
no obvious static route-level UI risks, but the release checks below must still
be rerun against the final production configuration:

`npm run launch:status` currently reports that 23 production values still require real data.
latest full local responsive browser QA did not complete cleanly after local Chromium/Next dev resource exhaustion; a focused dashboard desktop light/dark smoke passed after E2E harness hardening, and local accessibility QA passed 16/16 on the local stack, but full local and deployed production QA remain launch gates
because localhost cannot prove DNS, TLS, cookies, CORS, storage downloads, or
live provider integration.
The machine-readable launch evidence file must also pass all
81 machine-readable launch evidence checks, including the deployed accessibility
transcript in `browserQa.checks.accessibility-coverage`.

| Check | Result |
| --- | --- |
| TypeScript build (shared + API + web) | Must pass for the release ref |
| Lint | Must pass for the release ref |
| Unit tests (API, web, shared) | Must pass for the release ref |
| Production-tooling tests | Must pass for the release ref |
| Prisma schema validation | Must pass for the release ref |
| Secret scan + SAST scan | Must pass for the release ref |
| `npm audit` (production deps, moderate+) | Must show no moderate-or-higher production vulnerabilities |
| `npm ci` reproducible install | Must pass on the release build machine |
| Full app boots in Docker (db + API + web), migrates, seeds, serves | Must be proven for the release candidate |

The core security model is already in place: HTTP-only cookie auth,
hashed rotating refresh sessions, role guards, private document storage with
signed URLs, security headers + CSP, rate limiting, browser-origin protection,
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
- **Why:** Stores all governance data. Must have TLS (`sslmode=require`) and
  managed backups with point-in-time recovery.
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

- **TLS is now turnkey.** You no longer have to hand-configure certificates. The
  repo ships an optional reverse proxy (`compose.production-tls.yml` +
  `caddy/Caddyfile`) that obtains and renews HTTPS certificates automatically via
  Let's Encrypt. Once you have a server and DNS:
  1. Point DNS `A` records for `app.charitypilot.ie` **and** `api.charitypilot.ie` at
     your server's public IP; open ports 80 and 443.
  2. In `.env.production`, set `CADDY_ACME_EMAIL` (for Let's Encrypt) and
     `TRUSTED_PROXY_ADDRESSES` (so the API trusts the proxy's forwarded client IPs).
  3. Bring up the stack with the proxy overlay:
     ```bash
     npm run deploy:production -- --production-env-file=.env.production
     ```
  Caddy terminates HTTPS for both domains and proxies to the internal containers;
  certificates are issued and renewed with no further action. You still need the
  server and DNS, but the certificate/proxy complexity is handled for you. (If you
  use a managed load balancer or platform TLS instead, run the deploy command
  with `--no-tls-proxy` and keep equivalent TLS evidence in the launch ledger.)

### Step 5 - Fill in the real secrets
- **Start with one command** - it creates `.env.production` for you and
  auto-generates the random secrets you'd otherwise have to craft by hand
  (`JWT_SECRET`, `READINESS_API_KEY`), leaving clearly-marked placeholders for
  the values only you can provide:
  ```bash
  npm run setup:production-env
  ```
  It prints exactly which values you still need and where each comes from.
- **Then** open `.env.production` and replace each remaining `REPLACE_ME` with the
  real value from Steps 1-4. **Never commit this file** (it's already gitignored).
- **Then verify it** (these commands check your config without launching):
  ```bash
  npm run check:production -- --production-env-file=.env.production
  npm run check:production:providers -- --production-env-file=.env.production
  npm run check:production:supabase -- --production-env-file=.env.production
  npm run check:production:hosting -- --production-env-file=.env.production
  npm run check:production:database -- --production-env-file=.env.production --expect-operational-sentinel
  npm run check:production:observability -- --production-env-file=.env.production
  ```
- **Why:** These catch misconfiguration (wrong keys, public bucket, missing TLS)
  before real data is at risk.
- **Effort:** A couple of hours, iterating until all checks pass.

### Step 6 - Deploy
- **What:** Run migrations against the production DB, then deploy the signed images.
  ```bash
  npm run db:migrate:deploy -w @charitypilot/api
  npm run deploy:preflight -- --production-env-file=.env.production
  npm run deploy:production -- --production-env-file=.env.production
  ```
- **Why:** The preflight verifies signed, digest-pinned images and renders the
  compose file; the deploy brings the stack up and runs a public HTTPS smoke test
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
  machine-readable `production-launch-evidence.json`, with five named approvals:
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
