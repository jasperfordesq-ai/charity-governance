# CharityPilot Platform Completion Audit

Generated: 2026-07-06

Branch: `master`

Working-tree base commit when generated: `7dae26e`

Generation note: inspect `git status` before release because this report is committed as part of the audit work.

This ledger is a current-state engineering audit. It is not legal advice and does not claim CharityPilot is legally complete, guaranteed, or ready to process real charity data.

## Executive Readiness

| Area | Current state | Next action |
| --- | --- | --- |
| Product UI | 25 page routes scanned; 15 are P0 trustee/compliance workflows; 0 route files are 450+ lines. | Complete deployed browser QA for every route across desktop/mobile and both themes. |
| API/backend | 12 route groups scanned with route-local guard heuristics and 44 API test files. | Preserve auth, tenant isolation, role guards, plan gates, validation, and redaction while fixing only audit-backed defects. |
| Launch operations | .env.production exists but 23 value(s) still need real data. | Complete external provider, hosting, backup, observability, legal, browser QA, and security evidence before real charity data. |
| Irish compliance model | 12 matrix entries; last checked 2026-07-06; statuses guidance:6, conditional:3, not_commenced:2, in_force:1. | Refresh official sources before legal copy changes and record professional-review signoff outside git. |
| Verification surface | 16 web unit test files, 44 API test files, 11 Playwright specs. | Run full release, production-check, accessibility, and deployed-browser gates before launch signoff. |

## Fixed During This Audit Pass

