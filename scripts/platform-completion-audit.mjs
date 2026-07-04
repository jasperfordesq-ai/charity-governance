#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessLaunchState } from './launch-status.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const outputPath = join(repoRoot, 'docs', 'platform-completion-audit.md');

const auditDate = '2026-07-04';

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
  'Sensitive auth and invite throttles now use body-aware identifier keys for email or token attempts while preserving request-level protection where needed.',
  'Optional in-process cron logging now serializes errors through the redacted logger helper.',
  'Compliance/export/dashboard aggregate progress labels now say recorded progress rather than implying legal compliance certification.',
  'API-rendered exports now include a source/professional-review appendix and a not-legal-advice/non-certificate disclaimer.',
  'Compliance detail autosave now flushes pending edits on blur/unmount, warns on browser unload, confirms in-app navigation while saves are pending, and exposes a retry action for failed saves.',
  'Production deploy defaults now include the TLS compose overlay, with an explicit --no-tls-proxy escape hatch for managed platform TLS.',
  'Production hostname defaults now consistently use app.charitypilot.ie for the web app and api.charitypilot.ie for the API.',
  'The Irish compliance matrix now includes explicit not-yet-commenced Charities (Amendment) Act 2024 monitoring rows with solicitor review flags.',
  'Organisation setup now captures conditional obligation profile facts for staff, volunteers, fundraising, safeguarding, GDPR, premises/events, public-sector context, and processors.',
  'Approval readiness and exports now flag missing standard records, missing action/evidence fields, missing explanations, missing conditional-profile facts, and profile-triggered professional-review prompts.',
  'Dashboard navigation now gives the mobile sidebar explicit ARIA controls, Escape-to-close focus recovery, non-tabbable closed mobile links, and source-backed principle breadcrumb labels.',
  'Documents now surface profile-triggered evidence prompts from the conditional obligation profile, including linked standard counts, source references, and professional-review flags.',
  'The document upload modal and oversize-file guard UI are split out of the oversized documents route behind a wiring regression test.',
  'The document standard-link modal is split out of the oversized documents route behind a wiring regression test.',
  'The document delete confirmation modal is split out of the oversized documents route behind a wiring regression test.',
  'The uploaded-document list panel is split out of the oversized documents route behind a wiring regression test.',
  'Deadlines now surface profile-triggered review-date prompts from the conditional obligation profile, including source references, professional-review flags, and one-click review deadline prefills.',
  'The regulator guide now prioritises conditional obligation profile triggers with source references, workflow areas, and professional-review flags without legal-certainty claims.',
  'Governance registers now prioritise conditional obligation profile triggers with register-evidence signals, source references, and professional-review flags.',
  'The register profile-priority model and panel are split out of the oversized registers route behind a wiring regression test.',
  'The register Annual Report readiness and financial control review cards are split out of the oversized registers route behind a wiring regression test.',
  'The register overview summary panel and metric tiles are split out of the oversized registers route behind a wiring regression test.',
  'The register modal record forms and payload normaliser are split out of the oversized registers route behind a wiring regression test.',
  'The register record modal shell is split out of the oversized registers route behind a wiring regression test.',
  'The register operational record list sections are split out of the oversized registers route behind a wiring regression test.',
  'The compliance principle standard editor card and save-state UI are split out of the oversized compliance detail route behind a wiring regression test.',
  'The document profile-triggered evidence prompt model and panel are split out of the oversized documents route behind a wiring regression test.',
  'The deadline profile-triggered review-date prompt model and panel are split out of the oversized deadlines route behind a wiring regression test.',
  'The deadline add/edit form modal is split out of the oversized deadlines route behind a wiring regression test.',
  'The deadline list panel, status classifier, and summary helper are split out of the oversized deadlines route behind a wiring regression test.',
  'The board trustee evidence prompt cards and evidence chips are split out of the oversized board route behind a wiring regression test.',
  'The board member add/edit modal is split out of the oversized board route behind a wiring regression test.',
  'The export report preview cards and score helpers are split out of the oversized export route behind a wiring regression test.',
  'The organisation conditional-obligation profile fields are split out of the oversized organisation route behind a wiring regression test.',
  'The dashboard deadline and board-alert action lists are split out of the oversized dashboard route behind a wiring regression test.',
  'The board review-ready summary panel is split out of the oversized board route behind a wiring regression test.',
];

