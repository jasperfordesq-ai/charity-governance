# Reliability goal — an autonomous brief for provable trust

> **Historical prompt artifact:** this brief explains the origin of the trust
> ledger. It is not the current execution report; use `RELIABILITY.md` and the
> current CI/E2E result for present evidence.

This file holds a ready-to-run, all-day autonomous brief. Paste the fenced
`GOAL` block below as the prompt for a fresh autonomous session (or a scheduled /
background run) when you want to harden the platform's reliability.

## Why this exists (read before reaching for an "audit")

An adversarial audit is **unbounded** — it is optimised to find *something*, and
on any real codebase it always will, forever. "It found problems again" is a
property of the method, not a verdict on the platform. Each pass quietly lowers
its bar (real bugs → edge cases → theoretical nits → style opinions), so chasing
"audit silence" is an infinite loop that *erodes* confidence even as the code gets
more solid.

Trust is not the absence of findings — it is the presence of **evidence**: tests
that encode "this must always work", proof that the scary failure modes (one
charity seeing another's data, a member doing an admin's action, a provider
outage taking the whole app down) simply cannot happen, and alarms that catch
regressions before users do. That work is the opposite of an audit: it is
**bounded and convergent**. You can finish it, it stays finished, and it pays off
on every future change.

The brief below encodes exactly that: build a finite "trust ledger" of
falsifiable reliability guarantees, prove each with a deterministic test, and
**stop when the ledger is green** — rather than hunting for what's wrong.

## The brief