- Strict shared ISO date validation now rejects impossible calendar dates before they can normalize into filing, board, document, register, or deadline records.
- Organisation profile date changes and derived auto-deadline regeneration now run inside one Prisma transaction.
- Document storage paths now include a UUID segment to avoid same-millisecond same-filename collisions.
- Stripe customer creation now uses an organisation-scoped idempotency key to reduce orphan/duplicate external customers after retries.
- Stripe checkout now reconciles an existing Stripe customer by organisation metadata before creating a new customer.
- Stored Stripe customer IDs are now verified against Stripe customer metadata before checkout or portal reuse, and stale or wrong-organisation IDs are repaired through metadata reconciliation.
- Sensitive auth and invite throttles now use body-aware identifier keys for email or token attempts while preserving request-level protection where needed.
- Refresh and logout throttles now key by hashed refresh-token identifiers from the request body or refresh cookie, so one token cannot exhaust the same-IP bucket for another token.
- Sensitive public auth and invite throttles now have regression coverage proving one email/token identifier does not block a different identifier from the same caller.
- Registration throttling now has regression coverage proving normalized email identifiers share a throttle bucket without blocking a different email from the same caller.
- Resend-verification throttling now keys by hashed bearer/access-cookie credentials at the request hook, so one invalid credential cannot burn the same-IP bucket for another credential.
- Optional in-process cron logging now serializes errors through the redacted logger helper.
- Deadline reminder and optional cron runtime logs now route through injectable logger contracts instead of direct console.log calls.
- Email delivery degradation logs now route through an injectable logger contract instead of direct console warn/error calls.
- Compliance/export/dashboard aggregate progress labels now say recorded progress rather than implying legal compliance certification.
- API-rendered exports now include a source/professional-review appendix and a not-legal-advice/non-certificate disclaimer.
- The export workflow now surfaces source counts, professional-review flags, and not-yet-commenced monitoring metadata before report generation or board sign-off.
- Compliance detail autosave now flushes pending edits on blur/unmount, warns on browser unload, confirms in-app navigation while saves are pending, and exposes a retry action for failed saves.
- Production deploy defaults now include the TLS compose overlay, with an explicit --no-tls-proxy escape hatch for managed platform TLS.
- Production hostname defaults and launch/runtime validators now consistently require app.charitypilot.ie for the web app and api.charitypilot.ie for the API.
- The Irish compliance matrix now includes explicit not-yet-commenced Charities (Amendment) Act 2024 monitoring rows with solicitor review flags.
- Organisation setup now captures conditional obligation profile facts for staff, volunteers, fundraising, safeguarding, GDPR, premises/events, public-sector context, and processors.
- Approval readiness and exports now flag missing standard records, missing action/evidence fields, missing explanations, missing conditional-profile facts, and profile-triggered professional-review prompts.
- Governance architecture and backend audit docs now describe the broadened approval-readiness model behind a production tooling regression test.
- Dashboard navigation now gives the mobile sidebar explicit ARIA controls, Escape-to-close focus recovery, non-tabbable closed mobile links, and source-backed principle breadcrumb labels.
- Dashboard, compliance, compliance detail, and export route chrome now use lucide-react status, chevron, and download icons instead of route-local inline SVG markup behind a wiring regression test.
- Auth routes now use lucide-react password visibility, validation, mail, and alert icons instead of route-local inline SVG markup behind a wiring regression test.
- Marketing routes now use lucide-react feature, pricing, FAQ, and share/navigation icons instead of route-local inline SVG markup behind a wiring regression test.
- Documents now surface profile-triggered evidence prompts from the conditional obligation profile, including linked standard counts, source references, and professional-review flags.
- The document summary panel is split out of the oversized documents route behind a wiring regression test while preserving successful-load gating.
- The document upload modal and oversize-file guard UI are split out of the oversized documents route behind a wiring regression test.
- The document standard-link modal is split out of the oversized documents route behind a wiring regression test.
- The document delete confirmation modal is split out of the oversized documents route behind a wiring regression test.
- The uploaded-document list panel is split out of the oversized documents route behind a wiring regression test.
- The document evidence-pack checklist and operational signal panels are split out of the documents route behind a wiring regression test.
- The document workflow loading, organisation-profile prompts, upload/link/delete/download mutations, and trusted download handling are split into a route-local hook behind a wiring regression test.
- Shared loading, empty, error, locked-feature, review-warning, and inline-status primitives now contain long text and actions within narrow/mobile layouts.
- Deadlines now surface profile-triggered review-date prompts from the conditional obligation profile, including source references, professional-review flags, and one-click review deadline prefills.
- The deadlines regulatory cadence panel now cites the Charities Regulator Annual Report source and last-checked metadata for the 10-month filing prompt.
- Deadline and regulator official-source links now share reusable source-reference primitives behind a wiring regression test.
- Regulator profile-triggered priority source links now use the shared source-reference primitive instead of route-local anchor styling.
- Profile-triggered document, deadline, register, regulator, and export prompts now render official sources as shared clickable source-reference lists.
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
- The compliance principle standard list is split out of the oversized compliance detail route behind a wiring regression test.
- The compliance principle loading and error states are split out of the oversized compliance detail route behind a wiring regression test.
- The compliance principle workflow hook now owns loading, autosave, approval-readiness refresh, and pending-navigation guards behind a wiring regression test.
- The document profile-triggered evidence prompt model and panel are split out of the oversized documents route behind a wiring regression test.
- The deadline profile-triggered review-date prompt model and panel are split out of the oversized deadlines route behind a wiring regression test.
- The deadline add/edit form modal is split out of the oversized deadlines route behind a wiring regression test.
- The deadline list panel, status classifier, and summary helper are split out of the oversized deadlines route behind a wiring regression test.
- The deadline overview and regulatory cadence panels are split out of the oversized deadlines route behind a wiring regression test.
- The deadline delete confirmation modal is split out of the deadlines route behind a wiring regression test.
- The deadline workflow loading, organisation-profile prompts, add/edit/delete/toggle mutations, and modal state are split into a route-local hook behind a wiring regression test.
- The board trustee evidence prompt cards and evidence chips are split out of the oversized board route behind a wiring regression test.
- The board member add/edit modal is split out of the oversized board route behind a wiring regression test.
- The board member list, mobile cards, desktop table, and status-toggle states are split out of the oversized board route behind a wiring regression test.
- The board workflow loading, summary derivation, add/edit/toggle mutations, and trustee form state are split into a route-local hook behind a wiring regression test.
- The export report preview cards and score helpers are split out of the oversized export route behind a wiring regression test.
- The export controls and readiness-warning panel are split out of the oversized export route behind a wiring regression test.
- The export board-approval form panel is split out of the oversized export route behind a wiring regression test.
- The export workflow loading, approval-readiness refresh, board sign-off mutation, report-opening state, and blocker derivation are split into a route-local hook behind a wiring regression test.
- The compliance principle evidence-readiness panel is split out of the oversized compliance detail route behind a wiring regression test.
- Compliance principle in-app navigation now uses a HeroUI save/leave confirmation modal instead of a bare browser confirm prompt.
- The primary add actions on documents, board, and deadlines now use lucide-react Plus icons instead of route-local inline SVG markup behind a wiring regression test.
- The organisation conditional-obligation profile fields are split out of the oversized organisation route behind a wiring regression test.
- The organisation profile form section is split out of the oversized organisation route behind a wiring regression test.
- The organisation complexity guidance modal is split out of the oversized organisation route behind a wiring regression test.
- The organisation setup summary panel is split out of the oversized organisation route behind a wiring regression test.
- The organisation workflow session hydration, dirty-state guard, validation, save mutation, and setup form state are split into a route-local hook behind a wiring regression test.
- The dashboard deadline and board-alert action lists are split out of the oversized dashboard route behind a wiring regression test.
- The dashboard annual sign-off and governance register summary cards are split out of the oversized dashboard route behind a wiring regression test.
- The dashboard overall progress and principle progress panels are split out of the oversized dashboard route behind a wiring regression test.
- The dashboard workflow API loading, approval-readiness fetch, subscription-lapse handling, and derived board-alert state are split into a route-local hook behind a wiring regression test.
- The compliance overview principle list and disclosure cards are split out of the oversized compliance route behind a wiring regression test.
- The compliance overview workflow API loading, approval-readiness fetch, year/filter state, and evidence-prompt derivation are split into a route-local hook behind a wiring regression test.
- The billing plan gates, Stripe checkout cards, and billing notes are split out of the oversized billing route behind a wiring regression test.
- The board review-ready summary panel is split out of the oversized board route behind a wiring regression test.
- Responsive browser-smoke coverage now enumerates every shipped page route across desktop/mobile and light/dark themes, with a guard against reverting to network-idle waits that hang on dev-only noise.
- Deployed browser QA mode now uses existing non-sensitive test credentials and skips direct database reset or token-injection seams.
- Regulator official-source links now use compact link styling instead of pill-badge styling behind a wiring regression test.
- Regulator official guidance cards now use the shared source-reference card primitive instead of route-local external-link card markup.
- The regulator profile-triggered priorities section is split out of the oversized regulator route behind a wiring regression test.
- The regulator readiness overview and operating-model cards are split out of the oversized regulator route behind a wiring regression test.
- The regulator source-cited readiness matrix is split out of the oversized regulator route behind a wiring regression test.
- The platform audit now distinguishes decorative pill styling from functional switches and status dots so visual QA findings stay actionable.
- The platform audit now scans route-local extracted UI components when assessing static route-level visual and dark-mode signals.
- Launch status now separates missing production env values from external launch evidence gates, including deployed QA, provider/backups/observability evidence, legal review, pentest, and final signoffs.
- Platform audit now records launch evidence ledger status so operators know whether the ignored external evidence file has been initialized before filling the 85 checks.
- Platform audit now surfaces launch evidence approval state, final signoff state, and the next incomplete checks from the ignored evidence ledger.
- Launch evidence status now reports final approval role progress separately from checklist completion so signoff gaps stay visible.
- Launch status and platform audit now group missing production values by provider/source so operator handoff is clearer.
- Launch status and production readiness TODO now name all 85 machine-readable launch evidence checks and the browserQa accessibility, cross-browser, and iOS Safari evidence slots.
- Production launch evidence now has a read-only status command that summarizes area-by-area completion without weakening the final validator.
- Production launch evidence initialization now writes the template to an ignored .charitypilot-launch-evidence directory to keep real launch evidence out of the repo root.
- Production launch evidence now requires legal/compliance final approval alongside engineering, operations, security, and business signoffs.
- Production launch evidence now requires named solicitor/governance/privacy review evidence inside the legal/compliance checklist area.
- Billing/email launch evidence now requires Stripe webhook subscription-event proof, webhook-secret secret-store proof, Resend accepted-send proof, and production email-link origin proof.
- Browser QA launch evidence now requires a dedicated deployed accessibility command transcript for light and dark theme checks.
- Deployed browser QA now has cross-browser responsive and accessibility script wiring for Chromium desktop, Chromium mobile emulation, Firefox, and WebKit evidence runs while keeping real iOS Safari as manual or cloud-device evidence.
- Supabase launch evidence now requires backup policy or PITR evidence and restore-test ownership in addition to private bucket, signed URL, and readiness proof.
- The team member list, role edit controls, loading/error/empty states, and shared role display metadata are split out of the team route behind a wiring regression test.
- The team invite form and pending-invite list are split out of the team route behind a wiring regression test while preserving invite role gates and revoke states.
- The team role guidance panel is split out of the team route behind a wiring regression test and now uses shared status panel styling.
- Team feedback now uses the shared inline status primitive instead of route-local alert styling.
- Dashboard shell loading and dashboard/compliance status dots now use shared UI primitives with dark-mode-aware semantic tones.
- Board and compliance binary filters now use HeroUI Switch controls instead of route-local switch markup.
- Deadline completion now uses a HeroUI Checkbox instead of a route-local button with checkbox ARIA.
- Export approval-readiness issue cards and conditional review prompts are split out of the route and now use shared status/review primitives instead of repeated warning-card markup.
- Organisation setup warning surfaces now use the shared inline status primitive instead of route-local amber advisory boxes.
- Organisation purpose and conditional-obligation checkbox groups now use HeroUI Checkbox controls instead of raw input controls.
- Organisation complexity selection now uses HeroUI RadioGroup controls instead of route-local pressed-button toggles.
- Board trustee conduct and induction evidence toggles now use HeroUI Checkbox controls instead of raw checkbox inputs.
- Register Annual Report and financial-control checklist rows now use HeroUI Checkbox controls instead of raw checkbox inputs.
- Compliance standard editor status rendering now tolerates optional selected-item labels during production builds.
- Compliance overview principle disclosure buttons now expose expanded state and controlled panel relationships for assistive technology.
- Auth password visibility controls now use a shared HeroUI icon-button primitive instead of repeated route-local raw buttons.
- Shared utility icon controls for theme switching, copying links, and back-to-top now use HeroUI Button semantics.
- Compliance principle back navigation and autosave retry controls now use HeroUI Button primitives.
- Public marketing navigation, blog filters, and cookie-consent actions now use HeroUI Button primitives with dark-mode mobile navigation styling.
- Global recovery, not-found, dashboard mobile-menu, and compliance disclosure actions now use HeroUI Button primitives instead of bespoke route-local action markup.
- Responsive browser-smoke QA now waits for the parsed document shell before applying light/dark theme checks after commit-stage navigations.
- Document uploads now use a shared HeroUI-backed file upload field instead of route-local file input styling.
- Marketing blog search and trial CTA now use HeroUI Input and Button primitives instead of route-local form/link styling.
- Billing plan-gate explanation tiles now use a shared status tile primitive instead of route-local tile markup.
- Billing plan feature lists and FAQ disclosure controls now use lucide-react Check and ChevronDown icons instead of decorative dot/text affordances.
- Dashboard primary actions now share dark-mode-aware action button styling instead of repeating route-local teal button classes.
- Public marketing and auth primary CTAs now share the same dark-mode-aware action styling as dashboard workflows.
- Remaining public action controls now share the dark-mode-aware action button helper while banner and selected-filter styling stay scoped.
- The plain-English launch guide now matches the evidence validator by requiring five final approval roles, including legal/compliance.
- The release readiness command now emits ASCII-safe operator output for cleaner Windows terminals and launch evidence transcripts.
- The release readiness command now distinguishes skipped gates from a full release-ready result in its final summary.
- The production readiness TODO now reflects the current 23-value launch blocker state without overclaiming unrun local smoke or external evidence.
- The plain-English launch guide now uses ASCII-safe operator text for cleaner Windows terminals, CI logs, and launch evidence transcripts.
- The production readiness TODO and launch guide now record the 2026-07-06 local responsive and accessibility QA evidence while keeping deployed QA open.
- The reliability report and generated reliability ledger now use ASCII-safe status text for cleaner release and launch evidence transcripts.
- The production environment generator now uses ASCII-safe operator hints for cleaner setup transcripts.
- The launch status script now keeps its operator-facing source text ASCII-safe for cleaner status transcripts.
- Launch status now has a non-secret JSON output mode for CI summaries, release handoffs, and operations dashboards.
- The release readiness command now reports full local success as repository release gates passed instead of implying production launch readiness.
- The standalone Next production web server now serializes caught request and shutdown errors before logging them.
- The Prisma seed script now serializes fatal seed errors through the shared redacted logger helper before printing them.
- The Next build cleanup helper now reports sanitized error codes instead of raw filesystem error objects in release transcripts.
- Accessibility browser QA now uses commit-stage navigation, parsed-document waits, direct light/dark theme application, and longer owner setup headroom to survive local Next.js cold compiles.
- Responsive browser-smoke global setup now warms every public and auth route in the smoke suite before timed browser assertions.
- Responsive browser-smoke navigation now retries local Next.js dev-server restart responses after waiting for the web origin, without masking deployed QA failures.
- Responsive browser-smoke dashboard coverage now runs one route per test and seeds the shared local owner directly, while auth journey specs still exercise registration UI.
- Local Docker web QA now gives Next dev a configurable heap ceiling and ignores Playwright report/test-result artifacts so route smoke output does not trigger repeated recompiles.
- Local Playwright screenshots, traces, videos, and HTML reports now default outside the repository, while CI writes them to an explicit uploaded artifact directory.
- Local Playwright QA now creates external artifact directories before reporters run, keeping early setup failures readable.
- Browser auth helpers now pre-seed the cookie-consent preference before registration, login, and invite acceptance so setup submissions are not competing with the consent dialog.
- Compliance record autosave now recovers from concurrent create races on the organisation/standard/year key with a scoped update instead of leaking a 500.
- Auth journey browser helpers now retry only local dev-server blank form loads after a Next.js restart while keeping deployed QA failures strict.
- Irish compliance matrix source metadata was refreshed against official Charities Regulator, Irish Statute Book, and Revised Acts sources on 2026-07-06.

