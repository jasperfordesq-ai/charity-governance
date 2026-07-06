import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const hostingScriptPath = join(scriptsDir, 'check-production-hosting.mjs');

async function loadHostingRunner() {
  assert.ok(existsSync(hostingScriptPath), 'production hosting checker script must exist');
  const module = await import(pathToFileURL(hostingScriptPath).href);
  assert.equal(typeof module.runProductionHostingCheckFromArgs, 'function');
  return module.runProductionHostingCheckFromArgs;
}

function productionEnv(overrides = {}) {
  const values = {
    FRONTEND_URL: 'https://app.charitypilot.ie',
    NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    ...overrides,
  };

  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

function writeEnvFile(content) {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-production-hosting-'));
  const envPath = join(tempDir, 'production.env');
  writeFileSync(envPath, content);
  return { tempDir, envPath };
}

function headers(values = {}) {
  const normalized = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    get(name) {
      return normalized.get(name.toLowerCase()) ?? null;
    },
  };
}

function response(status, headerValues = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headers(headerValues),
  };
}

function secureHeaders() {
  return {
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
  };
}

test('production hosting checker verifies DNS, TLS, reachability, and security headers', async () => {
  const runProductionHostingCheckFromArgs = await loadHostingRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv());
  const dnsCalls = [];
  const tlsCalls = [];
  const fetchCalls = [];

  try {
    const result = await runProductionHostingCheckFromArgs(
      ['--production-env-file', envPath],
      {
        resolveHost: async (hostname) => {
          dnsCalls.push(hostname);
          return [{ address: hostname.startsWith('app.') ? '8.8.8.8' : '1.1.1.1', family: 4 }];
        },
        inspectTlsCertificate: async (origin) => {
          tlsCalls.push(origin);
          return {
            authorized: true,
            validTo: '2030-01-01T00:00:00.000Z',
          };
        },
        fetchImpl: async (url) => {
          fetchCalls.push(String(url));
          return response(200, secureHeaders());
        },
        now: () => Date.parse('2026-06-08T12:00:00.000Z'),
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Production hosting check passed/);
    assert.deepEqual(dnsCalls, ['app.charitypilot.ie', 'api.charitypilot.ie']);
    assert.deepEqual(tlsCalls, ['https://app.charitypilot.ie', 'https://api.charitypilot.ie']);
    assert.deepEqual(fetchCalls, ['https://app.charitypilot.ie/', 'https://api.charitypilot.ie/api/v1/health']);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production hosting checker rejects reserved documentation DNS ranges', async () => {
  const runProductionHostingCheckFromArgs = await loadHostingRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv());

  try {
    const result = await runProductionHostingCheckFromArgs(
      ['--production-env-file', envPath],
      {
        resolveHost: async (hostname) => [{ address: hostname.startsWith('app.') ? '203.0.113.10' : '2001:db8::1', family: hostname.startsWith('app.') ? 4 : 6 }],
        inspectTlsCertificate: async () => ({ authorized: true, validTo: '2030-01-01T00:00:00.000Z' }),
        fetchImpl: async () => response(200, secureHeaders()),
        now: () => Date.parse('2026-06-08T12:00:00.000Z'),
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /app.charitypilot.ie DNS must resolve only to public IP addresses/);
    assert.match(result.stderr, /api.charitypilot.ie DNS must resolve only to public IP addresses/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production hosting checker rejects private DNS and bad TLS before reachability passes', async () => {
  const runProductionHostingCheckFromArgs = await loadHostingRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv());

  try {
    const result = await runProductionHostingCheckFromArgs(
      ['--production-env-file', envPath, '--min-tls-days', '30'],
      {
        resolveHost: async (hostname) => [{ address: hostname.startsWith('app.') ? '10.0.0.5' : '203.0.113.11', family: 4 }],
        inspectTlsCertificate: async (origin) => ({
          authorized: origin.includes('app.'),
          authorizationError: origin.includes('api.') ? 'CERT_HAS_EXPIRED' : '',
          validTo: origin.includes('app.')
            ? '2026-06-20T00:00:00.000Z'
            : '2030-01-01T00:00:00.000Z',
        }),
        fetchImpl: async () => response(200, secureHeaders()),
        now: () => Date.parse('2026-06-08T12:00:00.000Z'),
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /app.charitypilot.ie DNS must resolve only to public IP addresses/);
    assert.match(result.stderr, /app.charitypilot.ie TLS certificate must be valid for at least 30 days/);
    assert.match(result.stderr, /api.charitypilot.ie TLS certificate is not authorized/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production hosting checker fails when HTTPS reachability or security headers are missing', async () => {
  const runProductionHostingCheckFromArgs = await loadHostingRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv());

  try {
    const result = await runProductionHostingCheckFromArgs(
      ['--production-env-file', envPath],
      {
        resolveHost: async () => [{ address: '8.8.4.4', family: 4 }],
        inspectTlsCertificate: async () => ({ authorized: true, validTo: '2030-01-01T00:00:00.000Z' }),
        fetchImpl: async (url) => (
          String(url).includes('/api/v1/health')
            ? response(503, secureHeaders())
            : response(200, { 'x-content-type-options': 'nosniff' })
        ),
        now: () => Date.parse('2026-06-08T12:00:00.000Z'),
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /web origin must include strict-transport-security/);
    assert.match(result.stderr, /API health must return 2xx/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production hosting checker redacts thrown request failure transcripts', async () => {
  const runProductionHostingCheckFromArgs = await loadHostingRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv());

  try {
    const result = await runProductionHostingCheckFromArgs(
      ['--production-env-file', envPath],
      {
        resolveHost: async () => [{ address: '8.8.4.4', family: 4 }],
        inspectTlsCertificate: async () => ({ authorized: true, validTo: '2030-01-01T00:00:00.000Z' }),
        fetchImpl: async () => {
          throw new Error(
            'fetch failed with Authorization Bearer configured-readiness-key-32-chars at https://api.charitypilot.ie/api/v1/health?token=secret-token',
          );
        },
        now: () => Date.parse('2026-06-08T12:00:00.000Z'),
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /hosting check request failed/);
    assert.match(result.stderr, /Bearer \[redacted\]/);
    assert.match(result.stderr, /token=\[redacted\]/);
    assert.doesNotMatch(result.stderr, /configured-readiness-key-32-chars|secret-token/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production hosting checker requires the full baseline response security headers', async () => {
  const runProductionHostingCheckFromArgs = await loadHostingRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv());

  try {
    const result = await runProductionHostingCheckFromArgs(
      ['--production-env-file', envPath],
      {
        resolveHost: async () => [{ address: '8.8.4.4', family: 4 }],
        inspectTlsCertificate: async () => ({ authorized: true, validTo: '2030-01-01T00:00:00.000Z' }),
        fetchImpl: async () => response(200, {
          'strict-transport-security': 'max-age=31536000; includeSubDomains',
          'x-content-type-options': 'nosniff',
        }),
        now: () => Date.parse('2026-06-08T12:00:00.000Z'),
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /web origin must include x-frame-options/);
    assert.match(result.stderr, /web origin must include referrer-policy/);
    assert.match(result.stderr, /web origin must include permissions-policy/);
    assert.match(result.stderr, /web origin must include content-security-policy/);
    assert.match(result.stderr, /API health must include x-frame-options/);
    assert.match(result.stderr, /API health must include referrer-policy/);
    assert.match(result.stderr, /API health must include permissions-policy/);
    assert.match(result.stderr, /API health must include content-security-policy/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production hosting checker rejects non-canonical CharityPilot origins before network calls', async () => {
  const runProductionHostingCheckFromArgs = await loadHostingRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv({
    FRONTEND_URL: 'https://charitypilot.ie',
    NEXT_PUBLIC_API_URL: 'https://services.charitypilot.ie',
  }));
  let called = false;

  try {
    const result = await runProductionHostingCheckFromArgs(
      ['--production-env-file', envPath],
      {
        resolveHost: async () => {
          called = true;
          return [];
        },
      },
    );

    assert.equal(result.status, 1);
    assert.equal(called, false);
    assert.match(result.stderr, /FRONTEND_URL must use the canonical production web origin https:\/\/app\.charitypilot\.ie/);
    assert.match(result.stderr, /NEXT_PUBLIC_API_URL must use the canonical production API origin https:\/\/api\.charitypilot\.ie/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production hosting checker fails before network calls for non-production origins', async () => {
  const runProductionHostingCheckFromArgs = await loadHostingRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv({
    FRONTEND_URL: 'http://localhost:3000',
    NEXT_PUBLIC_API_URL: 'https://api.attacker.example',
  }));
  let called = false;

  try {
    const result = await runProductionHostingCheckFromArgs(
      ['--production-env-file', envPath],
      {
        resolveHost: async () => {
          called = true;
          return [];
        },
      },
    );

    assert.equal(result.status, 1);
    assert.equal(called, false);
    assert.match(result.stderr, /FRONTEND_URL must be an origin-only HTTPS URL/);
    assert.match(result.stderr, /NEXT_PUBLIC_API_URL must use an approved CharityPilot production hostname/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
