#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessLaunchState } from './launch-status.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const outputPath = join(repoRoot, 'docs', 'platform-completion-audit.md');

const auditDate = new Date().toISOString().slice(0, 10);

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
  'Stripe customer creation now uses an organisation-scoped idempotency key to reduce orphan/duplicate external customers after retries.',
  'Stripe checkout now reconciles an existing Stripe customer by organisation metadata before creating a new customer.',
  'Stored Stripe customer IDs are now verified against Stripe customer metadata before checkout or portal reuse, and stale or wrong-organisation IDs are repaired through metadata reconciliation.',
  'Sensitive auth and invite throttles now use body-aware identifier keys for email or token attempts while preserving request-level protection where needed.',
  'Refresh and logout throttles now key by hashed refresh-token identifiers from the request body or refresh cookie, so one token cannot exhaust the same-IP bucket for another token.',
  'Sensitive public auth and invite throttles now have regression coverage proving one email/token identifier does not block a different identifier from the same caller.',
  'Registration throttling now has regression coverage proving normalized email identifiers share a throttle bucket without blocking a different email from the same caller.',
  'Resend-verification throttling now keys by hashed bearer/access-cookie credentials at the request hook, so one invalid credential cannot burn the same-IP bucket for another credential.',
  'Optional in-process cron logging now serializes errors through the redacted logger helper.',
  'Compliance/export/dashboard aggregate progress labels now say recorded progress rather than implying legal compliance certification.',
  'API-rendered exports now include a source/professional-review appendix and a not-legal-advice/non-certificate disclaimer.',
  'The export workflow now surfaces source counts, professional-review flags, and not-yet-commenced monitoring metadata before report generation or board sign-off.',
  'Compliance detail autosave now flushes pending edits on blur/unmount, warns on browser unload, confirms in-app navigation while saves are pending, and exposes a retry action for failed saves.',
  'Production deploy defaults now include the TLS compose overlay, with an explicit --no-tls-proxy escape hatch for managed platform TLS.',
  'Production hostname defaults and launch/runtime validators now consistently require app.charitypilot.ie for the web app and api.charitypilot.ie for the API.',
  'The Irish compliance matrix now includes explicit not-yet-commenced Charities (Amendment) Act 2024 monitoring rows with solicitor review flags.',
  'Organisation setup now captures conditional obligation profile facts for staff, volunteers, fundraising, safeguarding, GDPR, premises/events, public-sector context, and processors.',
  'Approval readiness and exports now flag missing standard records, missing action/evidence fields, missing explanations, missing conditional-profile facts, and profile-triggered professional-review prompts.',
  'Governance architecture and backend audit docs now describe the broadened approval-readiness model behind a production tooling regression test.',
  'Dashboard navigation now gives the mobile sidebar explicit ARIA controls, Escape-to-close focus recovery, non-tabbable closed mobile links, and source-backed principle breadcrumb labels.',
  'Dashboard, compliance, compliance detail, and export route chrome now use lucide-react status, chevron, and download icons instead of route-local inline SVG markup behind a wiring regression test.',
  'Auth routes now use lucide-react password visibility, validation, mail, and alert icons instead of route-local inline SVG markup behind a wiring regression test.',
  'Marketing routes now use lucide-react feature, pricing, FAQ, and share/navigation icons instead of route-local inline SVG markup behind a wiring regression test.',
  'Documents now surface profile-triggered evidence prompts from the conditional obligation profile, including linked standard counts, source references, and professional-review flags.',
  'The document summary panel is split out of the oversized documents route behind a wiring regression test while preserving successful-load gating.',
  'The document upload modal and oversize-file guard UI are split out of the oversized documents route behind a wiring regression test.',
  'The document standard-link modal is split out of the oversized documents route behind a wiring regression test.',
  'The document delete confirmation modal is split out of the oversized documents route behind a wiring regression test.',
  'The uploaded-document list panel is split out of the oversized documents route behind a wiring regression test.',
  'The document evidence-pack checklist and operational signal panels are split out of the documents route behind a wiring regression test.',
  'The document workflow loading, organisation-profile prompts, upload/link/delete/download mutations, and trusted download handling are split into a route-local hook behind a wiring regression test.',
  'Shared loading, empty, error, locked-feature, review-warning, and inline-status primitives now contain long text and actions within narrow/mobile layouts.',
  'Deadlines now surface profile-triggered review-date prompts from the conditional obligation profile, including source references, professional-review flags, and one-click review deadline prefills.',
  'The deadlines regulatory cadence panel now cites the Charities Regulator Annual Report source and last-checked metadata for the 10-month filing prompt.',
  'Deadline and regulator official-source links now share reusable source-reference primitives behind a wiring regression test.',
  'Regulator profile-triggered priority source links now use the shared source-reference primitive instead of route-local anchor styling.',
  'Profile-triggered document, deadline, register, regulator, and export prompts now render official sources as shared clickable source-reference lists.',
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
  'The export workflow loading, approval-readiness refresh, board sign-off mutation, report-opening state, and blocker derivation are split into a route-local hook behind a wiring regression test.',
  'The compliance principle evidence-readiness panel is split out of the oversized compliance detail route behind a wiring regression test.',
  'Compliance principle in-app navigation now uses a HeroUI save/leave confirmation modal instead of a bare browser confirm prompt.',
  'The primary add actions on documents, board, and deadlines now use lucide-react Plus icons instead of route-local inline SVG markup behind a wiring regression test.',
  'The organisation conditional-obligation profile fields are split out of the oversized organisation route behind a wiring regression test.',
  'The organisation profile form section is split out of the oversized organisation route behind a wiring regression test.',
  'The organisation complexity guidance modal is split out of the oversized organisation route behind a wiring regression test.',
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
  'Deployed browser QA mode now uses existing non-sensitive test credentials and skips direct database reset or token-injection seams.',
  'Regulator official-source links now use compact link styling instead of pill-badge styling behind a wiring regression test.',
  'The regulator profile-triggered priorities section is split out of the oversized regulator route behind a wiring regression test.',
  'The regulator readiness overview and operating-model cards are split out of the oversized regulator route behind a wiring regression test.',
  'The regulator source-cited readiness matrix is split out of the oversized regulator route behind a wiring regression test.',
  'The platform audit now distinguishes decorative pill styling from functional switches and status dots so visual QA findings stay actionable.',
  'The platform audit now scans route-local extracted UI components when assessing static route-level visual and dark-mode signals.',
  'Launch status now separates missing production env values from external launch evidence gates, including deployed QA, provider/backups/observability evidence, legal review, pentest, and final signoffs.',
  'Launch status and production readiness TODO now name all 81 machine-readable launch evidence checks and the browserQa.checks.accessibility-coverage evidence slot.',
  'Production launch evidence now requires legal/compliance final approval alongside engineering, operations, security, and business signoffs.',
  'Production launch evidence now requires named solicitor/governance/privacy review evidence inside the legal/compliance checklist area.',
  'Billing/email launch evidence now requires Stripe webhook subscription-event proof, webhook-secret secret-store proof, Resend accepted-send proof, and production email-link origin proof.',
  'Browser QA launch evidence now requires a dedicated deployed accessibility command transcript for light and dark theme checks.',
  'The team member list, role edit controls, loading/error/empty states, and shared role display metadata are split out of the team route behind a wiring regression test.',
  'The team invite form and pending-invite list are split out of the team route behind a wiring regression test while preserving invite role gates and revoke states.',
  'The team role guidance panel is split out of the team route behind a wiring regression test and now uses shared status panel styling.',
  'Team feedback now uses the shared inline status primitive instead of route-local alert styling.',
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
  'Shared utility icon controls for theme switching, copying links, and back-to-top now use HeroUI Button semantics.',
  'Compliance principle back navigation and autosave retry controls now use HeroUI Button primitives.',
  'Public marketing navigation, blog filters, and cookie-consent actions now use HeroUI Button primitives with dark-mode mobile navigation styling.',
  'Global recovery, not-found, dashboard mobile-menu, and compliance disclosure actions now use HeroUI Button primitives instead of bespoke route-local action markup.',
  'Responsive browser-smoke QA now waits for the parsed document shell before applying light/dark theme checks after commit-stage navigations.',
  'Document uploads now use a shared HeroUI-backed file upload field instead of route-local file input styling.',
  'Marketing blog search and trial CTA now use HeroUI Input and Button primitives instead of route-local form/link styling.',
  'Billing plan-gate explanation tiles now use a shared status tile primitive instead of route-local tile markup.',
  'Dashboard primary actions now share dark-mode-aware action button styling instead of repeating route-local teal button classes.',
  'Public marketing and auth primary CTAs now share the same dark-mode-aware action styling as dashboard workflows.',
  'Remaining public action controls now share the dark-mode-aware action button helper while banner and selected-filter styling stay scoped.',
  'The plain-English launch guide now matches the evidence validator by requiring five final approval roles, including legal/compliance.',
  'The release readiness command now emits ASCII-safe operator output for cleaner Windows terminals and launch evidence transcripts.',
  'The release readiness command now distinguishes skipped gates from a full release-ready result in its final summary.',
  'The production readiness TODO now reflects the current 23-value launch blocker state without overclaiming unrun local smoke or external evidence.',
  'The plain-English launch guide now uses ASCII-safe operator text for cleaner Windows terminals, CI logs, and launch evidence transcripts.',
  'The reliability report and generated reliability ledger now use ASCII-safe status text for cleaner release and launch evidence transcripts.',
  'The production environment generator now uses ASCII-safe operator hints for cleaner setup transcripts.',
  'The launch status script now keeps its operator-facing source text ASCII-safe for cleaner status transcripts.',
  'The release readiness command now reports full local success as repository release gates passed instead of implying production launch readiness.',
  'Accessibility browser QA now uses commit-stage navigation, parsed-document waits, direct light/dark theme application, and longer owner setup headroom to survive local Next.js cold compiles.',
  'Responsive browser-smoke global setup now warms every public and auth route in the smoke suite before timed browser assertions.',
  'Responsive browser-smoke navigation now retries local Next.js dev-server restart responses after waiting for the web origin, without masking deployed QA failures.',
  'Responsive browser-smoke dashboard coverage now runs one route per test and seeds the shared local owner directly, while auth journey specs still exercise registration UI.',
  'Local Docker web QA now gives Next dev a configurable heap ceiling and ignores Playwright report/test-result artifacts so route smoke output does not trigger repeated recompiles.',
  'Local Playwright screenshots, traces, videos, and HTML reports now default outside the repository, while CI writes them to an explicit uploaded artifact directory.',
  'Local Playwright QA now creates external artifact directories before reporters run, keeping early setup failures readable.',
  'Browser auth helpers now pre-seed the cookie-consent preference before registration, login, and invite acceptance so setup submissions are not competing with the consent dialog.',
  'Compliance record autosave now recovers from concurrent create races on the organisation/standard/year key with a scoped update instead of leaking a 500.',
  'Auth journey browser helpers now retry only local dev-server blank form loads after a Next.js restart while keeping deployed QA failures strict.',
  'Irish compliance matrix source metadata was refreshed against official Charities Regulator, Irish Statute Book, and Revised Acts sources on 2026-07-05.',
];

