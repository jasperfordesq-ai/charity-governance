# CharityPilot end-to-end tests

[Playwright](https://playwright.dev/) tests that drive a real Chromium browser
against a **runner-owned isolated Docker stack** - no external providers and no
connection to the persistent personal-development database. PostgreSQL data and
document bytes live in container tmpfs; one-time tokens use a guarded disposable
database role rather than a mailbox.

This is a **standalone** project, deliberately **not** a workspace of the root
monorepo, so Playwright never enters the API/web production installs or images.

## What it covers

| Spec | Journey |
| --- | --- |
| `tests/auth.spec.ts` | register -> email-verify (real `/verify-email` flow) -> log in -> dashboard; forgot-password -> reset-password -> log in with the new password; plus invalid verification/reset-token cases |
| `tests/compliance.spec.ts` | record a governance standard's status (auto-saved) -> board sign-off on the Export page; pending standard edits trigger the in-app navigation confirmation |
| `tests/conditional-obligations.spec.ts` | save organisation conditional triggers -> verify profile-triggered Documents, Deadlines, and Regulator prompts appear |
| `tests/documents.spec.ts` | upload a document -> download it and verify the bytes |
| `tests/dashboard-navigation.spec.ts` | mobile dashboard sidebar opens, moves focus into navigation, closes with Escape, restores focus, and removes closed links from tab order |
| `tests/deadlines-team.spec.ts` | create a deadline -> mark it complete; team invite -> accept -> join the workspace |
| `tests/billing.spec.ts` | billing page renders tier + trial + Complete-plan feature gating (Stripe test mode) |
| `tests/tenant-isolation.spec.ts` | an unknown/foreign principle id renders a clean not-found, never leaked content |
| `tests/auth-session.spec.ts` | an unauthenticated visit to a protected route -> `/login?next=`; an expired/cleared session -> login |
| `tests/authz.spec.ts` | a MEMBER gets read-only governance routes without privileged mutation affordances; a live Admin demotion fails closed in place |
| `tests/validation.spec.ts` | register blocks a long-but-weak password inline and sends no guaranteed-400 request |
| `tests/accessibility.spec.ts` | axe - 0 serious/critical WCAG 2.1 AA violations on every key page, light + dark |

## Prerequisites

1. **Docker must be available.** Do not start or layer the personal local stack;
   `scripts/run-isolated-e2e.mjs` owns standalone `compose.e2e.yml` from boot
   through project-scoped teardown.

2. **Install the test dependencies and the browser** (once):

   ```bash
   npm run test:e2e:install     # from the repo root
   # equivalently: npm --prefix e2e install && npm --prefix e2e run install:browsers
   ```

## Running

```bash
npm run test:e2e                              # all specs, from the repo root
npm run test:e2e -- tests/auth.spec.ts        # a single spec
npm run test:e2e:isolated:validate            # static validation; starts nothing
```

The retired boolean reset flag never grants reset authority. Local destructive
tests require the managed runner's generated UUID, exact loopback identity,
protected marker, restricted role and API binding proof. Direct Playwright from
this directory is not a supported destructive entry point.

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

The shared navigation helper fails protected-route resolution with explicit
diagnostics for HTTP 500 responses, Next.js/runtime overlays, unexpected login
redirects, and browser JavaScript `pageerror` events. Treat those as real route
readiness failures to investigate, not as missing-selector flakes.

If Chromium fails before a page opens with `Invalid file descriptor to ICU data
received`, the local Playwright browser cache is incomplete or corrupted. Rebuild
it from the repo root:

```bash
npm --prefix e2e exec playwright -- install chromium
```

The expected cache should include `icudtl.dat` under the Playwright
`chromium_headless_shell-*` directory.

## How it stays deterministic

- **Single worker, serial.** The suite shares one database and owner fixture, so
  `playwright.config.ts` sets `workers: 1` and `fullyParallel: false`.
- **Reset only after layered proof.** `global-setup.ts` proves the direct
  connection identity and restricted role, proves that the API is bound to the
  same per-run marker, then resets only after an exact live table inventory and
  per-table access-exclusive locks. The transaction rejects `ON TRUNCATE`
  triggers and truncate-publishing logical publications, re-proves identity as
  its final query, and uses `ONLY ... CONTINUE IDENTITY RESTRICT` without
  `CASCADE`; the API binding is checked again before browser work.
- **No personal persistence.** The standalone stack uses dedicated loopback
  ports (`55434`, `3302`, `3303`) and a runner-generated positive allow-list
  build context. The source Compose bytes are read once, validated, and written
  to a private `0600` runner snapshot; config, build, startup, logs, and teardown
  all use that same snapshot with the repository project directory fixed. The
  exact migration DSN and normalized Compose model are validated before startup;
  the daemon and integrated builder are locally proven and pinned;
  dependencies and the optimized Next.js build are baked into runner-scoped
  images; database and document writes stay in tmpfs, while web serves the
  immutable build from its read-only image with only `/tmp` writable. Compose
  declares no persistent volume or host mount. PostgreSQL, API, and web attach
  only to the internal `e2e` bridge and
  receive distinct `db`, `api`, and `web` aliases under the reserved
  `charitypilot-e2e.invalid` namespace. A
  dedicated non-root, read-only gateway image contains only the audited
  dependency-free TCP proxy; it receives no environment or secret, is the sole
  member of the project-scoped non-attachable `edge` bridge, and is the only
  service allowed to publish loopback ports. Its fixed routes use absolute
  trailing-dot names so a missing internal record cannot fall through a DNS
  search path. A no-handshake healthcheck proves all three gateway listeners
  from `/proc/net/tcp`. Web reuses the one app image built by API so Compose
  never races two exports to the same image tag. After build/start and before
  Playwright, the runner captures immutable image IDs and attests exactly one
  healthy project container per service, including labels, image IDs, networks,
  port bindings, tmpfs, mounts, user, read-only root, capabilities, and
  no-new-privileges settings.
- **Unique data per test.** Emails, deadline titles and document names are suffixed
  with a timestamp so reruns never collide.
- **One shared owner.** Auth routes are rate-limited to 5 requests/min, so a single
  verified OWNER is registered once per worker (`owner` fixture) and reused via
  `storageState`; dashboard specs run as that owner.

The isolated API sets `SEED_LOCAL_ADMIN=false`; tests create unique users and
organisations. The persistent personal local-admin workspace is never mounted or
addressed.

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

There is no committed DSN or password. The runner generates URL-safe bootstrap,
runner, JWT and readiness credentials plus a fresh UUID, stores them in a private
temporary env file, and removes it after successful verified teardown. If
teardown or residue verification fails, the run is red and retains the private
recovery inputs instead of hiding the cleanup problem.

## Managed local environment

Local URLs and identity are fixed by the runner: web
`http://127.0.0.1:3303`, API `http://127.0.0.1:3302`, and the reserved disposable
PostgreSQL target on `127.0.0.1:55434`. Ambient DSNs, generated credential names,
reset confirmations, instance IDs, Docker contexts, TLS endpoints, Buildx
builders, and BuildKit hosts are rejected. Every build, startup, log, teardown,
and residue command uses the same proven local daemon endpoint and private
Compose snapshot. `npm run test:e2e` first runs the pure isolation contract
suite, before the runner can call Docker. The web image is compiled once during
the controlled build, and its healthcheck requires an HTTP-success response
from that baked production runtime. The runner then allows up to ten minutes
for the first host-side web response. Teardown
and exact residue checks have long bounds for Docker Desktop image removal, and
`release:ready` gives the inner runner a separate cleanup margin.
`E2E_ARTIFACT_DIR` may select an artifact directory; it grants no database
authority.

By default local Playwright screenshots, traces, videos, and HTML reports are
written outside the repository so failure artifacts cannot dirty or enter the
runner's source allow-list. CI sets
`E2E_ARTIFACT_DIR=playwright-artifacts` and uploads
`e2e/playwright-artifacts/html-report`.

The local Docker web service runs the same optimized Next.js server shape as a
release, not `next dev`. Route compilation therefore fails during the bounded
image build instead of stalling an individual browser test.

## Exceptional remote-disposable mode

Remote-destructive execution is supported only from Linux or WSL. Native
Windows is rejected before remote preflight because Node does not provide the
Job Object-backed lifetime proof needed to rule out a detached descendant after
its group leader exits. Local-disposable E2E remains supported on native
Windows, and deployed QA remains non-destructive.

Remote destructive E2E is never selected by CI, `release:ready`, deployed QA or
the managed local runner. An operator may select `E2E_EXECUTION_MODE=remote-disposable`
only for separately provisioned test infrastructure whose non-privileged runner
is not the database or marker owner, has no role memberships, cannot mutate the
protected marker, and uses the same reserved database, schema, application name,
comment and UUID marker as local isolation. The local stack additionally makes
its separate one-time bootstrap owner `NOLOGIN`; a remote provider's distinct
owner is not required to share that local bootstrap implementation detail.
The database endpoint must be direct or session-affine: transaction/statement
poolers are unsupported because the suite lease relies on PostgreSQL session
advisory-lock semantics.

The fail-closed contract additionally requires:

- the deliberate `E2E_REMOTE_DATABASE_RESET_OVERRIDE` confirmation value from
  `helpers/database-safety.cjs`;
- a safe-labelled non-production database host and API/web HTTPS origins;
- `sslmode=verify-full`, an explicit connected-server IP, and a fresh UUID;
- high-entropy readiness/JWT secrets and a narrow safe-labelled
  `E2E_AUTH_COOKIE_DOMAIN` covering only the remote test web/API origins;
- direct connected-role/marker proof followed by the keyed API binding canary,
  both before Playwright; and
- one physical connection holding a suite-wide advisory lease before reset;
  every remote direct-database helper proves that lease is active, while the
  reset primitive proves that its own session owns the lease before `BEGIN`;
  and
- a bounded parent-runner janitor after the Playwright process group is proven
  absent. It opens a fresh connection, re-proves identity, reacquires the lease,
  rechecks API binding, resets, verifies binding again, releases, and
  disconnects. If process-group absence cannot be proven, the janitor is skipped
  and the run fails red with manual-recovery guidance.

The exported `resetDb()` path is local-only. Remote destructive reset is
available only through the acquired suite-lease handle. Guarded worker
read/create/token seams remain available to the remote test harness only while
the target database reports that exact suite lease active.

Canonical production hosts, production-like labels, shared/personal/default
targets, privileged roles, ambient application-DSN collisions and any CI or
managed automation context are rejected. The runner redacts the DSN and all
runtime credentials. Do not weaken these checks to make a remote environment
fit; provision an isolated disposable target instead.

## Deployed browser QA mode

The default suite is local and intentionally uses database seams for reset, token
injection, and assertions. For deployed HTTPS browser QA, set
`E2E_DEPLOYED_QA=true` and run only the browser-rendering/accessibility suites
against an approved non-sensitive test workspace.

In deployed browser QA mode the harness:

- does not reset the database;
- does not run the local public-route readiness sweep;
- logs in with `E2E_OWNER_EMAIL` and `E2E_OWNER_PASSWORD`;
- fails closed if any test tries to use the local direct-Postgres helpers.

Run the redacted environment preflight from the repo root before starting
deployed Playwright checks. It validates `E2E_DEPLOYED_QA=true`, canonical HTTPS
web/API origins, and credential presence without printing the credential values:

```bash
E2E_DEPLOYED_QA=true \
E2E_WEB_URL=https://app.charitypilot.ie \
E2E_API_URL=https://api.charitypilot.ie \
E2E_OWNER_EMAIL=SECRET_STORE_E2E_OWNER_EMAIL \
E2E_OWNER_PASSWORD=SECRET_STORE_E2E_OWNER_PASSWORD \
npm run check:production:browser-qa-env
```

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

## Form hydration proof

A browser can interact with server-rendered form controls before React has
attached their controlled-state handlers. The auth helpers (`fixtures.ts`)
therefore make hydration observable: `reliableFill` confirms that each HeroUI
value remains set, and `fillAndSubmit` requires the expected API response and
navigation. A native GET submit is never accepted as a passing form journey.

## CI

`.github/workflows/e2e.yml` validates and invokes the same managed runner, then
uploads the HTML report and failure artifacts. It runs on `workflow_dispatch`,
relevant pull requests and direct pushes to `master`. CI supplies no DSN,
database password, UUID or reset confirmation; the runner creates them per run.
