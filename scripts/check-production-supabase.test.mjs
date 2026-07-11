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

async function loadSupabaseModule() {
  assert.ok(existsSync(supabaseScriptPath), 'production Supabase checker script must exist');
  return import(pathToFileURL(supabaseScriptPath).href);
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
      return typeof body === 'string' ? JSON.parse(body) : body;
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

test('production Supabase checker verifies private bucket, authenticated download, public denial, and cleanup', async () => {
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
      if (options.method === 'GET') return response(200, 'CharityPilot production storage probe\n');
      if (options.method === 'DELETE') return response(200, {});
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
    assert.deepEqual(calls.map((call) => call.options.method ?? 'GET'), ['GET', 'POST', 'GET', 'GET', 'DELETE']);
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

test('production Supabase checker rejects empty production env file option as usage error', async () => {
  const runProductionSupabaseCheckFromArgs = await loadSupabaseRunner();
  let called = false;

  const result = await runProductionSupabaseCheckFromArgs(
    ['--production-env-file='],
    {
      fetchImpl: async () => {
        called = true;
        return response(200, {});
      },
    },
  );

  assert.equal(result.status, 2);
  assert.equal(called, false);
  assert.match(result.stderr, /Usage:/);
  assert.match(result.stderr, /--production-env-file requires a value/);
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

test('production Supabase checker cleans up the probe object when authenticated download verification fails', async () => {
  const runProductionSupabaseCheckFromArgs = await loadSupabaseRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv());
  const methods = [];

  const fetchImpl = async (url, options = {}) => {
    methods.push(options.method ?? 'GET');
    if (url.endsWith('/storage/v1/bucket/documents')) return response(200, { public: false });
    if (url.includes('/storage/v1/object/documents/')) {
      if (options.method === 'POST') return response(200, {});
      if (options.method === 'GET') return response(500, { error: 'download failed' });
      if (options.method === 'DELETE') return response(200, {});
    }
    return response(404, {});
  };

  try {
    const result = await runProductionSupabaseCheckFromArgs(
      ['--production-env-file', envPath],
      { fetchImpl, now: () => 1_786_000_000_000, randomBytes: () => 'abc123' },
    );

    assert.equal(result.status, 1);
    assert.deepEqual(methods, ['GET', 'POST', 'GET', 'DELETE']);
    assert.match(result.stderr, /service-role probe download failed/);
    assert.doesNotMatch(result.stderr, /charitypilot-production-check|configured-service-role-key/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production Supabase checker redacts request failure transcripts', async () => {
  const module = await loadSupabaseModule();
  assert.equal(typeof module.redactSupabaseTranscript, 'function');
  const { tempDir, envPath } = writeEnvFile(productionEnv());
  const secret = 'configured-service-role-key';
  const signedUrl =
    'https://production-project.supabase.co/storage/v1/object/sign/documents/charitypilot-production-check/1786000000000-abc123.txt?token=secret-token&signature=secret-signature';

  try {
    const result = await module.runProductionSupabaseCheckFromArgs(
      ['--production-env-file', envPath],
      {
        fetchImpl: async () => {
          throw new Error(`network failed for ${signedUrl} with Bearer ${secret} and apikey=${secret} SUPABASE_SERVICE_ROLE_KEY=${secret}`);
        },
        now: () => 1_786_000_000_000,
        randomBytes: () => 'abc123',
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Supabase request failed/);
    assert.match(result.stderr, /token=\[redacted\]/);
    assert.match(result.stderr, /Bearer \[redacted\]/);
    assert.match(result.stderr, /apikey=\[redacted\]/);
    assert.match(result.stderr, /SUPABASE_SERVICE_ROLE_KEY=\[redacted\]/);
    assert.doesNotMatch(result.stderr, /configured-service-role-key|secret-token|secret-signature|1786000000000-abc123/);
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

test('production Supabase checker rejects copied service-role secret-store placeholder before probing', async () => {
  const runProductionSupabaseCheckFromArgs = await loadSupabaseRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv({
    SUPABASE_SERVICE_ROLE_KEY: 'supabase-service-role-key-from-secret-store',
  }));
  let probed = false;

  try {
    const result = await runProductionSupabaseCheckFromArgs(
      ['--production-env-file', envPath],
      {
        fetchImpl: async () => {
          probed = true;
          return response(500, {});
        },
      },
    );

    assert.equal(result.status, 1);
    assert.equal(probed, false, 'checker must stop before probing with a copied service-role placeholder');
    assert.match(result.stderr, /SUPABASE_SERVICE_ROLE_KEY must be configured/);
    assert.doesNotMatch(result.stderr, /supabase-service-role-key-from-secret-store/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production Supabase checker rejects copied project-ref placeholder URLs before probing', async () => {
  const runProductionSupabaseCheckFromArgs = await loadSupabaseRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv({
    SUPABASE_URL: 'https://REAL_SUPABASE_PROJECT_REF.supabase.co',
  }));
  let probed = false;

  try {
    const result = await runProductionSupabaseCheckFromArgs(
      ['--production-env-file', envPath],
      {
        fetchImpl: async () => {
          probed = true;
          return response(500, {});
        },
      },
    );

    assert.equal(result.status, 1);
    assert.equal(probed, false, 'checker must stop before probing placeholder Supabase projects');
    assert.match(result.stderr, /SUPABASE_URL must be configured/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production Supabase checker rejects copied your-project placeholder URLs before probing', async () => {
  const runProductionSupabaseCheckFromArgs = await loadSupabaseRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv({
    SUPABASE_URL: 'https://your-project.supabase.co',
  }));
  let probed = false;

  try {
    const result = await runProductionSupabaseCheckFromArgs(
      ['--production-env-file', envPath],
      {
        fetchImpl: async () => {
          probed = true;
          return response(500, {});
        },
      },
    );

    assert.equal(result.status, 1);
    assert.equal(probed, false, 'checker must stop before probing placeholder Supabase projects');
    assert.match(result.stderr, /SUPABASE_URL must be configured/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production Supabase checker rejects sample project refs before probing', async () => {
  const runProductionSupabaseCheckFromArgs = await loadSupabaseRunner();

  for (const projectRef of ['configured-project', 'ci-project', 'sample-project']) {
    const { tempDir, envPath } = writeEnvFile(productionEnv({
      SUPABASE_URL: `https://${projectRef}.supabase.co`,
    }));
    let probed = false;

    try {
      const result = await runProductionSupabaseCheckFromArgs(
        ['--production-env-file', envPath],
        {
          fetchImpl: async () => {
            probed = true;
            return response(500, {});
          },
        },
      );

      assert.equal(result.status, 1);
      assert.equal(probed, false, 'checker must stop before probing sample Supabase projects');
      assert.match(result.stderr, /SUPABASE_URL must not use a sample Supabase project ref/);
      assert.doesNotMatch(result.stderr, new RegExp(projectRef));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});