const independentAuditFindings = [
  ['P0', 'Production launch', 'Launch evidence remains a template and .env.production still has placeholders; real provider, hosting, backup, observability, legal, browser QA, and pentest evidence are external blockers.'],
];

const localVerificationEvidence = [
  '`npm run release:ready -- --no-e2e` passed locally with 6/6 selected release gates and only the full Playwright suite skipped.',
  '`node --test scripts\\check-production-providers.test.mjs scripts\\production-launch-evidence.test.mjs` passed locally for provider and launch-evidence hardening.',
  '`npm test` passed locally across workspace tests, production-check scripts, and local Docker guard checks.',
  '`npm run test:e2e -- tests/accessibility.spec.ts` passed locally with 16/16 axe checks, including dashboard light/dark coverage.',
  '`npm run test:e2e:responsive` passed locally with 50/50 Playwright route smoke checks across desktop/mobile and light/dark themes.',
  'This is local Docker evidence only; deployed HTTPS QA with `E2E_DEPLOYED_QA=true` remains a launch gate.',
];

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
  const state = assessLaunchState({
    envExists: existsSync(envPath),
    envContent: existsSync(envPath) ? readFileSync(envPath, 'utf8') : '',
  });
  return {
    phase: state.phase,
    headline: state.headline,
    remainingKeys: state.remainingKeys ?? [],
  };
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

