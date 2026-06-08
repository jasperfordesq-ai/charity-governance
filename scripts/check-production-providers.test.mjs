import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const providersScriptPath = join(scriptsDir, 'check-production-providers.mjs');

async function loadProviderRunner() {
  assert.ok(existsSync(providersScriptPath), 'production provider checker script must exist');
  const module = await import(pathToFileURL(providersScriptPath).href);
  assert.equal(typeof module.runProductionProvidersCheckFromArgs, 'function');
  return module.runProductionProvidersCheckFromArgs;
}

function productionEnv(overrides = {}) {
  const values = {
    STRIPE_SECRET_KEY: 'sk_live_configuredSecret',
    STRIPE_WEBHOOK_SECRET: 'whsec_configuredSecret',
    STRIPE_ESSENTIALS_MONTHLY_PRICE_ID: 'price_essentialsMonthly',
    STRIPE_ESSENTIALS_YEARLY_PRICE_ID: 'price_essentialsYearly',
    STRIPE_COMPLETE_MONTHLY_PRICE_ID: 'price_completeMonthly',
    STRIPE_COMPLETE_YEARLY_PRICE_ID: 'price_completeYearly',
    RESEND_API_KEY: 're_configuredSecret',
    EMAIL_FROM: 'CharityPilot <noreply@charitypilot.ie>',
    NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    ...overrides,
  };

  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

function writeEnvFile(content) {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-production-providers-'));
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

function priceBody(id, overrides = {}) {
  return {
    id,
    object: 'price',
    active: true,
    livemode: true,
    recurring: { interval: 'month' },
    ...overrides,
  };
}

test('production provider checker verifies live Stripe prices, webhook endpoint, and Resend domain', async () => {
  const runProductionProvidersCheckFromArgs = await loadProviderRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv());
  const calls = [];

  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (url.includes('api.stripe.com/v1/prices/')) {
      return response(200, priceBody(decodeURIComponent(url.split('/').pop())));
    }
    if (url.includes('api.stripe.com/v1/webhook_endpoints')) {
      return response(200, {
        data: [
          {
            id: 'we_live',
            object: 'webhook_endpoint',
            livemode: true,
            status: 'enabled',
            url: 'https://api.charitypilot.ie/api/v1/billing/webhooks',
          },
        ],
      });
    }
    if (url.includes('api.resend.com/domains')) {
      return response(200, {
        data: [
          { id: 'domain_live', name: 'charitypilot.ie', status: 'verified' },
        ],
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  try {
    const result = await runProductionProvidersCheckFromArgs(
      ['--production-env-file', envPath],
      { fetchImpl },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Production provider check passed/);
    assert.equal(calls.filter((call) => call.url.includes('/v1/prices/')).length, 4);
    assert.ok(calls.some((call) => call.url.includes('/v1/webhook_endpoints')));
    assert.ok(calls.some((call) => call.url.includes('api.resend.com/domains')));
    for (const call of calls.filter((entry) => entry.url.includes('api.stripe.com'))) {
      assert.equal(call.options.headers.Authorization, 'Bearer sk_live_configuredSecret');
    }
    for (const call of calls.filter((entry) => entry.url.includes('api.resend.com'))) {
      assert.equal(call.options.headers.Authorization, 'Bearer re_configuredSecret');
    }
    assert.doesNotMatch(result.stdout, /sk_live_configuredSecret|re_configuredSecret|price_essentialsMonthly/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production provider checker fails when a Stripe price is inactive or not live recurring', async () => {
  const runProductionProvidersCheckFromArgs = await loadProviderRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv());

  try {
    const result = await runProductionProvidersCheckFromArgs(
      ['--production-env-file', envPath],
      {
        fetchImpl: async (url) => {
          if (url.includes('price_essentialsMonthly')) {
            return response(200, priceBody('price_essentialsMonthly', { active: false, livemode: false, recurring: null }));
          }
          if (url.includes('api.stripe.com/v1/prices/')) return response(200, priceBody(decodeURIComponent(url.split('/').pop())));
          if (url.includes('api.stripe.com/v1/webhook_endpoints')) {
            return response(200, { data: [{ livemode: true, status: 'enabled', url: 'https://api.charitypilot.ie/api/v1/billing/webhooks' }] });
          }
          if (url.includes('api.resend.com/domains')) {
            return response(200, { data: [{ name: 'charitypilot.ie', status: 'verified' }] });
          }
          return response(404, {});
        },
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /STRIPE_ESSENTIALS_MONTHLY_PRICE_ID must be active/);
    assert.match(result.stderr, /STRIPE_ESSENTIALS_MONTHLY_PRICE_ID must be live mode/);
    assert.match(result.stderr, /STRIPE_ESSENTIALS_MONTHLY_PRICE_ID must be recurring/);
    assert.doesNotMatch(result.stderr, /sk_live_configuredSecret|price_essentialsMonthly/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production provider checker fails when webhook or Resend domain evidence is missing', async () => {
  const runProductionProvidersCheckFromArgs = await loadProviderRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv());

  try {
    const result = await runProductionProvidersCheckFromArgs(
      ['--production-env-file', envPath],
      {
        fetchImpl: async (url) => {
          if (url.includes('api.stripe.com/v1/prices/')) return response(200, priceBody(decodeURIComponent(url.split('/').pop())));
          if (url.includes('api.stripe.com/v1/webhook_endpoints')) {
            return response(200, {
              data: [{ livemode: true, status: 'disabled', url: 'https://api.charitypilot.ie/api/v1/billing/webhooks' }],
            });
          }
          if (url.includes('api.resend.com/domains')) {
            return response(200, { data: [{ name: 'charitypilot.ie', status: 'pending' }] });
          }
          return response(404, {});
        },
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /enabled live Stripe webhook endpoint must exist for https:\/\/api\.charitypilot\.ie\/api\/v1\/billing\/webhooks/);
    assert.match(result.stderr, /Resend domain charitypilot\.ie must be verified/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production provider checker fails before network calls when provider env is missing', async () => {
  const runProductionProvidersCheckFromArgs = await loadProviderRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv({
    STRIPE_SECRET_KEY: 'sk_test_notProduction',
    RESEND_API_KEY: 'REPLACE_ME_RESEND',
    EMAIL_FROM: 'noreply@example.com',
    NEXT_PUBLIC_API_URL: 'http://localhost:3002',
  }));
  let called = false;

  try {
    const result = await runProductionProvidersCheckFromArgs(
      ['--production-env-file', envPath],
      {
        fetchImpl: async () => {
          called = true;
          return response(200, {});
        },
      },
    );

    assert.equal(result.status, 1);
    assert.equal(called, false);
    assert.match(result.stderr, /STRIPE_SECRET_KEY must use a live Stripe secret key/);
    assert.match(result.stderr, /RESEND_API_KEY must be configured/);
    assert.match(result.stderr, /EMAIL_FROM must use an approved CharityPilot sender domain/);
    assert.match(result.stderr, /NEXT_PUBLIC_API_URL must use https/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
