# Backend Audit

Date checked: 2026-07-03

Scope: Phase 7 backend/dependency hardening refresh. Runtime API, shared, dependency, and operational-readiness surfaces were inspected; no runtime code or package files were edited in this pass. Recommended phases refer to the approved full product revamp phases, not commits in this task.

## Findings

| Area | Current evidence | Product-readiness finding | Recommendation | Recommended phase |
| --- | --- | --- | --- | --- |
| API/auth/session baseline | `apps/api/src/server.ts` registers auth, organisation, compliance, documents, deadlines, billing, export, dashboard, registers, team, and health routes. `apps/api/src/middleware/auth.ts` verifies access tokens, checks active `AuthSession`, re-reads current user role/org, and rejects unverified users. `docs/SECURITY-REVIEW.md` confirms refresh-token rotation/reuse detection and HTTP-only cookie posture. | Baseline is strong and server-authoritative. Auth derives tenant/role from database rather than trusting stale token claims. | Preserve. Any route changes must keep `authGuard` and server-side org resolution. Approval-readiness is already covered by route and service tests. | Phase 3 and ongoing |
| Tenant isolation | Org-scoped service methods use `request.user.organisationId`; examples include `ComplianceService.getRecords()`, `upsertRecord()`, `getSignoff()`, and export register loading. Prisma schema indexes org-scoped models on `organisationId` or `(organisationId, reportingYear)`. `docs/RELIABILITY.md` lists tenant-isolation guarantees. | Strong baseline. Export, compliance, documents, board, team, organisation, deadlines, and registers are designed around session-derived tenant id. | Preserve the invariant: no client-supplied organisation id. Add review checklist item for every new route/query. | Phase 3 and all backend phases |
| Role guards | `apps/api/src/middleware/roles.ts` defines `requireAdmin` and `requireOwner`. Compliance record/signoff writes use `requireAdmin` in `apps/api/src/routes/compliance/index.ts`; document, board, deadline, registers, organisation/team writes are similarly guarded per reliability docs. | Good server-side authorization. Client affordances mirror roles but must remain non-authoritative. | Keep role checks at route preHandler. Approval-readiness remains an auth/subscription-only read; signoff approval enforcement stays in `ComplianceService`. | Phase 3 |
| Subscription/plan gates | `apps/api/src/middleware/subscription.ts` blocks missing/expired/past-due/inactive subscriptions. `apps/api/src/middleware/plan.ts` gates Complete-only features. `ComplianceService.includesAdditionalStandards()` only includes additional standards for `COMPLEX` plus `COMPLETE`. `governance-registers` route is Complete-gated per architecture docs. | Strong baseline. Additional standards and registers are gated at API. | Preserve. UI should display plan-gate states with source/evidence prompts but never bypass API gates. | Phase 4-6 |
| Validation and shared Zod schemas | `packages/shared/src/schemas/compliance.ts` validates reporting year, compliance status fields, text lengths, and signoff fields. `upsertComplianceSignoffSchema.superRefine()` requires board meeting date, minute reference, and approver name when status is `APPROVED`. Routes parse bodies/query and return `VALIDATION_ERROR`. | Shared validation exists and avoids many client/server drift risks. Record-dependent approval readiness is correctly enforced in `ComplianceService`, where the service can inspect the organisation/year records. | Keep field validation in shared schemas and record-dependent checks in service code. Do not make draft record editing stricter unless product explicitly changes the workflow. | Phase 3 |
| Compliance approval readiness | `ComplianceService.getApprovalReadiness(organisationId, reportingYear)` reports in-scope `NOT_APPLICABLE` and `EXPLAIN` records that lack a trimmed explanation. `GET /api/v1/compliance/approval-readiness?year=` exposes that result to authenticated subscribed users. `upsertSignoff()` blocks only `APPROVED` with `COMPLIANCE_APPROVAL_INCOMPLETE`; `DRAFT` and `BOARD_REVIEW` remain flexible. Tests cover the route, service readiness calculation, signoff blocking, and draft/board-review writes. | The earlier P0 trust gap is materially addressed. Board approval cannot be recorded while in-scope NA/EXPLAIN explanations are blank, while autosave/draft work remains usable. | Preserve the current boundary: explanation presence is a code gate for approval, but explanation quality, evidence sufficiency, and legal/professional judgement are review obligations outside this automated check. | Phase 3 implemented |
| Export readiness and warnings | `apps/api/src/routes/export/index.ts` builds printable HTML with escaped user fields and strict CSP. It includes standards, evidence, explanations when present, signoff, Complete-plan registers, and an approval-readiness warning section when explanations are incomplete. Export tests cover escaped warning content and omission when explanations are complete. | Export is safe HTML, tenant-scoped, and now review-ready for the specific approval-readiness warning. It is not a guarantee that evidence is complete, professional-review prompts have been resolved, or legal signoff has occurred. | Preserve approval-readiness warnings. Treat evidence completeness, professional-review/legal signoff, source last-checked display, and conditional-applicability decisions as product/legal-review items unless future code explicitly models them. | Phase 3 implemented; Phase 8 review |
| Prisma/data model | `apps/api/prisma/schema.prisma` has core models for Organisation, User/AuthSession, GovernancePrinciple/Standard, ComplianceRecord/Signoff, BoardMember, Document/DocumentStandardLink, governance registers, AnnualReportReadiness, FinancialControlReview, Deadline, TeamInvite, DeadlineReminderLog, Subscription, StripeWebhookEvent. The source-cited Irish compliance matrix lives in shared constants rather than new tables. | Data model covers most product workflows. Source/legal metadata, conditional applicability, and professional-review flags are reference-data/product guidance, not a legal conclusion or runtime guarantee. | No schema migration is needed for the current approval-readiness/export work. Consider later persistence only if the product needs organisation-specific applicability decisions, evidence completeness scoring, or audited legal-review status. | Phase 2-3 |
| Document storage/Supabase signed URL model | `apps/api/src/services/storage.service.ts` requires org-prefixed storage paths, rejects traversal/cross-org paths, uses Supabase private bucket signed URLs, has local driver for development, and exposes readiness checks. `DocumentStorageDeletion` outbox supports crash-safe deletion. | Strong trust baseline. Storage is private and signed-url based. | Preserve private bucket assumptions. Add UI source/evidence linking polish without changing storage model. Production still needs external Supabase setup/backup evidence. | Phase 6-7 |
| Scheduled jobs and deadline reminders | `apps/api/src/server.ts` starts cron jobs through `startCronJobs()`. `apps/api/src/jobs/production-scheduler.ts`, `send-deadline-reminders.ts`, and `cleanup-document-storage.ts` exist. `docs/SECURITY-REVIEW.md` notes reminder catch-up and UTC due-date fixes. `PRODUCTION_TODO.md` says in-process production scheduling is disabled unless explicitly enabled. | Reminder and cleanup posture is mature, but production execution depends on deployment configuration and external evidence. | Keep app-level reminders. Add source-cited Annual Report deadline explanation in UI and export. Do not alter scheduler in docs phase. | Phase 6-8 |
| Rate limits and security headers | `apps/api/src/server.ts` registers global `@fastify/rate-limit` with 100/minute. `apps/api/src/plugins/security-headers.ts` sets nosniff, frame deny, referrer policy, permissions policy, no-store, default CSP, and HSTS in production. Auth-sensitive routes have additional throttling per reliability docs. | Good security baseline. Product revamp should not weaken headers or cache controls. | Preserve headers. Add tests if new routes need custom CSP, especially export/readiness endpoints. | Phase 3 and release verification |
| Logging redaction and error responses | `apps/api/src/utils/logger.ts` redacts auth headers, cookies, Stripe signature, readiness key, passwords, tokens, database/JWT/Stripe/Resend/Supabase secrets, and error stacks. `apps/api/src/plugins/error-handler.ts` returns safe 500s in production and sends operational alerts for 5xx. | Strong baseline. Error bodies are user-safe and logs redact sensitive provider data. Approval-readiness enforcement returns a stable 400 code, not a generic 500. | Preserve redaction paths and stable error codes. | Phase 3 |
| Billing/Stripe degradation | `apps/api/src/routes/billing/index.ts` and `BillingService` are registered; reliability/security docs confirm webhook signature verification, idempotent `StripeWebhookEvent`, customer/org assertions, provider-unconfigured graceful responses, and trusted Stripe redirects on web. | Good trust posture. Product polish should make provider degradation obvious without creating broken checkout flows. | Keep degradation states. Share plan model between pricing and billing UI. Do not alter Stripe dependencies in Task 1. | Phase 6-7 |
| Email/Resend degradation | `EmailService` is used for auth/team/reminders; reliability docs cover graceful failure and operational alerts. Readiness checks `new EmailService().isConfigured()`. | Good baseline with external provider assumptions. | Preserve neutral auth flows and invite/reminder degradation. Production requires verified Resend/domain evidence outside code. | Phase 7-8 |
| Health/readiness checks | `apps/api/src/routes/health/index.ts` exposes public `/health` and protected `/health/readiness` using `x-charitypilot-readiness-key`; checks database, billing, email, storage configuration, and storage bucket reachability. | Strong operational baseline. Readiness is protected and uses timing-safe comparison. | Preserve. Production runbook should document readiness key and expected checks. | Phase 8 |
| Production/backup/restore assumptions | `PRODUCTION_TODO.md` still has open items for external penetration test, Supabase production project/private bucket/backups/restore testing/retention, hosting/DNS/TLS/secrets/observability, production browser QA, and production env checks. | Product cannot be claimed production-launched or legally complete from code alone. | Keep launch claims constrained. Source-cited product revamp can proceed, but final launch report must reference external evidence. | Phase 8 |
| Dependency posture and migration caution | Stack context checked 2026-07-03: Next.js 16 canary, React 19, Tailwind CSS 4, HeroUI v2, Fastify 5, Prisma 6, PostgreSQL, shared Zod schemas, Supabase, Stripe, Resend. `npm audit --omit=dev --audit-level=moderate` returned `found 0 vulnerabilities`. | Current production dependency audit is clean. Avoid churn: HeroUI v3, Prisma/Zod/Fastify/Stripe major changes should remain separate migrations with focused tests. | Do not edit package files without a concrete defect. Re-run production audit before release and after any dependency changes. | Phase 7 current |
| Legal copy and claims | Product docs prohibit "legally guaranteed", "legally bombproof", and "substitute for legal advice." Marketing/terms files contain static copy that should be reviewed during UI phases. | Legal copy must stay review-ready and source-cited. | Add source drawers, last-checked dates, and professional-review flags. Avoid legal certainty language in UI/export. | All phases |

