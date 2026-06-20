# CharityPilot Internal Security & Correctness Review

*Date: 2026-06-20. This documents the **internal** adversarial code review. It does
not replace the external penetration test required by
`docs/production-launch-checklist.md` §11 — it scopes and informs it.*

## Method

Two multi-agent adversarial reviews were run over the codebase. Each review
dimension was inspected against the actual source, and **every candidate finding
was independently re-verified by three separate reviewers** whose default
position was "not a bug." Only findings confirmed by a majority were treated as
real; single-vote findings were treated as likely false positives and assessed by
hand.

Coverage (14 dimensions):

- **API security** — multi-tenant data isolation / IDOR, authorization & role
  enforcement, authentication & session security, billing / Stripe abuse,
  document storage access control, input validation / mass assignment, error
  handling & sensitive-data leakage.
- **Web security** — API-proxy SSRF / request forwarding, client-side auth &
  open redirect, XSS / unsafe rendering.
- **Business-logic correctness** — export injection & data integrity, compliance
  scoring & sign-off integrity, deadline reminder correctness, governance
  registers / team / data integrity.
- **Performance/scale** — database indexing for the multi-tenant query patterns.

## Outcome

The codebase is well-engineered and defensively written. Across all 14
dimensions, only **three real issues** were found, all low/medium, all now fixed
with regression tests, plus one earlier dependency advisory:

| ID | Severity | Area | Status |
| --- | --- | --- | --- |
| Login timing user enumeration | Low | auth/session | Fixed — constant-cost bcrypt on the no-user path (`auth.service.ts`) |
| Reminder windows dropped on a missed scheduler run | Medium | reminders | Fixed — catch-up to most-urgent reached window, dedup keyed on configured window (`deadline-reminders.service.ts`) |
| Reminder email due-date off-by-one on sub-UTC servers | Low | reminders | Fixed — format in UTC (`email.service.ts`) |
| `form-data` CRLF injection (GHSA-hmw2-7cc7-3qxx) | High (dep) | dependencies | Fixed — pinned to 4.0.6 |

### Verified strong (no issues found)

- **Multi-tenant isolation:** every org-scoped query is constrained by the
  authenticated user's `organisationId`; storage paths are double-guarded
  (`assertOrganisationStoragePath` + resolved-path-within-root).
- **Authorization:** `authGuard` re-derives role/org from the database (never
  trusts token claims); owner/admin-only routes enforce role server-side.
- **Sessions:** opaque refresh tokens stored hashed, rotated, with **reuse
  detection** (a reused revoked token revokes all sessions).
- **Billing:** Stripe webhook signature verified against the raw body;
  idempotent via `StripeWebhookEvent` + a unique-constraint insert; every handler
  asserts the Stripe customer matches the organisation before granting
  entitlements.
- **Export:** HTML report (not CSV — no formula-injection vector); all
  user-controlled fields HTML-escaped under a restrictive `default-src 'none'`
  CSP with no `script-src`.
- **Web proxy:** Next.js 16 middleware (`proxy.ts`) with a fixed API origin (no
  SSRF), per-request CSP nonce, and reset/verify tokens moved to the URL fragment.
- **Database:** every org-scoped model is indexed on `organisationId`; report
  tables have composite `(organisationId, reportingYear)` indexes; auth/session
  lookups indexed. No index changes warranted.

### Open product decisions (not bugs — for the owner to decide)

- **Compliance `NOT_APPLICABLE`/`EXPLAIN` without explanation:** the record
  schema does not require `explanationIfNA`; only sign-off (`status=APPROVED`)
  enforces its fields. Consider requiring an explanation for NA/EXPLAIN standards
  before a Compliance Record can be marked approved, since the CRA code is
  "comply or explain." Left unchanged to avoid breaking a legitimate
  draft-then-explain workflow without product direction.
- **Reminder at-least-once delivery:** if the process crashes between the email
  provider accepting a message and the `SENT` status write, the 15-minute
  reclaim can re-send once. Eliminating this fully requires a distributed
  transaction with the email provider; the current trade-off (rare duplicate vs.
  never-sent) is reasonable.

## For the external penetration test

This internal review covered code-level logic. The external test should focus on
what only a deployed environment exposes: TLS configuration, real cookie/CORS
behaviour across the deployed origins, infrastructure hardening, rate-limit
effectiveness under distributed load, and live third-party integration
(Stripe/Supabase/Resend) boundaries. Record the provider, report reference, and
remediation evidence in `docs/production-launch-checklist.md` §11.