```
GOAL: Make CharityPilot's reliability PROVABLE and regression-proof. Take the
behaviours that — if they ever broke — would lose customer trust or generate
support tickets, and turn them into automated tests + monitoring that prove they
work today and will keep working. Produce a single "trust ledger" (docs/RELIABILITY.md)
that shows at a glance that every reliability-critical behaviour is covered and green.
This is additive, evidence-producing work — NOT a bug hunt.

WHY THIS IS NOT AN AUDIT (hold this line all day): an adversarial audit is unbounded —
optimised to find *something*, and on a real codebase it always will. "Found problems
again" is a property of the method, not proof the platform is broken. Chasing
audit-silence is an infinite loop that erodes confidence. Trust = EVIDENCE: tests that
encode "this must always work", guarantees the scary failure modes can't happen, and
alerts that catch regressions first. That work is finite and convergent — you finish it,
it stays finished, it pays off forever. Do NOT review for problems. Build proof of
correctness, lock it in, and STOP when the ledger is full.

GROUND TRUTH (do not relitigate, do not re-verify):
- The code gate is DONE and green (npm run lint, npx turbo test, npm run build,
  npm audit, Docker smoke). Five adversarial reviews already ran. Assume the code is
  correct unless a TEST YOU WRITE proves otherwise.
- Foundation already exists: docs/ARCHITECTURE.md (the system map) and e2e/ (Playwright,
  5 passing happy-path journeys). Build ON these.
- Stack: Turborepo — apps/api (Fastify 5, 12 route groups, 16 services, Prisma, jobs),
  apps/web (Next 16), packages/shared (Zod). 33 Prisma models, organisationId tenant
  scoping, role guards (OWNER/ADMIN/MEMBER), plan gating (ESSENTIALS/COMPLETE), graceful
  503 degradation when Stripe/Supabase/Resend are absent.
  Local stack: docker compose -f compose.yml -f compose.local.yml up
- DO NOT touch the launch gate: no secrets, no .env.production, no deploy, no external
  accounts. Stay in code + tests + docs + local Docker.

WORK ON BRANCH `reliability/provable-trust`. Keep the gate green at EVERY commit.
Commit incrementally. Never push or merge.

METHOD — build a finite ledger, then fill it:
Phase 0: enumerate the reliability surface as a FIXED matrix — every route group × the
concerns below — into docs/RELIABILITY.md as concrete, falsifiable guarantees, each
marked covered / not-covered. CHECK THE EXISTING unit + E2E tests first and credit what
they already prove (much is covered — do not redo it). This matrix BOUNDS the work. Then
fill the gaps. When every row is green, you are DONE. Do not invent new rows to keep going.

THE RELIABILITY CONCERNS (the trust surface):
1. Tenant isolation — a user in org A can NEVER read or modify any resource of org B
   (expect 403/404, never another org's data). The #1 trust guarantee for a multi-tenant
   SaaS. Prove it for every org-scoped route group.
2. Authorization boundaries — every requireAdmin write rejects a MEMBER; billing
   checkout/portal require OWNER; governance-registers require the COMPLETE plan.
3. Subscription/plan gating — an expired/cancelled subscription is blocked; ESSENTIALS
   cannot reach COMPLETE-only features.
4. Input validation — each validated endpoint rejects malformed/oversized input with a
   4xx + safe error code, never a 500 or a stack leak.
5. Graceful degradation — when Stripe/Supabase/Resend are unconfigured or failing, the
   affected endpoints return a clean 503 and the rest of the app keeps working; no crash,
   no partial writes.
6. Auth & session integrity — refresh rotation works, a revoked/replayed refresh token is
   rejected, and secrets/tokens never appear in logs.
7. At-least-once / idempotency — Stripe webhooks processed once (StripeWebhookEvent),
   deadline reminders dedupe (DeadlineReminderLog unique key), document-deletion
   reconciliation retries safely.
8. Observability — the readiness endpoint reflects real dependency health, and a job
   failure actually fires the error-alert webhook. Prove the alarm works.

PHASES (each has a COUNTABLE definition of done — meet the count, then move on):
- Phase 0 — Reliability ledger: the full matrix, grounded in existing tests.
  DoD: every route group × every concern appears as a concrete checklist item.
- Phase 1 — Tenant-isolation tests. DoD: every org-scoped route group has a test proving
  cross-org access fails. Prefer fast integration tests (Fastify app / Prisma) over the
  browser; add a couple of E2E isolation checks for the highest-value flows.
- Phase 2 — AuthZ + plan-gating tests. DoD: every requireAdmin/requireOwner/
  requireCompletePlan boundary has a rejection test.
- Phase 3 — Input-validation + graceful-degradation tests. DoD: each validated mutation
  has a bad-input 4xx test; each external provider has a degradation test.
- Phase 4 — Idempotency + observability tests. DoD: webhook idempotency, reminder dedup,
  deletion retry, readiness, and error-alert each have a proving test.
- Phase 5 — Make the ledger self-serving: wire all new tests into the existing test
  command, link every ledger row to the test that proves it, and add a one-command
  "reliability report" (guarantee counts + pass/fail) so a human sees the green state
  at a glance.

ANTI-SPIRAL RULES (the entire point — hold these hard):
- You are PROVING correctness, not hunting bugs. Default assumption: the behaviour is
  correct; your job is to lock it in with a test.
- If a test reveals a REAL defect: write the failing test, make the MINIMAL fix, confirm
  the gate is green, and record it under a short "Fixed while proving" list with the test
  name. Then STOP and continue the ledger. Do NOT refactor neighbouring code, do NOT
  broaden into a review, do NOT chase related smells.
- NO "could be better" / style / nit findings. If it isn't a falsifiable reliability
  guarantee, it does not go in the ledger.
- Finite means finite. The route groups, models, roles and providers are a fixed list.
  When the matrix is green, the job is done — do not add speculative rows to keep working.
- Every commit keeps the gate green. Tests must be deterministic (reuse the e2e patterns:
  DB reset, unique data, no real providers). Quarantine any flaky test and note it; never
  delete it.

WRAP-UP: leave docs/RELIABILITY.md as the trust ledger (every guarantee → the test that
proves it, all green) and a SESSION-SUMMARY at repo root: what was added, the branch, how
to run the reliability report, the number of guarantees now proven, and anything genuinely
ambiguous that needs your decision. Do not merge or push.
```

## How to run it

1. Make sure Docker is available. Do not start the persistent development stack
   for browser tests; `npm run test:e2e` provisions and tears down its own isolated
   disposable stack.
2. Start a fresh autonomous session and paste the `GOAL` block above as the prompt
   (or schedule it as a background run).
3. Review the result on the `reliability/provable-trust` branch — start with
   `docs/RELIABILITY.md` (the trust ledger) and the reliability report command.

It converges: the route groups, models, roles and providers are a fixed list, so
the ledger has a finite number of cells. The agent fills them and stops, leaving a
regression net that blocks the next bad change from shipping.
