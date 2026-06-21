# Frontend reliability goal — extending the trust ledger to the customer-facing app

This file holds a ready-to-run, all-day autonomous brief. Paste the fenced `GOAL`
block below as the prompt for a fresh autonomous session (or a scheduled /
background run) when you want to prove the **web app's** reliability and make the
whole platform's quality bar self-enforcing in CI.

It is the sequel to [`RELIABILITY-GOAL.md`](RELIABILITY-GOAL.md): that brief proved
the **API**; this one proves the **frontend customers actually touch**, then locks
every gate into CI so the green state can't silently regress.

## Why this is the right next day (and not an audit)

The backend is proven — see [`RELIABILITY.md`](RELIABILITY.md) (256 guarantees, 0
gaps, 382 unit tests). The architecture and dependencies are documented. What sits
between "code-complete" and "shippable" is the **customer-facing web app** — its
forms, plan-gated UI, error/empty/loading states, session handling, and
**accessibility** (a first-class requirement for a charity-sector product) — plus
the fact that today's gates are *runnable* but not yet *enforced* on every push.

Same discipline as before: this is **evidence, not an audit**. An audit is
unbounded and always "finds something"; a ledger asks the bounded question — *is
every reliability-critical, user-visible behaviour pinned by a test that is green?*
When the matrix is full, you are done. Do not review for problems; build proof of
correctness, lock it in, and stop. (See `RELIABILITY-GOAL.md` for the longer
why-this-is-not-an-audit argument — it applies verbatim.)

## Considered and deprioritised

- **Performance budgets** — no evidence of a perf problem; speculative.
- **More E2E happy-paths** — the method prefers fast integration tests; E2E is added
  only for the highest-value flows.
- **CI-only** — high-leverage but not a full day on its own, so it is folded in as
  the closing phase (Phase 5) rather than a standalone goal.

## The brief

