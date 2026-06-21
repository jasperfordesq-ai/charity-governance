# Session summary — provable reliability (the trust ledger)

**Branch:** `reliability/provable-trust` (5 commits, **not pushed, not merged**).
**Goal:** make CharityPilot's reliability *provable and regression-proof* — turn the
behaviours that would lose customer trust if they broke into automated tests + a single
"trust ledger" that shows every reliability-critical behaviour is covered and green.
**This was additive, evidence-producing work — not a bug hunt.**

## Result at a glance

- **271** reliability guarantees enumerated as a fixed matrix (12 route groups + 4
  cross-cutting areas × 8 concerns).
- **256 covered** — each proven by a passing automated test, and **256/256 links
  verified** green by the report tool.
- **15 n/a** — concerns explicitly considered and documented as not applicable.
- **0 gaps, 0 partial.** The matrix is full.
- API unit suite: **382 passing, 0 failing** (up from 234 — **148 new tests**).
- Code gate green: `npm run lint`, `npm run build` (all 3 workspaces), `tsc`, the full
  `node --test` suite.

## How to see it / run the report

```bash
npm run reliability:report          # compile + run the API suite, verify every covered
                                    # guarantee links to a passing test; exits non-zero
                                    # on any failure or broken link
npm run reliability:ledger          # the same, and regenerate docs/RELIABILITY.md
```

- **`docs/RELIABILITY.md`** — the human trust ledger (the matrix, each row → its proving test).
- **`docs/reliability/guarantees.json`** — machine-readable source of truth (one entry per
  guarantee: area, concern, status, and the exact proving test title/file).
- **`scripts/reliability-report.mjs`** — the one-command verifier (wired as the npm scripts above).

New tests are auto-discovered by `turbo test` (the API `test` script globs
`dist/tests/*.test.js`), so they already run as part of the standard gate.

## What was added

Phase 0 — the ledger: mapped the reliability surface, crediting the existing 234-test
unit suite + Playwright journeys, then bounded the remaining work as a finite gap list.

Phases 1–4 — 16 focused, self-contained `node:test` files in `apps/api/src/tests/`
(real Fastify app + hand-rolled Prisma mock + `app.inject`, no real DB, deterministic):

| Concern | What is now proven |
|---|---|
| Tenant isolation | Cross-org reads/writes return 404/403 and never touch another org's data; service queries carry the caller's `organisationId`; every org-scoped route group has a cross-org test. |
| Authorization | Every `requireAdmin` write rejects a MEMBER (403 FORBIDDEN, write never runs); billing checkout/portal require OWNER; governance-registers require the COMPLETE plan. |
| Plan gating | `subscriptionGuard` rejects missing/expired/inactive subscriptions with the right code; ESSENTIALS cannot reach COMPLETE-only features. |
| Input validation | Each validated mutation rejects malformed bodies with 400 `VALIDATION_ERROR` and performs no write. |
| Graceful degradation | Stripe/Supabase/Resend unconfigured or failing → clean 503, no partial write, rest of app keeps working. |
| Auth & session | Refresh rotation works; revoked/replayed refresh tokens rejected; cookies HttpOnly/SameSite/Secure; secrets redacted in logs. |
| Idempotency | Stripe webhook processed once (ledger row rolls back on a failed write, then retries and dedupes); reminder dedup race; document-deletion claim safe-retry. |
| Observability | Readiness reflects real dependency health (DB + providers); a job failure fires the error-alert webhook; a broken alert sender can't crash the run. |

Phase 5 — self-serving ledger: linked every row to its proving test, added the
one-command report, wired it into npm.

## Trust in the evidence

Every new test was **adversarially reviewed** (16 independent reviewers) specifically for
false-greens — tests that would still pass if the guarantee were violated, with special
attention to the guard-ordering trap (a "MEMBER forbidden" test that actually 403s at
`subscriptionGuard` rather than `requireAdmin`). **Result: 0 false-greens.** 5 tests
flagged as *tightenable* were hardened (notably the webhook-rollback test was upgraded from
proving write-ordering to proving true transactional commit/discard).

## Fixed while proving

**None.** Every guarantee was already correct — the code-gate ground truth held. The work
was to *pin* each behaviour with a test so it can never silently regress, not to find bugs.
(The ledger has a `Fixed while proving` section that stays empty unless a future test
surfaces a real defect.)

## Decisions needed from you

- **Nothing blocking.** The ledger is full and green; the branch is ready for your review.
- Two optional follow-ups, only if you want them (not done here to stay in scope):
  1. A couple of **E2E** cross-org isolation checks in `e2e/` for the highest-value flows
     (the isolation guarantees are currently proven at the fast integration layer, which is
     the recommended default; E2E would add browser-level belt-and-braces).
  2. Add `npm run reliability:report` to CI (`.github/workflows/ci.yml`) so the trust
     ledger is enforced on every push, not just runnable locally.

Branch is left for review — **not pushed, not merged.**
