# CharityPilot Full Product Revamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a polished, intuitive, source-cited, production-grade CharityPilot experience for Irish registered charities across UI, product workflow, backend trust boundaries, and governance compliance content.

**Architecture:** This is a phased full-stack revamp. Start with inventory and source-cited compliance modelling, then harden backend approval/export behaviour, then build reusable UI primitives, and finally convert route families one at a time with Playwright/axe verification in light and dark themes.

**Tech Stack:** Next.js 16, React 19, Tailwind CSS 4, HeroUI v2, Fastify 5, Prisma 6, PostgreSQL, shared Zod schemas, Supabase Storage, Stripe, Resend, Playwright, axe-core, Turborepo.

---

## Scope Check

The approved spec spans multiple independent subsystems. Do not implement the whole revamp in one patch. Execute it as phases:

1. Research and inventory.
2. Compliance matrix data model and source log.
3. Backend approval/export readiness hardening.
4. Shared UI/product system.
5. Marketing and auth route polish.
6. Dashboard workflow route polish.
7. Final verification, screenshots, and launch/legal review report.

Each phase must leave the app buildable and tests green before the next phase starts.

## File Structure

Expected new documentation:

- Create `docs/product-revamp/page-inventory.md`: every route, state, owner component, current issues, and target design notes.
- Create `docs/product-revamp/backend-audit.md`: API/schema/storage/billing/job/dependency findings and accepted changes.
- Create `docs/product-revamp/irish-source-log.md`: official legal/regulatory sources, URLs, date checked, and implementation notes.
- Create `docs/product-revamp/final-report.md`: final changed-files summary, verification evidence, source list, and professional-review items.

Expected shared/domain files:

- Create `packages/shared/src/constants/irish-compliance-matrix.ts`: source-cited matrix entries and helper lookup functions.
- Modify `packages/shared/src/constants/index.ts`: export the matrix.
- Create `packages/shared/src/tests/irish-compliance-matrix.test.ts`: matrix coverage and source-field tests.
- Modify `packages/shared/src/schemas/compliance.ts`: add approval readiness validation types only if they belong in shared schemas after service design.

Expected API files:

- Modify `apps/api/src/services/compliance.service.ts`: add approval-readiness evaluation for missing explanations and missing evidence.
- Modify `apps/api/src/routes/compliance/index.ts`: surface readiness failures with stable error codes.
- Modify `apps/api/src/routes/export/index.ts`: include review-readiness warnings in exports.
- Modify `apps/api/src/tests/compliance-reliability.test.ts`: route-level approval-readiness tests.
- Modify `apps/api/src/tests/compliance-service.test.ts`: service-level completeness tests.
- Modify `apps/api/src/tests/export-reliability.test.ts`: export warning tests.

Expected web files:

- Create `apps/web/src/components/ui/app-page.tsx`: shared page shell, page header, action row, and section layout primitives.
- Create `apps/web/src/components/ui/status.tsx`: status chips, evidence chips, review flags, and deadline badges.
- Create `apps/web/src/components/ui/states.tsx`: loading, empty, error, warning, and locked-feature states.
- Create `apps/web/src/components/ui/forms.tsx`: field group, helper text, validation summary, sticky form actions.
- Create `apps/web/src/components/ui/data-list.tsx`: responsive table/list wrapper for operational data.
- Create `apps/web/src/components/governance/evidence-readiness.tsx`: compliance evidence prompts and source/review flags.
- Modify `apps/web/src/app/globals.css`: complete theme tokens and accessible light/dark surfaces.
- Modify `apps/web/src/app/layout.tsx`: allow universal theme pre-paint instead of app-only dark mode.
- Modify `apps/web/src/app/(marketing)/layout.tsx`: polish public layout and dark mode.
- Modify `apps/web/src/app/(auth)/layout.tsx`: polish auth layout and dark mode.
- Modify all page routes under `apps/web/src/app/(marketing)`, `apps/web/src/app/(auth)`, and `apps/web/src/app/(dashboard)` route by route.

Expected E2E/test files:

- Modify `e2e/tests/accessibility.spec.ts`: expand route coverage after each route family changes.
- Create or modify `e2e/tests/product-revamp.spec.ts`: screenshot and workflow smoke checks for revamped routes.
- Modify `apps/web/src/lib/*test.ts` files only where a changed UI helper or route behaviour needs unit coverage.
- Update `docs/RELIABILITY.md` and `docs/reliability/guarantees.json` only by running the existing reliability ledger command when new guarantees are added.

