#!/usr/bin/env node

import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { canonicalOriginIssue, isApprovedCharityPilotHostname } from './production-hostnames.mjs';
import { redactProductionDeployTranscript } from './production-deploy-preflight.mjs';

const DEFAULT_MIN_TLS_DAYS = 14;

function usage() {
  return [
    'Usage: node scripts/check-production-hosting.mjs --production-env-file <path> [--min-tls-days <days>]',
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
    minTlsDays: DEFAULT_MIN_TLS_DAYS,
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
    if (arg === '--min-tls-days') {
      const value = argv[index + 1];
      if (!value) throw new Error('--min-tls-days requires a value');
      options.minTlsDays = parsePositiveInteger(value, '--min-tls-days');
      index += 1;
      continue;
    }
    if (arg.startsWith('--min-tls-days=')) {
      options.minTlsDays = parsePositiveInteger(arg.slice('--min-tls-days='.length), '--min-tls-days');
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

function envList(value) {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function originFor(name, value, issues, role) {
  if (!value?.trim()) {
    issues.push(`${name} is required for production hosting checks`);
    return null;
  }

  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.origin !== value.trim().replace(/\/+$/, '')) {
      issues.push(`${name} must be an origin-only HTTPS URL`);
      return null;
    }
    if (!isApprovedCharityPilotHostname(url.hostname)) {
      issues.push(`${name} must use an approved CharityPilot production hostname`);
      return null;
    }
    const issue = canonicalOriginIssue(name, url.origin, role);
    if (issue) {
      issues.push(issue);
      return null;
    }
    return url.origin;
  } catch {
    issues.push(`${name} must be a valid URL`);
    return null;
  }
}

function hostingConfig(env) {
  const issues = [];
  const origins = [];
  for (const [index, value] of envList(env.FRONTEND_URL ?? '').entries()) {
    const origin = originFor(index === 0 ? 'FRONTEND_URL' : `FRONTEND_URL[${index}]`, value, issues, 'web');
    if (origin) origins.push({ label: index === 0 ? 'web origin' : `web origin ${index + 1}`, origin });
  }
  const apiOrigin = originFor('NEXT_PUBLIC_API_URL', env.NEXT_PUBLIC_API_URL ?? '', issues, 'api');
  if (apiOrigin) origins.push({ label: 'API health', origin: apiOrigin, path: '/api/v1/health' });

  const unique = [];
  const seen = new Set();
  for (const entry of origins) {
    if (seen.has(`${entry.origin}${entry.path ?? '/'}`)) continue;
    seen.add(`${entry.origin}${entry.path ?? '/'}`);
    unique.push(entry);
  }
  return { issues, origins: unique };
}

function isPublicIp(address) {
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && parts[2] === 2) return false;
    if (a === 198 && b === 51 && parts[2] === 100) return false;
    if (a === 203 && b === 0 && parts[2] === 113) return false;
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

async function defaultInspectTlsCertificate(origin) {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: url.hostname,
      port: Number(url.port || 443),
      servername: url.hostname,
      timeout: 8000,
    });

    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      const validTo = cert?.valid_to ? new Date(cert.valid_to).toISOString() : '';
      resolve({
        authorized: socket.authorized,
        authorizationError: socket.authorizationError ? String(socket.authorizationError) : '',
        validTo,
      });
      socket.end();
    });
    socket.once('timeout', () => {
      socket.destroy(new Error('TLS connection timed out'));
    });
    socket.once('error', reject);
  });
}

function daysUntil(value, now) {
  const expiry = Date.parse(value ?? '');
  if (!Number.isFinite(expiry)) return -Infinity;
  return (expiry - now()) / 86_400_000;
}

function requireHeader(response, name, pattern, issues, label) {
  const value = response.headers.get(name) ?? '';
  if (!pattern.test(value)) {
    issues.push(`${label} must include ${name}`);
  }
}

