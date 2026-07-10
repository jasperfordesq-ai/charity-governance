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
    STRIPE_BILLING_PORTAL_CONFIGURATION_ID: 'bpc_charityPilotLive',
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
  const expected = {
    price_essentialsMonthly: {
      currency: 'eur',
      unit_amount: 1900,
      product: 'prod_essentials',
      recurring: { interval: 'month', interval_count: 1 },
    },
    price_essentialsYearly: {
      currency: 'eur',
      unit_amount: 19000,
      product: 'prod_essentials',
      recurring: { interval: 'year', interval_count: 1 },
    },
    price_completeMonthly: {
      currency: 'eur',
      unit_amount: 3900,
      product: 'prod_complete',
      recurring: { interval: 'month', interval_count: 1 },
    },
    price_completeYearly: {
      currency: 'eur',
      unit_amount: 39000,
      product: 'prod_complete',
      recurring: { interval: 'year', interval_count: 1 },
    },
  }[id];

  assert.ok(expected, `test fixture must define expected Stripe price ${id}`);
  return {
    id,
    object: 'price',
    active: true,
    livemode: true,
    ...expected,
    ...overrides,
  };
}

function portalConfigurationBody({
  id = 'bpc_charityPilotLive',
  active = true,
  livemode = true,
  subscriptionUpdate = {},
  subscriptionCancel = {},
} = {}) {
  return {
    id,
    object: 'billing_portal.configuration',
    active,
    livemode,
    features: {
      subscription_update: {
        enabled: true,
        default_allowed_updates: ['price'],
        proration_behavior: 'create_prorations',
        products: [
          {
            product: 'prod_essentials',
            prices: ['price_essentialsMonthly', 'price_essentialsYearly'],
          },
          {
            product: 'prod_complete',
            prices: ['price_completeMonthly', 'price_completeYearly'],
          },
        ],
        ...subscriptionUpdate,
      },
      subscription_cancel: {
        enabled: true,
        mode: 'at_period_end',
        proration_behavior: 'none',
        ...subscriptionCancel,
      },
    },
  };
}

function validProviderResponse(url) {
  if (url.includes('api.stripe.com/v1/prices/')) {
    return response(200, priceBody(decodeURIComponent(url.split('/').pop())));
  }
  if (url.includes('api.stripe.com/v1/billing_portal/configurations/')) {
    return response(200, portalConfigurationBody());
  }
  if (url.includes('api.stripe.com/v1/webhook_endpoints')) {
    return response(200, {
      data: [{
        id: 'we_live',
        object: 'webhook_endpoint',
        livemode: true,
        status: 'enabled',
        url: 'https://api.charitypilot.ie/api/v1/billing/webhooks',
        enabled_events: ['*'],
      }],
    });
  }
  if (url.includes('api.resend.com/domains')) {
    return response(200, {
      data: [{ id: 'domain_live', name: 'charitypilot.ie', status: 'verified' }],
    });
  }
  throw new Error(`unexpected request: ${url}`);
}

