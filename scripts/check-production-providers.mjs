#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { redactProductionDeployTranscript } from './production-deploy-preflight.mjs';
import { canonicalOriginIssue, isApprovedCharityPilotHostname } from './production-hostnames.mjs';

const stripePriceDefinitions = [
  {
    envName: 'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID',
    unitAmount: 1900,
    interval: 'month',
  },
  {
    envName: 'STRIPE_ESSENTIALS_YEARLY_PRICE_ID',
    unitAmount: 19000,
    interval: 'year',
  },
  {
    envName: 'STRIPE_COMPLETE_MONTHLY_PRICE_ID',
    unitAmount: 3900,
    interval: 'month',
  },
  {
    envName: 'STRIPE_COMPLETE_YEARLY_PRICE_ID',
    unitAmount: 39000,
    interval: 'year',
  },
];

const recognizedProrationBehaviors = new Set([
  'always_invoice',
  'create_prorations',
  'none',
]);

const requiredStripeWebhookEvents = [
  'checkout.session.completed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
];

function usage() {
  return [
    'Usage: node scripts/check-production-providers.mjs --production-env-file <path> [--expect-api-origin <origin>]',
    '',
  ].join('\n');
}

function result(status, stdout = '', stderr = '') {
  return { status, stdout, stderr };
}

function parseArgs(argv) {
  const options = {
    productionEnvFile: '.env.production',
    expectApiOrigin: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--production-env-file') {
      const value = argv[index + 1];
      if (!value) throw new Error('--production-env-file requires a value');
      options.productionEnvFile = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--production-env-file=')) {
      const value = arg.slice('--production-env-file='.length);
      if (!value) throw new Error('--production-env-file requires a value');
      options.productionEnvFile = value;
      continue;
    }
    if (arg === '--expect-api-origin') {
      const value = argv[index + 1];
      if (!value) throw new Error('--expect-api-origin requires a value');
      options.expectApiOrigin = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--expect-api-origin=')) {
      const value = arg.slice('--expect-api-origin='.length);
      if (!value) throw new Error('--expect-api-origin requires a value');
      options.expectApiOrigin = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function parseEnvFile(path) {
  if (!existsSync(path)) {
    throw new Error(`production env file not found: ${path}`);
  }

  const values = {};
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }

  return values;
}

function isConfigured(value) {
  return typeof value === 'string' && value.trim().length > 0 && !/REPLACE_ME|change-me|your_|your-|project_ref|TODO|TBD|placeholder/i.test(value);
}

function parseApiOrigin(value, issues) {
  if (!isConfigured(value)) {
    issues.push('NEXT_PUBLIC_API_URL must be configured for the production API origin');
    return null;
  }

  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') {
      issues.push('NEXT_PUBLIC_API_URL must use https for production provider checks');
    }
    if (url.origin !== value.replace(/\/+$/, '')) {
      issues.push('NEXT_PUBLIC_API_URL must be an origin-only production URL');
    }
    if (!isApprovedCharityPilotHostname(url.hostname)) {
      issues.push('NEXT_PUBLIC_API_URL must use an approved CharityPilot production hostname');
    }
    const issue = canonicalOriginIssue('NEXT_PUBLIC_API_URL', url.origin, 'api');
    if (issue) issues.push(issue);
    return url.origin;
  } catch {
    issues.push('NEXT_PUBLIC_API_URL must be a valid URL');
    return null;
  }
}

function senderDomain(emailFrom) {
  if (!isConfigured(emailFrom)) return null;
  const bracketMatch = emailFrom.match(/<([^<>@\s]+@[^<>@\s]+)>/);
  const address = bracketMatch?.[1] ?? emailFrom.trim();
  const atIndex = address.lastIndexOf('@');
  if (atIndex === -1) return null;
  return address.slice(atIndex + 1).toLowerCase();
}

