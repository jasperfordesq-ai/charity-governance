import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const supabaseScriptPath = join(scriptsDir, 'check-production-supabase.mjs');

async function loadSupabaseRunner() {
  assert.ok(existsSync(supabaseScriptPath), 'production Supabase checker script must exist');
  const module = await import(pathToFileURL(supabaseScriptPath).href);
  assert.equal(typeof module.runProductionSupabaseCheckFromArgs, 'function');
  return module.runProductionSupabaseCheckFromArgs;
}

function productionEnv(overrides = {}) {
  const values = {
    SUPABASE_URL: 'https://production-project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'configured-service-role-key',
    SUPABASE_STORAGE_BUCKET: 'documents',
    ...overrides,
  };

  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

function writeEnvFile(content) {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-production-supabase-'));
  const envPath = join(tempDir, 'production.env');
  writeFileSync(envPath, content);
  return { tempDir, envPath };
}

function response(status, body = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

test('production Supabase checker verifies private bucket, signed URL, public denial, and cleanup', async () => {
  const runProductionSupabaseCheckFromArgs = await loadSupabaseRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv());
  const calls = [];

  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (url.endsWith('/storage/v1/bucket/documents')) {
      return response(200, { id: 'documents', public: false });
    }
    if (url.includes('/storage/v1/object/documents/charitypilot-production-check/')) {
      if (options.method === 'POST') return response(200, { Key: 'redacted' });
      if (options.method === 'DELETE') return response(200, {});
    }
    if (url.includes('/storage/v1/object/sign/documents/charitypilot-production-check/')) {
      return response(200, { signedURL: '/storage/v1/object/sign/documents/redacted?token=secret-token' });
    }
    if (url.includes('/storage/v1/object/public/documents/charitypilot-production-check/')) {
      return response(403, { message: 'private bucket' });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  try {
    const result = await runProductionSupabaseCheckFromArgs(
      ['--production-env-file', envPath],
      { fetchImpl, now: () => 1_786_000_000_000, randomBytes: () => 'abc123' },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Production Supabase storage check passed/);
    assert.equal(calls.length, 5);
    assert.deepEqual(calls.map((call) => call.options.method ?? 'GET'), ['GET', 'POST', 'POST', 'GET', 'DELETE']);
    for (const call of calls.filter((entry) => !entry.url.includes('/object/public/'))) {
      assert.equal(call.options.headers.Authorization, 'Bearer configured-service-role-key');
      assert.equal(call.options.headers.apikey, 'configured-service-role-key');
    }
    assert.equal(calls[3].options.headers?.Authorization, undefined, 'anonymous direct access check must not use service role auth');
    assert.doesNotMatch(result.stdout, /configured-service-role-key|secret-token|charitypilot-production-check/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production Supabase checker fails when the bucket is public', async () => {
  const runProductionSupabaseCheckFromArgs = await loadSupabaseRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv());
  let uploaded = false;

  try {
    const result = await runProductionSupabaseCheckFromArgs(
      ['--production-env-file', envPath],
      {
        fetchImpl: async (url) => {
          if (url.endsWith('/storage/v1/bucket/documents')) {
            return response(200, { id: 'documents', public: true });
          }
          uploaded = true;
          return response(500, {});
        },
      },
    );

    assert.equal(result.status, 1);
    assert.equal(uploaded, false, 'checker must stop before uploading to a public bucket');
    assert.match(result.stderr, /Supabase storage check failed/);
    assert.match(result.stderr, /documents bucket must be private/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production Supabase checker cleans up the probe object when signed URL verification fails', async () => {
  const runProductionSupabaseCheckFromArgs = await loadSupabaseRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv());
  const methods = [];

  const fetchImpl = async (url, options = {}) => {
    methods.push(options.method ?? 'GET');
    if (url.endsWith('/storage/v1/bucket/documents')) return response(200, { public: false });
    if (url.includes('/storage/v1/object/documents/')) {
      if (options.method === 'POST') return response(200, {});
      if (options.method === 'DELETE') return response(200, {});
    }
    if (url.includes('/storage/v1/object/sign/documents/')) return response(500, { error: 'sign failed' });
    return response(404, {});
  };

  try {
    const result = await runProductionSupabaseCheckFromArgs(
      ['--production-env-file', envPath],
      { fetchImpl, now: () => 1_786_000_000_000, randomBytes: () => 'abc123' },
    );

    assert.equal(result.status, 1);
    assert.deepEqual(methods, ['GET', 'POST', 'POST', 'DELETE']);
    assert.match(result.stderr, /signed URL creation failed/);
    assert.doesNotMatch(result.stderr, /charitypilot-production-check|configured-service-role-key/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production Supabase checker fails without configured production storage env', async () => {
  const runProductionSupabaseCheckFromArgs = await loadSupabaseRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv({
    SUPABASE_URL: 'https://REPLACE_ME_PROJECT.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'REPLACE_ME_SERVICE_ROLE',
    SUPABASE_STORAGE_BUCKET: '',
  }));

  try {
    const result = await runProductionSupabaseCheckFromArgs(['--production-env-file', envPath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /SUPABASE_URL must be configured/);
    assert.match(result.stderr, /SUPABASE_SERVICE_ROLE_KEY must be configured/);
    assert.match(result.stderr, /SUPABASE_STORAGE_BUCKET must be configured/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
