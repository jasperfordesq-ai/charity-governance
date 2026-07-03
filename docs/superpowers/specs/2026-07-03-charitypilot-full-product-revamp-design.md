# CharityPilot Full Product Revamp Design

## Purpose

CharityPilot should become a polished, intuitive, trustworthy, production-grade Irish charity governance platform. The revamp should improve the whole product experience, not only isolated screens: first-class light and dark modes, accessible UI, coherent workflows, source-cited governance content, and backend behaviour that reinforces evidence-led compliance.

The target user is a trustee, charity administrator, CEO, chair, secretary, or governance lead in an Irish registered charity. The product should help them understand what evidence is missing, what decisions need board approval, what records should be kept, and what is ready for regulator or solicitor review.

## Legal Position

Do not describe CharityPilot as legally guaranteed, "100% legally bombproof", or a substitute for professional legal advice. The product should be review-ready: source-cited, transparent about assumptions, and explicit about areas that need solicitor, accountant, safeguarding, employment, data-protection, or governance-expert sign-off.

The product should make it hard for users to miss governance evidence, annual reporting/accounting duties, board approvals, trustee records, document retention, financial controls, fundraising controls, and relevant non-charity-law obligations. It should not pretend that software alone completes a charity's legal duties.

## Approved Direction

Use a trust-led phased revamp:

1. Build a coherent UI system for app pages, auth pages, marketing pages, states, forms, tables, empty states, errors, alerts, toasts, and review banners.
2. Make light and dark modes first-class across the whole product, including marketing and auth surfaces unless a later design decision explicitly limits them.
3. Turn governance work into clear workflows: onboarding, organisation setup, compliance-year selection, simple/complex classification, evidence capture, document linking, board sign-off, registers, annual return readiness, exports, and team permissions.
4. Build a source-cited Irish governance compliance matrix that maps product features to the Charities Governance Code, Compliance Record Form evidence, documents, board minutes, registers, statutory duties, and professional-review flags.
5. Tighten backend behaviour where it protects trust: validation, approval gates, exports, tenant isolation, role guards, rate limits, logging redaction, scheduled jobs, readiness checks, storage, billing gates, and dependency/security posture.
6. Verify each slice with automated checks and browser/a11y evidence before claiming completion.

## Current Repo Baseline

Repository: `C:\platforms\htdocs\CharityPilot`

Canonical GitHub repository: `https://github.com/jasperfordesq-ai/charity-governance`

Stack:

- Next.js 16 app router, React 19, Tailwind CSS 4, HeroUI v2 in `apps/web`.
- Fastify 5, Prisma 6, PostgreSQL, Supabase Storage, Stripe, Resend, Zod in `apps/api`.
- Shared schemas and governance constants in `packages/shared`.
- Playwright E2E, axe accessibility checks, reliability ledger, production preflight, security scan scripts, release gate scripts.

Existing route groups:

| Surface | Routes |
| --- | --- |
| Marketing | `/`, `/features`, `/pricing`, `/blog`, `/blog/[slug]`, `/privacy`, `/terms` |
| Auth | `/login`, `/register`, `/verify-email`, `/forgot-password`, `/reset-password`, `/accept-invite` |
| App | `/dashboard`, `/compliance`, `/compliance/[principleId]`, `/documents`, `/deadlines`, `/board`, `/registers`, `/regulator`, `/organisation`, `/team`, `/billing`, `/export` |

Existing architecture docs to preserve and update:

- `docs/architecture/01-system-overview.md`
- `docs/architecture/03-data-model.md`
- `docs/architecture/04-request-lifecycle.md`
- `docs/architecture/06-document-storage.md`
- `docs/architecture/08-governance-domain.md`
- `docs/architecture/09-frontend.md`
- `docs/SECURITY-REVIEW.md`
- `docs/RELIABILITY.md`
- `PRODUCTION_TODO.md`

Existing strengths:

- Strong API tenant isolation and auth/session model.
- HTTP-only auth cookies and refresh-token rotation.
- Shared Zod validation.
- Private document storage through signed URLs.
- Reliability ledger with API and web guarantees.
- Production launch/check scripts and external-evidence model.
- Governance Code constants already contain all 6 principles, 32 core standards, and 17 additional standards.