const independentAuditFindings = [
  ['P0', 'Production launch', 'Launch evidence remains a template and .env.production still has placeholders; real provider, hosting, backup, observability, legal, browser QA, and pentest evidence are external blockers.'],
  ['P1', 'Frontend polish', 'Largest all-client routes remain registers, documents, deadlines, compliance detail, board, and organisation; split route-local forms/cards/hooks before broader visual polish.'],
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

function countMatches(content, pattern) {
  return [...content.matchAll(pattern)].length;
}

function routeRisks(content, lines, route, area) {
  const risks = [];
  const svgCount = countMatches(content, /<svg\b/g);
  if (lines >= 700) risks.push('oversized route file; split first');
  else if (lines >= 450) risks.push('large route file; refactor soon');
  if (svgCount > 0) risks.push(`${svgCount} inline svg icon(s)`);
  if (/gradient|blur-|rounded-full/.test(content)) risks.push('decorative or pill-heavy styling needs visual QA');
  if (!/dark:|\bcp-surface\b|\bcp-text\b/.test(content)) risks.push('dark-mode relies mostly on layout; screenshot QA required');
  if (/use client/.test(content) && !/ErrorState|error|catch|toast|setError/i.test(content)) risks.push('client flow has weak visible error-state signal');
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
        risks: routeRisks(content, lines, route, area),
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

  let md = `# CharityPilot Platform Completion Audit\n\n`;
  md += `Generated: ${auditDate}\n\n`;
  md += `Branch: \`${branch}\`\n\n`;
  md += `Working-tree base commit when generated: \`${commit}\`\n\n`;
  md += `Generation note: inspect \`git status\` before release because this report is committed as part of the audit work.\n\n`;
  md += `This ledger is a current-state engineering audit. It is not legal advice and does not claim CharityPilot is legally complete, guaranteed, or ready to process real charity data.\n\n`;

  md += `## Executive Readiness\n\n`;
  md += `| Area | Current state | Next action |\n`;
  md += `| --- | --- | --- |\n`;
  md += `| Product UI | ${routes.length} page routes scanned; ${p0Routes.length} are P0 trustee/compliance workflows; ${oversizedRoutes.length} route files are 450+ lines. | Refactor and browser-QA the largest P0 workflows first: ${oversizedRoutes.slice(0, 6).map((r) => `${r.route} (${r.lines})`).join(', ') || 'none'}. |\n`;
  md += `| API/backend | ${apis.length} route groups scanned with route-local guard heuristics and ${tests.apiTests} API test files. | Preserve auth, tenant isolation, role guards, plan gates, validation, and redaction while fixing only audit-backed defects. |\n`;
  md += `| Launch operations | ${launch.headline.replace(/\|/g, '\\|')} | Complete external provider, hosting, backup, observability, legal, browser QA, and security evidence before real charity data. |\n`;
  md += `| Irish compliance model | ${compliance.entries} matrix entries; last checked ${compliance.lastChecked}; statuses ${Object.entries(compliance.statuses).map(([k, v]) => `${k}:${v}`).join(', ')}. | Refresh official sources before legal copy changes and record professional-review signoff outside git. |\n`;
  md += `| Verification surface | ${tests.webTests} web unit test files, ${tests.apiTests} API test files, ${tests.e2eTests} Playwright specs. | Run full release, production-check, accessibility, and deployed-browser gates before launch signoff. |\n\n`;

  md += `## Fixed During This Audit Pass\n\n`;
  md += `${markdownList(fixedInThisAuditBranch)}\n\n`;

  md += `## Independent Audit Findings Still Driving Next Work\n\n`;
  md += `| Priority | Area | Finding |\n`;
  md += `| --- | --- | --- |\n`;
  for (const [priority, area, finding] of independentAuditFindings) {
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
  md += `2. Decompose and polish the largest P0 workflows: registers, documents, board, dashboard, export, organisation, deadlines, and compliance detail.\n`;
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