## Local Verification Evidence

- `npm run release:ready -- --no-e2e` passed locally with 6/6 selected release gates and only the full Playwright suite skipped.
- `node --test scripts\check-production-providers.test.mjs scripts\production-launch-evidence.test.mjs` passed locally for provider and launch-evidence hardening.
- `npm test` passed locally across workspace tests, production-check scripts, and local Docker guard checks.
- `npm run test:e2e -- tests/accessibility.spec.ts` passed locally with 16/16 axe checks, including dashboard light/dark coverage.
- Local responsive browser QA completed with the `npm run test:e2e:responsive:*` focused chunk commands after reinstalling the corrupted Playwright Chromium cache: public desktop 13 passed, public mobile 12 passed with 1 retry-pass flaky check, dashboard desktop 10 passed with 2 retry-pass flaky checks, and dashboard mobile 12 passed.
- `npm run test:local-docker`, `npm run test:production-check`, and `npm run build -w @charitypilot/api` passed locally after the launch-status JSON and log-redaction hardening.
- `node --check scripts\clean-next-export.cjs`, `node --test scripts\check-production.test.mjs`, and `npm run test:production-check` passed locally after the Next cleanup transcript hardening.
- This is local Docker evidence only; deployed HTTPS QA with `E2E_DEPLOYED_QA=true` remains a launch gate.

