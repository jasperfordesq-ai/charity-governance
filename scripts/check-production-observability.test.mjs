import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const observabilityScriptPath = join(scriptsDir, 'check-production-observability.mjs');

async function loadObservabilityRunner() {
  assert.ok(existsSync(observabilityScriptPath), 'production observability checker script must exist');
  const module = await import(pathToFileURL(observabilityScriptPath).href);
  assert.equal(typeof module.runProductionObservabilityCheckFromArgs, 'function');
  return module.runProductionObservabilityCheckFromArgs;
}

function productionEnv(overrides = {}) {
  const values = {
    ERROR_ALERT_WEBHOOK_URL: 'https://alerts.charitypilot.ie/hooks/charitypilot',
    ...overrides,
  };

  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

function writeEnvFile(content) {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-production-observability-'));
  const envPath = join(tempDir, 'production.env');
  writeFileSync(envPath, content);
  return { tempDir, envPath };
}

function response(status) {
  return {
    ok: status >= 200 && status < 300,
    status,
  };
}

test('production observability checker sends a sanitized test alert to the configured webhook', async () => {
  const runProductionObservabilityCheckFromArgs = await loadObservabilityRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv());
  const dnsCalls = [];
  const fetchCalls = [];

  try {
    const result = await runProductionObservabilityCheckFromArgs(
      ['--production-env-file', envPath],
      {
        resolveHost: async (hostname) => {
          dnsCalls.push(hostname);
          return [{ address: '8.8.8.8', family: 4 }];
        },
        fetchImpl: async (url, options = {}) => {
          fetchCalls.push({ url: String(url), options });
          return response(202);
        },
        now: () => '2026-06-08T12:00:00.000Z',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Production observability check passed/);
    assert.doesNotMatch(result.stdout, /alerts\.charitypilot\.ie\/hooks\/charitypilot/);
    assert.deepEqual(dnsCalls, ['alerts.charitypilot.ie']);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, 'https://alerts.charitypilot.ie/hooks/charitypilot');
    assert.equal(fetchCalls[0].options.method, 'POST');
    assert.equal(fetchCalls[0].options.redirect, 'error');
    assert.equal(fetchCalls[0].options.headers['Content-Type'], 'application/json');

    const payload = JSON.parse(fetchCalls[0].options.body);
    assert.equal(payload.service, 'charitypilot-api');
    assert.equal(payload.environment, 'production');
    assert.equal(payload.severity, 'error');
    assert.equal(payload.method, 'CHECK');
    assert.equal(payload.url, '/production/observability-check');
    assert.equal(payload.statusCode, 500);
    assert.equal(payload.code, 'PRODUCTION_OBSERVABILITY_CHECK');
    assert.equal(payload.errorName, 'ProductionObservabilityCheck');
    assert.equal(payload.requestId, 'production-observability-check');
    assert.equal(payload.timestamp, '2026-06-08T12:00:00.000Z');
    assert.equal('message' in payload, false);
    assert.equal('stack' in payload, false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production observability checker rejects empty production env file option as usage error', async () => {
  const runProductionObservabilityCheckFromArgs = await loadObservabilityRunner();
  let called = false;

  const result = await runProductionObservabilityCheckFromArgs(
    ['--production-env-file='],
    {
      resolveHost: async () => {
        called = true;
        return [];
      },
      fetchImpl: async () => {
        called = true;
        return response(202);
      },
    },
  );

  assert.equal(result.status, 2);
  assert.equal(called, false);
  assert.match(result.stderr, /Usage:/);
  assert.match(result.stderr, /--production-env-file requires a value/);
});

test('production observability checker rejects missing, local, and non-HTTPS webhook URLs before sending', async () => {
  const runProductionObservabilityCheckFromArgs = await loadObservabilityRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv({
    ERROR_ALERT_WEBHOOK_URL: 'http://localhost:9000/webhook',
  }));
  let called = false;

  try {
    const result = await runProductionObservabilityCheckFromArgs(
      ['--production-env-file', envPath],
      {
        resolveHost: async () => {
          called = true;
          return [];
        },
        fetchImpl: async () => {
          called = true;
          return response(202);
        },
      },
    );

    assert.equal(result.status, 1);
    assert.equal(called, false);
    assert.match(result.stderr, /ERROR_ALERT_WEBHOOK_URL must use https/);
    assert.match(result.stderr, /ERROR_ALERT_WEBHOOK_URL must not point at localhost/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production observability checker rejects copied placeholder webhook hosts before DNS or sending', async () => {
  const runProductionObservabilityCheckFromArgs = await loadObservabilityRunner();
  for (const placeholderUrl of [
    'https://your-alerts.charitypilot.ie/hooks/charitypilot',
    'https://pending-alerts.charitypilot.ie/hooks/charitypilot',
  ]) {
    const { tempDir, envPath } = writeEnvFile(productionEnv({
      ERROR_ALERT_WEBHOOK_URL: placeholderUrl,
    }));
    let called = false;

    try {
      const result = await runProductionObservabilityCheckFromArgs(
        ['--production-env-file', envPath],
        {
          resolveHost: async () => {
            called = true;
            return [{ address: '8.8.8.8', family: 4 }];
          },
          fetchImpl: async () => {
            called = true;
            return response(202);
          },
        },
      );

      assert.equal(result.status, 1);
      assert.equal(called, false, 'checker must stop before resolving or sending to placeholder alert hosts');
      assert.match(result.stderr, /ERROR_ALERT_WEBHOOK_URL is missing or still contains a placeholder value/);
      assert.doesNotMatch(result.stderr, /your-alerts|pending-alerts/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test('production observability checker rejects private or reserved webhook DNS', async () => {
  const runProductionObservabilityCheckFromArgs = await loadObservabilityRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv());

  try {
    const result = await runProductionObservabilityCheckFromArgs(
      ['--production-env-file', envPath],
      {
        resolveHost: async () => [
          { address: '10.0.0.5', family: 4 },
          { address: '2001:db8::1', family: 6 },
        ],
        fetchImpl: async () => response(202),
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /alerts\.charitypilot\.ie DNS must resolve only to public IP addresses/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production observability checker fails when webhook delivery is not accepted', async () => {
  const runProductionObservabilityCheckFromArgs = await loadObservabilityRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv());

  try {
    const result = await runProductionObservabilityCheckFromArgs(
      ['--production-env-file', envPath],
      {
        resolveHost: async () => [{ address: '1.1.1.1', family: 4 }],
        fetchImpl: async () => response(500),
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /test alert webhook request failed with HTTP 500/);
    assert.doesNotMatch(result.stderr, /hooks\/charitypilot/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production observability checker redacts thrown webhook failure transcripts', async () => {
  const runProductionObservabilityCheckFromArgs = await loadObservabilityRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv());

  try {
    const result = await runProductionObservabilityCheckFromArgs(
      ['--production-env-file', envPath],
      {
        resolveHost: async () => [{ address: '1.1.1.1', family: 4 }],
        fetchImpl: async () => {
          throw new Error(
            'delivery failed for https://alerts.charitypilot.ie/hooks/charitypilot?token=secret-token with Bearer configured-alert-secret',
          );
        },
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /test alert webhook request failed: Error/);
    assert.match(result.stderr, /token=\[redacted\]/);
    assert.match(result.stderr, /Bearer \[redacted\]/);
    assert.doesNotMatch(result.stderr, /secret-token|configured-alert-secret/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
