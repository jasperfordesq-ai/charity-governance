#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { redactProductionDeployTranscript } from './production-deploy-preflight.mjs';
import { canonicalOriginIssue, isApprovedCharityPilotHostname } from './production-hostnames.mjs';

const stripePriceEnvNames = [
  'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID',
  'STRIPE_ESSENTIALS_YEARLY_PRICE_ID',
  'STRIPE_COMPLETE_MONTHLY_PRICE_ID',
  'STRIPE_COMPLETE_YEARLY_PRICE_ID',
];

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
      options.productionEnvFile = arg.slice('--production-env-file='.length);
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
      options.expectApiOrigin = arg.slice('--expect-api-origin='.length);
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
  for (const envName of stripePriceEnvNames) {
    if (!isConfigured(env[envName]) || !env[envName].startsWith('price_')) {
      issues.push(`${envName} must use a Stripe price ID`);
    }
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
    const errorMessage = redactProductionDeployTranscript(
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

function priceIssues(envName, price) {
  const issues = [];
  if (price?.object !== 'price') {
    issues.push(`${envName} lookup did not return a Stripe price object`);
    return issues;
  }
  if (price.active !== true) {
    issues.push(`${envName} must be active`);
  }
  if (price.livemode !== true) {
    issues.push(`${envName} must be live mode`);
  }
  if (!price.recurring) {
    issues.push(`${envName} must be recurring`);
  }
  return issues;
}

async function verifyStripePrices({ env, fetchImpl, issues }) {
  for (const envName of stripePriceEnvNames) {
    const price = await fetchJson(
      fetchImpl,
      `https://api.stripe.com/v1/prices/${encodeURIComponent(env[envName])}`,
      { method: 'GET', headers: stripeHeaders(env.STRIPE_SECRET_KEY) },
      `${envName} Stripe price lookup`,
      issues,
    );
    if (price) {
      issues.push(...priceIssues(envName, price));
    }
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
    await verifyStripePrices({ env, fetchImpl, issues });
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
    'Production provider check passed: active live recurring Stripe prices, enabled live billing webhook endpoint with required subscription events, and verified Resend sender domain confirmed.\n',
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