## API Route Baseline

| Route group | Guard baseline | Notes for revamp |
| --- | --- | --- |
| `/api/v1/auth` | Public for login/register/reset/verify flows; identity guard for `/me` and resend verification per reliability docs. | Preserve enumeration-safe messages and token handling. |
| `/api/v1/organisation` | Auth + subscription; writes require admin. | Organisation profile drives financial year deadlines, complexity, legal form, and conditional-obligation questions. |
| `/api/v1/compliance` | Auth + subscription; record/signoff writes require admin. | Approval-readiness is implemented without weakening draft autosave. |
| `/api/v1/documents` | Auth + subscription; uploads/deletes/standard links require admin per reliability docs. | Preserve private storage and signed URL validation. |
| `/api/v1/deadlines` | Auth + subscription; writes require admin per reliability docs. | Keep annual report deadline generation source-cited. |
| `/api/v1/governance-registers` | Auth + subscription + Complete plan; writes require admin. | Registers map well to conflicts, risks, complaints, fundraising, annual report, and financial controls. |
| `/api/v1/team` | Auth + subscription; invite/role actions role-gated. | Preserve owner/admin/member semantics and invite token safety. |
| `/api/v1/billing` | Auth + subscription where applicable; Stripe provider checks. | Preserve graceful degradation and trusted redirects. |
| `/api/v1/export` | Auth + subscription. | Includes approval-readiness warnings; remaining source/professional-review claims must stay review-ready rather than legally conclusive. |
| `/api/v1/health` | Public health; readiness protected by key. | Keep internal readiness details protected. |

