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
const localAdminEmail = 'admin@charitypilot.local';
const localAdminPassword = 'LocalAdmin123!';
const seededStarterDocumentNames = new Set([
  'Governing Document',
  'Trustee Code of Conduct',
  'Financial Controls Policy',
  'Insurance Schedule',
]);

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
  console.log('Applying local Docker migrations and dependency refresh...');
  const result = spawnSync(process.execPath, [migrationScriptPath], {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    throw new Error(`node ${migrationScriptPath} failed with exit code ${result.status ?? 'unknown'}`);
  }
  console.log('Local Docker migrations and dependency refresh completed.');
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

async function fetchWithTimeout(url, options = {}, timeoutMs = 5_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

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

function cookieHeaderFrom(response) {
  const setCookieHeaders = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);

  return setCookieHeaders
    .map((cookie) => cookie.split(';')[0])
    .filter(Boolean)
    .join('; ');
}

async function assertLocalDocumentDownload(cookieHeader, documentId, expectedText) {
  const downloadResponse = await fetchWithTimeout(`http://127.0.0.1:3002/api/v1/documents/${documentId}/download`, {
    headers: {
      cookie: cookieHeader,
      origin: 'http://localhost:3003',
    },
  });
  const downloadBody = await downloadResponse.json();

  if (
    downloadResponse.status !== 200 ||
    typeof downloadBody.url !== 'string' ||
    !downloadBody.url.startsWith('http://localhost:3002/api/v1/documents/_local-download?path=')
  ) {
    throw new Error(`local document download URL returned ${downloadResponse.status}: ${JSON.stringify(downloadBody)}`);
  }

  const fileResponse = await fetchWithTimeout(downloadBody.url, {
    headers: {
      cookie: cookieHeader,
      origin: 'http://localhost:3003',
    },
  });
  const fileBody = await fileResponse.text();

  if (fileResponse.status !== 200 || !fileBody.includes(expectedText)) {
    throw new Error(`local document file returned ${fileResponse.status}: ${fileBody}`);
  }
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
        body.checks?.storageConfigured !== true ||
        body.checks?.storageBucketReachable !== true ||
        body.checks?.billingConfigured !== false
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

async function smokeLocalAdminLoginAndDocumentStorage() {
  const loginResponse = await fetchWithTimeout('http://127.0.0.1:3002/api/v1/auth/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:3003',
    },
    body: JSON.stringify({
      email: localAdminEmail,
      password: localAdminPassword,
    }),
  });
  const loginBody = await loginResponse.json();

  if (
    loginResponse.status !== 200 ||
    loginBody.user?.email !== localAdminEmail ||
    loginBody.user?.role !== 'OWNER'
  ) {
    throw new Error(`local admin login returned ${loginResponse.status}: ${JSON.stringify(loginBody)}`);
  }

  const cookieHeader = cookieHeaderFrom(loginResponse);
  if (!cookieHeader.includes('charitypilot_access=') || !cookieHeader.includes('charitypilot_refresh=')) {
    throw new Error('local admin login did not issue auth cookies');
  }

  const documentsResponse = await fetchWithTimeout('http://127.0.0.1:3002/api/v1/documents', {
    headers: {
      cookie: cookieHeader,
      origin: 'http://localhost:3003',
    },
  });
  const documentsBody = await documentsResponse.json();
  const documents = documentsBody.data ?? [];
  const seededDocuments = documents.filter((document) => seededStarterDocumentNames.has(document.name));

  if (documentsResponse.status !== 200 || seededDocuments.length !== seededStarterDocumentNames.size) {
    throw new Error(`local seeded documents returned ${documentsResponse.status}: ${JSON.stringify(documentsBody)}`);
  }

  for (const document of seededDocuments) {
    await assertLocalDocumentDownload(cookieHeader, document.id, document.name);
  }

  console.log('Seeded starter documents downloaded through local filesystem storage.');

  const formData = new FormData();
  formData.append('name', 'Local smoke document');
  formData.append('category', 'OTHER');
  formData.append('description', 'Uploaded by the local Docker smoke test.');
  formData.append(
    'file',
    new Blob(['local filesystem storage smoke document'], { type: 'text/plain' }),
    'local-smoke.txt',
  );

  const uploadResponse = await fetchWithTimeout('http://127.0.0.1:3002/api/v1/documents', {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      origin: 'http://localhost:3003',
    },
    body: formData,
  });
  const uploadBody = await uploadResponse.json();

  if (uploadResponse.status !== 201 || !uploadBody.data?.id) {
    throw new Error(`local document upload returned ${uploadResponse.status}: ${JSON.stringify(uploadBody)}`);
  }

  const documentId = uploadBody.data.id;
  try {
    await assertLocalDocumentDownload(cookieHeader, documentId, 'local filesystem storage smoke document');
  } finally {
    await fetchWithTimeout(`http://127.0.0.1:3002/api/v1/documents/${documentId}`, {
      method: 'DELETE',
      headers: {
        cookie: cookieHeader,
        origin: 'http://localhost:3003',
      },
    });
  }

  console.log('Document uploaded and downloaded through local filesystem storage.');
}

async function smokeWeb() {
  const response = await fetchWithTimeout('http://127.0.0.1:3003/', {}, 180_000);
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
    console.log('Starting local Docker app services...');
    runDocker([...composeArgs, 'up', '--wait', '--wait-timeout', '180', '-d']);
  }

  console.log('Checking API health...');
  await waitForCheck('API health', smokeApiHealth);
  console.log('Checking API readiness...');
  await waitForCheck('API readiness', smokeApiReadiness);
  console.log('Checking public registration path...');
  await waitForCheck('API registration', smokeApiRegistration);
  console.log('Checking local admin login and document storage...');
  await waitForCheck('local admin document storage', smokeLocalAdminLoginAndDocumentStorage);
  console.log('Checking web root...');
  await waitForCheck('web root', smokeWeb, 600_000);

  console.log('Local Docker smoke passed: API health/readiness, registration, local admin document storage, and web root responded over loopback.');
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
