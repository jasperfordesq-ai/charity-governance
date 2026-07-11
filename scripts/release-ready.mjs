#!/usr/bin/env node
// CharityPilot release-readiness gate - one command that proves the repository gate state.
//
// Runs every quality gate in order, captures PASS/FAIL per gate, and prints a single
// summary with counts. Exits non-zero if any gate fails, so CI and humans can trust a
// single green/red signal.
//
//   npm run release:ready              # every gate incl. isolated Playwright E2E
//   npm run release:ready -- --no-e2e  # skip the isolated E2E gate
//   npm run release:ready -- --no-build
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const allowedArgs = new Set(['--no-e2e', '--no-build']);
for (const arg of args) {
  if (!allowedArgs.has(arg)) {
    console.error(`Unknown option: ${arg}`);
    console.error('Usage: npm run release:ready -- [--no-e2e] [--no-build]');
    process.exit(2);
  }
}
const noE2e = args.includes('--no-e2e');
const noBuild = args.includes('--no-build');

const RELEASE_READY_GATE_TIMEOUT_MS = positiveIntEnv('RELEASE_READY_GATE_TIMEOUT_MS', 900000);
const RELEASE_READY_E2E_TIMEOUT_MS = positiveIntEnv('RELEASE_READY_E2E_TIMEOUT_MS', 2400000);

function positiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cleanupProcessTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      // Each POSIX gate is its own process group. If the outer timeout expires
      // after the E2E runner's cleanup margin, kill only that exact gate tree.
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // Best-effort cleanup only; the gate remains failed either way.
  }
}

function packageManagerCli(name) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return name === 'npx' ? join(dirname(npmExecPath), 'npx-cli.js') : npmExecPath;
  }

  return join(dirname(process.execPath), `node_modules/npm/bin/${name}-cli.js`);
}

function resolveGateCommand(cmd, cmdArgs) {
  if (process.platform !== 'win32' || (cmd !== 'npm' && cmd !== 'npx')) {
    return { cmd, cmdArgs };
  }

  return {
    cmd: process.execPath,
    cmdArgs: [packageManagerCli(cmd), ...cmdArgs],
  };
}

function run(name, cmd, cmdArgs, opts = {}) {
  const started = Date.now();
  process.stdout.write(`\n-- ${name} --\n`);
  const timeoutMs = opts.timeoutMs ?? RELEASE_READY_GATE_TIMEOUT_MS;
  const resolved = resolveGateCommand(cmd, cmdArgs);
  const res = spawnSync(resolved.cmd, resolved.cmdArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    env: opts.replaceEnv ? opts.env : { ...process.env, ...(opts.env ?? {}) },
    timeout: opts.timeoutMs ?? RELEASE_READY_GATE_TIMEOUT_MS,
    detached: process.platform !== 'win32',
  });
  const ms = Date.now() - started;
  const timedOut = res.error?.code === 'ETIMEDOUT';
  if (timedOut) {
    cleanupProcessTree(res.pid);
    process.stdout.write(`Gate timed out after ${(timeoutMs / 1000).toFixed(0)}s.\n`);
  }
  const ok = res.status === 0;
  return { name, ok, ms, skipped: false };
}

function managedLocalE2eEnvironment(timeoutMs) {
  const env = { ...process.env };
  for (const key of [
    'E2E_ALLOW_LOCAL_DB_RESET',
    'E2E_DEPLOYED_QA',
    'E2E_DATABASE_URL',
    'E2E_DATABASE_INSTANCE_ID',
    'E2E_DESTRUCTIVE_RESET_CONFIRMATION',
    'E2E_REMOTE_DATABASE_RESET_OVERRIDE',
    'E2E_REMOTE_DATABASE_HOST',
    'E2E_DATABASE_SERVER_ADDRESS',
    'E2E_BOOTSTRAP_PASSWORD',
    'E2E_DATABASE_RUNNER_PASSWORD',
    'E2E_JWT_SECRET',
    'E2E_READINESS_API_KEY',
    'E2E_AUTH_COOKIE_DOMAIN',
    'E2E_DATABASE_EXPECTED_COMMENT',
    'E2E_DATABASE_EXPECTED_SCHEMA',
    'E2E_APP_IMAGE',
    'E2E_DATABASE_IMAGE',
    'E2E_GATEWAY_IMAGE',
    'E2E_BUILD_CONTEXT',
    'E2E_API_URL',
    'E2E_WEB_URL',
  ]) {
    delete env[key];
  }
  env.E2E_EXECUTION_MODE = 'local-disposable';
  env.E2E_MANAGED_LOCAL_RUNNER = 'true';
  env.E2E_RELEASE_READY = 'true';
  env.E2E_RUNNER_TIMEOUT_MS = String(timeoutMs);
  return env;
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

// 7. Playwright E2E against a fresh runner-owned disposable stack. The runner
// generates the database identity and credentials; release:ready cannot forward
// ambient reset authority or select remote-destructive mode.
if (noE2e) {
  results.push({ name: 'End-to-end (Playwright)', ok: true, ms: 0, skipped: true });
} else {
  results.push(run('End-to-end (Playwright)', 'npm', ['run', 'test:e2e'], {
    timeoutMs: RELEASE_READY_E2E_TIMEOUT_MS + 1800000,
    env: managedLocalE2eEnvironment(RELEASE_READY_E2E_TIMEOUT_MS),
    replaceEnv: true,
  }));
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