Current revamp risks:

- Dashboard route files are large and visually inconsistent.
- Marketing and auth layouts are currently light-only.
- UI primitives are scattered; there is no comprehensive app design system layer.
- Manual inline SVGs and inconsistent decorative styles appear in public and app pages.
- Some form validation and evidence prompts are server-authoritative but not always intuitive client-side.
- Compliance `NOT_APPLICABLE` and `EXPLAIN` can be drafted without explanation; approval should require explanation before board sign-off.
- The product needs a source-cited Irish governance matrix rather than implicit guidance embedded only in copy.

## Official Sources To Verify At Start Of Each Legal/Compliance Slice

These sources were checked on 2026-07-03 and should be rechecked before legal-content implementation because law and regulator guidance can change.

| Area | Current official source |
| --- | --- |
| Charities Governance Code | Charities Regulator, `https://www.charitiesregulator.ie/en/information-for-charities/charities-governance-code` and Code PDF `https://www.charitiesregulator.ie/media/fpbnz5xz/charities-governance-code.pdf` |
| Toolkit/templates | Charities Regulator toolkit and templates, `https://www.charitiesregulator.ie/en/information-for-charities/charities-governance-code/toolkit-and-templates` |
| Compliance Record Form | Charities Regulator forms page, `https://www.charitiesregulator.ie/en/guidance/forms-and-templates/forms` |
| Annual report | Charities Regulator register updates page, `https://www.charitiesregulator.ie/en/information-for-charities/updating-the-register-of-charities` |
| Charities Act 2009, revised | Law Reform Commission revised act PDF, `https://revisedacts.lawreform.ie/eli/2009/act/6/revised/en/pdf?annotations=false` |
| Charities Act 2009 amendments | Irish Statute Book effects table, `https://www.irishstatutebook.ie/eli/isbc/2009_6.html` |
| Charities (Amendment) Act 2024 | Irish Statute Book enacted act, `https://www.irishstatutebook.ie/eli/2024/act/21/enacted/en/html` |
| Commencement status | Irish Statute Book commencement table, `https://www.irishstatutebook.ie/eli/isbc/commence.html` and S.I. No. 10 of 2025 |
| Trustee duties | Charities Regulator charity trustee guidance, `https://www.charitiesregulator.ie/en/information-for-charities/being-a-charity-trustee` |
| Data protection | Data Protection Commission organisations guidance, `https://www.dataprotection.ie/en/organisations` |
| Health and safety | Health and Safety Authority safety statement guidance, `https://www.hsa.ie/topics/managing_health_and_safety/safety_statement_and_risk_assessment/` |
| Safeguarding | Tusla relevant services and Child Safeguarding Statement guidance, `https://www.tusla.ie/children-first/child-safeguarding-statement-compliance-unit-csscu/relevant-services-CSS/` |
| Protected disclosures | Workplace Relations Commission whistleblowing guidance, `https://www.workplacerelations.ie/en/what_you_should_know/employer-obligations/protection-of-whistleblowers/` |

Known source nuance as of 2026-07-03:

- The Law Reform Commission revised Charities Act 2009 PDF states it was updated to 22 April 2026 and that changes known to be in force as of 24 June 2026 were included.
- The Irish Statute Book effects table shows many Charities (Amendment) Act 2024 effects as not yet commenced and requiring commencement under section 1(2). The matrix must represent commenced and not-yet-commenced obligations separately.
- The Charities Regulator annual reporting guidance says a charity must submit an Annual Report within 10 months of the end of its financial year.
- GDPR, employment, equality, health and safety, safeguarding, and protected-disclosure obligations should be modelled as conditional relevance flags, not universal charity-law requirements for every charity.

## Master Prompt

Use this prompt when starting the implementation session:

```text
You are working in the CharityPilot monorepo at C:\platforms\htdocs\CharityPilot. The canonical GitHub repository is https://github.com/jasperfordesq-ai/charity-governance.

Goal:
Deliver a full-stack product revamp that makes CharityPilot feel polished, intuitive, trustworthy, and production-grade for Irish registered charities. Improve the whole platform: UI/UX, light and dark modes, accessibility, workflows, backend robustness, and source-cited Irish governance compliance content.

Legal constraint:
Do not claim CharityPilot is "100% legally bombproof" or a substitute for legal advice. Build a review-ready platform instead: cite official sources, document assumptions, show commencement status, flag areas needing solicitor/governance-expert/accountant/safeguarding/data-protection/employment review, and make required evidence, filings, records, board approvals, and deadlines difficult to miss.

Current stack:
Next.js 16, React 19, Tailwind CSS 4, HeroUI v2, Fastify 5, Prisma 6, PostgreSQL, shared Zod schemas, Supabase Storage, Stripe billing, Resend email, Playwright/axe E2E, reliability ledger, production preflight and security scripts.

Research first:
Before implementing legal/compliance content, verify current official Irish sources:
- Charities Regulator Governance Code, toolkit/templates, and Compliance Record Form.
- Charities Act 2009 as revised.
- Charities (Amendment) Act 2024 and commencement status.
- Trustee duties, annual reporting/accounting duties, fundraising guidance, financial controls guidance.
- Relevant conditional obligations: GDPR, employment, equality, health and safety, safeguarding, protected disclosures.

Repo inspection first:
Read the existing architecture docs, reliability/security docs, Prisma schema, shared governance constants, shared schemas, API services/routes, route layouts, and every page route. Preserve existing user changes and do not rewrite unrelated systems.

UI/UX objective:
Audit and polish every route and state:
- marketing: /, /features, /pricing, /blog, /blog/[slug], /privacy, /terms;
- auth: /login, /register, /verify-email, /forgot-password, /reset-password, /accept-invite;
- app: /dashboard, /compliance, /compliance/[principleId], /documents, /deadlines, /board, /registers, /regulator, /organisation, /team, /billing, /export;
- global loading, error, not-found, empty, disabled, validation, toasts, modals, mobile, and no-data states.

Design direction:
Create a coherent CharityPilot product system using Tailwind/HeroUI properly:
- reusable page shells, page headers, section headers, field groups, stat cards, evidence cards, status chips, review banners, empty states, loading skeletons, error panels, tables/lists, form actions, toolbar/actions, and app navigation;
- first-class light and dark modes across the whole platform with accessible contrast;
- restrained, professional, trust-led visual design suited to SaaS governance work;
- no decorative gradient orbs or unfinished stock-like visuals;
- use familiar icons for controls where appropriate;
- no text overlap, no horizontal mobile overflow, no awkward hero-scale type in compact UI surfaces.

Product workflow objective:
Make the platform intuitive for trustees and charity administrators:
- onboarding and charity setup;
- financial year and compliance year selection;
- simple vs complex classification;
- compliance evidence capture;
- document upload and linking;
- board review and sign-off;
- deadlines and annual return readiness;
- board/trustee records;
- conflicts, risks, complaints, fundraising, financial controls, annual report readiness;
- export/report generation;
- team permissions and billing gates;
- regulator-readiness view.

Compliance matrix objective:
Create a source-cited Irish charity governance compliance matrix that maps CharityPilot features to:
- the six Governance Code principles;
- all core and additional standards;
- Compliance Record Form evidence needs;
- expected governance documents;
- board approvals/minutes;
- registers;
- statutory annual reporting/accounting/document-retention duties;
- conditional obligations and professional-review flags.

Backend objective:
Review and improve API, schemas, Prisma models, tenant isolation, auth/session handling, role guards, rate limits, validation, error responses, logging redaction, Supabase document storage, scheduled jobs, reminders, exports, billing gates, health/readiness checks, backup/restore assumptions, dependency posture, and production config. Upgrade dependencies or code only where justified by security, reliability, maintainability, or stack alignment.

High-value backend change:
Before a Compliance Record can be marked APPROVED, require every in-scope standard with status NOT_APPLICABLE or EXPLAIN to have a non-empty explanation. Keep draft editing flexible; enforce completeness at approval/export readiness.

Implementation approach:
Work in small verifiable phases. Start with inventory and research. Create the compliance matrix and shared UI system before rewriting every page. Convert one route family at a time, preserving existing behavior and tests. Add focused tests for changed behavior. Keep the reliability ledger green.

Verification:
Run relevant lint, type checks, tests, builds, npm audit, accessibility checks in both themes, and Playwright screenshots at desktop and mobile sizes for key pages. Verify no blank pages, no text overlap, no dark-mode contrast regressions, no broken auth/dashboard flows, no tenant isolation regressions, no backend contract drift, and no legal claims beyond review-ready source-cited guidance.

Final report:
Summarize changed files, tests run, browser/a11y evidence, dependency/security changes, remaining legal-review items, and exact official sources used.
```

