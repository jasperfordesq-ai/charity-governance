# Backend Audit

Date checked: 2026-07-03

Scope: Phase 1 inventory only. No runtime code was edited. Recommended phases refer to the approved full product revamp phases, not commits in this task.

## Findings

| Area | Current evidence | Product-readiness finding | Recommendation | Recommended phase |
| --- | --- | --- | --- | --- |
| API/auth/session baseline | `apps/api/src/server.ts` registers auth, organisation, compliance, documents, deadlines, billing, export, dashboard, registers, team, and health routes. `apps/api/src/middleware/auth.ts` verifies access tokens, checks active `AuthSession`, re-reads current user role/org, and rejects unverified users. `docs/SECURITY-REVIEW.md` confirms refresh-token rotation/reuse detection and HTTP-only cookie posture. | Baseline is strong and server-authoritative. Auth derives tenant/role from database rather than trusting stale token claims. | Preserve. Any route changes must keep `authGuard` and server-side org resolution. Add tests for new approval-readiness route. | Phase 3 and ongoing |
| Tenant isolation | Org-scoped service methods use `request.user.organisationId`; examples include `ComplianceService.getRecords()`, `upsertRecord()`, `getSignoff()`, and export register loading. Prisma schema indexes org-scoped models on `organisationId` or `(organisationId, reportingYear)`. `docs/RELIABILITY.md` lists tenant-isolation guarantees. | Strong baseline. Export, compliance, documents, board, team, organisation, deadlines, and registers are designed around session-derived tenant id. | Preserve the invariant: no client-supplied organisation id. Add review checklist item for every new route/query. | Phase 3 and all backend phases |
| Role guards | `apps/api/src/middleware/roles.ts` defines `requireAdmin` and `requireOwner`. Compliance record/signoff writes use `requireAdmin` in `apps/api/src/routes/compliance/index.ts`; document, board, deadline, registers, organisation/team writes are similarly guarded per reliability docs. | Good server-side authorization. Client affordances mirror roles but must remain non-authoritative. | Keep role checks at route preHandler. New approval-readiness read can be auth/subscription-only; signoff approval enforcement must stay in service. | Phase 3 |
| Subscription/plan gates | `apps/api/src/middleware/subscription.ts` blocks missing/expired/past-due/inactive subscriptions. `apps/api/src/middleware/plan.ts` gates Complete-only features. `ComplianceService.includesAdditionalStandards()` only includes additional standards for `COMPLEX` plus `COMPLETE`. `governance-registers` route is Complete-gated per architecture docs. | Strong baseline. Additional standards and registers are gated at API. | Preserve. UI should display plan-gate states with source/evidence prompts but never bypass API gates. | Phase 4-6 |
| Validation and shared Zod schemas | `packages/shared/src/schemas/compliance.ts` validates reporting year, compliance status fields, text lengths, and signoff fields. `upsertComplianceSignoffSchema.superRefine()` requires board meeting date, minute reference, and approver name when status is `APPROVED`. Routes parse bodies/query and return `VALIDATION_ERROR`. | Shared validation exists and avoids many client/server drift risks. The signoff schema covers board approval fields but cannot inspect year records for missing explanations. | Keep field validation in shared schemas; implement record-dependent readiness in `ComplianceService` and route tests. | Phase 3 |
| Compliance approval readiness | `ComplianceRecord.explanationIfNA` is nullable in `apps/api/prisma/schema.prisma`. `upsertRecord()` accepts `NOT_APPLICABLE` and `EXPLAIN` without explanation. `upsertSignoff()` stamps `approvedAt` for `APPROVED` without checking related records. `docs/SECURITY-REVIEW.md` calls this an open product decision. | P0 trust gap. The app can approve a Compliance Record even when in-scope `NOT_APPLICABLE` or `EXPLAIN` records lack the explanation expected by comply-or-explain workflows. Draft editing should remain flexible. | Add `getApprovalReadiness(organisationId, reportingYear)` and block only `APPROVED` signoff with `COMPLIANCE_APPROVAL_INCOMPLETE` when any in-scope NA/EXPLAIN record lacks a trimmed explanation. Surface readiness via API and UI. | Phase 3 |
| Export readiness and warnings | `apps/api/src/routes/export/index.ts` builds printable HTML with escaped user fields and strict CSP. It includes standards, evidence, explanations when present, signoff, and Complete-plan registers. It does not compute missing explanation/evidence/professional-review warnings. | Export is safe HTML and tenant-scoped, but not yet review-ready for missing explanations, missing evidence, conditional obligations, or not-yet-commenced source nuance. | Add readiness warnings before report body: missing NA/EXPLAIN explanations, missing evidence, not-yet-commenced items, conditional professional-review flags, and source last-checked date. | Phase 3 after source matrix |
| Prisma/data model | `apps/api/prisma/schema.prisma` has core models for Organisation, User/AuthSession, GovernancePrinciple/Standard, ComplianceRecord/Signoff, BoardMember, Document/DocumentStandardLink, governance registers, AnnualReportReadiness, FinancialControlReview, Deadline, TeamInvite, DeadlineReminderLog, Subscription, StripeWebhookEvent. | Data model covers most product workflows. Source/legal metadata and conditional obligation triggers are not yet modelled. Explanation approval can be service-level first; matrix can initially live in shared constants. | Do not migrate schema in Task 1. Consider later fields or JSON/source tables only after matrix usage proves stable. | Phase 2-3 |
| Document storage/Supabase signed URL model | `apps/api/src/services/storage.service.ts` requires org-prefixed storage paths, rejects traversal/cross-org paths, uses Supabase private bucket signed URLs, has local driver for development, and exposes readiness checks. `DocumentStorageDeletion` outbox supports crash-safe deletion. | Strong trust baseline. Storage is private and signed-url based. | Preserve private bucket assumptions. Add UI source/evidence linking polish without changing storage model. Production still needs external Supabase setup/backup evidence. | Phase 6-7 |
| Scheduled jobs and deadline reminders | `apps/api/src/server.ts` starts cron jobs through `startCronJobs()`. `apps/api/src/jobs/production-scheduler.ts`, `send-deadline-reminders.ts`, and `cleanup-document-storage.ts` exist. `docs/SECURITY-REVIEW.md` notes reminder catch-up and UTC due-date fixes. `PRODUCTION_TODO.md` says in-process production scheduling is disabled unless explicitly enabled. | Reminder and cleanup posture is mature, but production execution depends on deployment configuration and external evidence. | Keep app-level reminders. Add source-cited Annual Report deadline explanation in UI and export. Do not alter scheduler in docs phase. | Phase 6-8 |
| Rate limits and security headers | `apps/api/src/server.ts` registers global `@fastify/rate-limit` with 100/minute. `apps/api/src/plugins/security-headers.ts` sets nosniff, frame deny, referrer policy, permissions policy, no-store, default CSP, and HSTS in production. Auth-sensitive routes have additional throttling per reliability docs. | Good security baseline. Product revamp should not weaken headers or cache controls. | Preserve headers. Add tests if new routes need custom CSP, especially export/readiness endpoints. | Phase 3 and release verification |
| Logging redaction and error responses | `apps/api/src/utils/logger.ts` redacts auth headers, cookies, Stripe signature, readiness key, passwords, tokens, database/JWT/Stripe/Resend/Supabase secrets, and error stacks. `apps/api/src/plugins/error-handler.ts` returns safe 500s in production and sends operational alerts for 5xx. | Strong baseline. Error bodies are user-safe and logs redact sensitive provider data. | Preserve redaction paths. Ensure new approval-readiness errors are 400 with stable code, not generic 500. | Phase 3 |
| Billing/Stripe degradation | `apps/api/src/routes/billing/index.ts` and `BillingService` are registered; reliability/security docs confirm webhook signature verification, idempotent `StripeWebhookEvent`, customer/org assertions, provider-unconfigured graceful responses, and trusted Stripe redirects on web. | Good trust posture. Product polish should make provider degradation obvious without creating broken checkout flows. | Keep degradation states. Share plan model between pricing and billing UI. Do not alter Stripe dependencies in Task 1. | Phase 6-7 |
| Email/Resend degradation | `EmailService` is used for auth/team/reminders; reliability docs cover graceful failure and operational alerts. Readiness checks `new EmailService().isConfigured()`. | Good baseline with external provider assumptions. | Preserve neutral auth flows and invite/reminder degradation. Production requires verified Resend/domain evidence outside code. | Phase 7-8 |
| Health/readiness checks | `apps/api/src/routes/health/index.ts` exposes public `/health` and protected `/health/readiness` using `x-charitypilot-readiness-key`; checks database, billing, email, storage configuration, and storage bucket reachability. | Strong operational baseline. Readiness is protected and uses timing-safe comparison. | Preserve. Production runbook should document readiness key and expected checks. | Phase 8 |
| Production/backup/restore assumptions | `PRODUCTION_TODO.md` still has open items for external penetration test, Supabase production project/private bucket/backups/restore testing/retention, hosting/DNS/TLS/secrets/observability, production browser QA, and production env checks. | Product cannot be claimed production-launched or legally complete from code alone. | Keep launch claims constrained. Source-cited product revamp can proceed, but final launch report must reference external evidence. | Phase 8 |
| Dependency posture and migration caution | Stack context: Next.js 16, React 19, Tailwind CSS 4, HeroUI v2, Fastify 5, Prisma 6, PostgreSQL, shared Zod schemas, Supabase, Stripe, Resend. Existing docs note production audit was clean after pinning `form-data` 4.0.6. | Avoid churn. HeroUI v3, Prisma/Zod/Fastify/Stripe major changes should be separate migrations with tests. | Run `npm audit --omit=dev --audit-level=moderate` in dependency phase. Do not edit package files in Task 1. | Phase 7 |
| Legal copy and claims | Product docs prohibit "legally guaranteed", "legally bombproof", and "substitute for legal advice." Marketing/terms files contain static copy that should be reviewed during UI phases. | Legal copy must stay review-ready and source-cited. | Add source drawers, last-checked dates, and professional-review flags. Avoid legal certainty language in UI/export. | All phases |

