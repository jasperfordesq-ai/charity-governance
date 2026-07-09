# CharityPilot end-to-end tests

[Playwright](https://playwright.dev/) tests that drive a real Chromium browser
against the **local Docker stack** - no external providers. Document storage uses
the local filesystem driver, Stripe/Resend are unconfigured (test mode / no-op),
and one-time tokens are read or injected via the database rather than a mailbox.

This is a **standalone** project, deliberately **not** a workspace of the root
monorepo, so Playwright never enters the API/web production installs or images.

## What it covers

| Spec | Journey |
| --- | --- |
| `tests/auth.spec.ts` | register -> email-verify (real `/verify-email` flow) -> log in -> dashboard; plus an invalid-token case |
| `tests/compliance.spec.ts` | record a governance standard's status (auto-saved) -> board sign-off on the Export page |
| `tests/documents.spec.ts` | upload a document -> download it and verify the bytes |
| `tests/deadlines-team.spec.ts` | create a deadline -> mark it complete; team invite -> accept -> join the workspace |
| `tests/billing.spec.ts` | billing page renders tier + trial + Complete-plan feature gating (Stripe test mode) |
| `tests/tenant-isolation.spec.ts` | an unknown/foreign principle id renders a clean not-found, never leaked content |
| `tests/auth-session.spec.ts` | an unauthenticated visit to a protected route -> `/login?next=`; an expired/cleared session -> login |
| `tests/authz.spec.ts` | a MEMBER sees admin-only team controls disabled/hidden (affordance; the API enforces it too) |
| `tests/validation.spec.ts` | register blocks a long-but-weak password inline and sends no guaranteed-400 request |
| `tests/accessibility.spec.ts` | axe - 0 serious/critical WCAG 2.1 AA violations on every key page, light + dark |

## Prerequisites

1. **The local Docker stack must be running** (the tests do not start it):

   ```bash
   docker compose -f compose.yml -f compose.local.yml up
   ```

   This serves the web app on <http://localhost:3003>, the API on
   <http://localhost:3002>, and publishes Postgres on host port `5434`.

2. **Install the test dependencies and the browser** (once):

   ```bash
   npm run test:e2e:install     # from the repo root
   # equivalently: npm --prefix e2e install && npm --prefix e2e run install:browsers
   ```

## Running

```bash
npm run test:e2e               # from the repo root
# or, from this directory:
npm test                       # all specs
npm run test:ui                # Playwright UI mode
npm run report                 # open the last HTML report
npx playwright test tests/auth.spec.ts   # a single spec
```

The responsive route matrix can also be run in four focused chunks from the repo
root. Use these when a local browser host or deployed QA runner cannot keep the
full 52-test matrix stable in one process:

```bash
npm run test:e2e:responsive:public:desktop
npm run test:e2e:responsive:public:mobile
npm run test:e2e:responsive:dashboard:desktop
npm run test:e2e:responsive:dashboard:mobile
```

Keep all four transcripts together if they are used as launch browser-QA
evidence.

If Chromium fails before a page opens with `Invalid file descriptor to ICU data
received`, the local Playwright browser cache is incomplete or corrupted. Rebuild
it from the repo root:

```bash
npm --prefix e2e exec playwright -- install chromium
```

The expected cache should include `icudtl.dat` under the Playwright
`chromium_headless_shell-*` directory.

## How it stays deterministic

- **Single worker, serial.** The suite shares one database, so `playwright.config.ts`
  sets `workers: 1` and `fullyParallel: false`.
- **Reset at the start of every run.** `global-setup.ts` waits for the stack to be
  reachable, then truncates all tenant/app tables (preserving the seeded governance
  reference data - `GovernancePrinciple` / `GovernanceStandard`). See
  `helpers/db.ts` for the exact table list.
- **Unique data per test.** Emails, deadline titles and document names are suffixed
  with a timestamp so reruns never collide.
- **One shared owner.** Auth routes are rate-limited to 5 requests/min, so a single
  verified OWNER is registered once per worker (`owner` fixture) and reused via
  `storageState`; dashboard specs run as that owner.

> The reset truncates the seeded local-admin workspace (`admin@charitypilot.local`).
> Restarting the `api` container re-seeds it (`compose.local.yml` runs
> `prisma migrate deploy && db:seed` on boot).

## The database seams (why we touch Postgres)

Locally, email delivery is a no-op (`RESEND_API_KEY` is a placeholder) and the
verify/invite tokens are stored **sha256-hashed**, so the plaintext that a user
would click in an email is unrecoverable. The harness therefore:

- **Email verification** - injects a known token: sets `User.verifyToken =
  sha256(known)` and drives the real `/verify-email#token=<known>` page
  (`helpers/db.ts` -> `injectVerifyToken`).
- **Team invite** - sends a real invite via the UI, then overwrites that invite's
  hashed token with a known one (`setInviteToken`) and drives
  `/accept-invite#token=<known>`.
- **Reset / lookups** - `resetDb`, `getUserAndOrg`, `getPrincipleIdByNumber`, and
  read-back helpers for assertions.

Connection: `postgresql://charitypilot:charitypilot_dev@localhost:5434/charitypilot`
(override with `E2E_DATABASE_URL`).

## Environment overrides

| Variable | Default |
| --- | --- |
| `E2E_WEB_URL` | `http://localhost:3003` |
| `E2E_API_URL` | `http://localhost:3002` |
| `E2E_DATABASE_URL` | `postgresql://charitypilot:charitypilot_dev@localhost:5434/charitypilot` |
| `E2E_ARTIFACT_DIR` | OS temp directory (`charitypilot-e2e-artifacts`) |
| `CHARITYPILOT_LOCAL_WEB_NODE_OPTIONS` | `--max-old-space-size=6144` for the local Docker web container |

By default local Playwright screenshots, traces, videos, and HTML reports are
written outside the repository so Next.js dev does not watch the artifacts and
recompile routes during browser QA. CI sets `E2E_ARTIFACT_DIR=playwright-artifacts`
and uploads `e2e/playwright-artifacts/html-report`.

The local Docker web container gives Next.js dev enough heap for cold route
compiles during responsive and accessibility QA. Keep the default unless the host
has materially less memory; lowering it can make local browser QA restart the dev
server mid-test.

## Deployed browser QA mode

The default suite is local and intentionally uses database seams for reset, token
injection, and assertions. For deployed HTTPS browser QA, set
`E2E_DEPLOYED_QA=true` and run only the browser-rendering/accessibility suites
against an approved non-sensitive test workspace.

In deployed browser QA mode the harness:

- does not reset the database;
- does not warm routes for local Next.js dev compilation;
- logs in with `E2E_OWNER_EMAIL` and `E2E_OWNER_PASSWORD`;
- fails closed if any test tries to use the local direct-Postgres helpers.

Example:

```bash
E2E_DEPLOYED_QA=true \
E2E_WEB_URL=https://app.charitypilot.ie \
E2E_API_URL=https://api.charitypilot.ie \
E2E_OWNER_EMAIL=SECRET_STORE_E2E_OWNER_EMAIL \
E2E_OWNER_PASSWORD=SECRET_STORE_E2E_OWNER_PASSWORD \
npm run test:e2e:responsive
```

Use the same environment for `npm run test:e2e -- tests/accessibility.spec.ts`.
If the deployed responsive matrix needs chunking, run the same four
`test:e2e:responsive:*` commands with the deployed environment variables above
and keep the four transcripts together as one browser-QA evidence set.

Example focused deployed chunks:

```bash
E2E_DEPLOYED_QA=true \
E2E_WEB_URL=https://app.charitypilot.ie \
E2E_API_URL=https://api.charitypilot.ie \
E2E_OWNER_EMAIL=SECRET_STORE_E2E_OWNER_EMAIL \
E2E_OWNER_PASSWORD=SECRET_STORE_E2E_OWNER_PASSWORD \
npm run test:e2e:responsive:public:desktop

E2E_DEPLOYED_QA=true \
E2E_WEB_URL=https://app.charitypilot.ie \
E2E_API_URL=https://api.charitypilot.ie \
E2E_OWNER_EMAIL=SECRET_STORE_E2E_OWNER_EMAIL \
E2E_OWNER_PASSWORD=SECRET_STORE_E2E_OWNER_PASSWORD \
npm run test:e2e:responsive:public:mobile

E2E_DEPLOYED_QA=true \
E2E_WEB_URL=https://app.charitypilot.ie \
E2E_API_URL=https://api.charitypilot.ie \
E2E_OWNER_EMAIL=SECRET_STORE_E2E_OWNER_EMAIL \
E2E_OWNER_PASSWORD=SECRET_STORE_E2E_OWNER_PASSWORD \
npm run test:e2e:responsive:dashboard:desktop

E2E_DEPLOYED_QA=true \
E2E_WEB_URL=https://app.charitypilot.ie \
E2E_API_URL=https://api.charitypilot.ie \
E2E_OWNER_EMAIL=SECRET_STORE_E2E_OWNER_EMAIL \
E2E_OWNER_PASSWORD=SECRET_STORE_E2E_OWNER_PASSWORD \
npm run test:e2e:responsive:dashboard:mobile
```

For cross-browser launch evidence on a runner with the required browsers
installed, use:

```bash
E2E_DEPLOYED_QA=true \
E2E_WEB_URL=https://app.charitypilot.ie \
E2E_API_URL=https://api.charitypilot.ie \
E2E_OWNER_EMAIL=SECRET_STORE_E2E_OWNER_EMAIL \
E2E_OWNER_PASSWORD=SECRET_STORE_E2E_OWNER_PASSWORD \
npm run test:e2e:deployed:responsive:cross-browser

E2E_DEPLOYED_QA=true \
E2E_WEB_URL=https://app.charitypilot.ie \
E2E_API_URL=https://api.charitypilot.ie \
E2E_OWNER_EMAIL=SECRET_STORE_E2E_OWNER_EMAIL \
E2E_OWNER_PASSWORD=SECRET_STORE_E2E_OWNER_PASSWORD \
npm run test:e2e:deployed:accessibility:cross-browser
```

Those commands run the deployed-safe rendering/accessibility specs through
Desktop Chrome, mobile Chromium/Android Chrome emulation, Desktop Firefox, and
Desktop WebKit. Keep manual or cloud-device evidence for real iOS Safari where
the launch checklist requires it.
Do not run the full local deterministic suite in deployed QA mode; specs that
exercise registration, token injection, invites, document mutation, or DB
assertions remain local-stack tests unless a dedicated production-safe variant is
written.

## A note on the Next.js dev hydration race

Under the dev server, a `type=submit` click can land before React hydrates,
producing a native GET submit (no API call). The auth helpers (`fixtures.ts`)
guard against this: `reliableFill` re-fills controlled HeroUI inputs until the
value sticks, and `fillAndSubmit` retries the submit until the expected
navigation occurs. Native GET retries don't consume the auth rate limit.

## CI

`.github/workflows/e2e.yml` boots the Docker stack, installs the browser, runs
the suite, and uploads the HTML report as an artifact. It runs on
`workflow_dispatch` and on pull requests that touch the apps or the suite.
