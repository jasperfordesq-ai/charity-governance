#!/usr/bin/env node
// CharityPilot reliability report - the unified "trust ledger" verifier (API + Web).
//
// Reads the curated guarantee matrix (docs/reliability/guarantees.json), runs the
// proving suites, and proves that every guarantee marked `covered` is linked to a
// test that actually exists and passes:
//   - surface "api"            -> apps/api  node:test unit suite (dist/tests/*.test.js)
//   - surface "web", unit      -> apps/web  node:test unit suite (.test-dist/**/*.test.js)
//   - surface "web", e2e       -> e2e/tests/*.spec.ts  (Playwright; linked statically by
//                                 title, executed by `npm run test:e2e` / the CI E2E gate)
//
// Prints guarantee counts (split by surface) and an overall PASS/FAIL, and exits
// non-zero if any executed suite has a failure or any covered guarantee's linked test
// is missing/failing (a broken link).
//
//   node scripts/reliability-report.mjs              # run api+web suites + report
//   node scripts/reliability-report.mjs --write      # also regenerate docs/RELIABILITY.md
//   node scripts/reliability-report.mjs --no-run     # report from the matrix only (skip suites)
//   node scripts/reliability-report.mjs --surface=web|api   # run only one surface's suite
//
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const API_DIR = join(ROOT, 'apps', 'api');
const WEB_DIR = join(ROOT, 'apps', 'web');
const E2E_DIR = join(ROOT, 'e2e', 'tests');
const GUARANTEES = join(ROOT, 'docs', 'reliability', 'guarantees.json');
const LEDGER_MD = join(ROOT, 'docs', 'RELIABILITY.md');

const args = process.argv.slice(2);
const USAGE_TEXT = 'Usage: node scripts/reliability-report.mjs [--write] [--no-run] [--surface=web|api]';
const unknownArg = args.find((arg) => arg !== '--write' && arg !== '--no-run' && !/^--surface=(web|api)$/.test(arg));
if (unknownArg) {
  console.error(`Unknown option: ${unknownArg}`);
  console.error(USAGE_TEXT);
  process.exit(2);
}
const WRITE = args.includes('--write');
const NO_RUN = args.includes('--no-run');
const SURFACE_ARG = (args.find((a) => a.startsWith('--surface=')) || '').split('=')[1] || '';

// ---- API surface groups (ordered) ----
const API_GROUP_ORDER = [
  ['auth', 'auth - `/api/v1/auth`'],
  ['organisation', 'organisation - `/api/v1/organisation`'],
  ['compliance', 'compliance - `/api/v1/compliance`'],
  ['board-members', 'board-members - `/api/v1/board-members`'],
  ['documents', 'documents - `/api/v1/documents`'],
  ['deadlines', 'deadlines - `/api/v1/deadlines`'],
  ['billing', 'billing - `/api/v1/billing`'],
  ['export', 'export - `/api/v1/export`'],
  ['dashboard', 'dashboard - `/api/v1/dashboard`'],
  ['governance-registers', 'governance-registers - `/api/v1/governance-registers`'],
  ['team', 'team - `/api/v1/team`'],
  ['health', 'health - `/api/v1/health`'],
  ['x-auth-session', 'cross-cutting - auth & session integrity'],
  ['x-idempotency', 'cross-cutting - idempotency & jobs'],
  ['x-observability', 'cross-cutting - observability'],
  ['x-degradation', 'cross-cutting - graceful degradation'],
];

// ---- Web surface groups (ordered) ----
const WEB_GROUP_ORDER = [
  ['web-platform', 'platform - proxy / CSP / API client / session refresh'],
  ['web-auth', 'auth pages - login / register / forgot / reset / verify / accept-invite'],
  ['web-dashboard', 'dashboard - `/dashboard`'],
  ['web-compliance', 'compliance - `/compliance`, `/compliance/[principleId]`'],
  ['web-board', 'board - `/board`'],
  ['web-documents', 'documents - `/documents`'],
  ['web-deadlines', 'deadlines - `/deadlines`'],
  ['web-registers', 'registers - `/registers`'],
  ['web-organisation', 'organisation - `/organisation`'],
  ['web-team', 'team - `/team`'],
  ['web-billing', 'billing & pricing - `/billing`, `/pricing`'],
  ['web-export', 'export - `/export`'],
  ['web-regulator', 'regulator - `/regulator`'],
];