## API Route Baseline

| Route group | Guard baseline | Notes for revamp |
| --- | --- | --- |
| `/api/v1/auth` | Public for login/register/reset/verify flows; identity guard for `/me` and resend verification per reliability docs. | Preserve enumeration-safe messages and token handling. |
| `/api/v1/organisation` | Auth + subscription; writes require admin. | Organisation profile drives financial year deadlines, complexity, legal form, and conditional-obligation questions. |
| `/api/v1/compliance` | Auth + subscription; record/signoff writes require admin. | Add approval readiness without weakening draft autosave. |
| `/api/v1/documents` | Auth + subscription; uploads/deletes/standard links require admin per reliability docs. | Preserve private storage and signed URL validation. |
| `/api/v1/deadlines` | Auth + subscription; writes require admin per reliability docs. | Keep annual report deadline generation source-cited. |
| `/api/v1/governance-registers` | Auth + subscription + Complete plan; writes require admin. | Registers map well to conflicts, risks, complaints, fundraising, annual report, and financial controls. |
| `/api/v1/team` | Auth + subscription; invite/role actions role-gated. | Preserve owner/admin/member semantics and invite token safety. |
| `/api/v1/billing` | Auth + subscription where applicable; Stripe provider checks. | Preserve graceful degradation and trusted redirects. |
| `/api/v1/export` | Auth + subscription. | Add warnings and source metadata to HTML export. |
| `/api/v1/health` | Public health; readiness protected by key. | Keep internal readiness details protected. |

