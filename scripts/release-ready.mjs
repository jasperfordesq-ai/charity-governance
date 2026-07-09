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

const WEB_URL = process.env.E2E_WEB_URL ?? 'http://localhost:3003';
const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3002';
const STACK_REACHABILITY_TOTAL_TIMEOUT_MS = 90000;
const STACK_REACHABILITY_REQUEST_TIMEOUT_MS = 10000;
const STACK_REACHABILITY_POLL_MS = 2000;
const RELEASE_READY_GATE_TIMEOUT_MS = positiveIntEnv('RELEASE_READY_GATE_TIMEOUT_MS', 900000);
const RELEASE_READY_E2E_TIMEOUT_MS = positiveIntEnv('RELEASE_READY_E2E_TIMEOUT_MS', 1500000);

function positiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cleanupProcessTree(pid) {
  if (process.platform !== 'win32' || !pid) {
    return;
  }
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    // Best-effort cleanup only; the gate remains failed either way.
  }
}

function cleanupRepoPlaywrightProcesses() {
  if (process.platform !== 'win32') {
    return;
  }

  const escapedRoot = ROOT.replaceAll("'", "''");
  const command = [
    `$repoRoot = '${escapedRoot}'`,
    "$patterns = @('test:e2e', '@playwright\\test', 'playwright\\lib\\worker\\workerProcessEntry')",
    '$processes = @(Get-CimInstance Win32_Process -Filter "name = \'node.exe\'")',
    '$byId = @{}',
    'foreach ($process in $processes) { $byId[[int]$process.ProcessId] = $process }',
    '$ids = @{}',
    '$repoMatchedProcessIds = @()',
    'foreach ($process in $processes) {',
    '  $commandLine = [string]$process.CommandLine',
    '  if (-not $commandLine -or $commandLine -notlike "*$repoRoot*") { continue }',
    '  foreach ($pattern in $patterns) {',
    '    if ($commandLine -like "*$pattern*") {',
    '      $repoMatchedProcessIds += [int]$process.ProcessId',
    '      break',
    '    }',
    '  }',
    '}',
    'foreach ($processId in $repoMatchedProcessIds) {',
    '  $currentId = [int]$processId',
    '  while ($byId.ContainsKey($currentId) -and -not $ids.ContainsKey($currentId)) {',
    '    $ids[$currentId] = $true',
    '    $currentId = [int]$byId[$currentId].ParentProcessId',
    '  }',
    '}',
    '$queue = New-Object System.Collections.Queue',
    'foreach ($processId in @($ids.Keys)) { [void]$queue.Enqueue([int]$processId) }',
    'while ($queue.Count -gt 0) {',
    '  $parentId = [int]$queue.Dequeue()',
    '  foreach ($child in $processes | Where-Object { [int]$_.ParentProcessId -eq $parentId }) {',
    '    $childId = [int]$child.ProcessId',
    '    if (-not $ids.ContainsKey($childId)) {',
    '      $ids[$childId] = $true',
    '      [void]$queue.Enqueue($childId)',
    '    }',
    '  }',
    '}',
    'foreach ($processId in @($ids.Keys)) { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }',
  ].join('; ');

  try {
    spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      stdio: 'ignore',
    });
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
    timeout: opts.timeoutMs ?? RELEASE_READY_GATE_TIMEOUT_MS,
  });
  const ms = Date.now() - started;
  const timedOut = res.error?.code === 'ETIMEDOUT';
  if (timedOut) {
    cleanupProcessTree(res.pid);
    process.stdout.write(`Gate timed out after ${(timeoutMs / 1000).toFixed(0)}s.\n`);
  }
  const ok = res.status === 0;
  if (!ok && opts.cleanupProcessTreeOnFailure && !timedOut) {
    cleanupProcessTree(res.pid);
  }
  if (!ok && opts.cleanupRepoPlaywrightProcessesOnFailure) {
    cleanupRepoPlaywrightProcesses();
  }
  return { name, ok, ms, skipped: false };
}

async function probeReachable(url) {
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(STACK_REACHABILITY_REQUEST_TIMEOUT_MS),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function waitUntilReachable(url) {
  const deadline = Date.now() + STACK_REACHABILITY_TOTAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probeReachable(url)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, STACK_REACHABILITY_POLL_MS));
  }
  return false;
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
  const [apiUp, webUp] = await Promise.all([
    waitUntilReachable(`${API_URL}/api/v1/health`),
    waitUntilReachable(`${WEB_URL}/`),
  ]);
  const up = apiUp && webUp;
  if (!up) {
    process.stdout.write(
      `\n-- End-to-end (Playwright) --\n` +
      `Stack not reachable at ${WEB_URL} / ${API_URL}.\n` +
      `Start it with:  docker compose -f compose.yml -f compose.local.yml up\n` +
      `(or re-run with --no-e2e to skip this gate)\n`,
    );
    results.push({ name: 'End-to-end (Playwright)', ok: false, ms: 0, skipped: false });
  } else {
    results.push(run('End-to-end (Playwright)', 'npm', ['run', 'test:e2e'], {
      timeoutMs: RELEASE_READY_E2E_TIMEOUT_MS,
      cleanupProcessTreeOnFailure: true,
      cleanupRepoPlaywrightProcessesOnFailure: true,
    }));
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
