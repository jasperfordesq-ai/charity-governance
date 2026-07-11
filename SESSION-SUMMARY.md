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
- **Web:** 95 covered, 0 gap, 7 n/a (102 rows).
- **Total proven:** 351 guarantees (256 api + 95 web), **0 gaps, 0 broken links**. Every row is
  🟢 covered or a documented ⚪ n/a.

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
- `authz.spec.ts` — a MEMBER gets read-only governance routes without privileged mutation affordances; a live Admin demotion fails closed in place.
- `validation.spec.ts` — register blocks a long-but-weak password inline, sends no 400.
- `accessibility.spec.ts` — axe: 0 serious/critical WCAG 2.1 AA on every key page in BOTH
  the light and dark themes (uses bounded retries + `reducedMotion` to absorb dev-server
  navigation jitter under host load; the contrast results themselves are deterministic).

Harness hardening (E2E reliability, not flake-masking): `global-setup.ts` warms the public
routes so the dev server's one-off on-demand compile happens once up front rather than
inside a per-test navigation, and the navigation timeout was raised to fit cold dev compiles
under host load. The axe suite additionally requests reduced motion and uses bounded retries
so framer-motion fade-ins and dev-server jitter don't flake the (deterministic) scan.

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
2. **WCAG 2.1 AA colour contrast (light + dark).** The axe sweep surfaced real contrast
   failures across the dashboard and marketing pages — `text-gray-400` muted text on white
   (~2.6:1), the brand teal as dark-mode text (3.1–4.47:1), `gray-500` on the dark surface
   (3.66:1), `text-amber-600` on white (3.19:1), the HeroUI danger-flat Logout label (4.34–
   4.4:1), a HeroUI flat warning Chip (4.34:1), HeroUI form labels (4.39:1), the marketing
   footer (3.66:1) and the home amber eyebrow (2.2:1). **Fix:** dashboard-scoped + dark text
   overrides in `globals.css` (gray, teal, label), accessible brand shades
   (`--color-teal-bright`, `--color-amber-deep`), and targeted darkening of the Logout label,
   amber text and the warning Chip. Backgrounds and the brand identity are untouched. Now
   axe-clean (0 serious/critical) on every key page in both themes; recorded in
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
- **Brand palette nudged for accessible contrast (FYI, not a blocker).** Closing the
  dark-mode + marketing contrast gaps required small, accessibility-driven colour choices
  you may want a designer to bless: a dark-mode text teal `#14B8A6` (the brand `#0D7377` is
  too dark on dark surfaces), a darker gold `#8A6914` for the home eyebrow, gray-500 (not
  gray-400) for muted dashboard text in light mode, and a brighter dark-mode Logout label.
  All keep the brand identity; none change a background. See "Fixed while proving".
- **Branch is unpushed/unmerged** per the brief — open a PR for `frontend/provable-trust`
  when ready.

## Anti-spiral note

Bounded, convergent work: a fixed matrix of route groups × concerns, filled with proofs and
stopped when green — not an open-ended bug hunt. The defects that surfaced (the password
drift and the WCAG colour-contrast failures) were fixed minimally and locked in by tests;
everything else was already correct and is now pinned by a test.
