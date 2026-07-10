#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assessLaunchState, collectRepositoryState } from './launch-status.mjs';
import { decodeJsonFile } from './production-launch-evidence-status.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const outputPath = join(repoRoot, 'docs', 'platform-completion-audit.md');
const launchEvidencePath = join(repoRoot, '.charitypilot-launch-evidence', 'production-launch-evidence.json');

const auditDate = new Date().toISOString().slice(0, 10);
const RECORDED_SELECTED_GATE_EVIDENCE = Object.freeze({
  command: 'npm run release:ready',
  date: '2026-07-09',
  commit: 'cf683f1',
  summary:
    'security scan, lint, build, workspace tests, dependency audit, reliability ledger, and 95 Playwright E2E tests passed; OVERALL: GREEN - repository release gates passed',
});

const routePriorities = new Map([
  ['/', 'P0'],
  ['/pricing', 'P0'],
  ['/login', 'P0'],
  ['/register', 'P0'],
  ['/dashboard', 'P0'],
  ['/compliance', 'P0'],
  ['/compliance/[principleId]', 'P0'],
  ['/documents', 'P0'],
  ['/deadlines', 'P0'],
  ['/board', 'P0'],
  ['/registers', 'P0'],
  ['/regulator', 'P0'],
  ['/organisation', 'P0'],
  ['/billing', 'P0'],
  ['/export', 'P0'],
  ['/privacy', 'P1'],
  ['/terms', 'P1'],
  ['/team', 'P1'],
  ['/features', 'P1'],
  ['/verify-email', 'P1'],
  ['/forgot-password', 'P1'],
  ['/reset-password', 'P1'],
  ['/accept-invite', 'P1'],
]);

const launchBlockers = [
  'Real production secrets and provider values are not committed and must be supplied from the operator secret store.',
  'Production hosting, DNS, TLS, reverse proxy, and public HTTPS smoke evidence remain external launch gates.',
  'Production PostgreSQL backup and restore evidence is required before real charity data.',
  'Production Supabase private bucket, signed URL, backup, and restore evidence is required.',
  'Stripe live products/prices/webhook and Resend sender-domain evidence are required.',
  'Observability, uptime checks, alert routing, incident owner, and test-alert evidence are required.',
  'Solicitor/governance/privacy review and external penetration test are required before real charity data.',
];

