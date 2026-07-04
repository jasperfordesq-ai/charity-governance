# CharityPilot Platform Completion Audit

Generated: 2026-07-04

Branch: `master`

Working-tree base commit when generated: `9300783`

Generation note: inspect `git status` before release because this report is committed as part of the audit work.

This ledger is a current-state engineering audit. It is not legal advice and does not claim CharityPilot is legally complete, guaranteed, or ready to process real charity data.

## Executive Readiness

| Area | Current state | Next action |
| --- | --- | --- |
| Product UI | 25 page routes scanned; 15 are P0 trustee/compliance workflows; 0 route files are 450+ lines. | Complete deployed browser QA for every route across desktop/mobile and both themes. |
| API/backend | 12 route groups scanned with route-local guard heuristics and 44 API test files. | Preserve auth, tenant isolation, role guards, plan gates, validation, and redaction while fixing only audit-backed defects. |
| Launch operations | .env.production exists but 23 value(s) still need real data. | Complete external provider, hosting, backup, observability, legal, browser QA, and security evidence before real charity data. |
| Irish compliance model | 12 matrix entries; last checked 2026-07-03; statuses guidance:6, conditional:3, not_commenced:2, in_force:1. | Refresh official sources before legal copy changes and record professional-review signoff outside git. |
| Verification surface | 16 web unit test files, 44 API test files, 11 Playwright specs. | Run full release, production-check, accessibility, and deployed-browser gates before launch signoff. |

## Fixed During This Audit Pass

- Strict shared ISO date validation now rejects impossible calendar dates before they can normalize into filing, board, document, register, or deadline records.
- Organisation profile date changes and derived auto-deadline regeneration now run inside one Prisma transaction.
- Document storage paths now include a UUID segment to avoid same-millisecond same-filename collisions.
- Stripe customer creation now uses an organisation-scoped idempotency key to reduce orphan/duplicate external customers after retries.
- Stripe checkout now reconciles an existing Stripe customer by organisation metadata before creating a new customer.
- Sensitive auth and invite throttles now use body-aware identifier keys for email or token attempts while preserving request-level protection where needed.
- Optional in-process cron logging now serializes errors through the redacted logger helper.
- Compliance/export/dashboard aggregate progress labels now say recorded progress rather than implying legal compliance certification.
- API-rendered exports now include a source/professional-review appendix and a not-legal-advice/non-certificate disclaimer.
- Compliance detail autosave now flushes pending edits on blur/unmount, warns on browser unload, confirms in-app navigation while saves are pending, and exposes a retry action for failed saves.
- Production deploy defaults now include the TLS compose overlay, with an explicit --no-tls-proxy escape hatch for managed platform TLS.
- Production hostname defaults and launch/runtime validators now consistently require app.charitypilot.ie for the web app and api.charitypilot.ie for the API.
- The Irish compliance matrix now includes explicit not-yet-commenced Charities (Amendment) Act 2024 monitoring rows with solicitor review flags.
- Organisation setup now captures conditional obligation profile facts for staff, volunteers, fundraising, safeguarding, GDPR, premises/events, public-sector context, and processors.
- Approval readiness and exports now flag missing standard records, missing action/evidence fields, missing explanations, missing conditional-profile facts, and profile-triggered professional-review prompts.
- Dashboard navigation now gives the mobile sidebar explicit ARIA controls, Escape-to-close focus recovery, non-tabbable closed mobile links, and source-backed principle breadcrumb labels.
- Dashboard, compliance, compliance detail, and export route chrome now use lucide-react status, chevron, and download icons instead of route-local inline SVG markup behind a wiring regression test.
- Auth routes now use lucide-react password visibility, validation, mail, and alert icons instead of route-local inline SVG markup behind a wiring regression test.
- Marketing routes now use lucide-react feature, pricing, FAQ, and share/navigation icons instead of route-local inline SVG markup behind a wiring regression test.
- Documents now surface profile-triggered evidence prompts from the conditional obligation profile, including linked standard counts, source references, and professional-review flags.
- The document upload modal and oversize-file guard UI are split out of the oversized documents route behind a wiring regression test.
- The document standard-link modal is split out of the oversized documents route behind a wiring regression test.
- The document delete confirmation modal is split out of the oversized documents route behind a wiring regression test.
- The uploaded-document list panel is split out of the oversized documents route behind a wiring regression test.
- The document workflow loading, organisation-profile prompts, upload/link/delete/download mutations, and trusted download handling are split into a route-local hook behind a wiring regression test.
- Deadlines now surface profile-triggered review-date prompts from the conditional obligation profile, including source references, professional-review flags, and one-click review deadline prefills.
- The regulator guide now prioritises conditional obligation profile triggers with source references, workflow areas, and professional-review flags without legal-certainty claims.
- Governance registers now prioritise conditional obligation profile triggers with register-evidence signals, source references, and professional-review flags.
- The register profile-priority model and panel are split out of the oversized registers route behind a wiring regression test.
- The register Annual Report readiness and financial control review cards are split out of the oversized registers route behind a wiring regression test.
- The register overview summary panel and metric tiles are split out of the oversized registers route behind a wiring regression test.
- The register modal record forms and payload normaliser are split out of the oversized registers route behind a wiring regression test.
- The register record modal shell is split out of the oversized registers route behind a wiring regression test.
- The register operational record list sections are split out of the oversized registers route behind a wiring regression test.
- The register workflow loading, stale-request guard, save mutations, and priority derivation are split into a route-local hook behind a wiring regression test.
- The compliance principle standard editor card and save-state UI are split out of the oversized compliance detail route behind a wiring regression test.
- The document profile-triggered evidence prompt model and panel are split out of the oversized documents route behind a wiring regression test.
- The deadline profile-triggered review-date prompt model and panel are split out of the oversized deadlines route behind a wiring regression test.
- The deadline add/edit form modal is split out of the oversized deadlines route behind a wiring regression test.
- The deadline list panel, status classifier, and summary helper are split out of the oversized deadlines route behind a wiring regression test.
- The board trustee evidence prompt cards and evidence chips are split out of the oversized board route behind a wiring regression test.
- The board member add/edit modal is split out of the oversized board route behind a wiring regression test.
- The board member list, mobile cards, desktop table, and status-toggle states are split out of the oversized board route behind a wiring regression test.
- The export report preview cards and score helpers are split out of the oversized export route behind a wiring regression test.
- The primary add actions on documents, board, and deadlines now use lucide-react Plus icons instead of route-local inline SVG markup behind a wiring regression test.
- The organisation conditional-obligation profile fields are split out of the oversized organisation route behind a wiring regression test.
- The organisation profile form section is split out of the oversized organisation route behind a wiring regression test.
- The dashboard deadline and board-alert action lists are split out of the oversized dashboard route behind a wiring regression test.
- The board review-ready summary panel is split out of the oversized board route behind a wiring regression test.
- Responsive browser-smoke coverage now enumerates every shipped page route across desktop/mobile and light/dark themes, with a guard against reverting to network-idle waits that hang on dev-only noise.
- Regulator official-source links now use compact link styling instead of pill-badge styling behind a wiring regression test.
- The platform audit now distinguishes decorative pill styling from functional switches and status dots so visual QA findings stay actionable.
- The platform audit now scans route-local extracted UI components when assessing static route-level visual and dark-mode signals.