function render() {
  const routes = readRouteInventory();
  const apis = readApiInventory();
  const compliance = readComplianceSummary();
  const launch = readLaunchSummary();
  const tests = readTestSurfaceSummary();
  const branch = shell('git branch --show-current') || 'unknown';
  const commit = shell('git rev-parse --short HEAD') || 'unknown';

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

  let md = `# CharityPilot Platform Completion Audit\n\n`;
  md += `Generated: ${auditDate}\n\n`;
  md += `Branch: \`${branch}\`\n\n`;
  md += `Working-tree base commit when generated: \`${commit}\`\n\n`;
  md += `Generation note: inspect \`git status\` before release because this report is committed as part of the audit work.\n\n`;
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
  md += `${markdownList(localVerificationEvidence)}\n\n`;

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
  if (launch.remainingKeys.length > 0) {
    md += `### Local Production Environment Placeholders\n\n`;
    md += `The local non-committed production env still needs ${launch.remainingKeys.length} real value(s):\n\n`;
    md += `${markdownList(launch.remainingKeys.map((key) => `\`${key}\``))}\n\n`;
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
  md += `3. Convert remaining route-local state UI into shared primitives for loading, empty, error, locked-feature, review-warning, status, source, evidence, and sticky form actions.\n`;
  md += `4. Keep compliance source metadata, professional-review flags, and conditional obligation prioritisation review-ready across deadlines, registers, evidence, exports, and regulator workflows without creating legal-certainty claims.\n`;
  md += `5. Run deployed HTTPS browser QA, accessibility checks in both themes, tenant-isolation regression tests, document privacy checks, billing/email provider checks, and external penetration testing.\n`;

  return md;
}

function main() {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, render(), 'utf8');
  console.log(`Wrote ${normalizePath(relative(repoRoot, outputPath))}`);
}

main();