const fixedInThisAuditBranch = [
  'Strict shared ISO date validation now rejects impossible calendar dates before they can normalize into filing, board, document, register, or deadline records.',
  'Organisation profile date changes and derived auto-deadline regeneration now run inside one Prisma transaction.',
  'Document storage paths now include a UUID segment to avoid same-millisecond same-filename collisions.',
  'The documents API route now delegates upload MIME, signature, extension, and multipart-limit validation helpers to a dedicated module behind a production tooling regression test.',
  'Stripe customer creation now uses an organisation-scoped idempotency key to reduce orphan/duplicate external customers after retries.',
  'Stripe checkout now reconciles an existing Stripe customer by organisation metadata before creating a new customer.',
  'Stored Stripe customer IDs are now verified against Stripe customer metadata before checkout or portal reuse, and stale or wrong-organisation IDs are repaired through metadata reconciliation.',
  'Sensitive auth and invite throttles now use body-aware identifier keys for email or token attempts while preserving request-level protection where needed.',
  'Refresh and logout throttles now key by hashed refresh-token identifiers from the request body or refresh cookie, so one token cannot exhaust the same-IP bucket for another token.',
  'Sensitive public auth and invite throttles now have regression coverage proving one email/token identifier does not block a different identifier from the same caller.',
  'Registration throttling now has regression coverage proving normalized email identifiers share a throttle bucket without blocking a different email from the same caller.',
  'Resend-verification throttling now keys by hashed bearer/access-cookie credentials at the request hook, so one invalid credential cannot burn the same-IP bucket for another credential.',
  'Optional in-process cron logging now serializes errors through the redacted logger helper.',
  'Deadline reminder and optional cron runtime logs now route through injectable logger contracts instead of direct console.log calls.',
  'Email delivery degradation logs now route through an injectable logger contract instead of direct console warn/error calls.',
  'Runtime provider-error formatting now redacts Stripe, Stripe webhook, Resend, bearer-token, and Supabase apikey-shaped values before log serialization.',
  'Production preflight now rejects reserved documentation hostnames in DATABASE_URL so copied sample PostgreSQL values cannot pass as real launch configuration.',
  'Production database backup/restore checks now also reject reserved documentation hostnames before attempting a production PostgreSQL backup.',
  'Production launch status, core preflight, and the Supabase storage checker now reject copied Supabase service-role secret-store placeholders before marking the value complete or probing storage.',
  'Compliance/export/dashboard aggregate progress labels now say recorded progress rather than implying legal compliance certification.',
  'API-rendered exports now include a source/professional-review appendix and a not-legal-advice/non-certificate disclaimer.',
  'The API export route now delegates source-cited HTML report rendering to a dedicated module behind a production tooling regression test.',
  'The export workflow now surfaces source counts, professional-review flags, and not-yet-commenced monitoring metadata before report generation or board sign-off.',
  'Compliance detail autosave now flushes pending edits on blur/unmount, warns on browser unload, confirms in-app navigation while saves are pending, and exposes a retry action for failed saves.',
  'Production deploy defaults now include the TLS compose overlay, with an explicit --no-tls-proxy escape hatch for managed platform TLS.',
  'Production launch evidence now accepts either the default compose.production-tls.yml deploy path or an explicit --no-tls-proxy managed-TLS deploy transcript with external TLS certificate evidence.',
  'The plain-English launch guide now describes the Caddy TLS overlay as the default deploy path rather than optional proxy wiring.',
  'Production hostname defaults, launch validators, web runtime API validation, and production CSP now consistently require app.charitypilot.ie for the web app and api.charitypilot.ie for the API.',
  'The Irish compliance matrix now includes explicit not-yet-commenced Charities (Amendment) Act 2024 monitoring rows with solicitor review flags.',
  'Organisation setup now captures conditional obligation profile facts for staff, volunteers, fundraising, safeguarding, GDPR, premises/events, public-sector context, and processors.',
  'Approval readiness and exports now flag missing standard records, missing action/evidence fields, missing explanations, missing conditional-profile facts, and profile-triggered professional-review prompts.',
  'Governance architecture and backend audit docs now describe the broadened approval-readiness model behind a production tooling regression test.',
  'Dashboard navigation now gives the mobile sidebar explicit ARIA controls, Escape-to-close focus recovery, non-tabbable closed mobile links, and source-backed principle breadcrumb labels.',
  'Dashboard navigation now traps Tab and Shift+Tab inside the open mobile sidebar while preserving Escape-to-close focus recovery.',
  'Dashboard, compliance, compliance detail, and export route chrome now use lucide-react status, chevron, and download icons instead of route-local inline SVG markup behind a wiring regression test.',
  'Auth routes now use lucide-react password visibility, validation, mail, and alert icons instead of route-local inline SVG markup behind a wiring regression test.',
  'Marketing routes now use lucide-react feature, pricing, FAQ, and share/navigation icons instead of route-local inline SVG markup behind a wiring regression test.',
  'Documents now surface profile-triggered evidence prompts from the conditional obligation profile, including linked standard counts, source references, and professional-review flags.',
  'The document summary panel is split out of the oversized documents route behind a wiring regression test while preserving successful-load gating.',
  'The document upload modal and oversize-file guard UI are split out of the oversized documents route behind a wiring regression test.',
  'The document standard-link modal is split out of the oversized documents route behind a wiring regression test.',
  'Document upload and standard-link modals now share a HeroUI modal form-action footer primitive behind a wiring regression test.',
  'The document delete confirmation modal is split out of the oversized documents route behind a wiring regression test.',
  'The uploaded-document list panel is split out of the oversized documents route behind a wiring regression test.',
  'The document evidence-pack checklist and operational signal panels are split out of the documents route behind a wiring regression test.',
  'The document workflow loading, organisation-profile prompts, upload/link/delete/download mutations, and trusted download handling are split into a route-local hook behind a wiring regression test.',
  'Document upload, link, unlink, and delete mutations now expose the shared save-status primitive in the Document Vault header behind a production tooling regression test.',
  'Shared loading, empty, error, locked-feature, review-warning, and inline-status primitives now contain long text and actions within narrow/mobile layouts.',
  'Document and deadline destructive confirmations now share a contained HeroUI confirmation modal primitive behind a wiring regression test.',
  'Deadlines now surface profile-triggered review-date prompts from the conditional obligation profile, including source references, professional-review flags, and one-click review deadline prefills.',
  'The deadlines regulatory cadence panel now cites the Charities Regulator Annual Report source and last-checked metadata for the 10-month filing prompt.',
  'Deadline and regulator official-source links now share reusable source-reference primitives behind a wiring regression test.',
  'Regulator profile-triggered priority source links now use the shared source-reference primitive instead of route-local anchor styling.',
  'Profile-triggered document, deadline, register, regulator, and export prompts now render official sources as shared clickable source-reference lists.',
  'Export controls and board-approval panels now use shared status panel styling instead of route-local neutral card markup.',
  'The regulator guide now prioritises conditional obligation profile triggers with source references, workflow areas, and professional-review flags without legal-certainty claims.',
  'Governance registers now prioritise conditional obligation profile triggers with register-evidence signals, source references, and professional-review flags.',
  'The register profile-priority model and panel are split out of the oversized registers route behind a wiring regression test.',
  'The register Annual Report readiness and financial control review cards are split out of the oversized registers route behind a wiring regression test.',
  'The register overview summary panel and metric tiles are split out of the oversized registers route behind a wiring regression test.',
  'The register modal record forms and payload normaliser are split out of the oversized registers route behind a wiring regression test.',
  'The register record modal shell is split out of the oversized registers route behind a wiring regression test.',
  'The register operational record list sections are split out of the oversized registers route behind a wiring regression test.',
  'The register workflow loading, stale-request guard, save mutations, and priority derivation are split into a route-local hook behind a wiring regression test.',
  'The compliance principle standard editor card and save-state UI are split out of the oversized compliance detail route behind a wiring regression test.',
  'The compliance principle standard list is split out of the oversized compliance detail route behind a wiring regression test.',
  'The compliance principle loading and error states are split out of the oversized compliance detail route behind a wiring regression test.',
  'The compliance principle workflow hook now owns loading, autosave, approval-readiness refresh, and pending-navigation guards behind a wiring regression test.',
  'The document profile-triggered evidence prompt model and panel are split out of the oversized documents route behind a wiring regression test.',
  'The deadline profile-triggered review-date prompt model and panel are split out of the oversized deadlines route behind a wiring regression test.',
  'The deadline add/edit form modal is split out of the oversized deadlines route behind a wiring regression test.',
  'Deadline, board trustee, and register record form modals now share the HeroUI modal form-action footer primitive behind wiring regression tests.',
  'The deadline list panel, status classifier, and summary helper are split out of the oversized deadlines route behind a wiring regression test.',
  'The deadline overview and regulatory cadence panels are split out of the oversized deadlines route behind a wiring regression test.',
  'The deadline delete confirmation modal is split out of the deadlines route behind a wiring regression test.',
  'The deadline workflow loading, organisation-profile prompts, add/edit/delete/toggle mutations, and modal state are split into a route-local hook behind a wiring regression test.',
  'The board trustee evidence prompt cards and evidence chips are split out of the oversized board route behind a wiring regression test.',
  'The board member add/edit modal is split out of the oversized board route behind a wiring regression test.',
  'The board member list, mobile cards, desktop table, and status-toggle states are split out of the oversized board route behind a wiring regression test.',
  'The board workflow loading, summary derivation, add/edit/toggle mutations, and trustee form state are split into a route-local hook behind a wiring regression test.',
  'The export report preview cards and score helpers are split out of the oversized export route behind a wiring regression test.',
  'The export controls and readiness-warning panel are split out of the oversized export route behind a wiring regression test.',
  'The export board-approval form panel is split out of the oversized export route behind a wiring regression test.',
  'The export board sign-off save action now exposes the shared save-status primitive behind a production tooling regression test.',
  'The export workflow loading, approval-readiness refresh, board sign-off mutation, report-opening state, and blocker derivation are split into a route-local hook behind a wiring regression test.',
  'The compliance principle evidence-readiness panel is split out of the oversized compliance detail route behind a wiring regression test.',
  'Compliance principle in-app navigation now uses a HeroUI save/leave confirmation modal instead of a bare browser confirm prompt.',
  'Compliance principle pending-save navigation now uses the shared confirmation modal primitive while preserving keep-editing, leave, and save-now choices.',
  'The session-timeout warning now uses the shared HeroUI modal form-action footer with explicit sign-out and stay-signed-in actions behind a wiring regression test.',
  'The primary add actions on documents, board, and deadlines now use lucide-react Plus icons instead of route-local inline SVG markup behind a wiring regression test.',
  'The organisation conditional-obligation profile fields are split out of the oversized organisation route behind a wiring regression test.',
  'The organisation profile form section is split out of the oversized organisation route behind a wiring regression test.',
  'The organisation complexity guidance modal is split out of the oversized organisation route behind a wiring regression test.',
  'The organisation complexity guidance modal now uses a shared HeroUI dismiss-action footer primitive behind a wiring regression test.',
  'The organisation setup summary panel is split out of the oversized organisation route behind a wiring regression test.',
  'The organisation workflow session hydration, dirty-state guard, validation, save mutation, and setup form state are split into a route-local hook behind a wiring regression test.',
  'The dashboard deadline and board-alert action lists are split out of the oversized dashboard route behind a wiring regression test.',
  'The dashboard annual sign-off and governance register summary cards are split out of the oversized dashboard route behind a wiring regression test.',
  'The dashboard overall progress and principle progress panels are split out of the oversized dashboard route behind a wiring regression test.',
  'The dashboard workflow API loading, approval-readiness fetch, subscription-lapse handling, and derived board-alert state are split into a route-local hook behind a wiring regression test.',
  'The compliance overview principle list and disclosure cards are split out of the oversized compliance route behind a wiring regression test.',
  'The compliance overview workflow API loading, approval-readiness fetch, year/filter state, and evidence-prompt derivation are split into a route-local hook behind a wiring regression test.',
  'The billing plan gates, Stripe checkout cards, and billing notes are split out of the oversized billing route behind a wiring regression test.',
  'The board review-ready summary panel is split out of the oversized board route behind a wiring regression test.',
  'Responsive browser-smoke coverage now enumerates every shipped page route across desktop/mobile and light/dark themes, with a guard against reverting to network-idle waits that hang on dev-only noise.',
  'Local e2e route warming now logs progress and can be skipped or time-boxed with E2E_SKIP_ROUTE_WARMING, E2E_ROUTE_WARM_TIMEOUT_MS, and E2E_ROUTE_WARM_BUDGET_MS for constrained Docker hosts.',
  'Local destructive E2E resets now require E2E_ALLOW_LOCAL_DB_RESET=true, while CI and release:ready opt in explicitly for disposable test databases.',
  'The production readiness TODO now requires final-release-ref command transcripts, commit SHA, workflow run, and digest manifest evidence instead of preserving stale local selected-gate commit claims.',
  'Deployed browser QA mode now uses existing non-sensitive test credentials and skips direct database reset or token-injection seams.',
  'Regulator official-source links now use compact link styling instead of pill-badge styling behind a wiring regression test.',
  'Regulator official guidance cards now use the shared source-reference card primitive instead of route-local external-link card markup.',
  'The regulator profile-triggered priorities section is split out of the oversized regulator route behind a wiring regression test.',
  'The regulator readiness overview and operating-model cards are split out of the oversized regulator route behind a wiring regression test.',
  'The regulator source-cited readiness matrix is split out of the oversized regulator route behind a wiring regression test.',
  'The platform audit now distinguishes decorative pill styling from functional switches and status dots so visual QA findings stay actionable.',
  'The platform audit now scans route-local extracted UI components when assessing static route-level visual and dark-mode signals.',
  'Launch status now separates missing production env values from external launch evidence gates, including deployed QA, provider/backups/observability evidence, legal review, pentest, and final signoffs.',
  'Platform audit now records launch evidence ledger status so operators know whether the ignored external evidence file has been initialized before filling the 87 checks.',
  'Platform audit now surfaces launch evidence approval state, final signoff state, and the next incomplete checks from the ignored evidence ledger.',
  'Launch evidence status now reports final approval role progress separately from checklist completion so signoff gaps stay visible.',
  'Launch status and platform audit now group missing production values by provider/source so operator handoff is clearer.',
  'Launch status and platform audit now report strict launch-gate completion percentages based only on production values, launch evidence checks, and final signoff roles.',
  'Launch status and production readiness TODO now name all 87 machine-readable launch evidence checks and the browserQa accessibility, cross-browser, and iOS Safari evidence slots.',
  'Production launch evidence now has a read-only status command that summarizes area-by-area completion without weakening the final validator.',
  'Production launch evidence status now surfaces required evidence hints for the next incomplete checks in both text and JSON output.',
  'Production launch evidence status now reports evidence-check and final-signoff completion percentages in both text and JSON output.',
  'Strict production launch evidence validation now prints checklist and final-signoff progress before the detailed issue list.',
  'Strict production launch evidence validation now supports --json output for CI and operator dashboards.',
  'Launch status now includes the next launch-evidence hint details in text and JSON output so operator dashboards can show the next proof to collect.',
  'Platform audit now records repository branch, HEAD, upstream sync, and dirty-worktree launch-evidence risk so external proof is tied to a clean, synced ref.',
  'Production launch evidence templates now include operator evidence hints for every required launch check behind a regression test.',
  'Production launch evidence status now falls back to current template hints for older evidence ledgers that were initialized before hint coverage was complete.',
  'Production launch evidence initialization now writes the template to an ignored .charitypilot-launch-evidence directory to keep real launch evidence out of the repo root.',
  'Protected production launch evidence workflows now validate dispatch-controlled artifact names, evidence file names, upload run ids, and SHA-256 values before using them in artifact or shell-path operations.',
  'Production launch evidence now requires legal/compliance final approval alongside engineering, operations, security, and business signoffs.',
  'Production launch evidence now requires named solicitor/governance/privacy review evidence inside the legal/compliance checklist area.',
  'Production preflight now rejects obvious low-entropy or sample JWT_SECRET and READINESS_API_KEY values instead of accepting length-only secrets.',
  'Production preflight now rejects sample Supabase project refs across API, public web, and Compose runtime Supabase origins.',
  'GitHub production environment validation now rejects sample Supabase project refs such as configured-project before release image promotion.',
  'Production launch evidence templates and validators now reject sample Supabase project refs so release evidence cannot contradict the GitHub environment preflight.',
  'Production Supabase storage checks now reject sample project refs before making any provider probe.',
  'Production release-run evidence validation now rejects sample Supabase build origins before GitHub API calls.',
  'Launch status now reports copied sample Supabase project refs as unresolved production values instead of ENV_COMPLETE.',
  'Production launch evidence status now treats sample Supabase release bindings as incomplete release identity evidence.',
  'Launch status now reports copied Stripe and Resend provider setup placeholders as unresolved production values instead of ENV_COMPLETE.',
  'Billing/email launch evidence now requires Stripe webhook subscription-event proof, webhook-secret secret-store proof, Resend accepted-send proof, and production email-link origin proof.',
  'Billing disabled checkout and portal actions now describe the visible provider-degraded or current-plan reason for assistive technology.',
  'Billing checkout and portal handoffs now use a shared visible inline status instead of a route-local hidden live-region message.',
  'Billing current-plan summary now uses shared status panel styling instead of route-local brand panel markup.',
  'Browser QA launch evidence now requires a dedicated deployed accessibility command transcript for light and dark theme checks.',
  'Deployed browser QA now has cross-browser responsive and accessibility script wiring for Chromium desktop, Chromium mobile emulation, Firefox, and WebKit evidence runs while keeping real iOS Safari as manual or cloud-device evidence.',
  'Deployed browser QA preflight now rejects copied credential placeholders and documentation owner email domains like example.com while keeping owner credential values out of operator transcripts.',
  'Supabase launch evidence now requires backup policy or PITR evidence plus restore-test owner/date/recovery notes, isolated restore target, non-production restore target, and confirmation that the production project was not overwritten.',
  'The team member list, role edit controls, loading/error/empty states, and shared role display metadata are split out of the team route behind a wiring regression test.',
  'The team invite form and pending-invite list are split out of the team route behind a wiring regression test while preserving invite role gates and revoke states.',
  'The team role guidance panel is split out of the team route behind a wiring regression test and now uses shared status panel styling.',
  'Team feedback now uses the shared inline status primitive instead of route-local alert styling.',
  'Team role-change and invite-revoke permission-denied messages now use a shared permission hint primitive instead of route-local grey boxes or text.',
  'Billing plan price blocks now use flat border bands instead of nested grey card panels behind a production tooling regression test.',
  'Dashboard shell loading and dashboard/compliance status dots now use shared UI primitives with dark-mode-aware semantic tones.',
  'Board and compliance binary filters now use HeroUI Switch controls instead of route-local switch markup.',
  'Deadline completion now uses a HeroUI Checkbox instead of a route-local button with checkbox ARIA.',
  'Export approval-readiness issue cards and conditional review prompts are split out of the route and now use shared status/review primitives instead of repeated warning-card markup.',
  'Organisation setup warning surfaces now use the shared inline status primitive instead of route-local amber advisory boxes.',
  'Organisation purpose and conditional-obligation checkbox groups now use HeroUI Checkbox controls instead of raw input controls.',
  'Organisation complexity selection now uses HeroUI RadioGroup controls instead of route-local pressed-button toggles.',
  'Board trustee conduct and induction evidence toggles now use HeroUI Checkbox controls instead of raw checkbox inputs.',
  'Register Annual Report and financial-control checklist rows now use HeroUI Checkbox controls instead of raw checkbox inputs.',
  'Compliance standard editor status rendering now tolerates optional selected-item labels during production builds.',
  'Compliance overview principle disclosure buttons now expose expanded state and controlled panel relationships for assistive technology.',
  'Auth password visibility controls now use a shared HeroUI icon-button primitive instead of repeated route-local raw buttons.',
  'Auth email and password-recovery status illustrations now use a shared dark-mode-aware status icon primitive instead of repeated route-local icon containers.',
  'Auth invite, reset-password, and verify-email async fallbacks now use shared loading primitives instead of route-local skeleton or spinner markup.',
  'Marketing blog search now uses the shared empty-state primitive for no-result filters instead of route-local dashed-panel markup.',
  'Marketing blog article copy now pairs hard-coded gray text colors with dark-mode text variants, closing the dark article contrast regression behind wiring and axe checks.',
  'Marketing landing workflow signal tiles now use shared status panel styling instead of route-local grey card markup.',
  'Compliance standard autosave, organisation profile saving, governance register saving, document vault mutations, export board sign-off, and board/deadline/team list mutations now use the shared save-status primitive instead of route-local status markup.',
  'Compliance overview summary and principle cards now use shared status panel styling instead of route-local neutral card markup.',
  'Compliance detail standard editor cards now use shared status panel styling instead of route-local neutral card markup.',
  'Shared utility icon controls for theme switching, copying links, and back-to-top now use HeroUI Button semantics.',
  'Compliance principle back navigation and autosave retry controls now use HeroUI Button primitives.',
  'Dashboard annual regulator summary now uses shared status panel styling instead of route-local brand panel markup.',
  'Dashboard summary and progress cards now use shared status panel styling instead of route-local neutral card markup.',
  'Dashboard deadline and board-alert action list cards now use shared status panel styling instead of route-local neutral card markup.',
  'The platform audit next sequence now shifts from broad route-local state cleanup to deployed-QA-driven fixes once static route findings are clear.',
  'Public marketing navigation, blog filters, and cookie-consent actions now use HeroUI Button primitives with dark-mode mobile navigation styling.',
  'Global recovery, not-found, dashboard mobile-menu, and compliance disclosure actions now use HeroUI Button primitives instead of bespoke route-local action markup.',
  'Responsive browser-smoke QA now waits for the parsed document shell before applying light/dark theme checks after commit-stage navigations.',
  'Document uploads now use a shared HeroUI-backed file upload field instead of route-local file input styling.',
  'Marketing blog search and trial CTA now use HeroUI Input and Button primitives instead of route-local form/link styling.',
  'Billing plan-gate explanation tiles now use a shared status tile primitive instead of route-local tile markup.',
  'Billing plan price bands, feature lists, and FAQ disclosure controls avoid nested card treatment and use lucide-react Check and ChevronDown icons instead of decorative dot/text affordances.',
  'Dashboard primary actions now share dark-mode-aware action button styling instead of repeating route-local teal button classes.',
  'Public marketing and auth primary CTAs now share the same dark-mode-aware action styling as dashboard workflows.',
  'Remaining public action controls now share the dark-mode-aware action button helper while banner and selected-filter styling stay scoped.',
  'Pricing metadata is ASCII-safe and pricing feature/comparison icons now use lucide-react directly without route-local wrappers.',
  'The plain-English launch guide now matches the evidence validator by requiring five final approval roles, including legal/compliance.',
  'The release readiness command now emits ASCII-safe operator output for cleaner Windows terminals and launch evidence transcripts.',
  'Public attribution surfaces now identify Jasper Ford as CharityPilot IP holder, declare AGPL-3.0-or-later licensing/no-warranty posture, and link to the canonical GitHub source repository across marketing, auth, dashboard, sitemap, NOTICE, and package metadata.',
  'The release readiness command now distinguishes skipped gates from a full release-ready result in its final summary.',
  'The release readiness command now times out local stack reachability probes so a half-started web/API stack fails the E2E gate cleanly instead of hanging operator evidence collection.',
  'The release readiness command now scopes failed Playwright E2E cleanup to this repository before stopping related Node processes, avoiding unrelated npm test processes on shared Windows hosts.',
  'The release readiness command now resolves npm and npx gates through explicit Node CLI entrypoints on Windows instead of shell execution, keeping launch evidence transcripts free of shell-argument deprecation warnings.',
  'The production readiness TODO now reflects the current 19-value launch blocker state without overclaiming unrun local smoke or external evidence.',
  'The launch guide, production readiness TODO, and agent continuation handoff now reflect the 2026-07-09 launch counters: 9/28 production values, 9/87 evidence checks, 0/5 final signoffs, and the remaining external launch blockers.',
  'The plain-English launch guide now uses ASCII-safe operator text for cleaner Windows terminals, CI logs, and launch evidence transcripts.',
  'The production readiness TODO and launch guide record local responsive and accessibility QA evidence while keeping deployed QA open.',
  'The 2026-07-08 local Docker browser QA rerun completed all four responsive route chunks and the accessibility suite cleanly after stabilizing the local QA stack.',
  'The personal local readiness gate now gives operators a non-destructive local confidence command for one-person use without Stripe, payments, or production providers, while warning that the default full E2E suite can reset tenant/app tables.',
  'Local-driver document downloads now require the requested storage path to belong to a live document row for the caller organisation before any file read occurs.',
  'The reliability report and generated reliability ledger now use ASCII-safe status text for cleaner release and launch evidence transcripts.',
  'The production environment generator now uses ASCII-safe operator hints for cleaner setup transcripts.',
  'The launch status script now keeps its operator-facing source text ASCII-safe for cleaner status transcripts.',
  'Launch status now has a non-secret JSON output mode for CI summaries, release handoffs, and operations dashboards.',
  'The release readiness command now reports full local success as repository release gates passed instead of implying production launch readiness.',
  'The standalone Next production web server now serializes caught request and shutdown errors before logging them.',
  'The Prisma seed script now serializes fatal seed errors through the shared redacted logger helper before printing them.',
  'The Next build cleanup helper now reports sanitized error codes instead of raw filesystem error objects in release transcripts.',
  'The PostgreSQL backup and restore helper now redacts database URLs, DATABASE_URL assignments, --database-url arguments, and user:password credentials from launch evidence transcripts.',
  'The production Supabase checker now redacts bearer keys, apikey values, signed URL tokens, storage object paths, and probe identifiers from request-failure launch transcripts.',
  'Production deploy, preflight, and rollback transcripts now redact database URLs, secret env assignments, bearer/apikey values, and signed token query parameters before surfacing command, smoke, or rollback failures.',
  'Production deploy smoke now redacts readiness keys, bearer values, and signed token query parameters from thrown request-failure launch transcripts.',
  'Production hosting checks now redact bearer values and signed token query parameters from thrown DNS/TLS/fetch failure launch transcripts.',
  'Production observability checks now retain sanitized webhook delivery exception detail while redacting bearer values and signed token query parameters from launch transcripts.',
  'Production provider checks now retain sanitized Stripe and Resend request exception detail while redacting bearer values, provider keys, and signed token query parameters from launch transcripts.',
  'Production release-run evidence checks now redact GitHub bearer tokens, GITHUB_TOKEN assignments, GitHub token prefixes, and signed artifact URL parameters from request-failure transcripts.',
  'Production database checks now catch and redact thrown backup-helper failures while still removing temporary backup directories unless retention is explicitly requested.',
  'Production rollback checks now redact manifest validation failures and thrown deploy exceptions while still deleting temporary merged env files.',
  'Production Supabase checks now redact service-role env assignments as well as bearer/apikey values, signed URL tokens, and storage probe paths from launch transcripts.',
  'Backend architecture docs now describe UUID-backed document storage keys and Stripe customer reconciliation instead of stale pre-hardening behavior.',
  'Request lifecycle docs now describe identifier-aware auth throttles for email, token, refresh-token, and credential buckets.',
  'Module dependency docs now describe auth as a public or partial-auth boundary with identifier-aware throttles instead of a missing organisation-guard concern.',
  'Production deploy preflight now redacts env-file failure transcripts before they are copied into release-gate evidence.',
  'Production environment preflight now redacts token-bearing env-file path failures before they are copied into release-gate evidence.',
  'Production launch evidence status and strict validation now redact token-bearing evidence-file path failures before operator handoff transcripts are stored.',
  'Production launch evidence status now has a non-secret JSON output mode for CI dashboards and operator handoff automation while preserving the strict final validator.',
  'Production launch evidence status completion now requires area statuses as well as all checks and final approval roles, reducing operator/validator drift.',
  'Launch status now exposes text and JSON launch-evidence status commands plus a stricter evidence-status-complete flag for operator dashboards.',
  'Launch status now exposes strict launch-evidence validation commands, including JSON output, alongside the read-only progress commands so operators can move from tracking to final gate validation without command drift.',
  'Strict launch-evidence JSON validation now includes the next incomplete checklist items and evidence hints so failing launch-gate output can drive operator work queues.',
  'Production launch evidence initialization now supports non-secret JSON output for operator dashboards and handoff automation without weakening the strict final validator.',
  'Deployed browser QA now has a no-network environment preflight that checks the deployed QA flag, canonical HTTPS origins, and test credential presence without printing credential values.',
  'Final signoff approval-role evidence now has to name the promoted release.commitSha, so engineering, operations, security, legal/compliance, and business signoffs cannot float across releases.',
    'Launch evidence status now counts final approval roles only when their approval evidence is bound to the promoted release.commitSha.',
    'Launch evidence status completion now requires the full release artifact binding, not only completed checklist statuses and final approval roles.',
    'Launch status now exposes repository branch, HEAD, upstream sync, and dirty-worktree risk so operators do not collect launch evidence from an unpushed or modified ref.',
  'Launch status now keeps the full source-grouped production value checklist visible even after .env.production exists, while separately listing the currently missing values.',
  'Launch status now exposes the deployed browser QA command set, including required environment values, the browserQa.browser-qa-completed preflight success marker, responsive/accessibility commands, cross-browser commands, iOS Safari evidence expectations, and the browserQa evidence target.',
  'Launch status now exposes the full production check, provider, deploy, rollback, release-run evidence, and final evidence validation command sequence needed to close the launch ledger.',
  'Platform audit now surfaces the release image promotion GitHub environment variables, workflow command, digest artifact, and evidence target from launch status so deploy operators do not miss the signed-image prerequisite.',
  'Launch status now exposes the required final signoff roles, solicitor/governance/privacy review, external pentest, release binding, and review-ready legal posture without legal-certainty claims.',
  'Production launch evidence now binds pentest, deployed browser QA, and final signoff proof to the exact promoted release commit SHA.',
  'Production launch evidence references now must use approved HTTPS evidence hosts and reject signed or token-bearing URL query strings.',
  'Production launch evidence now restricts GitHub evidence references to the canonical charity-governance repository.',
  'Production launch evidence chronology now lets operators prepare the package before collecting evidence while requiring all checklist evidence before final signoff approval.',
  'Production launch evidence deploy-smoke hints now match the strict validator by naming the deploy command, standalone smoke command, success marker, and canonical production origins.',
  'Platform audit generation now falls back to reading .git metadata directly when shelling out to git is unavailable.',
  'The plain-English launch guide and platform audit now describe launch status as local non-committed state, so fresh clones and partially configured production workstations do not contradict each other.',
  'Accessibility browser QA now uses commit-stage navigation, parsed-document waits, direct light/dark theme application, and longer owner setup headroom to survive local Next.js cold compiles.',
  'Responsive browser-smoke global setup now warms every public and auth route in the smoke suite before timed browser assertions.',
  'Responsive browser-smoke navigation now retries local Next.js dev-server restart responses after waiting for the web origin, without masking deployed QA failures.',
  'Responsive browser-smoke dashboard coverage now runs one route per test and seeds the shared local owner directly, while auth journey specs still exercise registration UI.',
  'Local Docker web QA now gives Next dev a 6144 MiB default configurable heap ceiling and ignores Playwright report/test-result artifacts so route smoke output does not trigger repeated recompiles.',
  'Local Playwright screenshots, traces, videos, and HTML reports now default outside the repository, while CI writes them to an explicit uploaded artifact directory.',
  'Local Playwright QA now creates external artifact directories before reporters run, keeping early setup failures readable.',
  'Browser auth helpers now pre-seed the cookie-consent preference before registration, login, and invite acceptance so setup submissions are not competing with the consent dialog.',
  'Compliance record autosave now recovers from concurrent create races on the organisation/standard/year key with a scoped update instead of leaking a 500.',
  'Auth journey browser helpers now retry only local dev-server blank form loads after a Next.js restart while keeping deployed QA failures strict.',
  'Irish compliance matrix source metadata was refreshed against official Charities Regulator, Irish Statute Book, and Revised Acts sources on 2026-07-09.',
];