```
GOAL: Make CharityPilot's CUSTOMER-FACING web app (apps/web) provably reliable and
regression-proof, and make the platform's entire quality bar SELF-ENFORCING in CI.
Extend the existing "trust ledger" to the frontend: take the user-visible behaviours
that — if they broke — would lose trust or generate support tickets, and turn them into
automated tests + checks that prove they work today and keep working. Then wire every
gate (backend reliability ledger included) into CI so the green state is enforced on
every push, not just runnable locally. This is additive, evidence-producing work — NOT
a bug hunt and NOT new features.

WHY THIS IS NOT AN AUDIT (hold this line all day): an adversarial audit is unbounded and
always "finds something" — that's a property of the method, not proof the app is broken.
Trust = EVIDENCE: tests that encode "this must always work", and CI that catches
regressions first. That work is finite and convergent — you finish it, it stays
finished. Do NOT review for problems. Build proof of correctness, lock it in, STOP when
the ledger is full.

GROUND TRUTH (do not relitigate, do not re-verify):
- The code gate is DONE and green (npm run lint, npm run build, npx turbo test,
  npm audit, Docker smoke). The BACKEND reliability ledger is COMPLETE and green:
  docs/RELIABILITY.md + docs/reliability/guarantees.json (256 guarantees proven, 0 gaps),
  scripts/reliability-report.mjs, 382 API unit tests. Assume backend correctness; only a
  TEST YOU WRITE may prove otherwise.
- Foundation to build ON: docs/ARCHITECTURE.md (system map, incl. 09-frontend.md),
  e2e/ (Playwright, 5 passing happy-path journeys), and apps/web/src/lib/*.test.ts
  (proxy, plan-feature, protected-routes, content-security-policy, chunk-load-recovery,
  url-security, safe-next-path). CREDIT these first; do not redo them.
- Stack: apps/web = Next 16 (React 19, HeroUI, App Router) behind a same-origin
  auth/CSP proxy (proxy.ts) to apps/api. Client validates with the SAME @charitypilot/
  shared Zod schemas as the server. Plan/role gating mirrors the API
  (ESSENTIALS/COMPLETE, OWNER/ADMIN/MEMBER). Local stack:
  docker compose -f compose.yml -f compose.local.yml up
- DO NOT touch the launch gate: no secrets, no .env.production, no deploy, no external
  accounts/domains. Stay in code + tests + docs + local Docker.

WORK ON BRANCH `frontend/provable-trust`. Keep the gate green at EVERY commit. Commit
incrementally. Do not push or merge unless explicitly asked.

THE FRONTEND TRUST CONCERNS (the customer-facing mirror of the backend ledger):
1. Tenant isolation (UI) — the app never renders another org's data; org context comes
   from the session, never a URL param a user can edit; navigating to a foreign resource
   id yields a clean not-found, never another org's content.
2. Authorization (UI) — a MEMBER never sees or can trigger admin-only actions (write
   controls hidden/disabled AND the action blocked by the API path); OWNER-only billing
   UI is gated. Prove both the affordance AND the enforcement.
3. Plan gating (UI) — ESSENTIALS users see COMPLETE-only features as locked/upsell, not
   broken; plan-feature.ts gating is correctly applied on every gated page.
4. Input validation parity — client forms use the SAME shared Zod schemas as the server
   (prove no drift); invalid input shows inline errors and never submits a guaranteed-400
   payload; a server 400 renders a safe, specific message (never a raw error/stack).
5. Graceful degradation — when the API returns 503 (Stripe/Supabase/Resend down) or any
   error, the UI shows a clean error/empty state — never a blank screen, infinite
   spinner, or unhandled exception. Includes chunk-load recovery and the offline path.
6. Auth & session integrity — single-flight session refresh works; an expired session
   redirects to login without a crash or data flash; protected routes redirect
   unauthenticated users; the proxy/CSP behaves.
7. State integrity / no accidental data loss — failed mutations roll the UI back to a
   correct state; loading/disabled states prevent double-submit; destructive actions
   confirm. No silent data loss on error.
8. Accessibility & resilience — WCAG 2.1 AA baseline: axe-clean on every key page,
   keyboard reachability + visible focus, semantic landmarks/labels, sufficient colour
   contrast in BOTH light and dark themes, and no layout break in error/empty/loading
   states. (A11y is a first-class requirement for a charity-sector product.)

METHOD — extend the existing ledger, then fill it:
Phase 0 — Frontend ledger: enumerate the reliability surface as a FIXED matrix — every
web route group (the (dashboard)/* and auth pages: organisation, compliance, board,
documents, deadlines, dashboard, registers, team, export, billing/pricing, login/
register/reset/verify) × the 8 concerns above — into the SAME machine-readable source of
truth. Add a `surface: "web"` field to docs/reliability/guarantees.json (backend rows get
`surface: "api"`) so ONE ledger and ONE report cover both. Credit the existing web lib
tests + 5 E2E journeys. Mark each row covered / gap. DoD: every web route group × every
applicable concern is a concrete, falsifiable checklist item. This bounds the work.

Phase 1 — Tenant isolation + AuthZ + plan gating in the UI. Prefer fast component/
integration tests over the browser where possible; add E2E for the highest-value flows.
DoD: every gated page proves (a) the control is hidden/disabled for the wrong role/plan
AND (b) the action is blocked end-to-end; every resource page proves a foreign/edited id
does not leak data.

Phase 2 — Input-validation parity + graceful degradation. DoD: each form proves it
shares the server's Zod schema and surfaces inline errors; each data view has a proven
error state and empty state; the 503/degraded-provider path renders cleanly (no blank
screen / infinite spinner).

Phase 3 — Auth/session integrity + state integrity. DoD: refresh, expiry-redirect, and
protected-route redirect each have a proving test; each destructive/critical mutation
proves no-double-submit and correct rollback on failure.

Phase 4 — Accessibility baseline. DoD: every key page is axe-clean (0 serious/critical
violations) in both themes via @axe-core/playwright; keyboard-only navigation reaches
every interactive control with visible focus on the primary journeys.

Phase 5 — Make the ledger SELF-ENFORCING in CI. Wire ALL gates into
.github/workflows/ci.yml: lint, build, turbo test, npm audit --omit=dev, the unified
reliability:report (api + web), the Playwright E2E suite against the local Docker stack,
and the security scan. Add one `npm run release:ready` that runs every gate and prints a
single PASS/FAIL with counts. Link every new ledger row to its proving test and
regenerate docs/RELIABILITY.md. DoD: a single command proves the whole platform green,
and CI fails the build if any gate or any covered guarantee regresses.

ANTI-SPIRAL RULES (the entire point — hold these hard):
- You are PROVING correctness, not hunting bugs. Default assumption: the behaviour is
  correct; your job is to lock it in with a test.
- If a test reveals a REAL defect: write the failing test, make the MINIMAL fix, confirm
  the gate is green, record it under "Fixed while proving" with the test name, then STOP
  and continue the ledger. No refactors, no neighbouring cleanup, no scope creep.
- NO "could be better" / style / nit findings. If it isn't a falsifiable, user-visible
  reliability guarantee, it does not go in the ledger.
- Finite means finite. Route groups, roles, plans, and the 8 concerns are a fixed list.
  When the matrix is green, the job is done — do not invent rows to keep going.
- Deterministic tests only: reuse the e2e patterns (DB reset, unique data, no real
  providers, mock the API where a unit/component test is enough). Quarantine and note any
  flake; never delete it. Every commit keeps the whole gate green.

WRAP-UP: leave the UNIFIED docs/RELIABILITY.md as the trust ledger (every guarantee, api
+ web, linked to the test that proves it, all green), CI enforcing it, and a
SESSION-SUMMARY at repo root: what was added, the branch, how to run `release:ready`, the
number of guarantees now proven (api + web), the "Fixed while proving" list, and anything
genuinely ambiguous that needs a human decision. Do not push or merge.
```