---

### Task 1: Research And Inventory

**Files:**
- Create: `docs/product-revamp/page-inventory.md`
- Create: `docs/product-revamp/backend-audit.md`
- Create: `docs/product-revamp/irish-source-log.md`

- [ ] **Step 1: Recheck official Irish sources**

Run official-source searches for the current date before writing legal content:

```powershell
# Use browser/web search, not repo memory, for these sources:
# Charities Regulator Governance Code and toolkit/templates
# Compliance Record Form
# Charities Act 2009 as revised
# Charities (Amendment) Act 2024 and commencement status
# annual reporting/accounting duties
# trustee duties
# fundraising and financial controls guidance
# DPC, HSA, Tusla, WRC conditional obligations
```

Expected: `docs/product-revamp/irish-source-log.md` records each official URL, date checked, source owner, product relevance, and any commencement nuance.

- [ ] **Step 2: Inventory every page route**

Run:

```powershell
Get-ChildItem -Path apps\web\src\app -Recurse -Filter page.tsx |
  ForEach-Object {
    $content = Get-Content -LiteralPath $_.FullName
    [PSCustomObject]@{
      Path = $_.FullName.Replace((Get-Location).Path + '\','')
      Lines = $content.Length
    }
  } |
  Sort-Object Lines -Descending |
  Format-Table -AutoSize
```

Expected: `docs/product-revamp/page-inventory.md` lists every route, current state coverage, mobile risk, dark-mode risk, validation risk, and target component strategy.

- [ ] **Step 3: Inventory backend trust boundaries**

Run:

```powershell
rg -n "authGuard|subscriptionGuard|requireAdmin|requireCompletePlan|organisationId|reportingYear|rateLimit|redact|storage|signed|export|APPROVED|NOT_APPLICABLE|EXPLAIN" apps/api/src packages/shared/src
```

Expected: `docs/product-revamp/backend-audit.md` lists route/service findings for tenant isolation, role guards, validation, approval readiness, exports, storage, jobs, billing, logging, health checks, and dependencies.

- [ ] **Step 4: Commit or checkpoint docs after review**

Run:

```powershell
git diff -- docs/product-revamp
git status --short
```

Expected: only the three inventory docs are changed in this task.

---

### Task 2: Compliance Matrix Foundation

**Files:**
- Create: `packages/shared/src/constants/irish-compliance-matrix.ts`
- Modify: `packages/shared/src/constants/index.ts`
- Create: `packages/shared/src/tests/irish-compliance-matrix.test.ts`
- Modify: `docs/architecture/08-governance-domain.md`

- [ ] **Step 1: Write matrix coverage tests first**

Add tests that assert:

```ts
import { GOVERNANCE_TOTALS } from '../constants/governance-code.js';
import {
  IRISH_COMPLIANCE_MATRIX,
  getMatrixEntriesForStandard,
  getProfessionalReviewFlags,
} from '../constants/irish-compliance-matrix.js';

test('matrix covers every Governance Code standard with a source-cited entry', () => {
  const covered = new Set(IRISH_COMPLIANCE_MATRIX.flatMap((entry) => entry.standardCodes));

  expect(covered.size).toBe(GOVERNANCE_TOTALS.totalStandards);
  for (const entry of IRISH_COMPLIANCE_MATRIX) {
    expect(entry.sourceRefs.length).toBeGreaterThan(0);
    for (const source of entry.sourceRefs) {
      expect(source.url).toMatch(/^https:\/\//);
      expect(source.lastChecked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  }
});

test('standard 4.2 exposes legal-register review flags', () => {
  const entries = getMatrixEntriesForStandard('4.2');
  expect(entries.some((entry) => entry.featureArea === 'regulator')).toBe(true);
  expect(getProfessionalReviewFlags('4.2')).toContain('solicitor');
});
```

Run:

```powershell
npm run test -w @charitypilot/shared -- irish-compliance-matrix
```

Expected: fail because the matrix module does not exist yet.

- [ ] **Step 2: Add matrix types and helpers**

Create `packages/shared/src/constants/irish-compliance-matrix.ts` with:

```ts
export type CommencementStatus = 'in_force' | 'not_commenced' | 'conditional' | 'guidance';

export type ProfessionalReviewFlag =
  | 'solicitor'
  | 'accountant'
  | 'data_protection'
  | 'employment'
  | 'equality'
  | 'health_and_safety'
  | 'safeguarding'
  | 'protected_disclosures'
  | 'governance_expert';

export interface ComplianceSourceRef {
  name: string;
  owner: string;
  url: string;
  lastChecked: string;
  note: string;
}

export interface IrishComplianceMatrixEntry {
  id: string;
  sourceRefs: ComplianceSourceRef[];
  commencementStatus: CommencementStatus;
  principleNumbers: number[];
  standardCodes: string[];
  featureArea:
    | 'onboarding'
    | 'organisation'
    | 'compliance'
    | 'documents'
    | 'board'
    | 'deadlines'
    | 'registers'
    | 'regulator'
    | 'export'
    | 'team'
    | 'billing';
  userTask: string;
  evidenceRequired: string[];
  boardApproval: 'required' | 'recommended' | 'conditional' | 'not_applicable';
  professionalReview: ProfessionalReviewFlag[];
  copyTone: string;
  testExpectation: string;
}
```

Then add entries for all 49 standards using `packages/shared/src/constants/governance-code.ts` as the canonical standard list. The entries must be concise and source-cited; do not quote long passages from official sources.

- [ ] **Step 3: Export the matrix**

Modify `packages/shared/src/constants/index.ts`:

```ts
export * from './governance-code.js';
export * from './irish-compliance-matrix.js';
```

- [ ] **Step 4: Run shared tests**

Run:

```powershell
npm run test -w @charitypilot/shared
```

Expected: shared tests pass and matrix coverage is proven.

- [ ] **Step 5: Update governance architecture docs**

Update `docs/architecture/08-governance-domain.md` with a short section explaining the new matrix and how it differs from legal advice.

---

### Task 3: Backend Approval And Export Readiness

**Files:**
- Modify: `apps/api/src/services/compliance.service.ts`
- Modify: `apps/api/src/routes/compliance/index.ts`
- Modify: `apps/api/src/routes/export/index.ts`
- Modify: `apps/api/src/tests/compliance-service.test.ts`
- Modify: `apps/api/src/tests/compliance-reliability.test.ts`
- Modify: `apps/api/src/tests/export-reliability.test.ts`

- [ ] **Step 1: Write failing service tests for approval readiness**

Add tests proving an annual sign-off cannot be approved when any in-scope `NOT_APPLICABLE` or `EXPLAIN` record lacks `explanationIfNA`.

Expected error:

```ts
{
  statusCode: 400,
  code: 'COMPLIANCE_APPROVAL_INCOMPLETE',
  message: 'Resolve compliance explanations before board approval.'
}
```

- [ ] **Step 2: Implement service readiness evaluation**

Add a service method shaped like:

```ts
async getApprovalReadiness(organisationId: string, reportingYear: number) {
  const records = await this.getRecords(organisationId, reportingYear);
  const missingExplanations = records.filter(
    (record) =>
      (record.status === 'NOT_APPLICABLE' || record.status === 'EXPLAIN') &&
      !record.explanationIfNA?.trim(),
  );

  return {
    ready: missingExplanations.length === 0,
    missingExplanations: missingExplanations.map((record) => ({
      standardId: record.standardId,
      standardCode: record.standard.code,
      status: record.status,
    })),
  };
}
```

Adapt the exact property names to the current `ComplianceRecordResponse` returned by `getRecords()`. Keep reads tenant-scoped by `organisationId`.

- [ ] **Step 3: Enforce readiness only on approval**

In `upsertSignoff()`, before writing `APPROVED`, call the readiness method and throw `COMPLIANCE_APPROVAL_INCOMPLETE` if any required explanation is missing. Do not block `DRAFT` or `BOARD_REVIEW`.

- [ ] **Step 4: Expose readiness to the web**

Add a `GET /api/v1/compliance/approval-readiness?year=` route that returns the readiness object under auth and subscription guards.

- [ ] **Step 5: Add export warnings**

Update export generation so incomplete approval readiness appears in the exported report as a warning section, not as hidden internal notes.

- [ ] **Step 6: Run API tests**

Run:

```powershell
npm run test -w @charitypilot/api
```

Expected: API tests pass with new approval-readiness coverage.

---

### Task 4: Shared UI System And Theme Foundation

**Files:**
- Create: `apps/web/src/components/ui/app-page.tsx`
- Create: `apps/web/src/components/ui/status.tsx`
- Create: `apps/web/src/components/ui/states.tsx`
- Create: `apps/web/src/components/ui/forms.tsx`
- Create: `apps/web/src/components/ui/data-list.tsx`
- Create: `apps/web/src/components/governance/evidence-readiness.tsx`
- Modify: `apps/web/src/app/globals.css`
- Modify: `apps/web/src/app/layout.tsx`
- Modify: `apps/web/src/app/(dashboard)/layout.tsx`
- Modify: `apps/web/src/app/(marketing)/layout.tsx`
- Modify: `apps/web/src/app/(auth)/layout.tsx`

