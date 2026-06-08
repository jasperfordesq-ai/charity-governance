#!/usr/bin/env node

import { lookup as dnsLookup } from 'node:dns/promises';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 5000;

function usage() {
  return [
    'Usage: node scripts/check-production-observability.mjs --production-env-file <path> [--timeout-ms <milliseconds>]',
    '',
  ].join('\n');
}

function result(status, stdout = '', stderr = '') {
  return { status, stdout, stderr };
}

function parsePositiveInteger(value, flagName) {
  if (!/^[1-9]\d*$/.test(value ?? '')) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  return Number(value);
}

function parseArgs(argv) {
  const options = {
    productionEnvFile: '.env.production',
    timeoutMs: DEFAULT_TIMEOUT_MS,
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
    if (arg === '--timeout-ms') {
      const value = argv[index + 1];
      if (!value) throw new Error('--timeout-ms requires a value');
      options.timeoutMs = parsePositiveInteger(value, '--timeout-ms');
      index += 1;
      continue;
    }
    if (arg.startsWith('--timeout-ms=')) {
      options.timeoutMs = parsePositiveInteger(arg.slice('--timeout-ms='.length), '--timeout-ms');
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
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
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
  return typeof value === 'string' && value.trim().length > 0 && !/REPLACE_ME|TODO|TBD|placeholder/i.test(value);
}

function normaliseHostname(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isLocalHostname(hostname) {
  const normalized = normaliseHostname(hostname);
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '0.0.0.0' ||
    normalized === '::1' ||
    normalized === 'host.docker.internal' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal') ||
    normalized.endsWith('.lan') ||
    normalized.endsWith('.home')
  );
}

function isReservedDocumentationHostname(hostname) {
  const normalized = normaliseHostname(hostname);
  return (
    normalized === 'example.com' ||
    normalized === 'example.net' ||
    normalized === 'example.org' ||
    normalized.endsWith('.example') ||
    normalized.endsWith('.example.com') ||
    normalized.endsWith('.example.net') ||
    normalized.endsWith('.example.org') ||
    normalized.endsWith('.test') ||
    normalized.endsWith('.invalid')
  );
}

function parseWebhookUrl(value, issues) {
  if (!isConfigured(value)) {
    issues.push('ERROR_ALERT_WEBHOOK_URL is missing or still contains a placeholder value');
    return null;
  }

  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:') {
      issues.push('ERROR_ALERT_WEBHOOK_URL must use https for production observability checks');
    }
    if (isLocalHostname(url.hostname)) {
      issues.push('ERROR_ALERT_WEBHOOK_URL must not point at localhost or private hostnames in production');
    }
    if (isReservedDocumentationHostname(url.hostname)) {
      issues.push('ERROR_ALERT_WEBHOOK_URL must not use a reserved documentation hostname');
    }
    return url;
  } catch {
    issues.push('ERROR_ALERT_WEBHOOK_URL must be a valid URL');
    return null;
  }
}

function isPublicIp(address) {
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    const [a, b, c] = parts;
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && c === 2) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    if (a === 169 && b === 254) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a >= 224) return false;
    return true;
  }

  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    if (
      normalized === '::1' ||
      normalized.startsWith('2001:db8:') ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80:') ||
      normalized.startsWith('::ffff:10.') ||
      normalized.startsWith('::ffff:127.') ||
      normalized.startsWith('::ffff:192.168.')
    ) {
      return false;
    }
    return true;
  }

  return false;
}

async function defaultResolveHost(hostname) {
  return dnsLookup(hostname, { all: true });
}

function buildTestAlertPayload(now) {
  return {
    service: 'charitypilot-api',
    environment: 'production',
    severity: 'error',
    method: 'CHECK',
    url: '/production/observability-check',
    statusCode: 500,
    code: 'PRODUCTION_OBSERVABILITY_CHECK',
    errorName: 'ProductionObservabilityCheck',
    requestId: 'production-observability-check',
    timestamp: now(),
  };
}

function redactedWebhook(url) {
  return `${url.origin}${url.pathname ? '/...' : ''}`;
}

async function verifyPublicDns(url, resolveHost, issues) {
  let addresses;
  try {
    addresses = await resolveHost(url.hostname);
  } catch {
    issues.push(`${url.hostname} DNS must resolve`);
    return;
  }

  if (!Array.isArray(addresses) || addresses.length === 0) {
    issues.push(`${url.hostname} DNS must resolve`);
  } else if (addresses.some((record) => !isPublicIp(record.address))) {
    issues.push(`${url.hostname} DNS must resolve only to public IP addresses`);
  }
}

async function postTestAlert({ fetchImpl, url, timeoutMs, now }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(url.href, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildTestAlertPayload(now)),
      redirect: 'error',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function runProductionObservabilityCheckFromArgs(
  args = process.argv.slice(2),
  {
    fetchImpl = globalThis.fetch,
    resolveHost = defaultResolveHost,
    now = () => new Date().toISOString(),
  } = {},
) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    return result(2, '', `${usage()}${error.message}\n`);
  }

  if (typeof fetchImpl !== 'function') {
    return result(1, '', 'Production observability check failed: fetch is not available in this runtime.\n');
  }

  let env;
  try {
    env = parseEnvFile(resolve(process.cwd(), options.productionEnvFile));
  } catch (error) {
    return result(1, '', `Production observability check failed: ${error.message}\n`);
  }

  const issues = [];
  const webhookUrl = parseWebhookUrl(env.ERROR_ALERT_WEBHOOK_URL, issues);
  if (!webhookUrl || issues.length > 0) {
    return result(1, '', `Production observability check failed (${issues.length} issue${issues.length === 1 ? '' : 's'}):\n- ${issues.join('\n- ')}\n`);
  }

  await verifyPublicDns(webhookUrl, resolveHost, issues);
  if (issues.length === 0) {
    try {
      const response = await postTestAlert({ fetchImpl, url: webhookUrl, timeoutMs: options.timeoutMs, now });
      if (!response?.ok) {
        issues.push(`test alert webhook request failed with HTTP ${response?.status ?? 'unknown'}`);
      }
    } catch (error) {
      issues.push(`test alert webhook request failed: ${error instanceof Error ? error.name : 'unknown error'}`);
    }
  }

  if (issues.length > 0) {
    return result(1, '', `Production observability check failed (${issues.length} issue${issues.length === 1 ? '' : 's'}):\n- ${issues.join('\n- ')}\n`);
  }

  return result(
    0,
    `Production observability check passed: sent sanitized test alert to ${redactedWebhook(webhookUrl)}.\n`,
    '',
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const checkResult = await runProductionObservabilityCheckFromArgs();
  if (checkResult.stdout) process.stdout.write(checkResult.stdout);
  if (checkResult.stderr) process.stderr.write(checkResult.stderr);
  process.exit(checkResult.status);
}
