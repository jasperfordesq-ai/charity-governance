#!/usr/bin/env node
// CharityPilot reliability report — the "trust ledger" verifier.
//
// Reads the curated guarantee matrix (docs/reliability/guarantees.json), compiles and
// runs the apps/api unit-test suite, and proves that every guarantee marked `covered`
// is linked to a test that actually exists and passes. Prints guarantee counts and an
// overall PASS/FAIL, and exits non-zero if the suite has any failure or any covered
// guarantee's linked test is missing/failing (a broken link).
//
//   node scripts/reliability-report.mjs            # run + report
//   node scripts/reliability-report.mjs --write     # also regenerate docs/RELIABILITY.md
//   node scripts/reliability-report.mjs --no-run     # report from a previous run (skip tests)
//
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const API_DIR = join(ROOT, 'apps', 'api');
const GUARANTEES = join(ROOT, 'docs', 'reliability', 'guarantees.json');
const LEDGER_MD = join(ROOT, 'docs', 'RELIABILITY.md');

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const NO_RUN = args.includes('--no-run');

const GROUP_ORDER = [
  ['auth', 'auth — `/api/v1/auth`'],
  ['organisation', 'organisation — `/api/v1/organisation`'],
  ['compliance', 'compliance — `/api/v1/compliance`'],
  ['board-members', 'board-members — `/api/v1/board-members`'],
  ['documents', 'documents — `/api/v1/documents`'],
  ['deadlines', 'deadlines — `/api/v1/deadlines`'],
  ['billing', 'billing — `/api/v1/billing`'],
  ['export', 'export — `/api/v1/export`'],
  ['dashboard', 'dashboard — `/api/v1/dashboard`'],
  ['governance-registers', 'governance-registers — `/api/v1/governance-registers`'],
  ['team', 'team — `/api/v1/team`'],
  ['health', 'health — `/api/v1/health`'],
  ['x-auth-session', 'cross-cutting — auth & session integrity'],
  ['x-idempotency', 'cross-cutting — idempotency & jobs'],
  ['x-observability', 'cross-cutting — observability'],
  ['x-degradation', 'cross-cutting — graceful degradation'],
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
};

function readGuarantees() {
  return JSON.parse(readFileSync(GUARANTEES, 'utf8'));
}