## Approval Readiness Current Behaviour

Current behaviour:

- `upsertComplianceRecordSchema` accepts `status: 'NOT_APPLICABLE'` or `status: 'EXPLAIN'` with `explanationIfNA` omitted or null.
- `upsertComplianceSignoffSchema` requires board details for `APPROVED`.
- `ComplianceService.getApprovalReadiness()` returns `{ ready, missingExplanations }` for the caller organisation and reporting year.
- `GET /api/v1/compliance/approval-readiness?year=YYYY` exposes that readiness shape to authenticated subscribed users and validates `year`.
- `ComplianceService.upsertSignoff()` rejects `APPROVED` with `400 COMPLIANCE_APPROVAL_INCOMPLETE` when readiness is incomplete and does not write the signoff.
- Draft record editing remains flexible.
- `BOARD_REVIEW` can remain a soft workflow state unless product later requires stricter gating.
- Export shows the same missing-explanation readiness warning even before signoff is approved.

Readiness response shape:

```json
{
  "data": {
    "ready": false,
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

The approval gate checks for the presence of a trimmed explanation. It does not certify that the explanation is legally sufficient, that supporting evidence is complete, that conditional obligations have been resolved, or that a solicitor/accountant/governance expert has signed off.

## External Assumptions Not Solved By Code

- Supabase production project setup, private bucket configuration, backup retention, and restore-test evidence.
- Resend account/domain setup, sender verification, and production deliverability evidence.
- Stripe live-mode configuration, product/price mapping, webhook endpoint setup, and billing operations evidence.
- Production hosting, DNS, TLS, reverse proxy/trusted proxy configuration, secrets, browser QA, monitoring, alert routing, and incident runbooks.
- Solicitor, accountant, and governance expert review of source-cited guidance, professional-review flags, legal copy, export wording, and operational signoff.

## Recommended Backend Phasing

1. Phase 2: Source-cited Irish compliance matrix is present in shared/domain code, with commencement status and conditional/professional-review flags.
2. Phase 3: Approval-readiness service, API route, signoff enforcement, and export warning coverage are implemented and tested.
3. Phase 6: UI pages are wired to readiness and source/review flags.
4. Phase 7: Dependency posture was rechecked on 2026-07-03 with zero production audit vulnerabilities; major migration deferrals remain deliberate.
5. Phase 8: Final readiness still depends on external evidence, backup/restore assumptions, provider configuration, browser QA, observability, and legal/professional review.
