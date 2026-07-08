#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { canonicalOriginIssue, isApprovedCharityPilotHostname } from './production-hostnames.mjs';
import { redactProductionDeployTranscript } from './production-deploy-preflight.mjs';

const ENV_FILE_FLAG = '--production-env-file=';
const READINESS_PATH = '/api/v1/health/readiness';
const DISALLOWED_CORS_PROBE_ORIGIN = 'https://not-charitypilot.example';
const placeholderSecretPattern = /(?:replace_me|change-me|your_|your-|todo|tbd|pending|placeholder)/i;

function usage() {
  return 'Usage: node scripts/smoke-production-deploy.mjs --production-env-file <path> [--dry-run]\n';
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    productionEnvFile: '.env.production',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--production-env-file') {
      const value = argv[index + 1];
      if (!value) throw new Error('--production-env-file requires a value');
      options.productionEnvFile = value;
      index += 1;
      continue;
    }
    if (arg.startsWith(ENV_FILE_FLAG)) {
      options.productionEnvFile = arg.slice(ENV_FILE_FLAG.length);
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

function result(status, stdout = '', stderr = '') {
  return { status, stdout, stderr };
}

function envList(value) {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function originFor(name, value, issues, role) {
  if (!value?.trim()) {
    issues.push(`${name} is required for production deploy smoke`);
    return null;
  }

  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.origin !== value.trim().replace(/\/+$/, '')) {
      issues.push(`${name} must be an origin-only HTTPS URL for production deploy smoke`);
      return null;
    }
    if (!isApprovedCharityPilotHostname(url.hostname)) {
      issues.push(`${name} must use an approved CharityPilot production hostname for production deploy smoke`);
      return null;
    }
    const issue = canonicalOriginIssue(name, url.origin, role);
    if (issue) {
      issues.push(issue);
      return null;
    }
    return url.origin;
  } catch {
    issues.push(`${name} must be a valid URL for production deploy smoke`);
    return null;
  }
}

