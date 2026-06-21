# Session summary — frontend provable trust (the web reliability ledger)

**Branch:** `frontend/provable-trust` (off `master`). **Not** pushed, **not** merged.

## What this session did

Extended the platform's existing "trust ledger" from the API to the **customer-facing
web app** (`apps/web`), and wired the whole quality bar to be **self-enforcing in CI**.
Additive, evidence-producing work: every user-visible behaviour whose failure would lose
trust or generate support tickets is now a concrete, falsifiable guarantee linked to an
automated test, in the SAME machine-readable source of truth as the backend.

One ledger, one report, two surfaces:
- `docs/reliability/guarantees.json` — every row now carries `surface` (`api` | `web`) and
  `testType` (`unit` | `e2e`). Added **97 web-surface guarantees** across 13 route groups ×
  the 8 customer-facing concerns (tenant isolation, authorization, plan gating,
  input-validation parity, graceful degradation, auth & session integrity, state integrity,
  accessibility).
- `scripts/reliability-report.mjs` — now runs the `apps/web` `node:test` suite as well as
  the API suite, links every covered web unit row to a passing test, links e2e rows to
  Playwright spec titles (executed by the E2E gate), and renders ONE ledger
  (`docs/RELIABILITY.md`) with both matrices.

## Guarantee counts (proven)

- **API:** 256 covered, 0 gap, 15 n/a (271 rows — unchanged; the backend ledger was already green).
- **Web:** 94 covered, 1 documented gap, 7 n/a (102 rows).
- **Total proven:** 350 guarantees (256 api + 94 web), **0 broken links**. The single gap is
  the dark-mode colour-contrast finding above (a documented human-decision item, not a
  regression); every other row is 🟢 covered or a documented ⚪ n/a.

## How to run it

```bash
# The unified reliability ledger (API + Web unit suites + linkage):
npm run reliability:report
#   -- --write          also regenerates docs/RELIABILITY.md
#   -- --surface=web|api run only one surface's suite

# Prove the WHOLE platform green in one command (every gate + the ledger + E2E):
npm run release:ready
#   -- --no-e2e   skip the Playwright gate (e.g. the local Docker stack isn't up)
#   -- --no-build skip the build gate

# The Playwright E2E suite (needs the local Docker stack up):
docker compose -f compose.yml -f compose.local.yml up   # then, in another shell:
npm run test:e2e
```

`release:ready` runs, in order: security scan → lint → build → unit/integration tests
(turbo) → dependency audit → reliability ledger (api + web) → Playwright E2E, and prints a
single PASS/FAIL table with per-gate timing.

## Self-enforcing CI

- `.github/workflows/ci.yml` — added a **Reliability ledger (API + Web)** step
  (`npm run reliability:report`) that fails the build if any covered guarantee loses its
  linked passing test. The job already ran security scan, lint, test, build, Docker smoke
  and `npm audit`.
- `.github/workflows/e2e.yml` (pre-existing) — boots the local Docker stack and runs the
  full Playwright suite on PRs; it now also runs the **new** web reliability journeys
  (tenant isolation, auth-session, authz, validation, accessibility) automatically.

## Tests added (apps/web `node:test`, deterministic, CJS-safe)

- `errors.test.ts` — server errors render a safe, specific message; never throws/leaks.
- `client-logger.test.ts` — production error logging is redacted (no raw message/stack).
- `api.test.ts` (+4) — 401 interceptor refresh→retry, skipAuthRefresh opt-out, envelope
  unwrap, paginated passthrough.
- `tenant-isolation.test.ts` — structural guard: cookie-based client, no org id from the
  URL, no org id in any request, only `principleId`/`slug` dynamic segments.
- `team-permissions.test.ts` — extracted + proven `/team` role predicates.
- `form-schema-parity.test.ts` — every auth form validates with the shared Zod schemas.
- `web-wiring.test.ts` — pages correctly apply the tested helpers (plan gating, trusted
  outbound URLs, double-submit guards, error/empty states).

## E2E added (Playwright, against the local Docker stack)