function requireSecurityHeaders(response, issues, label) {
  requireHeader(response, 'strict-transport-security', /max-age=/i, issues, label);
  requireHeader(response, 'x-content-type-options', /^nosniff$/i, issues, label);
  requireHeader(response, 'x-frame-options', /^DENY$/i, issues, label);
  requireHeader(response, 'referrer-policy', /strict-origin-when-cross-origin/i, issues, label);
  requireHeader(response, 'permissions-policy', /camera=\(\).*microphone=\(\).*geolocation=\(\).*payment=\(\)/i, issues, label);
  requireHeader(response, 'content-security-policy', /frame-ancestors 'none'/i, issues, label);
}

async function checkOrigin({ entry, resolveHost, inspectTlsCertificate, fetchImpl, minTlsDays, now }) {
  const issues = [];
  const url = new URL(entry.origin);
  const label = entry.label;
  const addresses = await resolveHost(url.hostname);
  if (!Array.isArray(addresses) || addresses.length === 0) {
    issues.push(`${url.hostname} DNS must resolve`);
  } else if (addresses.some((record) => !isPublicIp(record.address))) {
    issues.push(`${url.hostname} DNS must resolve only to public IP addresses`);
  }

  const tlsResult = await inspectTlsCertificate(entry.origin);
  if (tlsResult.authorized !== true) {
    issues.push(`${url.hostname} TLS certificate is not authorized${tlsResult.authorizationError ? `: ${tlsResult.authorizationError}` : ''}`);
  }
  if (daysUntil(tlsResult.validTo, now) < minTlsDays) {
    issues.push(`${url.hostname} TLS certificate must be valid for at least ${minTlsDays} days`);
  }

  const requestUrl = `${entry.origin}${entry.path ?? '/'}`;
  const response = await fetchImpl(requestUrl, { method: 'GET' });
  if (!response?.ok) {
    issues.push(`${label} must return 2xx: ${response?.status ?? 'unknown'}`);
  } else {
    requireSecurityHeaders(response, issues, label);
  }

  return issues;
}

export async function runProductionHostingCheckFromArgs(
  args = process.argv.slice(2),
  {
    fetchImpl = globalThis.fetch,
    resolveHost = defaultResolveHost,
    inspectTlsCertificate = defaultInspectTlsCertificate,
    now = Date.now,
  } = {},
) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    return result(2, '', `${usage()}${error.message}\n`);
  }

  if (typeof fetchImpl !== 'function') {
    return result(1, '', 'Production hosting check failed: fetch is not available in this runtime.\n');
  }

  let env;
  try {
    env = parseEnvFile(options.productionEnvFile);
  } catch (error) {
    const message = redactProductionDeployTranscript(error instanceof Error ? error.message : String(error));
    return result(1, '', `Production hosting check failed: ${message}\n`);
  }

  const config = hostingConfig(env);
  if (config.issues.length > 0) {
    return result(
      1,
      '',
      [
        `Production hosting check failed (${config.issues.length} issue${config.issues.length === 1 ? '' : 's'}):`,
        ...config.issues.map((issue) => `- ${issue}`),
        '',
      ].join('\n'),
    );
  }

  const issues = [];
  try {
    for (const entry of config.origins) {
      issues.push(...await checkOrigin({
        entry,
        resolveHost,
        inspectTlsCertificate,
        fetchImpl,
        minTlsDays: options.minTlsDays,
        now,
      }));
    }
  } catch (error) {
    const message = redactProductionDeployTranscript(error instanceof Error ? error.message : String(error));
    issues.push(`hosting check request failed: ${message}`);
  }

  if (issues.length > 0) {
    return result(
      1,
      '',
      [
        `Production hosting check failed (${issues.length} issue${issues.length === 1 ? '' : 's'}):`,
        ...issues.map((issue) => `- ${issue}`),
        '',
      ].join('\n'),
    );
  }

  return result(
    0,
    `Production hosting check passed: ${config.origins.length} HTTPS origin(s) resolved publicly, served authorized TLS, responded over HTTPS, and included baseline security headers.\n`,
  );
}

async function main() {
  const checkResult = await runProductionHostingCheckFromArgs();
  if (checkResult.stdout) process.stdout.write(checkResult.stdout);
  if (checkResult.stderr) process.stderr.write(checkResult.stderr);
  process.exit(checkResult.status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
