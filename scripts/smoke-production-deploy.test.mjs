import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const smokeScriptPath = join(scriptsDir, 'smoke-production-deploy.mjs');

function cleanEnv() {
  return {
    PATH: process.env.PATH ?? '',
    Path: process.env.Path ?? '',
    SystemRoot: process.env.SystemRoot ?? '',
    WINDIR: process.env.WINDIR ?? '',
    TEMP: process.env.TEMP ?? tmpdir(),
    TMP: process.env.TMP ?? tmpdir(),
  };
}

async function loadSmokeRunner() {
  assert.ok(existsSync(smokeScriptPath), 'production deploy smoke script must exist');
  const module = await import(pathToFileURL(smokeScriptPath).href);
  assert.equal(typeof module.runProductionDeploySmokeFromArgs, 'function');
  return module.runProductionDeploySmokeFromArgs;
}

function completeSmokeEnv(overrides = {}) {
  const values = {
    FRONTEND_URL: 'https://app.charitypilot.ie',
    NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    READINESS_API_KEY: 'configured-readiness-key-32-chars',
    ...overrides,
  };

  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

function response(status, body, headers = {}) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );

  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        return normalizedHeaders[name.toLowerCase()] ?? null;
      },
    },
    async json() {
      return body;
    },
  };
}

function baselineHeaders(extra = {}) {
  return {
    'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    ...extra,
  };
}

test('production deploy smoke dry-run lists public HTTPS checks without fetching', async () => {
  const runProductionDeploySmokeFromArgs = await loadSmokeRunner();
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-production-smoke-dry-run-'));
  const envPath = join(tempDir, 'production.env');
  let fetchCalled = false;

  writeFileSync(envPath, completeSmokeEnv());

  try {
    const result = await runProductionDeploySmokeFromArgs(
      ['--production-env-file', envPath, '--dry-run'],
      {
        processEnv: cleanEnv(),
        fetchImpl: async () => {
          fetchCalled = true;
          return response(200, {});
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fetchCalled, false);
    assert.match(result.stdout, /Production deploy smoke dry-run/);
    assert.match(result.stdout, /Web origin: https:\/\/app\.charitypilot\.ie/);
    assert.match(result.stdout, /API origin: https:\/\/api\.charitypilot\.ie/);
    assert.match(result.stdout, /GET https:\/\/api\.charitypilot\.ie\/api\/v1\/health\/readiness with readiness key/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production deploy smoke verifies public web, API, CORS, and keyed readiness', async () => {
  const runProductionDeploySmokeFromArgs = await loadSmokeRunner();
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-production-smoke-success-'));
  const envPath = join(tempDir, 'production.env');
  const calls = [];

  writeFileSync(envPath, completeSmokeEnv());

  try {
    const result = await runProductionDeploySmokeFromArgs(
      ['--production-env-file', envPath],
      {
        processEnv: cleanEnv(),
        fetchImpl: async (url, options = {}) => {
          calls.push({ url: String(url), headers: options.headers ?? {} });

          if (url === 'https://app.charitypilot.ie/') {
            return response(200, {}, baselineHeaders({
              'content-security-policy': "default-src 'self'; frame-ancestors 'none'; connect-src 'self' https://api.charitypilot.ie",
            }));
          }

          if (url === 'https://api.charitypilot.ie/api/v1/health') {
            return response(200, { status: 'ok' }, baselineHeaders({
              'access-control-allow-origin': 'https://app.charitypilot.ie',
              'access-control-allow-credentials': 'true',
            }));
          }

          if (!options.headers?.['x-charitypilot-readiness-key']) {
            return response(401, { code: 'READINESS_UNAUTHORIZED' }, baselineHeaders());
          }

          return response(200, {
            status: 'ready',
            checks: {
              database: true,
              billingConfigured: true,
              emailConfigured: true,
              storageConfigured: true,
              storageBucketReachable: true,
            },
          }, baselineHeaders());
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Production deploy smoke passed/);
    assert.deepEqual(calls.map((call) => call.url), [
      'https://app.charitypilot.ie/',
      'https://api.charitypilot.ie/api/v1/health',
      'https://api.charitypilot.ie/api/v1/health/readiness',
      'https://api.charitypilot.ie/api/v1/health/readiness',
    ]);
    assert.equal(calls[1].headers.origin, 'https://app.charitypilot.ie');
    assert.equal(calls[3].headers['x-charitypilot-readiness-key'], 'configured-readiness-key-32-chars');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production deploy smoke fails when keyed readiness is not ready', async () => {
  const runProductionDeploySmokeFromArgs = await loadSmokeRunner();
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-production-smoke-not-ready-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(envPath, completeSmokeEnv());

  try {
    const result = await runProductionDeploySmokeFromArgs(
      ['--production-env-file', envPath],
      {
        processEnv: cleanEnv(),
        fetchImpl: async (url, options = {}) => {
          if (url === 'https://app.charitypilot.ie/') return response(200, {}, baselineHeaders());
          if (url === 'https://api.charitypilot.ie/api/v1/health') {
            return response(200, { status: 'ok' }, baselineHeaders({
              'access-control-allow-origin': 'https://app.charitypilot.ie',
              'access-control-allow-credentials': 'true',
            }));
          }
          if (!options.headers?.['x-charitypilot-readiness-key']) {
            return response(401, { code: 'READINESS_UNAUTHORIZED' }, baselineHeaders());
          }
          return response(503, {
            status: 'not_ready',
            checks: { database: true, storageConfigured: true, storageBucketReachable: false },
          }, baselineHeaders());
        },
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /keyed readiness must return 200 ready/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