## Independent Audit Findings Still Driving Next Work

| Priority | Area | Finding |
| --- | --- | --- |
| P0 | Production launch | Launch evidence remains a template and .env.production still has placeholders; real provider, hosting, backup, observability, legal, browser QA, and pentest evidence are external blockers. |
| P1 | Frontend polish | No route files remain over 450 lines, route page inline SVG findings are closed, and route-surface static dark-mode/decorative findings are clear; deployed browser and accessibility evidence remain. |

## Route Audit

| Priority | Route | Area | File | Lines | Client | Static audit finding |
| --- | --- | --- | --- | ---: | --- | --- |
| P0 | `/` | marketing | `apps/web/src/app/(marketing)/page.tsx` | 364 | no | no obvious static risk; verify in browser |
| P1 | `/accept-invite` | auth | `apps/web/src/app/(auth)/accept-invite/page.tsx` | 158 | yes | no obvious static risk; verify in browser |
| P0 | `/billing` | dashboard | `apps/web/src/app/(dashboard)/billing/page.tsx` | 367 | yes | no obvious static risk; verify in browser |
| P2 | `/blog` | marketing | `apps/web/src/app/(marketing)/blog/page.tsx` | 33 | no | no obvious static risk; verify in browser |
| P2 | `/blog/[slug]` | marketing | `apps/web/src/app/(marketing)/blog/[slug]/page.tsx` | 187 | no | no obvious static risk; verify in browser |
| P0 | `/board` | dashboard | `apps/web/src/app/(dashboard)/board/page.tsx` | 258 | yes | no obvious static risk; verify in browser |
| P0 | `/compliance` | dashboard | `apps/web/src/app/(dashboard)/compliance/page.tsx` | 359 | yes | no obvious static risk; verify in browser |
| P0 | `/compliance/[principleId]` | dashboard | `apps/web/src/app/(dashboard)/compliance/[principleId]/page.tsx` | 397 | yes | no obvious static risk; verify in browser |
| P0 | `/dashboard` | dashboard | `apps/web/src/app/(dashboard)/dashboard/page.tsx` | 435 | yes | no obvious static risk; verify in browser |
| P0 | `/deadlines` | dashboard | `apps/web/src/app/(dashboard)/deadlines/page.tsx` | 394 | yes | no obvious static risk; verify in browser |
| P0 | `/documents` | dashboard | `apps/web/src/app/(dashboard)/documents/page.tsx` | 253 | yes | no obvious static risk; verify in browser |
| P0 | `/export` | dashboard | `apps/web/src/app/(dashboard)/export/page.tsx` | 399 | yes | no obvious static risk; verify in browser |
| P1 | `/features` | marketing | `apps/web/src/app/(marketing)/features/page.tsx` | 252 | no | no obvious static risk; verify in browser |
| P1 | `/forgot-password` | auth | `apps/web/src/app/(auth)/forgot-password/page.tsx` | 107 | yes | no obvious static risk; verify in browser |
| P0 | `/login` | auth | `apps/web/src/app/(auth)/login/page.tsx` | 138 | yes | no obvious static risk; verify in browser |
| P0 | `/organisation` | dashboard | `apps/web/src/app/(dashboard)/organisation/page.tsx` | 353 | yes | no obvious static risk; verify in browser |
| P0 | `/pricing` | marketing | `apps/web/src/app/(marketing)/pricing/page.tsx` | 259 | no | no obvious static risk; verify in browser |
| P1 | `/privacy` | marketing | `apps/web/src/app/(marketing)/privacy/page.tsx` | 278 | no | no obvious static risk; verify in browser |
| P0 | `/register` | auth | `apps/web/src/app/(auth)/register/page.tsx` | 270 | yes | no obvious static risk; verify in browser |
| P0 | `/registers` | dashboard | `apps/web/src/app/(dashboard)/registers/page.tsx` | 180 | yes | no obvious static risk; verify in browser |
| P0 | `/regulator` | dashboard | `apps/web/src/app/(dashboard)/regulator/page.tsx` | 396 | yes | no obvious static risk; verify in browser |
| P1 | `/reset-password` | auth | `apps/web/src/app/(auth)/reset-password/page.tsx` | 194 | yes | no obvious static risk; verify in browser |
| P1 | `/team` | dashboard | `apps/web/src/app/(dashboard)/team/page.tsx` | 401 | yes | no obvious static risk; verify in browser |
| P1 | `/terms` | marketing | `apps/web/src/app/(marketing)/terms/page.tsx` | 257 | no | no obvious static risk; verify in browser |
| P1 | `/verify-email` | auth | `apps/web/src/app/(auth)/verify-email/page.tsx` | 200 | yes | no obvious static risk; verify in browser |