- [ ] **Step 1: Add shared page primitives**

Create components with stable props:

```ts
export interface AppPageProps {
  title: string;
  description?: string;
  eyebrow?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}

export interface AppSectionProps {
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}
```

Use restrained spacing, accessible headings, and no nested decorative cards.

- [ ] **Step 2: Add shared state primitives**

Create `LoadingState`, `EmptyState`, `ErrorState`, `LockedFeatureState`, and `ReviewWarningState`. Each must support compact and full-page variants.

- [ ] **Step 3: Make dark mode universal**

Modify `apps/web/src/app/layout.tsx` so the pre-paint theme script can apply `.dark` on all routes. Keep the CSP nonce.

- [ ] **Step 4: Complete theme tokens**

Update `apps/web/src/app/globals.css` with semantic surface/text/border/status variables and check against the frontend design constraints:

```powershell
rg -n "gradient|blur-|rounded-full|text-gray-500|text-teal-primary|dark:" apps/web/src/app apps/web/src/components
```

Expected: any remaining one-off styles are intentional and accessible.

- [ ] **Step 5: Run web tests**

Run:

```powershell
npm run test -w @charitypilot/web
npm run lint -w @charitypilot/web
```

Expected: web tests and lint pass.

---

### Task 5: Marketing And Auth Polish

**Files:**
- Modify: `apps/web/src/app/(marketing)/page.tsx`
- Modify: `apps/web/src/app/(marketing)/features/page.tsx`
- Modify: `apps/web/src/app/(marketing)/pricing/page.tsx`
- Modify: `apps/web/src/app/(marketing)/blog/page.tsx`
- Modify: `apps/web/src/app/(marketing)/blog/[slug]/page.tsx`
- Modify: `apps/web/src/app/(marketing)/privacy/page.tsx`
- Modify: `apps/web/src/app/(marketing)/terms/page.tsx`
- Modify: `apps/web/src/app/(auth)/login/page.tsx`
- Modify: `apps/web/src/app/(auth)/register/page.tsx`
- Modify: `apps/web/src/app/(auth)/verify-email/page.tsx`
- Modify: `apps/web/src/app/(auth)/forgot-password/page.tsx`
- Modify: `apps/web/src/app/(auth)/reset-password/page.tsx`
- Modify: `apps/web/src/app/(auth)/accept-invite/page.tsx`

- [ ] **Step 1: Remove unfinished decorative language**

Replace gradient-orb and oversized decorative marketing styling with a trust-led public product surface that clearly shows CharityPilot as Irish charity governance software.

- [ ] **Step 2: Apply shared states and form primitives**

Convert auth forms to shared field groups, validation summaries, submit states, and safe inline errors.

- [ ] **Step 3: Verify public light/dark accessibility**

Run:

```powershell
cd e2e
npm test -- --grep "Accessibility"
```

Expected: changed public/auth routes are axe-clean in light and dark themes.

- [ ] **Step 4: Capture desktop and mobile screenshots**

Run Playwright screenshot checks for:

- `/`
- `/features`
- `/pricing`
- `/login`
- `/register`

Expected: no blank page, no text overlap, no horizontal overflow, and readable dark mode.

---

### Task 6: Dashboard Workflow Polish

**Files:**
- Modify: `apps/web/src/app/(dashboard)/dashboard/page.tsx`
- Modify: `apps/web/src/app/(dashboard)/compliance/page.tsx`
- Modify: `apps/web/src/app/(dashboard)/compliance/[principleId]/page.tsx`
- Modify: `apps/web/src/app/(dashboard)/documents/page.tsx`
- Modify: `apps/web/src/app/(dashboard)/deadlines/page.tsx`
- Modify: `apps/web/src/app/(dashboard)/board/page.tsx`
- Modify: `apps/web/src/app/(dashboard)/registers/page.tsx`
- Modify: `apps/web/src/app/(dashboard)/regulator/page.tsx`
- Modify: `apps/web/src/app/(dashboard)/organisation/page.tsx`
- Modify: `apps/web/src/app/(dashboard)/team/page.tsx`
- Modify: `apps/web/src/app/(dashboard)/billing/page.tsx`
- Modify: `apps/web/src/app/(dashboard)/export/page.tsx`