## Independent Audit Findings Still Driving Next Work

| Priority | Area | Finding |
| --- | --- | --- |
| P0 | Production launch | Launch evidence remains a template and .env.production still has placeholders; real provider, hosting, backup, observability, legal, browser QA, and pentest evidence are external blockers. |
| P1 | Frontend polish | No route files remain over 450 lines, route page inline SVG findings are closed, and route-surface static dark-mode/decorative findings are clear; deployed browser and accessibility evidence remain. |

## Route Audit

| Priority | Route | Area | File | Lines | Client | Static audit finding |
| --- | --- | --- | --- | ---: | --- | --- |
| P0 | `/` | marketing | `apps/web/src/app/(marketing)/page.tsx` | 364 | no | no obvious static risk; verify in browser |
| P1 | `/accept-invite` | auth | `apps/web/src/app/(auth)/accept-invite/page.tsx` | 166 | yes | no obvious static risk; verify in browser |
| P0 | `/billing` | dashboard | `apps/web/src/app/(dashboard)/billing/page.tsx` | 197 | yes | no obvious static risk; verify in browser |
| P2 | `/blog` | marketing | `apps/web/src/app/(marketing)/blog/page.tsx` | 33 | no | no obvious static risk; verify in browser |
| P2 | `/blog/[slug]` | marketing | `apps/web/src/app/(marketing)/blog/[slug]/page.tsx` | 192 | no | no obvious static risk; verify in browser |
| P0 | `/board` | dashboard | `apps/web/src/app/(dashboard)/board/page.tsx` | 119 | yes | no obvious static risk; verify in browser |
| P0 | `/compliance` | dashboard | `apps/web/src/app/(dashboard)/compliance/page.tsx` | 143 | yes | no obvious static risk; verify in browser |
| P0 | `/compliance/[principleId]` | dashboard | `apps/web/src/app/(dashboard)/compliance/[principleId]/page.tsx` | 100 | yes | no obvious static risk; verify in browser |
| P0 | `/dashboard` | dashboard | `apps/web/src/app/(dashboard)/dashboard/page.tsx` | 131 | yes | no obvious static risk; verify in browser |
| P0 | `/deadlines` | dashboard | `apps/web/src/app/(dashboard)/deadlines/page.tsx` | 127 | yes | no obvious static risk; verify in browser |
| P0 | `/documents` | dashboard | `apps/web/src/app/(dashboard)/documents/page.tsx` | 195 | yes | no obvious static risk; verify in browser |
| P0 | `/export` | dashboard | `apps/web/src/app/(dashboard)/export/page.tsx` | 116 | yes | no obvious static risk; verify in browser |
| P1 | `/features` | marketing | `apps/web/src/app/(marketing)/features/page.tsx` | 252 | no | no obvious static risk; verify in browser |
| P1 | `/forgot-password` | auth | `apps/web/src/app/(auth)/forgot-password/page.tsx` | 108 | yes | no obvious static risk; verify in browser |
| P0 | `/login` | auth | `apps/web/src/app/(auth)/login/page.tsx` | 136 | yes | no obvious static risk; verify in browser |
| P0 | `/organisation` | dashboard | `apps/web/src/app/(dashboard)/organisation/page.tsx` | 148 | yes | no obvious static risk; verify in browser |
| P0 | `/pricing` | marketing | `apps/web/src/app/(marketing)/pricing/page.tsx` | 260 | no | no obvious static risk; verify in browser |
| P1 | `/privacy` | marketing | `apps/web/src/app/(marketing)/privacy/page.tsx` | 278 | no | no obvious static risk; verify in browser |
| P0 | `/register` | auth | `apps/web/src/app/(auth)/register/page.tsx` | 266 | yes | no obvious static risk; verify in browser |
| P0 | `/registers` | dashboard | `apps/web/src/app/(dashboard)/registers/page.tsx` | 184 | yes | no obvious static risk; verify in browser |
| P0 | `/regulator` | dashboard | `apps/web/src/app/(dashboard)/regulator/page.tsx` | 189 | yes | no obvious static risk; verify in browser |
| P1 | `/reset-password` | auth | `apps/web/src/app/(auth)/reset-password/page.tsx` | 190 | yes | no obvious static risk; verify in browser |
| P1 | `/team` | dashboard | `apps/web/src/app/(dashboard)/team/page.tsx` | 197 | yes | no obvious static risk; verify in browser |
| P1 | `/terms` | marketing | `apps/web/src/app/(marketing)/terms/page.tsx` | 257 | no | no obvious static risk; verify in browser |
| P1 | `/verify-email` | auth | `apps/web/src/app/(auth)/verify-email/page.tsx` | 206 | yes | no obvious static risk; verify in browser |

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
| `export` | `apps/api/src/routes/export/index.ts` | 470 | auth, subscription, plan gate | 2 | preserve current guard and tenant boundary |
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