const independentAuditFindings = [
  ['P0', 'Production launch', 'Launch evidence remains a template and .env.production still has placeholders; real provider, hosting, backup, observability, legal, browser QA, and pentest evidence are external blockers.'],
];

function localVerificationEvidence() {
  const { commit: currentCommit } = currentGitBranchAndCommit();
  const selectedGateEvidence =
    RECORDED_SELECTED_GATE_EVIDENCE.commit === currentCommit
      ? `Current local release-gate evidence: \`${RECORDED_SELECTED_GATE_EVIDENCE.command}\` passed locally on ${RECORDED_SELECTED_GATE_EVIDENCE.date} at commit ${RECORDED_SELECTED_GATE_EVIDENCE.commit}: ${RECORDED_SELECTED_GATE_EVIDENCE.summary}.`
      : `Historical local release-gate evidence: \`${RECORDED_SELECTED_GATE_EVIDENCE.command}\` passed locally on ${RECORDED_SELECTED_GATE_EVIDENCE.date} at commit ${RECORDED_SELECTED_GATE_EVIDENCE.commit}: ${RECORDED_SELECTED_GATE_EVIDENCE.summary}. This may be stale for the current checkout; rerun the selected gate on the final release ref and verify \`npm run launch:status -- --json\` reports the intended \`repositoryState.headSha\` before treating it as current release evidence.`;

  return [
    selectedGateEvidence,
    '`npm run test:production-check` passed locally on 2026-07-09 with 352/352 production-tooling checks passing, including production validators, launch evidence validation, provider checker contracts, GitHub secret-store checker contracts, deployment tooling, deployed browser QA environment preflight, launch evidence work queue JSON, and CI/release workflow guards.',
    '`node --test scripts\\check-production-providers.test.mjs scripts\\production-launch-evidence.test.mjs` passed locally for provider and launch-evidence hardening.',
    '`npm test` passed locally across workspace tests, production-check scripts, and local Docker guard checks.',
    '`npm run test:e2e -- tests/accessibility.spec.ts` passed locally on 2026-07-08 across launch-critical public/auth and dashboard routes in light and dark themes, with no serious/critical violations.',
    '`cd e2e && npm test -- tests/accessibility.spec.ts --grep "/blog/understanding-the-charities-governance-code is axe-clean" --repeat-each=3` passed locally on 2026-07-09 after blog article dark-mode contrast hardening.',
    'Local responsive browser QA revalidated cleanly on 2026-07-09 with focused `npm run test:e2e:responsive:*` chunk commands: public desktop 14/14, public mobile 14/14, dashboard desktop 12/12, and dashboard mobile 12/12.',
    '`npm run test:e2e -- tests/accessibility.spec.ts` passed locally on 2026-07-09 with 26/26 accessibility checks across launch-critical public/auth and dashboard routes in light and dark themes.',
    '`npm run test:local-docker`, `npm run test:production-check`, and `npm run build -w @charitypilot/api` passed locally after the launch-status JSON and log-redaction hardening.',
    '`npm run lint -w @charitypilot/web`, `npm run build -w @charitypilot/web`, `node --check scripts\\platform-completion-audit.mjs`, and `npm run test:production-check` passed locally after shared board/deadline/team/document/export mutation-status, billing action/status and price-band cleanup, team permission-hint cleanup, launch-evidence hardening, GitHub secret-store checker hardening, release-ready stack probe/repo-scoped child-process cleanup/no-shell gate execution hardening, deployed browser QA env preflight hardening, and launch evidence work-queue JSON hardening; production-tooling checks passed 352/352.',
    '`node --check scripts\\clean-next-export.cjs`, `node --test scripts\\check-production.test.mjs`, and `npm run test:production-check` passed locally after the Next cleanup transcript hardening.',
    '`node --check scripts\\postgres-backup.mjs`, `node --test scripts\\postgres-backup.test.mjs`, and `npm run test:production-check` passed locally after the PostgreSQL backup transcript-redaction hardening.',
    '`node --check scripts\\check-production-supabase.mjs`, `node --test scripts\\check-production-supabase.test.mjs`, and `npm run test:production-check` passed locally after the Supabase request-failure transcript hardening.',
    '`node --check scripts\\production-deploy-preflight.mjs scripts\\production-compose-deploy.mjs scripts\\production-compose-rollback.mjs`, focused deploy/rollback tests, and `npm run test:production-check` passed locally after deploy transcript-redaction hardening.',
    '`node --check scripts\\smoke-production-deploy.mjs`, focused smoke/deploy tests, and `npm run test:production-check` passed locally after production deploy smoke transcript-redaction hardening.',
    '`node --check scripts\\check-production-hosting.mjs`, focused hosting/smoke tests, and `npm run test:production-check` passed locally after production hosting transcript-redaction hardening.',
    '`node --check scripts\\check-production-observability.mjs`, focused observability/provider/hosting tests, and `npm run test:production-check` passed locally after production observability transcript-redaction hardening.',
    '`node --check scripts\\check-production-providers.mjs`, focused provider/preflight tests, and `npm run test:production-check` passed locally after production provider transcript-redaction hardening.',
    '`node --check scripts\\production-release-run-evidence.mjs`, focused release-run/preflight tests, and `npm run test:production-check` passed locally after production release-run transcript-redaction hardening.',
    '`node --check scripts\\check-production-database.mjs`, focused database/backup tests, and `npm run test:production-check` passed locally after production database checker thrown-failure redaction hardening.',
    '`node --check scripts\\production-compose-rollback.mjs`, focused rollback/deploy/preflight tests, and `npm run test:production-check` passed locally after production rollback transcript-redaction hardening.',
    '`node --check scripts\\check-production-supabase.mjs`, focused Supabase/production-config tests, and `npm run test:production-check` passed locally after production Supabase transcript-redaction hardening.',
    '`node --check scripts\\production-deploy-preflight.mjs`, focused deploy/preflight/rollback tests, and `npm run test:production-check` passed locally after production deploy preflight env-failure transcript hardening.',
    '`node --check scripts\\check-production.mjs`, focused production/preflight tests, and `npm run test:production-check` passed locally after production environment preflight path-redaction hardening.',
    '`node --check scripts\\production-launch-evidence.mjs scripts\\production-launch-evidence-status.mjs`, focused launch-evidence/status tests, and `npm run test:production-check` passed locally after production launch evidence path-redaction hardening.',
    '`node --check scripts\\production-launch-evidence-status.mjs`, focused launch-evidence status tests, and `npm run test:production-check` passed locally after production launch evidence status JSON hardening.',
    '`node --check scripts\\production-launch-evidence-status.mjs`, focused launch-evidence status tests, and `npm run test:production-check` passed locally after aligning status completion with area statuses.',
    '`node --check scripts\\launch-status.mjs scripts\\production-launch-evidence-status.mjs`, focused launch-status/evidence-status tests, and `npm run test:production-check` passed locally after surfacing launch-evidence status commands in launch status.',
    '`npm run test:local-docker:smoke` passed locally on 2026-07-08 after stabilizing the local Docker QA stack, covering API health/readiness, registration, local admin document storage, and the web root over loopback.',
    'CI local Docker smoke passed on 2026-07-09 at commit 91e26b9, covering API health/readiness, registration, local admin document storage, and the web root over loopback before production Docker image gates.',
    '`npm run personal:ready` passed locally on 2026-07-09, covering local Docker smoke, PostgreSQL backup, restore verification, local document storage backup, and a non-destructive personal browser smoke with billing disabled when Stripe is absent.',
    'This is local Docker evidence only; deployed HTTPS QA with `E2E_DEPLOYED_QA=true` remains a launch gate.',
  ];
}