## Approval Readiness Gap Detail

Current behaviour:

- `upsertComplianceRecordSchema` accepts `status: 'NOT_APPLICABLE'` or `status: 'EXPLAIN'` with `explanationIfNA` omitted or null.
- `upsertComplianceSignoffSchema` requires board details for `APPROVED`.
- `ComplianceService.upsertSignoff()` writes `APPROVED` and sets `approvedAt` without inspecting records for missing explanations.

Target behaviour:

- Draft record editing remains flexible.
- `BOARD_REVIEW` can remain a soft workflow state unless product later requires stricter gating.
- `APPROVED` must fail with a stable 400 error if any in-scope standard for that organisation/year has a record status of `NOT_APPLICABLE` or `EXPLAIN` and `explanationIfNA` is empty after trimming.
- Export should show the same readiness warnings even before signoff is approved.

Suggested response shape:

```json
{
  "error": "Resolve compliance explanations before board approval.",
  "code": "COMPLIANCE_APPROVAL_INCOMPLETE",
  "details": {
    "missingExplanations": [
      {
        "standardId": "governance-standard-4-2",
        "standardCode": "4.2",
        "status": "EXPLAIN"
      }
    ]
  }
}
```

## Recommended Backend Phasing

1. Phase 2: Add source-cited Irish compliance matrix in shared/domain code, with commencement status and conditional/professional-review flags.
2. Phase 3: Add approval-readiness service, API route, signoff enforcement, and export warnings.
3. Phase 6: Wire UI pages to readiness and source/review flags.
4. Phase 7: Recheck dependency posture and document major migration deferrals.
5. Phase 8: Verify production readiness against external evidence, backup/restore assumptions, provider configuration, browser QA, and legal/professional review.