### Launch Evidence Ledger

- .charitypilot-launch-evidence/production-launch-evidence.json exists. Checklist checks complete: 0 / 85.
- approvedForLaunch: false
- finalSignoff: pending
- Final approval roles approved: 0 / 5
- Next incomplete checks:
  - releaseGate.npm-ci (pending)
  - releaseGate.db-generate (pending)
  - releaseGate.prisma-validate (pending)
  - releaseGate.lint (pending)
  - releaseGate.test (pending)
- Track progress with:  npm run check:production:evidence:status -- --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json

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

Grouped by source:

- Hosting, DNS, TLS, and proxy:
  - `TRUSTED_PROXY_ADDRESSES`: Reverse-proxy IP/CIDR in front of the API (Step 4)
  - `FRONTEND_URL`: Public HTTPS web app origin, e.g. https://app.charitypilot.ie (Step 1/4)
  - `NEXT_PUBLIC_API_URL`: Public HTTPS API origin, e.g. https://api.charitypilot.ie (Step 4)
  - `CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL`: Docker Compose web runtime API origin; must match NEXT_PUBLIC_API_URL (Step 4/6)
- PostgreSQL:
  - `DATABASE_URL`: Managed production PostgreSQL URL with sslmode=require (Step 3)
- Stripe billing:
  - `STRIPE_SECRET_KEY`: Live Stripe secret key sk_live_... (Step 2)
  - `STRIPE_WEBHOOK_SECRET`: Live Stripe webhook signing secret whsec_... (Step 2)
  - `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`: Live Stripe publishable key pk_live_... (Step 2)
  - `STRIPE_ESSENTIALS_MONTHLY_PRICE_ID`: Live Stripe Essentials monthly price ID price_... (Step 2)
  - `STRIPE_ESSENTIALS_YEARLY_PRICE_ID`: Live Stripe Essentials yearly price ID price_... (Step 2)
  - `STRIPE_COMPLETE_MONTHLY_PRICE_ID`: Live Stripe Complete monthly price ID price_... (Step 2)
  - `STRIPE_COMPLETE_YEARLY_PRICE_ID`: Live Stripe Complete yearly price ID price_... (Step 2)