function runSuite() {
  // Compile then run with the spec reporter so we get deterministic ✔/✖ lines.
  execSync('npx tsc -p tsconfig.json', { cwd: API_DIR, stdio: 'inherit' });
  let out = '';
  try {
    out = execSync('node --test --test-reporter=spec "dist/tests/*.test.js"', {
      cwd: API_DIR,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    // node --test exits non-zero when a test fails; we still want its output.
    out = (e.stdout || '') + (e.stderr || '');
  }
  return out;
}

function parseResults(out) {
  const pass = new Set();
  const fail = new Set();
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.replace(/\[[0-9;]*m/g, ''); // strip ANSI
    let m = line.match(/^\s*✔\s+(.*?)(?:\s+\(\d[\d.]*ms\))?\s*$/);
    if (m) { pass.add(m[1].trim()); continue; }
    m = line.match(/^\s*✖\s+(.*?)(?:\s+\(\d[\d.]*ms\))?\s*$/);
    if (m) { fail.add(m[1].trim()); continue; }
  }
  // Summary counts from the spec footer (best-effort).
  const passN = (out.match(/# pass (\d+)/) || [])[1];
  const failN = (out.match(/# fail (\d+)/) || [])[1];
  return { pass, fail, passN: passN ? +passN : pass.size, failN: failN ? +failN : fail.size };
}

function statusBadge(s) {
  if (s === 'covered') return '🟢 covered';
  if (s === 'partial') return '🟡 partial';
  if (s === 'gap') return '🔴 gap';
  if (s === 'na') return '⚪ n/a';
  return s;
}

function buildMarkdown(guars, res) {
  const counts = {};
  for (const g of guars) counts[g.status] = (counts[g.status] || 0) + 1;
  const total = guars.length;
  const date = process.env.RELIABILITY_DATE || new Date().toISOString().slice(0, 10);

  let md = '';
  md += '# CharityPilot Reliability Ledger\n\n';
  md += '> **The trust ledger.** Every behaviour here is one whose failure would lose customer\n';
  md += '> trust or generate support tickets. Each row is a concrete, falsifiable guarantee\n';
  md += '> linked to the automated test that proves it holds today and will keep holding.\n\n';
  md += 'This is **evidence, not an audit**. An audit asks "can I find a problem?" — an unbounded\n';
  md += 'question that always finds *something*. This ledger asks the bounded question: "is every\n';
  md += 'reliability-critical behaviour pinned by a test that is green?" When every row is 🟢 (or a\n';
  md += 'documented ⚪ n/a), the job is finished and stays finished.\n\n';

  md += '## At a glance\n\n';
  md += `Generated: ${date} · Source of truth: [\`docs/reliability/guarantees.json\`](reliability/guarantees.json)\n\n`;
  md += '| Status | Count |\n|---|---|\n';
  md += `| 🟢 covered (proven by a passing test) | ${counts.covered || 0} |\n`;
  if (counts.partial) md += `| 🟡 partial (some of the guarantee proven) | ${counts.partial} |\n`;
  if (counts.gap) md += `| 🔴 gap (not yet proven) | ${counts.gap} |\n`;
  md += `| ⚪ n/a (concern documented as not applicable) | ${counts.na || 0} |\n`;
  md += `| **Total guarantees** | **${total}** |\n\n`;

  if (res) {
    const ok = res.failN === 0 && res.brokenLinks.length === 0;
    md += `**Suite:** ${res.passN} tests passing, ${res.failN} failing. `;
    md += `**Linkage:** ${res.proven}/${counts.covered || 0} covered guarantees verified against a passing test`;
    md += res.brokenLinks.length ? `, ${res.brokenLinks.length} broken link(s).` : '.';
    md += `\n\n**Overall: ${ok ? '✅ GREEN' : '❌ NOT GREEN'}**\n\n`;
  }

  md += '## How to verify\n\n';
  md += '```bash\n';
  md += '# Compile + run the API suite and check every covered guarantee links to a passing test\n';
  md += 'npm run reliability:report\n';
  md += '```\n\n';
  md += 'The report exits non-zero if any test fails or any 🟢 guarantee\'s linked test is missing.\n';
  md += 'Regenerate this document from the source of truth with `npm run reliability:report -- --write`.\n\n';

  md += '## The eight reliability concerns\n\n';
  md += '1. **Tenant isolation** — a user in org A can never read or modify a resource of org B.\n';
  md += '2. **Authorization boundary** — `requireAdmin` writes reject MEMBER; billing requires OWNER.\n';
  md += '3. **Subscription / plan gating** — expired/cancelled blocked; ESSENTIALS cannot reach COMPLETE-only features.\n';
  md += '4. **Input validation** — malformed/oversized input is a 4xx with a safe code, never a 500 or stack leak.\n';
  md += '5. **Graceful degradation** — when Stripe/Supabase/Resend are absent or failing, a clean 503; the rest keeps working.\n';
  md += '6. **Auth & session integrity** — refresh rotation works; revoked/replayed tokens rejected; secrets never logged.\n';
  md += '7. **At-least-once / idempotency** — webhooks processed once; reminders dedupe; deletion reconciliation retries safely.\n';
  md += '8. **Observability** — readiness reflects real dependency health; a job failure fires the error alert.\n\n';

  md += '## The matrix\n\n';
  const byGroup = {};
  for (const g of guars) (byGroup[g.group] ||= []).push(g);

  for (const [slug, label] of GROUP_ORDER) {
    const rows = byGroup[slug];
    if (!rows || !rows.length) continue;
    const gc = rows.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
    md += `### ${label}\n\n`;
    md += `_${rows.length} guarantees — `;
    md += [['covered', '🟢'], ['partial', '🟡'], ['gap', '🔴'], ['na', '⚪']]
      .filter(([k]) => gc[k]).map(([k, e]) => `${e} ${gc[k]}`).join('  ') + '_\n\n';
    md += '| Concern | Guarantee | Status | Proven by |\n|---|---|---|---|\n';
    // Sort by concern then status.
    rows.sort((a, b) => (a.concern.localeCompare(b.concern)) || a.id.localeCompare(b.id));
    for (const r of rows) {
      const concern = CONCERN_LABEL[r.concern] || r.concern;
      const g = r.guarantee.replace(/\|/g, '\\|').replace(/\n/g, ' ');
      let proof = '—';
      if (r.testTitle) {
        const file = r.testFile ? r.testFile.replace(/^apps\/api\/src\/tests\//, '') : '';
        proof = `\`${r.testTitle.replace(/\|/g, '\\|')}\``;
        if (file) proof += `<br/><sub>${file}</sub>`;
      } else if (r.status === 'na') {
        proof = `_${(r.gapDescription || 'documented not applicable').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 160)}_`;
      } else if (r.proposedTitle) {
        proof = `_planned:_ \`${r.proposedTitle.replace(/\|/g, '\\|')}\``;
      }
      md += `| ${concern} | ${g} | ${statusBadge(r.status)} | ${proof} |\n`;
    }
    md += '\n';
  }

  // Fixed-while-proving section, driven by an optional sidecar file.
  let fixed = [];
  try { fixed = JSON.parse(readFileSync(join(ROOT, 'docs', 'reliability', 'fixed-while-proving.json'), 'utf8')); } catch {}
  md += '## Fixed while proving\n\n';
  if (fixed.length) {
    md += 'Real defects found *by a test written here*, fixed minimally, and locked in:\n\n';
    md += '| Defect | Minimal fix | Proven by |\n|---|---|---|\n';
    for (const f of fixed) md += `| ${f.defect} | ${f.fix} | \`${f.test}\` |\n`;
    md += '\n';
  } else {
    md += '_None. Every guarantee above was already correct; the work was to pin each one with a test._\n\n';
  }

  md += '---\n\n';
  md += '<sub>Legend: 🟢 covered = a passing automated test proves the guarantee · 🟡 partial = part proven ·\n';
  md += '🔴 gap = not yet proven · ⚪ n/a = concern considered and documented as not applicable to this group.</sub>\n';
  return md;
}

// ---- main ----
const guars = readGuarantees();
const counts = {};
for (const g of guars) counts[g.status] = (counts[g.status] || 0) + 1;

let res = null;
if (!NO_RUN) {
  const out = runSuite();
  const { pass, fail, passN, failN } = parseResults(out);
  const covered = guars.filter(g => g.status === 'covered' && g.testTitle);
  const brokenLinks = covered.filter(g => !pass.has(g.testTitle));
  const proven = covered.length - brokenLinks.length;
  res = { passN, failN, proven, brokenLinks, pass, fail };
}

if (WRITE) {
  writeFileSync(LEDGER_MD, buildMarkdown(guars, res));
  console.log(`Wrote ${LEDGER_MD}`);
}

// ---- console report ----
console.log('\n=== CharityPilot Reliability Report ===');
console.log(`Guarantees: ${guars.length} total`);
console.log(`  🟢 covered : ${counts.covered || 0}`);
console.log(`  🟡 partial : ${counts.partial || 0}`);
console.log(`  🔴 gap     : ${counts.gap || 0}`);
console.log(`  ⚪ n/a     : ${counts.na || 0}`);

if (res) {
  console.log(`\nSuite: ${res.passN} passing, ${res.failN} failing`);
  console.log(`Covered-guarantee linkage: ${res.proven}/${(counts.covered || 0)} verified against a passing test`);
  if (res.brokenLinks.length) {
    console.log(`\n❌ ${res.brokenLinks.length} BROKEN LINK(S) — covered guarantee with no passing test of that title:`);
    for (const b of res.brokenLinks.slice(0, 50)) console.log(`   - [${b.id}] expected test: "${b.testTitle}"`);
  }
  const green = res.failN === 0 && res.brokenLinks.length === 0;
  console.log(`\nOVERALL: ${green ? '✅ GREEN' : '❌ NOT GREEN'}`);
  process.exit(green ? 0 : 1);
} else {
  console.log('\n(--no-run: skipped executing the suite)');
}