## API And Backend Audit

| Route group | File | Lines | Guard signals | Nearby tests | Audit note |
| --- | --- | ---: | --- | ---: | --- |
| `auth` | `apps/api/src/routes/auth/index.ts` | 211 | public/partial by design | 6 | preserve current guard and tenant boundary |
| `billing` | `apps/api/src/routes/billing/index.ts` | 88 | auth, owner actions | 2 | preserve current guard and tenant boundary |
| `board-members` | `apps/api/src/routes/board-members/index.ts` | 64 | auth, subscription, admin writes | 2 | preserve current guard and tenant boundary |
| `compliance` | `apps/api/src/routes/compliance/index.ts` | 148 | auth, subscription, admin writes | 2 | preserve current guard and tenant boundary |
| `dashboard` | `apps/api/src/routes/dashboard/index.ts` | 95 | auth, subscription | 1 | preserve current guard and tenant boundary |
| `deadlines` | `apps/api/src/routes/deadlines/index.ts` | 64 | auth, subscription, admin writes | 3 | preserve current guard and tenant boundary |
| `documents` | `apps/api/src/routes/documents/index.ts` | 382 | auth, subscription, admin writes | 3 | preserve current guard and tenant boundary |
| `export` | `apps/api/src/routes/export/index.ts` | 461 | auth, subscription, plan gate | 2 | preserve current guard and tenant boundary |
| `governance-registers` | `apps/api/src/routes/governance-registers/index.ts` | 243 | auth, subscription, admin writes | 2 | preserve current guard and tenant boundary |
| `health` | `apps/api/src/routes/health/index.ts` | 82 | public/partial by design | 2 | preserve current guard and tenant boundary |
| `organisations` | `apps/api/src/routes/organisations/index.ts` | 39 | auth, subscription, admin writes | 3 | preserve current guard and tenant boundary |
| `team` | `apps/api/src/routes/team/index.ts` | 113 | auth, subscription | 2 | preserve current guard and tenant boundary |