const officialSources = [
  ['Charities Governance Code', 'Charities Regulator', 'https://www.charitiesregulator.ie/en/information-for-charities/charities-governance-code'],
  ['Toolkit and templates', 'Charities Regulator', 'https://www.charitiesregulator.ie/en/information-for-charities/charities-governance-code/toolkit-and-templates'],
  ['Compliance Record Form', 'Charities Regulator', 'https://www.charitiesregulator.ie/en/guidance/forms-and-templates/forms'],
  ['Annual report submission guidance', 'Charities Regulator', 'https://www.charitiesregulator.ie/en/information-for-charities/annual-report-how-to-submit'],
  ['Charities Act 2009 revised', 'Law Reform Commission', 'https://revisedacts.lawreform.ie/eli/2009/act/6/front/revised/en/html'],
  ['Charities (Amendment) Act 2024 commencement table', 'Irish Statute Book', 'https://www.irishstatutebook.ie/isbc/2024_21.html'],
  ['S.I. No. 10/2025 commencement order', 'Irish Statute Book', 'https://www.irishstatutebook.ie/eli/2025/si/10/made/en/print'],
  ['GDPR accountability obligation', 'Data Protection Commission', 'https://www.dataprotection.ie/en/organisations/know-your-obligations/accountability-obligation'],
  ['Safety Statement and Risk Assessment', 'Health and Safety Authority', 'https://www.hsa.ie/topics/managing_health_and_safety/safety_statement_and_risk_assessment/'],
  ['Child safeguarding statement relevance', 'Tusla', 'https://www.tusla.ie/children-first/organisations/what-is-a-child-safeguarding-statement/who-needs-to-have-a-child-safeguarding-statement/'],
  ['Protected disclosures employer obligations', 'Workplace Relations Commission', 'https://www.workplacerelations.ie/en/what_you_should_know/employer-obligations/protection-of-whistleblowers/new-obligations-under-the-protected-disclosures-amendment-act-2022/'],
];