- Resend email:
  - `RESEND_API_KEY`: Resend production API key re_... (Step 2)
- Supabase storage:
  - `SUPABASE_URL`: Same Supabase project URL (Step 2)
  - `SUPABASE_SERVICE_ROLE_KEY`: Supabase service role key - secret store only (Step 2)
  - `NEXT_PUBLIC_SUPABASE_URL`: Supabase project URL, https://<ref>.supabase.co (Step 2)
  - `CHARITYPILOT_WEB_NEXT_PUBLIC_SUPABASE_URL`: Docker Compose web runtime Supabase origin; must match NEXT_PUBLIC_SUPABASE_URL (Step 2/6)
- Observability:
  - `ERROR_ALERT_WEBHOOK_URL`: HTTPS incident webhook (Slack etc.) (Step 2)
- Release image promotion:
  - `CHARITYPILOT_API_IMAGE`: Digest-pinned API image ref from release-image-digests.env (Step 6)
  - `CHARITYPILOT_WEB_IMAGE`: Digest-pinned web image ref from release-image-digests.env (Step 6)
  - `CHARITYPILOT_MIGRATION_IMAGE`: Digest-pinned migration image ref from release-image-digests.env (Step 6)
  - `CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL`: Web image build API origin copied from release-image-digests.env (Step 6)
  - `CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_SUPABASE_URL`: Web image build Supabase origin copied from release-image-digests.env (Step 6)

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