## Launch Evidence Blockers

- Real production secrets and provider values are not committed and must be supplied from the operator secret store.
- Production hosting, DNS, TLS, reverse proxy, and public HTTPS smoke evidence remain external launch gates.
- Production PostgreSQL backup and restore evidence is required before real charity data.
- Production Supabase private bucket, signed URL, backup, and restore evidence is required.
- Stripe live products/prices/webhook and Resend sender-domain evidence are required.
- Observability, uptime checks, alert routing, incident owner, and test-alert evidence are required.
- Solicitor/governance/privacy review and external penetration test are required before real charity data.

### Local Production Environment Placeholders

The local non-committed production env still needs 23 real value(s):

- `TRUSTED_PROXY_ADDRESSES`
- `DATABASE_URL`
- `FRONTEND_URL`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- `STRIPE_ESSENTIALS_MONTHLY_PRICE_ID`
- `STRIPE_ESSENTIALS_YEARLY_PRICE_ID`
- `STRIPE_COMPLETE_MONTHLY_PRICE_ID`
- `STRIPE_COMPLETE_YEARLY_PRICE_ID`
- `RESEND_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ERROR_ALERT_WEBHOOK_URL`
- `NEXT_PUBLIC_API_URL`
- `NEXT_PUBLIC_SUPABASE_URL`
- `CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL`
- `CHARITYPILOT_WEB_NEXT_PUBLIC_SUPABASE_URL`
- `CHARITYPILOT_API_IMAGE`
- `CHARITYPILOT_WEB_IMAGE`
- `CHARITYPILOT_MIGRATION_IMAGE`
- `CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL`
- `CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_SUPABASE_URL`

## Irish Compliance Source Posture

The matrix must stay source-cited and review-ready. The following official sources were used as the current verification set for this audit; refresh them again before production legal signoff.

| Source | Owner | URL |
| --- | --- | --- |
| Charities Governance Code | Charities Regulator | https://www.charitiesregulator.ie/en/information-for-charities/charities-governance-code |
| Toolkit and templates | Charities Regulator | https://www.charitiesregulator.ie/en/information-for-charities/charities-governance-code/toolkit-and-templates |
| Compliance Record Form | Charities Regulator | https://www.charitiesregulator.ie/en/guidance/forms-and-templates/forms |
| Annual report submission guidance | Charities Regulator | https://www.charitiesregulator.ie/en/information-for-charities/annual-report-how-to-submit |
| Charities Act 2009 revised | Law Reform Commission | https://revisedacts.lawreform.ie/eli/2009/act/6/front/revised/en/html |
| Charities (Amendment) Act 2024 commencement table | Irish Statute Book | https://www.irishstatutebook.ie/isbc/2024_21.html |
| S.I. No. 10/2025 commencement order | Irish Statute Book | https://www.irishstatutebook.ie/eli/2025/si/10/made/en/print |
| GDPR accountability obligation | Data Protection Commission | https://www.dataprotection.ie/en/organisations/know-your-obligations/accountability-obligation |
| Safety Statement and Risk Assessment | Health and Safety Authority | https://www.hsa.ie/topics/managing_health_and_safety/safety_statement_and_risk_assessment/ |
| Child safeguarding statement relevance | Tusla | https://www.tusla.ie/children-first/organisations/what-is-a-child-safeguarding-statement/who-needs-to-have-a-child-safeguarding-statement/ |
| Protected disclosures employer obligations | Workplace Relations Commission | https://www.workplacerelations.ie/en/what_you_should_know/employer-obligations/protection-of-whistleblowers/new-obligations-under-the-protected-disclosures-amendment-act-2022/ |

## Next Completion Sequence

1. Close launch evidence: real secret store, provider accounts, hosting, DNS/TLS, backups, observability, release evidence, and external signoffs.
2. Complete deployed browser QA across every route in desktop/mobile and light/dark mode, then attach production-only evidence.
3. Convert remaining route-local state UI into shared primitives for loading, empty, error, locked-feature, review-warning, status, source, evidence, and sticky form actions.
4. Keep compliance source metadata, professional-review flags, and conditional obligation prioritisation review-ready across deadlines, registers, evidence, exports, and regulator workflows without creating legal-certainty claims.
5. Run deployed HTTPS browser QA, accessibility checks in both themes, tenant-isolation regression tests, document privacy checks, billing/email provider checks, and external penetration testing.