## Compliance Matrix Data Shape

Create a source-cited matrix in shared/domain code and render it in the product. The data model should include these fields:

| Field | Purpose |
| --- | --- |
| `id` | Stable matrix id, for example `code-4.2-legal-register` |
| `sourceRefs` | Official source names, URLs, section/page notes, and last-checked date |
| `commencementStatus` | `in_force`, `not_commenced`, `conditional`, or `guidance` |
| `principleNumbers` | One or more Governance Code principle numbers |
| `standardCodes` | Core/additional standard codes such as `4.2` or `6.4` |
| `featureArea` | Product area, such as compliance, documents, board, registers, deadlines, export |
| `userTask` | Plain-language task the user must complete |
| `evidenceRequired` | Evidence prompts, documents, register records, or board minutes |
| `boardApproval` | Required, recommended, conditional, or not applicable |
| `professionalReview` | Flags for solicitor, accountant, data protection, employment, safeguarding, health and safety, or other review |
| `copyTone` | Plain-language UI copy or prompt wording |
| `testExpectation` | Behaviour that must be proven by tests or QA |

## UI Acceptance Criteria

- Light and dark mode work on marketing, auth, and app surfaces.
- Every route has polished loading, empty, error, disabled, validation, and mobile states.
- Navigation is predictable and makes the current workflow obvious.
- Dashboard routes use shared UI primitives instead of one-off visual patterns.
- Dense operational pages remain scan-friendly and avoid marketing-style hero composition.
- Typography and spacing are consistent.
- All text meets contrast requirements in both themes.
- Forms show helpful inline validation and do not lose data on failed saves.
- Trustee/admin users can understand what to do next without reading long instructions.

## Backend Acceptance Criteria

- Tenant isolation remains enforced server-side; no route trusts organisation ids from the client.
- Role guards remain server-authoritative and are covered by tests where behaviour changes.
- Validation remains shared or contract-tested; approval/export completeness adds tests.
- `NOT_APPLICABLE` and `EXPLAIN` records require explanations before annual sign-off approval.
- Exports identify missing evidence and review flags clearly.
- Document storage remains private and signed-url based.
- Billing gates and degradation states remain safe.
- Health/readiness checks remain explicit about provider configuration.
- Production config and dependency upgrades are evidence-led, not churn.

## Verification Targets

Minimum verification for a phase that changes code:

- `npm run lint`
- `npm run test`
- `npm run build -w @charitypilot/shared`
- `npm run build -w @charitypilot/api`
- `npm run build -w @charitypilot/web`
- `npm audit --omit=dev --audit-level=moderate`
- `npm run reliability:report -- --json`
- Playwright/axe checks for changed routes in light and dark mode
- Desktop and mobile screenshots for changed route families

For documentation-only phases, run `git diff --check` and targeted `rg` checks proving required source links, disclaimers, and acceptance criteria are present.

## Out Of Scope

- Do not give legal advice.
- Do not mark the platform legally complete without professional review.
- Do not claim production launch is complete without the external launch evidence in the existing production checklist.
- Do not migrate to major new library versions unless the migration is separately planned and verified.
- Do not replace working backend foundations for aesthetic reasons.
- Do not remove existing reliability/security checks.

## Completion Standard

The revamp is complete only when the product is polished across every route and state, the compliance matrix is source-cited and review-ready, backend changes are implemented and tested, light/dark accessibility evidence exists, and the final report names remaining professional-review items and exact sources used.

Until then, report completed phases and open risks rather than declaring the full revamp finished.