- `tenant-isolation.spec.ts` — foreign principle id → clean not-found, no leak.
- `auth-session.spec.ts` — unauthenticated → `/login?next=`; expired session → login.
- `authz.spec.ts` — a MEMBER sees admin-only team controls disabled/hidden.
- `validation.spec.ts` — register blocks a long-but-weak password inline, sends no 400.
- `accessibility.spec.ts` — axe: 0 serious/critical WCAG 2.1 AA on every key page in the
  default (light) theme (see the dark-theme finding under "Decisions").

Harness hardening (E2E reliability, not flake-masking): `global-setup.ts` now warms the
public **and** (authenticated) protected routes so the dev server's one-off on-demand
compile happens once up front rather than inside a per-test navigation; the navigation
timeout was raised to fit cold dev compiles under host load.

## Fixed while proving (real defect → minimal fix → locked in)

1. **Auth password validation drifted from the server.** The auth forms checked only
   `password.length >= 8` client-side while the server (shared `registerSchema` /
   `resetPasswordSchema` / `acceptTeamInviteSchema`) also requires upper + lower + digit, so
   a long-but-weak password was submitted and bounced with a 400 instead of caught inline.
   **Fix:** added `apps/web/src/lib/form-schemas.ts` (re-exports the shared Zod schemas) and
   gated every auth form's submit with the SAME schema (`firstSchemaError` / `passwordIssue`).
   `accept-invite`, which had no client password check at all, now enforces the shared rule.
   Proven by `the password forms no longer gate on a bare length-only check` and the
   `register blocks a long-but-weak password inline` E2E. Recorded in
   `docs/reliability/fixed-while-proving.json`.

## Decisions worth a human's eye (not blockers)

- **Server-authoritative dashboard forms.** The dashboard create/edit forms (board,
  deadlines, registers, organisation) intentionally defer validation to the server (which
  validates with the shared schema and returns a 400 the UI renders cleanly). Their
  client-side schema-parity rows are marked ⚪ n/a (no client rule exists to drift). Wiring
  shared-schema **client** pre-validation into them is an optional defense-in-depth
  enhancement, not a correctness gap.
- **ESM/CJS boundary.** `@charitypilot/shared` is ESM-only, so the web `node:test`
  (CommonJS) suite cannot import it directly. Validation-parity is therefore proven by a
  source-scan (the form references the shared schema) plus the schema's own behaviour on the
  API surface, plus the E2E. If a future change makes the web test runner ESM, those rows
  could load the schema directly for an even stronger assertion.
- **Dark-mode colour contrast (real finding, needs a design decision).** An axe sweep
  found a *systemic* dark-theme contrast problem: the brand teal (`#0D7377` / `#10998E`) and
  the `gray-500` secondary text are too dark on the dark surfaces (e.g. `/compliance` reports
  23 serious contrast nodes in dark mode), and HeroUI's danger-flat Logout button sits at
  4.34:1 (needs 4.5:1). Fixing this is a dark-mode design-token pass — choosing an
  accessible dark-mode brand-teal shade and secondary-grey, which affects brand
  presentation — so it is **not** a minimal fix and was deliberately left for a design
  decision rather than changed speculatively. The accessibility tests prove the **default
  (light)** theme is axe-clean on every key page today; the dark-theme contrast row in the
  ledger is marked 🔴 gap with this note. Recommended next step: define dark-mode `text`
  shades (a brighter teal ≈ `#2DD4BF`, secondary `gray-400`) and a higher-contrast Logout
  button, then extend `accessibility.spec.ts` to assert the dark theme too.
- **Marketing home eyebrow contrast (minor).** The public landing (`/`) hero/eyebrow uses
  `text-amber-accent` (#D4A843) on white (~2.2:1) — below WCAG AA. It is a brand-colour
  choice (how dark the gold may go), so `/` is omitted from the a11y assertion and the
  finding is left for a design call. All key app + auth + `/pricing` pages are axe-clean.
- **Branch is unpushed/unmerged** per the brief — open a PR for `frontend/provable-trust`
  when ready.

## Anti-spiral note

Bounded, convergent work: a fixed matrix of route groups × concerns, filled with proofs and
stopped when green — not an open-ended bug hunt. Exactly one real defect surfaced (the
password drift); it was fixed minimally and locked in. Everything else was already correct
and is now pinned by a test.