function smokeConfig(env) {
  const issues = [];
  const webOrigin = originFor('FRONTEND_URL', envList(env.FRONTEND_URL ?? '')[0] ?? '', issues, 'web');
  const apiOrigin = originFor('NEXT_PUBLIC_API_URL', env.NEXT_PUBLIC_API_URL ?? '', issues, 'api');
  const readinessKey = env.READINESS_API_KEY?.trim() ?? '';

  if (!readinessKey || placeholderSecretPattern.test(readinessKey)) {
    issues.push('READINESS_API_KEY is required for production deploy smoke');
  }

  return { issues, webOrigin, apiOrigin, readinessKey };
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

function requireWebCspConnectsToApi(response, apiOrigin, issues) {
  const csp = response.headers.get('content-security-policy') ?? '';
  const connectSrc = csp
    .split(';')
    .map((directive) => directive.trim())
    .find((directive) => /^connect-src\b/i.test(directive));

  const allowedOrigins = connectSrc?.split(/\s+/).slice(1) ?? [];
  if (!allowedOrigins.includes(apiOrigin)) {
    issues.push(`web origin CSP connect-src must include ${apiOrigin}`);
  }
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function runSmoke({ webOrigin, apiOrigin, readinessKey, fetchImpl }) {
  const issues = [];
  const webUrl = `${webOrigin}/`;
  const healthUrl = `${apiOrigin}/api/v1/health`;
  const readinessUrl = `${apiOrigin}${READINESS_PATH}`;

  const webResponse = await fetchImpl(webUrl);
  if (!webResponse.ok) {
    issues.push(`web origin must return 2xx: ${webResponse.status}`);
  }
  requireSecurityHeaders(webResponse, issues, 'web origin');
  requireWebCspConnectsToApi(webResponse, apiOrigin, issues);

  const healthResponse = await fetchImpl(healthUrl, {
    headers: { origin: webOrigin },
  });
  if (!healthResponse.ok) {
    issues.push(`API health must return 2xx: ${healthResponse.status}`);
  }
  requireSecurityHeaders(healthResponse, issues, 'API health');
  if (healthResponse.headers.get('access-control-allow-origin') !== webOrigin) {
    issues.push('API health must allow the configured production web Origin');
  }
  if (healthResponse.headers.get('access-control-allow-credentials') !== 'true') {
    issues.push('API health must allow credentials for the configured production web Origin');
  }

  const disallowedCorsResponse = await fetchImpl(healthUrl, {
    headers: { origin: DISALLOWED_CORS_PROBE_ORIGIN },
  });
  const disallowedAllowOrigin = disallowedCorsResponse.headers.get('access-control-allow-origin');
  if (disallowedAllowOrigin === DISALLOWED_CORS_PROBE_ORIGIN || disallowedAllowOrigin === '*') {
    issues.push('API health must not allow an unapproved browser Origin');
  }

  const unauthorizedReadinessResponse = await fetchImpl(readinessUrl);
  const unauthorizedBody = await safeJson(unauthorizedReadinessResponse);
  if (unauthorizedReadinessResponse.status !== 401 || unauthorizedBody?.code !== 'READINESS_UNAUTHORIZED' || 'checks' in (unauthorizedBody ?? {})) {
    issues.push('unauthenticated readiness must return 401 without dependency checks');
  }

  const readinessResponse = await fetchImpl(readinessUrl, {
    headers: { 'x-charitypilot-readiness-key': readinessKey },
  });
  const readinessBody = await safeJson(readinessResponse);
  if (readinessResponse.status !== 200 || readinessBody?.status !== 'ready') {
    issues.push('keyed readiness must return 200 ready');
  }
  for (const check of ['database', 'billingConfigured', 'emailConfigured', 'storageConfigured', 'storageBucketReachable']) {
    if (readinessBody?.checks?.[check] !== true) {
      issues.push(`keyed readiness check ${check} must be true`);
    }
  }

  return issues;
}

export async function runProductionDeploySmokeFromArgs(
  args = process.argv.slice(2),
  {
    processEnv = process.env,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    return result(2, '', `${usage()}${error.message}\n`);
  }

  let fileEnv;
  try {
    fileEnv = parseEnvFile(options.productionEnvFile);
  } catch (error) {
    const message = redactProductionDeployTranscript(error instanceof Error ? error.message : String(error));
    return result(1, '', `Production deploy smoke failed: ${message}\n`);
  }

  const config = smokeConfig({ ...processEnv, ...fileEnv });
  if (config.issues.length > 0) {
    return result(1, '', [
      `Production deploy smoke failed (${config.issues.length} issue${config.issues.length === 1 ? '' : 's'}):`,
      ...config.issues.map((issue) => `- ${issue}`),
      '',
    ].join('\n'));
  }

  if (options.dryRun) {
    return result(0, [
      'Production deploy smoke dry-run:',
      `Web origin: ${config.webOrigin}`,
      `API origin: ${config.apiOrigin}`,
      `GET ${config.webOrigin}/`,
      `GET ${config.apiOrigin}/api/v1/health with Origin ${config.webOrigin}`,
      `GET ${config.apiOrigin}/api/v1/health with disallowed Origin ${DISALLOWED_CORS_PROBE_ORIGIN}`,
      `GET ${config.apiOrigin}${READINESS_PATH} without readiness key`,
      `GET ${config.apiOrigin}${READINESS_PATH} with readiness key`,
      '',
    ].join('\n'));
  }

  try {
    const issues = await runSmoke({ ...config, fetchImpl });
    if (issues.length > 0) {
      return result(1, '', [
        `Production deploy smoke failed (${issues.length} issue${issues.length === 1 ? '' : 's'}):`,
        ...issues.map((issue) => `- ${issue}`),
        '',
      ].join('\n'));
    }
  } catch (error) {
    const message = redactProductionDeployTranscript(error instanceof Error ? error.message : String(error));
    return result(1, '', `Production deploy smoke failed: ${message}\n`);
  }

  return result(0, 'Production deploy smoke passed: public web, API health, CORS, and keyed readiness verified.\n');
}

async function main() {
  const smokeResult = await runProductionDeploySmokeFromArgs();
  if (smokeResult.stdout) process.stdout.write(smokeResult.stdout);
  if (smokeResult.stderr) process.stderr.write(smokeResult.stderr);
  process.exit(smokeResult.status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