function normalizePath(path) {
  return path.split(sep).join('/');
}

function shell(command) {
  try {
    return execSync(command, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function readGitHead() {
  const headPath = join(repoRoot, '.git', 'HEAD');
  if (!existsSync(headPath)) return { branch: '', commit: '' };

  const head = readFileSync(headPath, 'utf8').trim();
  const refPrefix = 'ref: ';
  if (!head.startsWith(refPrefix)) return { branch: '', commit: head };

  const ref = head.slice(refPrefix.length);
  const refPath = join(repoRoot, '.git', ...ref.split('/'));
  const branch = ref.split('/').at(-1) ?? '';
  if (existsSync(refPath)) {
    return { branch, commit: readFileSync(refPath, 'utf8').trim() };
  }

  const packedRefsPath = join(repoRoot, '.git', 'packed-refs');
  if (existsSync(packedRefsPath)) {
    const packed = readFileSync(packedRefsPath, 'utf8')
      .split(/\r?\n/)
      .find((line) => line.endsWith(` ${ref}`));
    if (packed) return { branch, commit: packed.split(' ')[0] };
  }

  return { branch, commit: '' };
}

function currentGitBranchAndCommit() {
  const fallback = readGitHead();
  return {
    branch: shell('git branch --show-current') || fallback.branch || 'unknown',
    commit: shell('git rev-parse --short HEAD') || fallback.commit.slice(0, 7) || 'unknown',
  };
}

function walk(dir, predicate, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.next', '.turbo', 'dist', '.git'].includes(entry.name)) continue;
      walk(child, predicate, files);
      continue;
    }
    if (entry.isFile() && predicate(child)) files.push(child);
  }
  return files;
}

function lineCount(content) {
  if (!content) return 0;
  return content.split(/\r?\n/).length;
}

function routeFromPage(pagePath) {
  const appRoot = join(repoRoot, 'apps', 'web', 'src', 'app');
  const rel = normalizePath(relative(appRoot, pagePath)).replace(/\/page\.tsx$/, '');
  const parts = rel.split('/').filter(Boolean).filter((part) => !/^\(.+\)$/.test(part));
  return `/${parts.join('/')}`.replace(/\/$/, '') || '/';
}

function routeArea(pagePath) {
  const normalized = normalizePath(pagePath);
  if (normalized.includes('/(marketing)/')) return 'marketing';
  if (normalized.includes('/(auth)/')) return 'auth';
  if (normalized.includes('/(dashboard)/')) return 'dashboard';
  return 'root';
}

function routeSurfaceContent(pagePath, pageContent) {
  const routeDir = dirname(pagePath);
  const siblingSurfaceFiles = readdirSync(routeDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith('.tsx') && name !== 'page.tsx' && !name.endsWith('.test.tsx'))
    .sort();

  const siblingContent = siblingSurfaceFiles.map((name) => readFileSync(join(routeDir, name), 'utf8'));
  return [pageContent, ...siblingContent].join('\n');
}

function countMatches(content, pattern) {
  return [...content.matchAll(pattern)].length;
}

const gradientOrBlurPattern = /gradient|blur-/;
const pillLikeDecorativePattern =
  /(?:rounded-full[^\n"'`]*(?:border|px-|py-|shadow)|(?:border|px-|py-|shadow)[^\n"'`]*rounded-full)/;

function hasDecorativeStylingRisk(content) {
  return gradientOrBlurPattern.test(content) || pillLikeDecorativePattern.test(content);
}

function routeRisks(content, pageContent, lines, route, area) {
  const risks = [];
  const svgCount = countMatches(content, /<svg\b/g);
  if (lines >= 700) risks.push('oversized route file; split first');
  else if (lines >= 450) risks.push('large route file; refactor soon');
  if (svgCount > 0) risks.push(`${svgCount} inline svg icon(s)`);
  if (hasDecorativeStylingRisk(content)) risks.push('decorative or pill-heavy styling needs visual QA');
  if (!/dark:|\bcp-surface\b|\bcp-text\b/.test(content)) risks.push('dark-mode relies mostly on layout; screenshot QA required');
  if (/use client/.test(pageContent) && !/ErrorState|error|catch|toast|setError/i.test(content)) risks.push('client flow has weak visible error-state signal');
  if (routePriorities.get(route) === 'P0' && area === 'dashboard' && !/source|Source|review|Review|evidence|Evidence/.test(content)) {
    risks.push('trust workflow should expose source/evidence review cues');
  }
  return risks.length ? risks.join('; ') : 'no obvious static risk; verify in browser';
}

function readRouteInventory() {
  const appRoot = join(repoRoot, 'apps', 'web', 'src', 'app');
  return walk(appRoot, (file) => file.endsWith(`${sep}page.tsx`))
    .map((pagePath) => {
      const content = readFileSync(pagePath, 'utf8');
      const surfaceContent = routeSurfaceContent(pagePath, content);
      const route = routeFromPage(pagePath);
      const area = routeArea(pagePath);
      const lines = lineCount(content);
      return {
        route,
        area,
        file: normalizePath(relative(repoRoot, pagePath)),
        lines,
        client: /['"]use client['"]/.test(content),
        priority: routePriorities.get(route) ?? 'P2',
        risks: routeRisks(surfaceContent, content, lines, route, area),
      };
    })
    .sort((a, b) => a.route.localeCompare(b.route));
}

function readApiInventory() {
  const routesRoot = join(repoRoot, 'apps', 'api', 'src', 'routes');
  const testsRoot = join(repoRoot, 'apps', 'api', 'src', 'tests');
  const testFiles = existsSync(testsRoot)
    ? readdirSync(testsRoot).filter((name) => name.endsWith('.test.ts'))
    : [];

  return readdirSync(routesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const routeFile = join(routesRoot, entry.name, 'index.ts');
      const content = existsSync(routeFile) ? readFileSync(routeFile, 'utf8') : '';
      const tests = testFiles.filter((name) => name.includes(entry.name) || name.includes(entry.name.replace(/s$/, ''))).length;
      const guards = [
        content.includes('authGuard') ? 'auth' : '',
        content.includes('subscriptionGuard') || content.includes('requireSubscription') ? 'subscription' : '',
        content.includes('requireAdmin') ? 'admin writes' : '',
        content.includes('requireOwner') ? 'owner actions' : '',
        content.includes('requirePlan') || content.includes('COMPLETE') ? 'plan gate' : '',
      ].filter(Boolean);
      const isPublic = ['auth', 'health'].includes(entry.name);
      const review = !isPublic && !content.includes('authGuard')
        ? 'verify auth guard before launch'
        : 'preserve current guard and tenant boundary';
      return {
        group: entry.name,
        file: normalizePath(relative(repoRoot, routeFile)),
        lines: lineCount(content),
        guards: guards.length ? guards.join(', ') : isPublic ? 'public/partial by design' : 'none detected',
        tests,
        review,
      };
    })
    .sort((a, b) => a.group.localeCompare(b.group));
}

function readComplianceSummary() {
  const matrixPath = join(repoRoot, 'packages', 'shared', 'src', 'constants', 'irish-compliance-matrix.ts');
  const sourcePath = join(repoRoot, 'docs', 'product-revamp', 'irish-source-log.md');
  const matrix = readFileSync(matrixPath, 'utf8');
  const sourceLogExists = existsSync(sourcePath);
  const lastChecked = matrix.match(/IRISH_COMPLIANCE_MATRIX_LAST_CHECKED\s*=\s*'([^']+)'/)?.[1] ?? 'unknown';
  const entries = countMatches(matrix, /\bid:\s*'/g);
  const statuses = {};
  for (const match of matrix.matchAll(/commencementStatus:\s*'([^']+)'/g)) {
    statuses[match[1]] = (statuses[match[1]] ?? 0) + 1;
  }
  return { lastChecked, entries, statuses, sourceLogExists };
}

function readLaunchSummary() {
  const envPath = join(repoRoot, '.env.production');
  const evidenceFileExists = existsSync(launchEvidencePath);
  const repositoryState = collectRepositoryState();
  const state = assessLaunchState({
    envExists: existsSync(envPath),
    envContent: existsSync(envPath) ? readFileSync(envPath, 'utf8') : '',
    evidenceContent: evidenceFileExists ? decodeJsonFile(launchEvidencePath) : '',
    evidenceFileExists,
    repositoryState,
  });
  return {
    phase: state.phase,
    headline: state.headline,
    remainingKeys: state.remainingKeys ?? [],
    remainingKeyDetails: state.remainingKeyDetails ?? [],
    remainingKeyGroups: state.remainingKeyGroups ?? [],
    launchProgress: state.launchProgress,
    evidenceLedger: state.evidenceLedger,
    deployedBrowserQa: state.deployedBrowserQa,
    localPersonalReadiness: state.localPersonalReadiness,
    productionLaunchCommands: state.productionLaunchCommands,
    finalLaunchEvidenceWorkflow: state.finalLaunchEvidenceWorkflow,
    releaseImagePromotion: state.releaseImagePromotion,
    finalSignoffRequirements: state.finalSignoffRequirements,
    repositoryState: state.repositoryState,
  };
}

function localLaunchStateNote(launch) {
  if (launch.phase === 'NO_ENV') {
    return 'This generated section reflects local non-committed files. This checkout has no `.env.production` and no committed launch evidence; a partially configured production workstation may instead report `ENV_INCOMPLETE` with operator-supplied values still outstanding.';
  }

  if (launch.phase === 'ENV_INCOMPLETE') {
    return 'This generated section reflects the local non-committed `.env.production`; listed placeholder, provider, TLS, or cookie issues are not committed and may differ on another operator workstation or secret-store checkout.';
  }

  return 'This generated section reflects the local non-committed `.env.production`; launch still depends on external evidence and final signoffs, even when local placeholders are filled.';
}

function readTestSurfaceSummary() {
  const e2eTests = walk(join(repoRoot, 'e2e', 'tests'), (file) => file.endsWith('.spec.ts')).length;
  const apiTests = walk(join(repoRoot, 'apps', 'api', 'src', 'tests'), (file) => file.endsWith('.test.ts')).length;
  const webTests = walk(join(repoRoot, 'apps', 'web', 'src'), (file) => file.endsWith('.test.ts') || file.endsWith('.test.tsx')).length;
  return { e2eTests, apiTests, webTests };
}

function markdownList(items) {
  return items.map((item) => `- ${item}`).join('\n');
}

function deriveFrontendAuditState(routes) {
  const oversizedRoutes = routes
    .filter((route) => route.lines >= 450)
    .sort((a, b) => b.lines - a.lines);
  const p0Routes = routes.filter((route) => route.priority === 'P0');
  const inlineSvgRoutes = routes.filter((route) => route.risks.includes('inline svg'));
  const decorativeRoutes = routes.filter((route) => route.risks.includes('decorative or pill-heavy'));
  const oversizedRouteSummary = oversizedRoutes.slice(0, 6).map((r) => `${r.route} (${r.lines})`).join(', ');
  const productUiNextAction = oversizedRoutes.length > 0
    ? `Refactor and browser-QA the largest P0 workflows first: ${oversizedRouteSummary}.`
    : inlineSvgRoutes.length > 0
      ? 'Browser-QA flagged P0 workflows and clean remaining route-local inline SVG/decorative styling.'
      : decorativeRoutes.length > 0
        ? 'Browser-QA flagged P0 workflows and visual treatment on decorative or pill-heavy pages.'
        : 'Complete deployed browser QA for every route across desktop/mobile and both themes.';
  const frontendPolishFinding = oversizedRoutes.length > 0
    ? `Largest all-client route remains ${oversizedRoutes[0].route} (${oversizedRoutes[0].lines} lines); keep splitting route-local forms/cards/hooks before broader visual polish and browser QA.`
    : inlineSvgRoutes.length > 0
      ? 'No route files remain over 450 lines; shift frontend polish toward browser QA, route-local icon cleanup, and visual treatment on flagged P0 routes.'
      : decorativeRoutes.length > 0
        ? 'No route files remain over 450 lines and route page inline SVG findings are closed; shift frontend polish toward browser QA and visual treatment on flagged P0 routes.'
        : 'No route files remain over 450 lines, route page inline SVG findings are closed, and route-surface static dark-mode/decorative findings are clear; deployed browser and accessibility evidence remain.';
  const workflowPolishStep = oversizedRoutes.length > 0
    ? 'Decompose and polish the largest remaining P0 workflows: documents, board, dashboard, export, organisation, deadlines, compliance detail, and route-specific browser-QA follow-ups.'
    : decorativeRoutes.length > 0
      ? 'Browser-QA and polish flagged P0 workflows: dashboard, export, regulator, billing, compliance, documents, board, and auth/marketing entry points.'
      : 'Complete deployed browser QA across every route in desktop/mobile and light/dark mode, then attach production-only evidence.';
  const stateUiFollowupStep = oversizedRoutes.length > 0 || inlineSvgRoutes.length > 0 || decorativeRoutes.length > 0
    ? 'Convert remaining route-local state UI into shared primitives for loading, empty, error, locked-feature, review-warning, status, source, evidence, and sticky form actions.'
    : 'Use deployed QA findings to fix route-specific state or visual regressions with shared primitives for loading, empty, error, locked-feature, review-warning, status, source, evidence, and sticky form actions.';

  return {
    oversizedRoutes,
    p0Routes,
    inlineSvgRoutes,
    decorativeRoutes,
    productUiNextAction,
    frontendPolishFinding,
    workflowPolishStep,
    stateUiFollowupStep,
  };
}

export function buildAuditPayload() {
  const routes = readRouteInventory();
  const apis = readApiInventory();
  const compliance = readComplianceSummary();
  const launch = readLaunchSummary();
  const tests = readTestSurfaceSummary();
  const { branch, commit } = currentGitBranchAndCommit();
  const frontend = deriveFrontendAuditState(routes);
  const launchStateNote = localLaunchStateNote(launch);
  const nextCompletionSequence = [
    'Close launch evidence: real secret store, provider accounts, hosting, DNS/TLS, backups, observability, release evidence, and external signoffs.',
    frontend.workflowPolishStep,
    frontend.stateUiFollowupStep,
    'Keep compliance source metadata, professional-review flags, and conditional obligation prioritisation review-ready across deadlines, registers, evidence, exports, and regulator workflows without creating legal-certainty claims.',
    'Run deployed HTTPS browser QA, accessibility checks in both themes, tenant-isolation regression tests, document privacy checks, billing/email provider checks, and external penetration testing.',
  ];

  return {
    generated: auditDate,
    branch,
    commit,
    generationNote:
      'Repository state is live-only; run npm run launch:status -- --json from the release checkout before collecting launch evidence.',
    legalPosture:
      'This ledger is an engineering audit, not legal advice, and does not claim CharityPilot is legally complete, guaranteed, or ready to process real charity data.',
    auditCommands: {
      writeMarkdown: 'npm run audit:platform',
      checkMarkdown: 'npm run audit:platform:check',
      json: 'node scripts/platform-completion-audit.mjs --json',
    },
    counts: {
      routes: routes.length,
      p0Routes: frontend.p0Routes.length,
      oversizedRouteFiles: frontend.oversizedRoutes.length,
      inlineSvgRouteFindings: frontend.inlineSvgRoutes.length,
      decorativeRouteFindings: frontend.decorativeRoutes.length,
      apiRouteGroups: apis.length,
      webTestFiles: tests.webTests,
      apiTestFiles: tests.apiTests,
      e2eSpecs: tests.e2eTests,
    },
    executiveReadiness: {
      productUi: {
        currentState: `${routes.length} page routes scanned; ${frontend.p0Routes.length} are P0 trustee/compliance workflows; ${frontend.oversizedRoutes.length} route files are 450+ lines.`,
        nextAction: frontend.productUiNextAction,
      },
      apiBackend: {
        currentState: `${apis.length} route groups scanned with route-local guard heuristics and ${tests.apiTests} API test files.`,
        nextAction: 'Preserve auth, tenant isolation, role guards, plan gates, validation, and redaction while fixing only audit-backed defects.',
      },
      launchOperations: {
        currentState: launch.headline,
        nextAction: 'Complete external provider, hosting, backup, observability, legal, browser QA, and security evidence before real charity data.',
      },
      irishComplianceModel: {
        currentState: `${compliance.entries} matrix entries; last checked ${compliance.lastChecked}; statuses ${Object.entries(compliance.statuses).map(([k, v]) => `${k}:${v}`).join(', ')}.`,
        nextAction: 'Refresh official sources before legal copy changes and record professional-review signoff outside git.',
      },
      verificationSurface: {
        currentState: `${tests.webTests} web unit test files, ${tests.apiTests} API test files, ${tests.e2eTests} Playwright specs.`,
        nextAction: 'Run full release, production-check, accessibility, and deployed-browser gates before launch signoff.',
      },
    },
    fixedInThisAuditPass: fixedInThisAuditBranch,
    localVerificationEvidence: localVerificationEvidence(),
    independentAuditFindings: [
      ...independentAuditFindings.map(([priority, area, finding]) => ({ priority, area, finding })),
      { priority: 'P1', area: 'Frontend polish', finding: frontend.frontendPolishFinding },
    ],
    routeAudit: routes,
    apiAndBackendAudit: apis,
    launch: {
      ...launch,
      launchBlockers,
      localStateNote: launchStateNote,
    },
    compliance: {
      ...compliance,
      officialSources: officialSources.map(([title, owner, url]) => ({ title, owner, url })),
    },
    tests,
    nextCompletionSequence,
  };
}

function render() {
  const routes = readRouteInventory();
  const apis = readApiInventory();
  const compliance = readComplianceSummary();
  const launch = readLaunchSummary();
  const tests = readTestSurfaceSummary();
  const { branch } = currentGitBranchAndCommit();
  const {
    oversizedRoutes,
    p0Routes,
    productUiNextAction,
    frontendPolishFinding,
    workflowPolishStep,
    stateUiFollowupStep,
  } = deriveFrontendAuditState(routes);

  let md = `# CharityPilot Platform Completion Audit\n\n`;
  md += `Generated: ${auditDate}\n\n`;
  md += `Branch: \`${branch}\`\n\n`;
  md += `Generation note: repository state is intentionally live-only; run \`npm run launch:status -- --json\` from the release checkout before collecting launch evidence. Use \`node scripts/platform-completion-audit.mjs --json\` for machine-readable route, backend, launch, compliance, and next-action data without rewriting this Markdown ledger.\n\n`;
  md += `This ledger is a current-state engineering audit. It is not legal advice and does not claim CharityPilot is legally complete, guaranteed, or ready to process real charity data.\n\n`;

  md += `## Executive Readiness\n\n`;
  md += `| Area | Current state | Next action |\n`;
  md += `| --- | --- | --- |\n`;
  md += `| Product UI | ${routes.length} page routes scanned; ${p0Routes.length} are P0 trustee/compliance workflows; ${oversizedRoutes.length} route files are 450+ lines. | ${productUiNextAction} |\n`;
  md += `| API/backend | ${apis.length} route groups scanned with route-local guard heuristics and ${tests.apiTests} API test files. | Preserve auth, tenant isolation, role guards, plan gates, validation, and redaction while fixing only audit-backed defects. |\n`;
  md += `| Launch operations | ${launch.headline.replace(/\|/g, '\\|')} | Complete external provider, hosting, backup, observability, legal, browser QA, and security evidence before real charity data. |\n`;
  md += `| Irish compliance model | ${compliance.entries} matrix entries; last checked ${compliance.lastChecked}; statuses ${Object.entries(compliance.statuses).map(([k, v]) => `${k}:${v}`).join(', ')}. | Refresh official sources before legal copy changes and record professional-review signoff outside git. |\n`;
  md += `| Verification surface | ${tests.webTests} web unit test files, ${tests.apiTests} API test files, ${tests.e2eTests} Playwright specs. | Run full release, production-check, accessibility, and deployed-browser gates before launch signoff. |\n\n`;

  md += `## Fixed During This Audit Pass\n\n`;
  md += `${markdownList(fixedInThisAuditBranch)}\n\n`;

  md += `## Local Verification Evidence\n\n`;
  md += `${markdownList(localVerificationEvidence())}\n\n`;

  md += `## Independent Audit Findings Still Driving Next Work\n\n`;
  md += `| Priority | Area | Finding |\n`;
  md += `| --- | --- | --- |\n`;
  for (const [priority, area, finding] of [
    ...independentAuditFindings,
    ['P1', 'Frontend polish', frontendPolishFinding],
  ]) {
    md += `| ${priority} | ${area} | ${finding.replace(/\|/g, '\\|')} |\n`;
  }
  md += `\n`;

  md += `## Route Audit\n\n`;
  md += `| Priority | Route | Area | File | Lines | Client | Static audit finding |\n`;
  md += `| --- | --- | --- | --- | ---: | --- | --- |\n`;
  for (const route of routes) {
    md += `| ${route.priority} | \`${route.route}\` | ${route.area} | \`${route.file}\` | ${route.lines} | ${route.client ? 'yes' : 'no'} | ${route.risks.replace(/\|/g, '\\|')} |\n`;
  }

  md += `\n## API And Backend Audit\n\n`;
  md += `| Route group | File | Lines | Guard signals | Nearby tests | Audit note |\n`;
  md += `| --- | --- | ---: | --- | ---: | --- |\n`;
  for (const api of apis) {
    md += `| \`${api.group}\` | \`${api.file}\` | ${api.lines} | ${api.guards} | ${api.tests} | ${api.review} |\n`;
  }

  md += `\n## Launch Evidence Blockers\n\n`;
  md += `${markdownList(launchBlockers)}\n\n`;
  md += `Local-state note: ${localLaunchStateNote(launch)}\n\n`;
  md += `### Launch Evidence Ledger\n\n`;
  md += `- ${launch.evidenceLedger.headline}\n`;
  if (launch.evidenceLedger.exists && typeof launch.evidenceLedger.approvedForLaunch === 'boolean') {
    md += `- approvedForLaunch: ${launch.evidenceLedger.approvedForLaunch ? 'true' : 'false'}\n`;
    md += `- finalSignoff: ${launch.evidenceLedger.finalSignoffStatus}\n`;
    md += `- Final approval roles approved: ${launch.evidenceLedger.approvedFinalSignoffRoles} / ${launch.evidenceLedger.totalFinalSignoffRoles}\n`;
    if (launch.evidenceLedger.releaseBinding) {
      md += `- Release binding: ${launch.evidenceLedger.releaseBinding.headline}\n`;
    }
  }
  if (launch.evidenceLedger.nextIncompleteChecks?.length > 0) {
    md += `- Next incomplete checks:\n`;
    for (const check of launch.evidenceLedger.nextIncompleteChecks) md += `  - ${check}\n`;
  }
  md += `- ${launch.evidenceLedger.nextAction}\n`;
  if (launch.evidenceLedger.validationCommand || launch.evidenceLedger.jsonValidationCommand) {
    md += `- Strict validation: \`${launch.evidenceLedger.validationCommand}\`\n`;
    md += `- Strict validation JSON: \`${launch.evidenceLedger.jsonValidationCommand}\`\n`;
  }
  md += `\n`;
  if (launch.localPersonalReadiness) {
    md += `### Local Personal Data Safety\n\n`;
    md += `- Command: \`${launch.localPersonalReadiness.command}\`\n`;
    md += `- Docs: \`${launch.localPersonalReadiness.docs}\`\n`;
    md += `- Purpose: ${launch.localPersonalReadiness.purpose}\n`;
    md += `- Proves:\n`;
    for (const item of launch.localPersonalReadiness.proves) md += `  - ${item}\n`;
    md += `- Warning: ${launch.localPersonalReadiness.warning}\n`;
    md += `- Launch evidence limit: ${launch.localPersonalReadiness.notLaunchEvidence}\n\n`;
  }
  if (launch.deployedBrowserQa) {
    md += `### Deployed Browser QA Commands\n\n`;
    md += `- Required environment:\n`;
    for (const item of launch.deployedBrowserQa.requiredEnvironment) md += `  - \`${item}\`\n`;
    md += `- Preflight: \`${launch.deployedBrowserQa.preflightCommand}\`\n`;
    md += `- Preflight JSON: \`${launch.deployedBrowserQa.preflightJsonCommand}\`\n`;
    md += `- Responsive: \`${launch.deployedBrowserQa.responsiveCommand}\`\n`;
    md += `- Focused responsive chunks:\n`;
    for (const command of launch.deployedBrowserQa.focusedResponsiveCommands) md += `  - \`${command}\`\n`;
    md += `- Accessibility: \`${launch.deployedBrowserQa.accessibilityCommand}\`\n`;
    md += `- Cross-browser responsive: \`${launch.deployedBrowserQa.crossBrowserResponsiveCommand}\`\n`;
    md += `- Cross-browser accessibility: \`${launch.deployedBrowserQa.crossBrowserAccessibilityCommand}\`\n`;
    md += `- iOS Safari: ${launch.deployedBrowserQa.iosSafariEvidence}\n`;
    md += `- Evidence target: ${launch.deployedBrowserQa.evidenceTarget}\n\n`;
  }
  if (launch.productionLaunchCommands) {
    md += `### Production Launch Command Sequence\n\n`;
    md += `- Core preflight: \`${launch.productionLaunchCommands.corePreflight}\`\n`;
    md += `- GitHub production environment: \`${launch.productionLaunchCommands.githubEnvironment}\`\n`;
    md += `- GitHub production environment JSON: \`${launch.productionLaunchCommands.githubEnvironmentJson}\`\n`;
    md += `- GitHub production secret store: \`${launch.productionLaunchCommands.githubSecretStore}\`\n`;
    md += `- GitHub production secret-store JSON: \`${launch.productionLaunchCommands.githubSecretStoreJson}\`\n`;
    md += `- Hosting/DNS/TLS: \`${launch.productionLaunchCommands.hosting}\`\n`;
    md += `- Database backup/restore: \`${launch.productionLaunchCommands.database}\`\n`;
    md += `- Supabase storage: \`${launch.productionLaunchCommands.supabase}\`\n`;
    md += `- Stripe/Resend providers: \`${launch.productionLaunchCommands.providers}\`\n`;
    md += `- Observability alerting: \`${launch.productionLaunchCommands.observability}\`\n`;
    md += `- Deployed browser QA env preflight: \`${launch.productionLaunchCommands.deployedBrowserQaPreflight}\`\n`;
    md += `- Deployed browser QA env preflight JSON: \`${launch.productionLaunchCommands.deployedBrowserQaPreflightJson}\`\n`;
    md += `- Deploy preflight: \`${launch.productionLaunchCommands.deployPreflight}\`\n`;
    md += `- Deploy production: \`${launch.productionLaunchCommands.deployProduction}\`\n`;
    md += `- Rollback rehearsal: \`${launch.productionLaunchCommands.rollbackRehearsal}\`\n`;
    md += `- Release-run evidence: \`${launch.productionLaunchCommands.releaseRunEvidence}\`\n`;
    md += `- Release-run evidence JSON: \`${launch.productionLaunchCommands.releaseRunEvidenceJson}\`\n`;
    md += `- Final evidence validation: \`${launch.productionLaunchCommands.finalEvidenceValidation}\`\n`;
    md += `- Final evidence validation JSON: \`${launch.productionLaunchCommands.finalEvidenceValidationJson}\`\n\n`;
  }
  if (launch.finalLaunchEvidenceWorkflow) {
    md += `### Protected Final Launch Evidence Workflow\n\n`;
    md += `- Upload workflow file: \`${launch.finalLaunchEvidenceWorkflow.uploadWorkflowFile}\`\n`;
    md += `- Workflow file: \`${launch.finalLaunchEvidenceWorkflow.workflowFile}\`\n`;
    md += `- GitHub environment: \`${launch.finalLaunchEvidenceWorkflow.githubEnvironment}\`\n`;
    md += `- Required input: \`${launch.finalLaunchEvidenceWorkflow.requiredInput}\`\n`;
    md += `- Default evidence artifact: \`${launch.finalLaunchEvidenceWorkflow.defaultArtifactName}\`\n`;
    md += `- Default evidence file: \`${launch.finalLaunchEvidenceWorkflow.defaultEvidenceFileName}\`\n`;
    md += `- Validation artifact: \`${launch.finalLaunchEvidenceWorkflow.validationArtifactName}\`\n`;
    md += `- Validation artifact files:\n`;
    for (const artifactFile of launch.finalLaunchEvidenceWorkflow.validationArtifactFiles) md += `  - \`${artifactFile}\`\n`;
    md += `- Prepare/upload: \`${launch.finalLaunchEvidenceWorkflow.prepareUploadCommand}\`\n`;
    md += `- Upload evidence target: ${launch.finalLaunchEvidenceWorkflow.uploadEvidenceTarget}\n`;
    md += `- Run: \`${launch.finalLaunchEvidenceWorkflow.runCommand}\`\n`;
    md += `- Evidence target: ${launch.finalLaunchEvidenceWorkflow.evidenceTarget}\n\n`;
  }
  if (launch.releaseImagePromotion) {
    md += `### Release Image Promotion\n\n`;
    md += `- GitHub environment: \`${launch.releaseImagePromotion.githubEnvironment}\`\n`;
    md += `- Required GitHub environment variables:\n`;
    for (const item of launch.releaseImagePromotion.requiredGitHubEnvironmentVariables) md += `  - \`${item}\`\n`;
    md += `- Configure with:\n`;
    for (const command of launch.releaseImagePromotion.configureCommands) md += `  - \`${command}\`\n`;
    md += `- Workflow: \`${launch.releaseImagePromotion.workflowCommand}\`\n`;
    md += `- Watch: \`${launch.releaseImagePromotion.watchCommand}\`\n`;
    md += `- Preflight GitHub environment: \`${launch.releaseImagePromotion.githubEnvironmentCheckCommand}\`\n`;
    md += `- Preflight GitHub environment JSON: \`${launch.releaseImagePromotion.githubEnvironmentCheckJsonCommand}\`\n`;
    md += `- Digest artifact: \`${launch.releaseImagePromotion.evidenceArtifact}\`\n`;
    md += `- Evidence target: ${launch.releaseImagePromotion.evidenceTarget}\n\n`;
  }
  if (launch.finalSignoffRequirements) {
    md += `### Final Signoff Requirements\n\n`;
    md += `- Required roles: ${launch.finalSignoffRequirements.requiredRoles.map((role) => `\`${role}\``).join(', ')}\n`;
    md += `- External reviews:\n`;
    for (const review of launch.finalSignoffRequirements.externalReviews) md += `  - ${review}\n`;
    md += `- Release binding: ${launch.finalSignoffRequirements.releaseBinding}\n`;
    md += `- Evidence target: ${launch.finalSignoffRequirements.evidenceTarget}\n`;
    md += `- Legal posture: ${launch.finalSignoffRequirements.legalPosture}\n\n`;
  }
  if (launch.repositoryState) {
    md += `### Repository State For Launch Evidence\n\n`;
    md += `- Do not use this committed audit file as proof that the current checkout is clean, synced, or release-bound.\n`;
    md += `- Run \`npm run launch:status -- --json\` and inspect \`repositoryState\` immediately before collecting external launch evidence.\n`;
    md += `- Required live state: branch \`master\`, clean worktree, synced with \`origin/master\`, and \`launchEvidenceRisk: clean_synced\`.\n`;
    md += `- Record the exact final release commit in the ignored launch evidence ledger after the release workflow and deployed checks complete.\n\n`;
  }
  md += `### Local Production Environment State\n\n`;
  md += `- Phase: \`${launch.phase}\`\n`;
  md += `- ${launch.headline}\n`;
  md += `- ${localLaunchStateNote(launch)}\n\n`;

  if (launch.launchProgress) {
    md += `### Launch Progress Summary\n\n`;
    md += `- Production values complete: ${launch.launchProgress.productionValues.completed} / ${launch.launchProgress.productionValues.total} (${launch.launchProgress.productionValues.remaining} remaining)\n`;
    if (launch.launchProgress.evidenceChecks) {
      md += `- Launch evidence checks complete: ${launch.launchProgress.evidenceChecks.completed} / ${launch.launchProgress.evidenceChecks.total} (${launch.launchProgress.evidenceChecks.remaining} remaining)\n`;
    }
    if (launch.launchProgress.finalSignoffs) {
      md += `- Final signoffs approved: ${launch.launchProgress.finalSignoffs.approved} / ${launch.launchProgress.finalSignoffs.total} (${launch.launchProgress.finalSignoffs.remaining} remaining)\n`;
    }
    if (launch.launchProgress.strictLaunchGates) {
      md += `- Strict launch gates complete: ${launch.launchProgress.strictLaunchGates.completed} / ${launch.launchProgress.strictLaunchGates.total} (${launch.launchProgress.strictLaunchGates.remaining} remaining, ${launch.launchProgress.percentages.strictLaunchGates}% complete)\n`;
    }
    md += `- approvedForLaunch: ${launch.launchProgress.approvedForLaunch ? 'true' : 'false'}\n\n`;
  }

  if (launch.remainingKeys.length > 0) {
    const issueByKey = new Map((launch.remainingKeyDetails ?? []).map((issue) => [issue.key, issue]));
    md += `### Local Production Environment Issues\n\n`;
    md += `The local non-committed production env still has ${launch.remainingKeys.length} unresolved value issue(s):\n\n`;
    md += `${markdownList(launch.remainingKeys.map((key) => {
      const issue = issueByKey.get(key);
      return `\`${key}\`${issue?.reason ? ` (${issue.reason})` : ''}${issue?.detail ? `: ${issue.detail}` : ''}`;
    }))}\n\n`;
    if (launch.remainingKeyGroups.length > 0) {
      md += `Grouped by source:\n\n`;
      for (const group of launch.remainingKeyGroups) {
        md += `- ${group.label}:\n`;
        for (const item of group.items ?? group.keys.map((key) => ({ key, hint: 'Operator-supplied production value' }))) {
          md += `  - \`${item.key}\`: ${item.hint}\n`;
        }
      }
      md += `\n`;
    }
  }

  md += `## Irish Compliance Source Posture\n\n`;
  md += `The matrix must stay source-cited and review-ready. The following official sources were used as the current verification set for this audit; refresh them again before production legal signoff.\n\n`;
  md += `| Source | Owner | URL |\n`;
  md += `| --- | --- | --- |\n`;
  for (const [title, owner, url] of officialSources) {
    md += `| ${title} | ${owner} | ${url} |\n`;
  }

  md += `\n## Next Completion Sequence\n\n`;
  md += `1. Close launch evidence: real secret store, provider accounts, hosting, DNS/TLS, backups, observability, release evidence, and external signoffs.\n`;
  md += `2. ${workflowPolishStep}\n`;
  md += `3. ${stateUiFollowupStep}\n`;
  md += `4. Keep compliance source metadata, professional-review flags, and conditional obligation prioritisation review-ready across deadlines, registers, evidence, exports, and regulator workflows without creating legal-certainty claims.\n`;
  md += `5. Run deployed HTTPS browser QA, accessibility checks in both themes, tenant-isolation regression tests, document privacy checks, billing/email provider checks, and external penetration testing.\n`;

  return md;
}