function validateEnv(env, expectApiOrigin) {
  const issues = [];
  if (!isConfigured(env.STRIPE_SECRET_KEY) || !env.STRIPE_SECRET_KEY.startsWith('sk_live_')) {
    issues.push('STRIPE_SECRET_KEY must use a live Stripe secret key');
  }
  if (!isConfigured(env.STRIPE_WEBHOOK_SECRET) || !env.STRIPE_WEBHOOK_SECRET.startsWith('whsec_')) {
    issues.push('STRIPE_WEBHOOK_SECRET must be configured as a Stripe webhook signing secret');
  }
  const validPriceIds = [];
  for (const { envName } of stripePriceDefinitions) {
    if (!isConfigured(env[envName]) || !env[envName].startsWith('price_')) {
      issues.push(`${envName} must use a Stripe price ID`);
    } else {
      validPriceIds.push(env[envName]);
    }
  }
  if (
    validPriceIds.length === stripePriceDefinitions.length &&
    new Set(validPriceIds).size !== validPriceIds.length
  ) {
    issues.push('the four Stripe price environment values must use distinct price IDs');
  }
  if (
    !isConfigured(env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID) ||
    !env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID.startsWith('bpc_')
  ) {
    issues.push('STRIPE_BILLING_PORTAL_CONFIGURATION_ID must use a Stripe billing portal configuration ID');
  }
  if (!isConfigured(env.RESEND_API_KEY) || !env.RESEND_API_KEY.startsWith('re_')) {
    issues.push('RESEND_API_KEY must be configured as a Resend API key');
  }

  const domain = senderDomain(env.EMAIL_FROM);
  if (!domain || !isApprovedCharityPilotHostname(domain)) {
    issues.push('EMAIL_FROM must use an approved CharityPilot sender domain');
  }

  const apiOrigin = parseApiOrigin(expectApiOrigin ?? env.NEXT_PUBLIC_API_URL, issues);
  return { issues, apiOrigin, emailDomain: domain };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function fetchJson(fetchImpl, url, options, label, issues) {
  let response;
  try {
    response = await fetchImpl(url, options);
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'unknown error';
    const errorMessage = redactProviderTranscript(
      error instanceof Error ? error.message : String(error),
    );
    issues.push(`${label} request failed: ${errorName}${errorMessage ? `: ${errorMessage}` : ''}`);
    return null;
  }

  if (!response?.ok) {
    issues.push(`${label} request failed with HTTP ${response?.status ?? 'unknown'}`);
    return null;
  }

  return readJson(response);
}

function redactProviderTranscript(value) {
  return redactProductionDeployTranscript(value)
    .replace(/\bprice_[A-Za-z0-9_=-]+/g, '[redacted-stripe-price-id]')
    .replace(/\bbpc_[A-Za-z0-9_=-]+/g, '[redacted-stripe-portal-configuration-id]')
    .replace(/\bprod_[A-Za-z0-9_=-]+/g, '[redacted-stripe-product-id]');
}

function stripeHeaders(secretKey) {
  return {
    Authorization: `Bearer ${secretKey}`,
  };
}

function resendHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
  };
}

function priceIssues(definition, expectedPriceId, price) {
  const { envName, unitAmount, interval } = definition;
  const issues = [];
  if (price?.object !== 'price') {
    issues.push(`${envName} lookup did not return a Stripe price object`);
    return issues;
  }
  if (price.id !== expectedPriceId) {
    issues.push(`${envName} lookup returned a different Stripe price`);
  }
  if (price.active !== true) {
    issues.push(`${envName} must be active`);
  }
  if (price.livemode !== true) {
    issues.push(`${envName} must be live mode`);
  }
  if (!price.recurring) {
    issues.push(`${envName} must be recurring`);
  } else {
    if (price.recurring.interval !== interval) {
      issues.push(`${envName} must recur every ${interval}`);
    }
    if (price.recurring.interval_count !== 1) {
      issues.push(`${envName} must use a recurring interval count of 1`);
    }
  }
  if (price.currency !== 'eur') {
    issues.push(`${envName} must use EUR currency`);
  }
  if (price.unit_amount !== unitAmount) {
    issues.push(`${envName} must use the approved EUR unit amount of ${unitAmount}`);
  }
  if (typeof price.product !== 'string' || !price.product.startsWith('prod_')) {
    issues.push(`${envName} must reference a Stripe product ID`);
  }
  return issues;
}