const CONCERN_LABEL = {
  'tenant-isolation': 'Tenant isolation',
  'authz-boundary': 'Authorization boundary',
  'plan-gating': 'Subscription / plan gating',
  'input-validation': 'Input validation',
  'graceful-degradation': 'Graceful degradation',
  'auth-session': 'Auth & session integrity',
  'idempotency': 'At-least-once / idempotency',
  'observability': 'Observability',
  'state-integrity': 'State integrity / no data loss',
  'accessibility': 'Accessibility & resilience',
};

function readGuarantees() {
  const raw = JSON.parse(readFileSync(GUARANTEES, 'utf8'));
  // Normalise defaults: existing rows are the API surface; tests default to unit.
  return raw.map((g) => ({ surface: 'api', testType: 'unit', ...g }));
}

function compile(dir, project) {
  execSync(`npx tsc -p ${project}`, { cwd: dir, stdio: 'inherit' });
}

function runNodeTest(dir, glob, nodeArgs = []) {
  const globs = Array.isArray(glob) ? glob : [glob];
  const command = [
    'node',
    ...nodeArgs,
    '--test',
    '--test-reporter=spec',
    ...globs,
  ].map((part) => JSON.stringify(part)).join(' ');
  let out = '';
  try {
    out = execSync(command, {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    // node --test exits non-zero when a test fails; we still want its output.
    out = (e.stdout || '') + (e.stderr || '');
  }
  return out;
}

function runApiSuite() {
  // A deleted or renamed source test must not survive as compiled evidence.
  // Clear only the emitted test directory; production source compilation can
  // continue to use the package's normal build output.
  rmSync(join(API_DIR, 'dist', 'tests'), { recursive: true, force: true });
  compile(API_DIR, 'tsconfig.json');
  return runNodeTest(API_DIR, 'dist/tests/*.test.js');
}

function runWebSuite() {
  // tsconfig.test.json emits into this dedicated tree. Start from an empty tree
  // so a removed test title cannot falsely satisfy the reliability ledger.
  rmSync(join(WEB_DIR, '.test-dist'), { recursive: true, force: true });
  compile(WEB_DIR, 'tsconfig.test.json');
  return runNodeTest(
    WEB_DIR,
    '.test-dist/**/*.test.js',
    ['--import', 'tsx', '--require', './test-register.cjs'],
  );
}

function parseResults(out) {
  const pass = new Set();
  const fail = new Set();
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.replace(/\[[0-9;]*m/g, ''); // strip ANSI
    let m = line.match(/^\s*\u2714\s+(.*?)(?:\s+\(\d[\d.]*ms\))?\s*$/u);
    if (m) { pass.add(m[1].trim()); continue; }
    m = line.match(/^\s*\u2716\s+(.*?)(?:\s+\(\d[\d.]*ms\))?\s*$/u);
    if (m) { fail.add(m[1].trim()); continue; }
  }
  const passN = (out.match(/# pass (\d+)/) || [])[1];
  const failN = (out.match(/# fail (\d+)/) || [])[1];
  return { pass, fail, passN: passN ? +passN : pass.size, failN: failN ? +failN : fail.size };
}

// Statically collect Playwright test titles from the e2e spec files. The E2E suite is
// executed by `npm run test:e2e` / the CI E2E gate (the managed runner provisions
// its own isolated disposable Docker stack);
// the ledger links each e2e guarantee to a title that must exist in a spec file.
function readE2eTitles() {
  const titles = new Set();
  let files = [];
  try { files = readdirSync(E2E_DIR).filter((f) => f.endsWith('.spec.ts')); } catch { return titles; }
  for (const f of files) {
    const src = readFileSync(join(E2E_DIR, f), 'utf8');
    const re = /(?:^|\s)test\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
    let m;
    while ((m = re.exec(src))) titles.add(m[2].trim());
  }
  return titles;
}

function statusBadge(s) {
  if (s === 'covered') return 'covered';
  if (s === 'partial') return 'partial';
  if (s === 'gap') return 'gap';
  if (s === 'na') return 'n/a';
  return s;
}

function countByStatus(rows) {
  return rows.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
}

function proofCell(r) {
  if (r.testTitle) {
    let file = '';
    if (r.testFile) file = r.testFile.replace(/^apps\/(api|web)\/src\/tests?\//, '').replace(/^apps\/web\/src\//, '').replace(/^e2e\//, '');
    const kind = r.testType === 'e2e' ? ' <sup>e2e</sup>' : '';
    let proof = `\`${r.testTitle.replace(/\|/g, '\\|')}\`${kind}`;
    if (file) proof += `<br/><sub>${file}</sub>`;
    return proof;
  }
  if (r.status === 'na') {
    return `_${(r.gapDescription || 'documented not applicable').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 200)}_`;
  }
  if (r.proposedTitle) return `_planned:_ \`${r.proposedTitle.replace(/\|/g, '\\|')}\``;
  return '-';
}

function renderMatrix(md, rows, groupOrder) {
  const byGroup = {};
  for (const g of rows) (byGroup[g.group] ||= []).push(g);
  let out = md;
  for (const [slug, label] of groupOrder) {
    const grp = byGroup[slug];
    if (!grp || !grp.length) continue;
    const gc = countByStatus(grp);
    out += `### ${label}\n\n`;
    out += `_${grp.length} guarantees - `;
    out += [['covered', 'covered'], ['partial', 'partial'], ['gap', 'gap'], ['na', 'n/a']]
      .filter(([k]) => gc[k]).map(([k, e]) => `${e} ${gc[k]}`).join('  ') + '_\n\n';
    out += '| Concern | Guarantee | Status | Proven by |\n|---|---|---|---|\n';
    grp.sort((a, b) => (a.concern.localeCompare(b.concern)) || a.id.localeCompare(b.id));
    for (const r of grp) {
      const concern = CONCERN_LABEL[r.concern] || r.concern;
      const g = r.guarantee.replace(/\|/g, '\\|').replace(/\n/g, ' ');
      out += `| ${concern} | ${g} | ${statusBadge(r.status)} | ${proofCell(r)} |\n`;
    }
    out += '\n';
  }
  // Any groups not in the declared order - surface them so nothing is silently dropped.
  const known = new Set(groupOrder.map(([s]) => s));
  for (const slug of Object.keys(byGroup)) {
    if (known.has(slug)) continue;
    const grp = byGroup[slug];
    out += `### ${slug}\n\n`;
    out += '| Concern | Guarantee | Status | Proven by |\n|---|---|---|---|\n';
    for (const r of grp) {
      const concern = CONCERN_LABEL[r.concern] || r.concern;
      const g = r.guarantee.replace(/\|/g, '\\|').replace(/\n/g, ' ');
      out += `| ${concern} | ${g} | ${statusBadge(r.status)} | ${proofCell(r)} |\n`;
    }
    out += '\n';
  }
  return out;
}

function buildMarkdown(guars, res) {
  const apiRows = guars.filter((g) => g.surface === 'api');
  const webRows = guars.filter((g) => g.surface === 'web');
  const counts = countByStatus(guars);
  const apiCounts = countByStatus(apiRows);
  const webCounts = countByStatus(webRows);
  const total = guars.length;
  const date = process.env.RELIABILITY_DATE || new Date().toISOString().slice(0, 10);

  let md = '';
  md += '# CharityPilot Reliability Ledger\n\n';
  md += '> **The trust ledger - API + Web.** Every behaviour here is one whose failure would\n';
  md += '> lose customer trust or generate support tickets. Each row is a concrete, falsifiable\n';
  md += '> guarantee linked to the automated test that proves it holds today and will keep holding.\n\n';
  md += 'This is **evidence, not an audit**. An audit asks "can I find a problem?" - an unbounded\n';
  md += 'question that always finds *something*. This ledger asks the bounded question: "is every\n';
  md += 'reliability-critical behaviour pinned by a test that is green?" When every row is covered (or a\n';
  md += 'documented n/a), the job is finished and stays finished.\n\n';

  md += '## At a glance\n\n';
  md += `Generated: ${date} - Source of truth: [\`docs/reliability/guarantees.json\`](reliability/guarantees.json)\n\n`;
  md += '| Surface | covered | partial | gap | n/a | Total |\n|---|---|---|---|---|---|\n';
  const row = (label, c, rows) => `| ${label} | ${c.covered || 0} | ${c.partial || 0} | ${c.gap || 0} | ${c.na || 0} | ${rows.length} |\n`;
  md += row('API', apiCounts, apiRows);
  md += row('Web', webCounts, webRows);
  md += `| **Total** | **${counts.covered || 0}** | **${counts.partial || 0}** | **${counts.gap || 0}** | **${counts.na || 0}** | **${total}** |\n\n`;

  if (res) {
    const ok = res.failN === 0 && res.brokenLinks.length === 0;
    md += `**API suite:** ${res.api ? `${res.api.passN} passing, ${res.api.failN} failing` : 'not run'}. `;
    md += `**Web suite:** ${res.web ? `${res.web.passN} passing, ${res.web.failN} failing` : 'not run'}. `;
    md += `**E2E:** ${res.e2eCount} Playwright titles linked (executed by the CI E2E gate).\n\n`;
    md += `**Linkage:** ${res.proven}/${counts.covered || 0} covered guarantees verified against a passing/linked test`;
    md += res.brokenLinks.length ? `, ${res.brokenLinks.length} broken link(s).` : '.';
    md += `\n\n**Overall: ${ok ? 'GREEN' : 'NOT GREEN'}**\n\n`;
  }

  md += '## How to verify\n\n';
  md += '```bash\n';
  md += '# Compile + run the API and Web unit suites and check every covered guarantee\n';
  md += '# links to a passing test (E2E rows are linked by title and run by the E2E gate).\n';
  md += 'npm run reliability:report\n';
  md += '\n# Prove the WHOLE platform green in one command (every gate + this report):\n';
  md += 'npm run release:ready\n';
  md += '```\n\n';
  md += 'The report exits non-zero if any executed suite fails or any covered guarantee\'s linked test\n';
  md += 'is missing. Regenerate this document with `npm run reliability:report -- --write`.\n\n';

  md += '## The reliability concerns\n\n';
  md += '**API surface (8):** tenant isolation / authorization boundary / subscription/plan gating /\n';
  md += 'input validation / graceful degradation / auth & session integrity / at-least-once/idempotency /\n';
  md += 'observability.\n\n';
  md += '**Web surface (8):** tenant isolation (UI) / authorization (UI) / plan gating (UI) /\n';
  md += 'input-validation parity / graceful degradation / auth & session integrity / state integrity /\n';
  md += 'no data loss / accessibility & resilience.\n\n';

  md += '---\n\n';
  md += `## API surface - the matrix (${apiRows.length} guarantees)\n\n`;
  md = renderMatrix(md, apiRows, API_GROUP_ORDER);

  md += '---\n\n';
  md += `## Web surface - the matrix (${webRows.length} guarantees)\n\n`;
  md += '> The customer-facing mirror of the API ledger. Fast `node:test` unit tests prove the\n';
  md += '> extractable logic (auth/session, validation parity, plan/role decisions, redirect & download\n';
  md += '> allow-listing, error redaction); Playwright E2E (<sup>e2e</sup>) proves rendered behaviour and\n';
  md += '> accessibility against the managed runner-owned disposable Docker stack.\n\n';
  md = renderMatrix(md, webRows, WEB_GROUP_ORDER);

  // Fixed-while-proving section, driven by an optional sidecar file.
  let fixed = [];
  try { fixed = JSON.parse(readFileSync(join(ROOT, 'docs', 'reliability', 'fixed-while-proving.json'), 'utf8')); } catch {}
  md += '---\n\n## Fixed while proving\n\n';
  if (fixed.length) {
    md += 'Real defects found *by a test written here*, fixed minimally, and locked in:\n\n';
    md += '| Surface | Defect | Minimal fix | Proven by |\n|---|---|---|---|\n';
    for (const f of fixed) md += `| ${f.surface || '-'} | ${f.defect} | ${f.fix} | \`${f.test}\` |\n`;
    md += '\n';
  } else {
    md += '_None. Every guarantee above was already correct; the work was to pin each one with a test._\n\n';
  }

  md += '---\n\n';
  md += '<sub>Legend: covered = a passing automated test proves the guarantee / partial = part proven /\n';
  md += 'gap = not yet proven / n/a = concern considered and documented as not applicable to this group.\n';
  md += '<sup>e2e</sup> = proven by a Playwright journey, executed by the CI E2E gate.</sub>\n';
  return md;
}

// ---- main ----
const guars = readGuarantees();
const counts = countByStatus(guars);

const apiCovered = guars.filter((g) => g.surface === 'api' && g.status === 'covered' && g.testTitle);
const webUnitCovered = guars.filter((g) => g.surface === 'web' && g.testType === 'unit' && g.status === 'covered' && g.testTitle);
const e2eCovered = guars.filter((g) => g.testType === 'e2e' && g.status === 'covered' && g.testTitle);

let res = null;
if (!NO_RUN) {
  const wantApi = (!SURFACE_ARG || SURFACE_ARG === 'api') && apiCovered.length > 0;
  const wantWeb = (!SURFACE_ARG || SURFACE_ARG === 'web') && webUnitCovered.length > 0;

  const api = wantApi ? parseResults(runApiSuite()) : null;
  const web = wantWeb ? parseResults(runWebSuite()) : null;
  const e2eTitles = readE2eTitles();

  const brokenLinks = [];
  if (api) for (const g of apiCovered) if (!api.pass.has(g.testTitle)) brokenLinks.push(g);
  if (web) for (const g of webUnitCovered) if (!web.pass.has(g.testTitle)) brokenLinks.push(g);
  for (const g of e2eCovered) if (!e2eTitles.has(g.testTitle)) brokenLinks.push(g);

  const coveredChecked = (api ? apiCovered.length : 0) + (web ? webUnitCovered.length : 0) + e2eCovered.length;
  const proven = coveredChecked - brokenLinks.length;
  const failN = (api?.failN || 0) + (web?.failN || 0);
  res = { api, web, e2eCount: e2eTitles.size, proven, brokenLinks, failN };
}

if (WRITE) {
  writeFileSync(LEDGER_MD, buildMarkdown(guars, res));
  console.log(`Wrote ${LEDGER_MD}`);
}

// ---- console report ----
const apiRows = guars.filter((g) => g.surface === 'api');
const webRows = guars.filter((g) => g.surface === 'web');
console.log('\n=== CharityPilot Reliability Report (API + Web) ===');
console.log(`Guarantees: ${guars.length} total  (api ${apiRows.length}, web ${webRows.length})`);
console.log(`  covered : ${counts.covered || 0}`);
console.log(`  partial : ${counts.partial || 0}`);
console.log(`  gap     : ${counts.gap || 0}`);
console.log(`  n/a     : ${counts.na || 0}`);

if (res) {
  if (res.api) console.log(`\nAPI suite: ${res.api.passN} passing, ${res.api.failN} failing`);
  if (res.web) console.log(`Web suite: ${res.web.passN} passing, ${res.web.failN} failing`);
  console.log(`E2E: ${res.e2eCount} Playwright titles linked (run by the E2E gate)`);
  const coveredChecked = (res.api ? apiCovered.length : 0) + (res.web ? webUnitCovered.length : 0) + e2eCovered.length;
  console.log(`Covered-guarantee linkage: ${res.proven}/${coveredChecked} verified against a passing/linked test`);
  if (res.brokenLinks.length) {
    console.log(`\nFAIL ${res.brokenLinks.length} BROKEN LINK(S) - covered guarantee with no passing/linked test of that title:`);
    for (const b of res.brokenLinks.slice(0, 60)) console.log(`   - [${b.surface}/${b.testType}] [${b.id}] expected: "${b.testTitle}"`);
  }
  const green = res.failN === 0 && res.brokenLinks.length === 0;
  console.log(`\nOVERALL: ${green ? 'GREEN' : 'NOT GREEN'}`);
  process.exit(green ? 0 : 1);
} else {
  console.log('\n(--no-run: skipped executing the suites)');
}