- [ ] **Step 1: Convert dashboard overview**

Use the shared page shell, readiness banners, deadline cards, progress summaries, and clear next actions. Preserve all existing API calls and plan-gating behaviour.

- [ ] **Step 2: Convert compliance workspace**

Add compliance-year context, simple/complex explanation, matrix-backed source/review flags, missing-evidence prompts, and approval-readiness warnings.

- [ ] **Step 3: Convert operational routes**

For documents, deadlines, board, registers, organisation, team, billing, and export, use shared UI primitives, consistent form actions, mobile layouts, empty states, disabled states, and safe errors.

- [ ] **Step 4: Verify dashboard workflows**

Run:

```powershell
npm run test -w @charitypilot/web
cd e2e
npm test -- --grep "dashboard|compliance|documents|deadlines|team|billing|Accessibility"
```

Expected: core dashboard journeys pass and changed routes are axe-clean in both themes.

---

### Task 7: Backend Dependency And Production Posture Review

**Files:**
- Modify dependency files only when the upgrade is selected and tested.
- Modify: `docs/DEPENDENCIES.md` if dependency decisions are documented there.
- Modify: `docs/product-revamp/backend-audit.md`

- [ ] **Step 1: Recheck production vulnerabilities**

Run:

```powershell
npm audit --omit=dev --audit-level=moderate
```

Expected: zero moderate-or-higher production vulnerabilities or a documented mitigation.

- [ ] **Step 2: Review outdated dependencies**

Run:

```powershell
npm outdated --workspaces --long
```

Expected: `docs/product-revamp/backend-audit.md` classifies each relevant upgrade as patch/minor safe, major migration, or defer.

- [ ] **Step 3: Apply only justified upgrades**

Apply patch/minor upgrades first. Major migrations, including HeroUI v3, Prisma 7, Zod 4, Fastify plugin major versions, Stripe major versions, and Resend major versions, require separate migration plans and compatibility tests.

- [ ] **Step 4: Run full verification after upgrades**

Run:

```powershell
npm run lint
npm run test
npm run build -w @charitypilot/shared
npm run build -w @charitypilot/api
npm run build -w @charitypilot/web
npm audit --omit=dev --audit-level=moderate
```

Expected: all commands pass before dependency changes are kept.

---

### Task 8: Final Verification And Report

**Files:**
- Create: `docs/product-revamp/final-report.md`
- Modify: `docs/RELIABILITY.md` only if the reliability ledger is regenerated.
- Modify: `docs/architecture/09-frontend.md`
- Modify: `docs/architecture/08-governance-domain.md`
- Modify: `docs/SECURITY-REVIEW.md` only if backend trust posture changes need a new note.

- [ ] **Step 1: Run full code verification**

Run:

```powershell
npm run lint
npm run test
npm run build -w @charitypilot/shared
npm run build -w @charitypilot/api
npm run build -w @charitypilot/web
npm audit --omit=dev --audit-level=moderate
npm run reliability:report -- --json
```

Expected: all commands pass and reliability remains green.

- [ ] **Step 2: Run browser verification**

Run Playwright against the key pages at desktop and mobile sizes in both themes:

- `/`
- `/pricing`
- `/login`
- `/dashboard`
- `/compliance`
- `/compliance/[principleId]`
- `/documents`
- `/deadlines`
- `/board`
- `/registers`
- `/organisation`
- `/team`
- `/billing`
- `/export`

Expected: no blank pages, no text overlap, no dark-mode contrast regressions, no broken auth/dashboard flows, and no horizontal mobile overflow.

- [ ] **Step 3: Write final report**

`docs/product-revamp/final-report.md` must include:

- exact changed files;
- verification commands and results;
- screenshots/evidence location;
- official sources used and date checked;
- legal/professional-review items remaining;
- backend risk decisions;
- dependency decisions;
- known launch items still governed by `PRODUCTION_TODO.md`.

- [ ] **Step 4: Do not overclaim**

Run:

```powershell
rg -n "100% legally|legally bombproof|substitute for legal advice|guaranteed compliant" apps docs packages
```

Expected: no product copy claims legal certainty. Mentions in this spec/plan are acceptable only as prohibitions.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-03-charitypilot-full-product-revamp.md`. Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per phase, review between phases, and keep each patch small.
2. **Inline Execution** - execute phases in this session using executing-plans with checkpoints between route families.

Choose the execution mode before implementing code.