async function verifyStripePrices({ env, fetchImpl, issues }) {
  const prices = new Map();
  for (const definition of stripePriceDefinitions) {
    const { envName } = definition;
    const price = await fetchJson(
      fetchImpl,
      `https://api.stripe.com/v1/prices/${encodeURIComponent(env[envName])}`,
      { method: 'GET', headers: stripeHeaders(env.STRIPE_SECRET_KEY) },
      `${envName} Stripe price lookup`,
      issues,
    );
    if (price) {
      prices.set(envName, price);
      issues.push(...priceIssues(definition, env[envName], price));
    }
  }

  const priceFor = (envName) => prices.get(envName);
  const essentialsMonthlyProduct = priceFor('STRIPE_ESSENTIALS_MONTHLY_PRICE_ID')?.product;
  const essentialsYearlyProduct = priceFor('STRIPE_ESSENTIALS_YEARLY_PRICE_ID')?.product;
  const completeMonthlyProduct = priceFor('STRIPE_COMPLETE_MONTHLY_PRICE_ID')?.product;
  const completeYearlyProduct = priceFor('STRIPE_COMPLETE_YEARLY_PRICE_ID')?.product;

  if (
    typeof essentialsMonthlyProduct === 'string' &&
    typeof essentialsYearlyProduct === 'string' &&
    essentialsMonthlyProduct !== essentialsYearlyProduct
  ) {
    issues.push('Essentials monthly and yearly Stripe prices must share one product');
  }
  if (
    typeof completeMonthlyProduct === 'string' &&
    typeof completeYearlyProduct === 'string' &&
    completeMonthlyProduct !== completeYearlyProduct
  ) {
    issues.push('Complete monthly and yearly Stripe prices must share one product');
  }
  if (
    typeof essentialsMonthlyProduct === 'string' &&
    typeof essentialsYearlyProduct === 'string' &&
    essentialsMonthlyProduct === essentialsYearlyProduct &&
    typeof completeMonthlyProduct === 'string' &&
    typeof completeYearlyProduct === 'string' &&
    completeMonthlyProduct === completeYearlyProduct &&
    essentialsMonthlyProduct === completeMonthlyProduct
  ) {
    issues.push('Essentials and Complete Stripe prices must use different products');
  }

  return prices;
}

function expectedPortalProducts(env, prices) {
  if (prices.size !== stripePriceDefinitions.length) return null;

  const products = new Map();
  for (const { envName } of stripePriceDefinitions) {
    const price = prices.get(envName);
    if (typeof price?.product !== 'string' || !price.product.startsWith('prod_')) return null;
    const productPrices = products.get(price.product) ?? [];
    productPrices.push(env[envName]);
    products.set(price.product, productPrices);
  }

  if (products.size !== 2) return null;
  return [...products.entries()]
    .map(([product, priceIds]) => ({ product, prices: [...priceIds].sort() }))
    .sort((left, right) => left.product.localeCompare(right.product));
}

function normalizedPortalProducts(products) {
  if (!Array.isArray(products)) return null;

  const seenProducts = new Set();
  const normalized = [];
  for (const entry of products) {
    if (
      typeof entry?.product !== 'string' ||
      !entry.product.startsWith('prod_') ||
      !Array.isArray(entry.prices) ||
      entry.prices.some((priceId) => typeof priceId !== 'string' || !priceId.startsWith('price_')) ||
      new Set(entry.prices).size !== entry.prices.length ||
      seenProducts.has(entry.product)
    ) {
      return null;
    }
    seenProducts.add(entry.product);
    normalized.push({ product: entry.product, prices: [...entry.prices].sort() });
  }

  return normalized.sort((left, right) => left.product.localeCompare(right.product));
}

async function verifyStripePortalConfiguration({ env, fetchImpl, prices, issues }) {
  const configuration = await fetchJson(
    fetchImpl,
    `https://api.stripe.com/v1/billing_portal/configurations/${encodeURIComponent(env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID)}`,
    { method: 'GET', headers: stripeHeaders(env.STRIPE_SECRET_KEY) },
    'Stripe billing portal configuration lookup',
    issues,
  );
  if (!configuration) return;

  if (configuration.object !== 'billing_portal.configuration') {
    issues.push('Stripe billing portal lookup did not return a billing portal configuration object');
    return;
  }
  if (configuration.id !== env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID) {
    issues.push('Stripe billing portal lookup returned a different configuration');
  }
  if (configuration.active !== true) {
    issues.push('Stripe billing portal configuration must be active');
  }
  if (configuration.livemode !== true) {
    issues.push('Stripe billing portal configuration must be live mode');
  }

  const subscriptionUpdate = configuration.features?.subscription_update;
  if (subscriptionUpdate?.enabled !== true) {
    issues.push('Stripe billing portal subscription updates must be enabled');
  }
  const allowedUpdates = Array.isArray(subscriptionUpdate?.default_allowed_updates)
    ? subscriptionUpdate.default_allowed_updates
    : [];
  if (!allowedUpdates.includes('price')) {
    issues.push('Stripe billing portal subscription updates must allow price changes');
  }
  if (allowedUpdates.includes('quantity')) {
    issues.push('Stripe billing portal subscription updates must not allow quantity changes');
  }
  if (!recognizedProrationBehaviors.has(subscriptionUpdate?.proration_behavior)) {
    issues.push('Stripe billing portal subscription updates must set a recognized explicit proration behavior');
  }

  const expectedProducts = expectedPortalProducts(env, prices);
  const actualProducts = normalizedPortalProducts(subscriptionUpdate?.products);
  if (
    expectedProducts === null ||
    actualProducts === null ||
    JSON.stringify(actualProducts) !== JSON.stringify(expectedProducts)
  ) {
    issues.push('Stripe billing portal subscription updates must use the exact approved product and price allow-list');
  }

  const subscriptionCancel = configuration.features?.subscription_cancel;
  if (subscriptionCancel?.enabled !== true) {
    issues.push('Stripe billing portal subscription cancellation must be enabled');
  }
  if (subscriptionCancel?.mode !== 'at_period_end') {
    issues.push('Stripe billing portal subscription cancellation must take effect at period end');
  }
  if (!recognizedProrationBehaviors.has(subscriptionCancel?.proration_behavior)) {
    issues.push('Stripe billing portal subscription cancellation must set a recognized explicit proration behavior');
  }
}

