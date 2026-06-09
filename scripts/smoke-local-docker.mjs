#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const composeArgs = ['compose', '-f', 'compose.yml', '-f', 'compose.local.yml'];
const migrationScriptPath = join('scripts', 'migrate-local-docker.mjs');
const nextEnvPath = join(repoRoot, 'apps', 'web', 'next-env.d.ts');
const cleanup = process.argv.includes('--cleanup');
const cleanupVolumes = process.argv.includes('--cleanup-volumes');
const nextEnvSnapshot = existsSync(nextEnvPath) ? readFileSync(nextEnvPath, 'utf8') : null;

function runDocker(args) {
  const result = spawnSync('docker', args, {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function captureDocker(args) {
  const result = spawnSync('docker', args, {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || `docker ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}`);
  }

  return result.stdout;
}

async function runLocalDockerMigrations() {
  const result = spawnSync(process.execPath, [migrationScriptPath], {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    throw new Error(`node ${migrationScriptPath} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function localServicesAreRunning() {
  const output = captureDocker([...composeArgs, 'ps', '--format', 'json']);
  const services = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const runningServices = new Set(
    services
      .filter((service) => service.State === 'running')
      .map((service) => service.Service),
  );

  return ['db', 'api', 'web'].every((service) => runningServices.has(service));
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForCheck(label, check, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      await check();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000));
    }
  }

  throw new Error(`${label} did not pass within ${timeoutMs}ms: ${lastError?.message ?? 'unknown error'}`);
}

async function expectJson(url, options, validate) {
  const response = await fetchWithTimeout(url, options);
  const body = await response.json();
  validate(response, body);
}

async function smokeApiHealth() {
  await expectJson('http://127.0.0.1:3002/api/v1/health', {}, (response, body) => {
    if (response.status !== 200 || body.status !== 'ok') {
      throw new Error(`API health returned ${response.status}: ${JSON.stringify(body)}`);
    }
  });
}

async function smokeApiReadiness() {
  await expectJson('http://127.0.0.1:3002/api/v1/health/readiness', {}, (response, body) => {
    if (response.status !== 401 || body.code !== 'READINESS_UNAUTHORIZED' || 'checks' in body) {
      throw new Error(`unauthorized readiness leaked details: ${JSON.stringify(body)}`);
    }
  });

  await expectJson(
    'http://127.0.0.1:3002/api/v1/health/readiness',
    { headers: { 'x-charitypilot-readiness-key': 'local-readiness-key-at-least-32-characters' } },
    (response, body) => {
      if (
        response.status !== 503 ||
        body.status !== 'not_ready' ||
        body.checks?.database !== true ||
        body.checks?.storageConfigured !== false ||
        body.checks?.storageBucketReachable !== false
      ) {
        throw new Error(`local readiness returned unexpected body: ${JSON.stringify(body)}`);
      }
    },
  );
}

async function smokeApiRegistration() {
  const email = `local-docker-smoke-${Date.now()}@example.com`;
  const response = await fetchWithTimeout('http://127.0.0.1:3002/api/v1/auth/register', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:3003',
    },
    body: JSON.stringify({
      email,
      password: 'NewPassword1',
      name: 'Local Docker Smoke User',
      organisationName: 'Local Docker Smoke Organisation',
    }),
  });
  const body = await response.json();
  const expectedMessage = 'If this registration can be completed, check your email for next steps.';

  if (response.status !== 202 || body.message !== expectedMessage) {
    throw new Error(`local registration returned ${response.status}: ${JSON.stringify(body)}`);
  }
  if (response.headers.has('set-cookie')) {
    throw new Error('local registration smoke must not issue auth cookies');
  }
}

async function smokeWeb() {
  const response = await fetchWithTimeout('http://127.0.0.1:3003/');
  const body = await response.text();

  if (response.status !== 200 || !body.includes('CharityPilot')) {
    throw new Error(`web root returned ${response.status} without the CharityPilot app shell`);
  }
}

try {
  mkdirSync(join(repoRoot, 'apps', 'web', '.next'), { recursive: true });

  await runLocalDockerMigrations();

  if (localServicesAreRunning()) {
    console.log('Local Docker services already running; skipping compose up.');
    try {
      await smokeApiHealth();
    } catch {
      console.log('Existing API health check failed; restarting local API and web services.');
      runDocker([...composeArgs, 'restart', 'api', 'web']);
    }
  } else {
    runDocker([...composeArgs, 'up', '--wait', '--wait-timeout', '180', '-d']);
  }

  await waitForCheck('API health', smokeApiHealth);
  await waitForCheck('API readiness', smokeApiReadiness);
  await waitForCheck('API registration', smokeApiRegistration);
  await waitForCheck('web root', smokeWeb);

  console.log('Local Docker smoke passed: API health/readiness, registration, and web root responded over loopback.');
} finally {
  if (cleanup) {
    const downArgs = [...composeArgs, 'down', '--remove-orphans'];
    if (cleanupVolumes) downArgs.push('--volumes');
    runDocker(downArgs);
  }

  if (nextEnvSnapshot !== null) {
    writeFileSync(nextEnvPath, nextEnvSnapshot);
  }
}