export function normaliseAuditForCheck(value) {
  return value
    .replace(/- Branch: `[^`]+`/g, '- Branch: `CURRENT`');
}

function main() {
  const args = new Set(process.argv.slice(2));
  const usageText = 'Usage: node scripts/platform-completion-audit.mjs [--json] [--stdout] [--check]';
  for (const arg of args) {
    if (!['--json', '--stdout', '--check'].includes(arg)) {
      console.error(`Unknown option: ${arg}`);
      console.error(usageText);
      process.exit(2);
    }
  }

  if (args.has('--json')) {
    process.stdout.write(`${JSON.stringify(buildAuditPayload(), null, 2)}\n`);
    return;
  }

  const rendered = render();

  if (args.has('--stdout')) {
    process.stdout.write(rendered);
    return;
  }

  if (args.has('--check')) {
    const relativeOutputPath = normalizePath(relative(repoRoot, outputPath));

    if (!existsSync(outputPath)) {
      console.error(`Platform completion audit is missing. Run npm run audit:platform to create ${relativeOutputPath}.`);
      process.exitCode = 1;
      return;
    }

    const current = normaliseAuditForCheck(readFileSync(outputPath, 'utf8'));
    const expected = normaliseAuditForCheck(rendered);
    if (current !== expected) {
      console.log(`Platform completion audit differs from this checkout or local operator state; no files written. Run npm run audit:platform to refresh ${relativeOutputPath} intentionally.`);
      return;
    }

    console.log(`Platform completion audit is current: ${relativeOutputPath}`);
    return;
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, rendered, 'utf8');
  console.log(`Wrote ${normalizePath(relative(repoRoot, outputPath))}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