async function verifyStripeWebhook({ env, fetchImpl, apiOrigin, issues }) {
  const expectedWebhookUrl = `${apiOrigin}/api/v1/billing/webhooks`;
  const endpoints = await fetchJson(
    fetchImpl,
    'https://api.stripe.com/v1/webhook_endpoints?limit=100',
    { method: 'GET', headers: stripeHeaders(env.STRIPE_SECRET_KEY) },
    'Stripe webhook endpoint lookup',
    issues,
  );
  if (!endpoints) return;

  const expectedEndpoint = Array.isArray(endpoints.data) && endpoints.data.find((endpoint) => (
    endpoint?.livemode === true &&
    endpoint?.status === 'enabled' &&
    endpoint?.url === expectedWebhookUrl
  ));
  if (!expectedEndpoint) {
    issues.push(`enabled live Stripe webhook endpoint must exist for ${expectedWebhookUrl}`);
    return;
  }

  const enabledEvents = Array.isArray(expectedEndpoint.enabled_events) ? expectedEndpoint.enabled_events : [];
  const subscribesToAll = enabledEvents.includes('*');
  for (const eventName of requiredStripeWebhookEvents) {
    if (!subscribesToAll && !enabledEvents.includes(eventName)) {
      issues.push(`Stripe webhook endpoint for ${expectedWebhookUrl} must subscribe to ${eventName}`);
    }
  }
}

async function verifyResendDomain({ env, fetchImpl, emailDomain, issues }) {
  const domains = await fetchJson(
    fetchImpl,
    'https://api.resend.com/domains',
    { method: 'GET', headers: resendHeaders(env.RESEND_API_KEY) },
    'Resend domain lookup',
    issues,
  );
  if (!domains) return;

  const hasVerifiedDomain = Array.isArray(domains.data) && domains.data.some((domain) => (
    domain?.name?.toLowerCase?.() === emailDomain &&
    domain?.status === 'verified'
  ));
  if (!hasVerifiedDomain) {
    issues.push(`Resend domain ${emailDomain} must be verified`);
  }
}

export async function runProductionProvidersCheckFromArgs(
  args = process.argv.slice(2),
  {
    fetchImpl = globalThis.fetch,
  } = {},
) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    return result(2, '', `${usage()}${error.message}\n`);
  }

  if (typeof fetchImpl !== 'function') {
    return result(1, '', 'Production provider check failed: fetch is not available in this runtime.\n');
  }

  let fileEnv;
  try {
    fileEnv = parseEnvFile(resolve(process.cwd(), options.productionEnvFile));
  } catch (error) {
    return result(
      1,
      '',
      `Production provider check failed: ${redactProductionDeployTranscript(error.message)}\n`,
    );
  }

  const env = {
    ...process.env,
    ...fileEnv,
  };
  const { issues, apiOrigin, emailDomain } = validateEnv(env, options.expectApiOrigin);
  if (issues.length === 0) {
    const prices = await verifyStripePrices({ env, fetchImpl, issues });
    await verifyStripePortalConfiguration({ env, fetchImpl, prices, issues });
    await verifyStripeWebhook({ env, fetchImpl, apiOrigin, issues });
    await verifyResendDomain({ env, fetchImpl, emailDomain, issues });
  }

  if (issues.length > 0) {
    return result(
      1,
      '',
      [
        `Production provider check failed (${issues.length} issue${issues.length === 1 ? '' : 's'}):`,
        ...issues.map((issue) => `- ${issue}`),
        '',
      ].join('\n'),
    );
  }

  return result(
    0,
    'Production provider check passed: exact active live Stripe prices and products, safe live billing portal configuration, enabled live billing webhook endpoint with required subscription events, and verified Resend sender domain confirmed.\n',
  );
}

async function main() {
  const checkResult = await runProductionProvidersCheckFromArgs();
  if (checkResult.stdout) process.stdout.write(checkResult.stdout);
  if (checkResult.stderr) process.stderr.write(checkResult.stderr);
  process.exit(checkResult.status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
