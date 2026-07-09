#!/usr/bin/env node
// CharityPilot release-readiness gate - one command that proves the repository gate state.
//
// Runs every quality gate in order, captures PASS/FAIL per gate, and prints a single
// summary with counts. Exits non-zero if any gate fails, so CI and humans can trust a
// single green/red signal.
//
//   npm run release:ready              # every gate incl. Playwright E2E (needs the stack up)
//   npm run release:ready -- --no-e2e  # skip the E2E gate (e.g. stack not running)
//   npm run release:ready -- --no-build
//
// E2E needs the local Docker stack:
//   docker compose -f compose.yml -f compose.local.yml up
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const noE2e = args.includes('--no-e2e');
const noBuild = args.includes('--no-build');

const WEB_URL = process.env.E2E_WEB_URL ?? 'http://localhost:3003';
const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3002';
const STACK_REACHABILITY_TIMEOUT_MS = 5000;

function run(name, cmd, cmdArgs, opts = {}) {
  const started = Date.now();
  process.stdout.write(`\n-- ${name} --\n`);
  const res = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', shell: true, ...opts });
  const ms = Date.now() - started;
  const ok = res.status === 0;
  return { name, ok, ms, skipped: false };
}

async function reachable(url) {
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(STACK_REACHABILITY_TIMEOUT_MS),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

const results = [];

// 1. Secrets + SAST scan
results.push(run('Security scan (secrets + SAST)', 'npm', ['run', 'security:scan']));
// 2. Lint (all workspaces)
results.push(run('Lint', 'npm', ['run', 'lint']));
// 3. Build (shared + api + web)
if (noBuild) {
  results.push({ name: 'Build', ok: true, ms: 0, skipped: true });
} else {
  results.push(run('Build', 'npm', ['run', 'build']));
}
// 4. Unit + integration suites (turbo: api + web + shared)
results.push(run('Unit/integration tests (turbo)', 'npx', ['turbo', 'test']));
// 5. Dependency audit (production deps only)
results.push(run('Dependency audit', 'npm', ['audit', '--omit=dev', '--audit-level=moderate']));
// 6. Unified reliability ledger (api + web) - verifies every covered guarantee links to a passing test
results.push(run('Reliability ledger (api + web)', 'npm', ['run', 'reliability:report']));

// 7. Playwright E2E against the local Docker stack
if (noE2e) {
  results.push({ name: 'End-to-end (Playwright)', ok: true, ms: 0, skipped: true });
} else {
  const up = (await reachable(`${API_URL}/api/v1/health`)) && (await reachable(`${WEB_URL}/`));
  if (!up) {
    process.stdout.write(
      `\n-- End-to-end (Playwright) --\n` +
      `Stack not reachable at ${WEB_URL} / ${API_URL}.\n` +
      `Start it with:  docker compose -f compose.yml -f compose.local.yml up\n` +
      `(or re-run with --no-e2e to skip this gate)\n`,
    );
    results.push({ name: 'End-to-end (Playwright)', ok: false, ms: 0, skipped: false });
  } else {
    results.push(run('End-to-end (Playwright)', 'npm', ['run', 'test:e2e']));
  }
}

// ---- summary ----
const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
console.log('\n==================== release:ready ====================');
for (const r of results) {
  const status = r.skipped ? 'SKIP' : r.ok ? 'PASS' : 'FAIL';
  console.log(`  ${status}  ${pad(r.name, 36)} ${r.skipped ? '' : `${(r.ms / 1000).toFixed(1)}s`}`);
}
const failed = results.filter((r) => !r.ok && !r.skipped);
const passed = results.filter((r) => r.ok && !r.skipped).length;
const skipped = results.filter((r) => r.skipped).length;
const overallStatus = failed.length > 0
  ? 'NOT GREEN'
  : skipped > 0
    ? 'GREEN - selected gates passed; skipped gates remain'
    : 'GREEN - repository release gates passed';
console.log('-------------------------------------------------------');
console.log(`  ${passed} passed, ${failed.length} failed, ${skipped} skipped`);
console.log(`  OVERALL: ${overallStatus}`);
console.log('=======================================================\n');
process.exit(failed.length === 0 ? 0 : 1);