test('production provider checker verifies exact live Stripe prices, safe portal configuration, webhook endpoint, and Resend domain', async () => {
  const runProductionProvidersCheckFromArgs = await loadProviderRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv());
  const calls = [];

  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (url.includes('api.stripe.com/v1/prices/')) {
      return response(200, priceBody(decodeURIComponent(url.split('/').pop())));
    }
    if (url.includes('api.stripe.com/v1/billing_portal/configurations/')) {
      return response(200, portalConfigurationBody());
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
            enabled_events: [
              'checkout.session.completed',
              'customer.subscription.updated',
              'customer.subscription.deleted',
            ],
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
    assert.match(result.stdout, /safe live billing portal configuration/);
    assert.match(result.stdout, /required subscription events/);
    assert.equal(calls.filter((call) => call.url.includes('/v1/prices/')).length, 4);
    assert.equal(calls.filter((call) => call.url.includes('/v1/billing_portal/configurations/')).length, 1);
    assert.ok(calls.some((call) => call.url.includes('/v1/webhook_endpoints')));
    assert.ok(calls.some((call) => call.url.includes('api.resend.com/domains')));
    for (const call of calls.filter((entry) => entry.url.includes('api.stripe.com'))) {
      assert.equal(call.options.headers.Authorization, 'Bearer sk_live_configuredSecret');
    }
    for (const call of calls.filter((entry) => entry.url.includes('api.resend.com'))) {
      assert.equal(call.options.headers.Authorization, 'Bearer re_configuredSecret');
    }
    assert.doesNotMatch(result.stdout, /sk_live_configuredSecret|re_configuredSecret|price_essentialsMonthly|bpc_charityPilotLive/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production provider checker rejects empty production env file option as usage error', async () => {
  const runProductionProvidersCheckFromArgs = await loadProviderRunner();
  let called = false;

  const result = await runProductionProvidersCheckFromArgs(
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

test('production provider checker rejects empty expected API origin option as usage error', async () => {
  const runProductionProvidersCheckFromArgs = await loadProviderRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv());
  let called = false;

  try {
    const result = await runProductionProvidersCheckFromArgs(
      ['--production-env-file', envPath, '--expect-api-origin='],
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
    assert.match(result.stderr, /--expect-api-origin requires a value/);
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
          if (url.includes('api.stripe.com/v1/billing_portal/configurations/')) {
            return response(200, portalConfigurationBody());
          }
          if (url.includes('api.stripe.com/v1/webhook_endpoints')) {
            return response(200, {
              data: [{
                livemode: true,
                status: 'enabled',
                url: 'https://api.charitypilot.ie/api/v1/billing/webhooks',
                enabled_events: ['*'],
              }],
            });
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

test('production provider checker rejects wrong Stripe price currency, amount, cadence, and product grouping', async () => {
  const runProductionProvidersCheckFromArgs = await loadProviderRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv());

  try {
    const result = await runProductionProvidersCheckFromArgs(
      ['--production-env-file', envPath],
      {
        fetchImpl: async (url) => {
          if (url.includes('price_essentialsMonthly')) {
            return response(200, priceBody('price_essentialsMonthly', {
              currency: 'usd',
              unit_amount: 999,
              product: 'prod_wrongEssentials',
              recurring: { interval: 'year', interval_count: 2 },
            }));
          }
          return validProviderResponse(url);
        },
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /STRIPE_ESSENTIALS_MONTHLY_PRICE_ID must use EUR currency/);
    assert.match(result.stderr, /STRIPE_ESSENTIALS_MONTHLY_PRICE_ID must use the approved EUR unit amount of 1900/);
    assert.match(result.stderr, /STRIPE_ESSENTIALS_MONTHLY_PRICE_ID must recur every month/);
    assert.match(result.stderr, /STRIPE_ESSENTIALS_MONTHLY_PRICE_ID must use a recurring interval count of 1/);
    assert.match(result.stderr, /Essentials monthly and yearly Stripe prices must share one product/);
    assert.match(result.stderr, /exact approved product and price allow-list/);
    assert.doesNotMatch(result.stderr, /price_essentialsMonthly|prod_wrongEssentials/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production provider checker rejects unsafe Stripe billing portal features and allow-list', async () => {
  const runProductionProvidersCheckFromArgs = await loadProviderRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv());

  try {
    const result = await runProductionProvidersCheckFromArgs(
      ['--production-env-file', envPath],
      {
        fetchImpl: async (url) => {
          if (url.includes('api.stripe.com/v1/billing_portal/configurations/')) {
            return response(200, portalConfigurationBody({
              id: 'bpc_differentConfiguration',
              active: false,
              livemode: false,
              subscriptionUpdate: {
                enabled: false,
                default_allowed_updates: ['quantity'],
                proration_behavior: 'unsupported_behavior',
                products: [{
                  product: 'prod_essentials',
                  prices: ['price_essentialsMonthly'],
                }],
              },
              subscriptionCancel: {
                enabled: false,
                mode: 'immediately',
                proration_behavior: 'unsupported_behavior',
              },
            }));
          }
          return validProviderResponse(url);
        },
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /billing portal lookup returned a different configuration/);
    assert.match(result.stderr, /billing portal configuration must be active/);
    assert.match(result.stderr, /billing portal configuration must be live mode/);
    assert.match(result.stderr, /subscription updates must be enabled/);
    assert.match(result.stderr, /subscription updates must allow price changes/);
    assert.match(result.stderr, /subscription updates must not allow quantity changes/);
    assert.match(result.stderr, /must set a recognized explicit proration behavior/);
    assert.match(result.stderr, /must use the exact approved product and price allow-list/);
    assert.match(result.stderr, /subscription cancellation must be enabled/);
    assert.match(result.stderr, /subscription cancellation must take effect at period end/);
    assert.match(result.stderr, /subscription cancellation must set a recognized explicit proration behavior/);
    assert.doesNotMatch(result.stderr, /bpc_charityPilotLive|price_essentialsMonthly|prod_essentials/);
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
          if (url.includes('api.stripe.com/v1/billing_portal/configurations/')) {
            return response(200, portalConfigurationBody());
          }
          if (url.includes('api.stripe.com/v1/webhook_endpoints')) {
            return response(200, {
              data: [{
                livemode: true,
                status: 'disabled',
                url: 'https://api.charitypilot.ie/api/v1/billing/webhooks',
                enabled_events: [
                  'checkout.session.completed',
                  'customer.subscription.updated',
                  'customer.subscription.deleted',
                ],
              }],
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

test('production provider checker fails when the Stripe webhook is missing required events', async () => {
  const runProductionProvidersCheckFromArgs = await loadProviderRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv());

  try {
    const result = await runProductionProvidersCheckFromArgs(
      ['--production-env-file', envPath],
      {
        fetchImpl: async (url) => {
          if (url.includes('api.stripe.com/v1/prices/')) return response(200, priceBody(decodeURIComponent(url.split('/').pop())));
          if (url.includes('api.stripe.com/v1/billing_portal/configurations/')) {
            return response(200, portalConfigurationBody());
          }
          if (url.includes('api.stripe.com/v1/webhook_endpoints')) {
            return response(200, {
              data: [{
                livemode: true,
                status: 'enabled',
                url: 'https://api.charitypilot.ie/api/v1/billing/webhooks',
                enabled_events: ['checkout.session.completed'],
              }],
            });
          }
          if (url.includes('api.resend.com/domains')) {
            return response(200, { data: [{ name: 'charitypilot.ie', status: 'verified' }] });
          }
          return response(404, {});
        },
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /must subscribe to customer\.subscription\.updated/);
    assert.match(result.stderr, /must subscribe to customer\.subscription\.deleted/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production provider checker rejects non-canonical API origin before network calls', async () => {
  const runProductionProvidersCheckFromArgs = await loadProviderRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv({
    NEXT_PUBLIC_API_URL: 'https://services.charitypilot.ie',
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
    assert.match(result.stderr, /NEXT_PUBLIC_API_URL must use the canonical production API origin https:\/\/api\.charitypilot\.ie/);
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

test('production provider checker requires a pinned portal configuration and four distinct price IDs before network calls', async () => {
  const runProductionProvidersCheckFromArgs = await loadProviderRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv({
    STRIPE_COMPLETE_YEARLY_PRICE_ID: 'price_essentialsMonthly',
    STRIPE_BILLING_PORTAL_CONFIGURATION_ID: 'portal_notPinned',
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
    assert.match(result.stderr, /four Stripe price environment values must use distinct price IDs/);
    assert.match(result.stderr, /STRIPE_BILLING_PORTAL_CONFIGURATION_ID must use a Stripe billing portal configuration ID/);
    assert.doesNotMatch(result.stderr, /price_essentialsMonthly|portal_notPinned/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production provider checker rejects live-looking placeholder provider values before network calls', async () => {
  const runProductionProvidersCheckFromArgs = await loadProviderRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv({
    STRIPE_SECRET_KEY: 'sk_live_your_stripe_secret',
    STRIPE_WEBHOOK_SECRET: 'whsec_your_webhook_secret',
    STRIPE_ESSENTIALS_MONTHLY_PRICE_ID: 'price_your_essentials_monthly',
    STRIPE_BILLING_PORTAL_CONFIGURATION_ID: 'bpc_your_portal_configuration',
    RESEND_API_KEY: 're_your_resend_key',
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
    assert.equal(called, false, 'checker must stop before calling providers with placeholder values');
    assert.match(result.stderr, /STRIPE_SECRET_KEY must use a live Stripe secret key/);
    assert.match(result.stderr, /STRIPE_WEBHOOK_SECRET must be configured as a Stripe webhook signing secret/);
    assert.match(result.stderr, /STRIPE_ESSENTIALS_MONTHLY_PRICE_ID must use a Stripe price ID/);
    assert.match(result.stderr, /STRIPE_BILLING_PORTAL_CONFIGURATION_ID must use a Stripe billing portal configuration ID/);
    assert.match(result.stderr, /RESEND_API_KEY must be configured as a Resend API key/);
    assert.doesNotMatch(result.stderr, /your_stripe|your_webhook|your_essentials|your_portal|your_resend/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production provider checker redacts thrown provider request transcripts', async () => {
  const runProductionProvidersCheckFromArgs = await loadProviderRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv());

  try {
    const result = await runProductionProvidersCheckFromArgs(
      ['--production-env-file', envPath],
      {
        fetchImpl: async () => {
          throw new Error(
            [
              'provider failed with Bearer sk_live_configuredSecret',
              'RESEND_API_KEY=re_configuredSecret',
              'at https://api.stripe.com/v1/prices/price_essentialsMonthly?token=secret-token',
              'portal bpc_charityPilotLive product prod_essentials',
            ].join(' '),
          );
        },
      },
    );

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /STRIPE_ESSENTIALS_MONTHLY_PRICE_ID Stripe price lookup request failed: Error:/,
    );
    assert.match(result.stderr, /Bearer \[redacted-stripe-key\]/);
    assert.match(result.stderr, /RESEND_API_KEY=\[redacted\]/);
    assert.match(result.stderr, /token=\[redacted\]/);
    assert.doesNotMatch(
      result.stderr,
      /sk_live_configuredSecret|re_configuredSecret|secret-token|price_essentialsMonthly|bpc_charityPilotLive|prod_essentials/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
