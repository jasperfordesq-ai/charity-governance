#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import {
  CANONICAL_PRODUCTION_API_ORIGIN,
  CANONICAL_PRODUCTION_WEB_ORIGIN,
} from './production-hostnames.mjs';

const USAGE_TEXT = 'Usage: node scripts/check-deployed-browser-qa-env.mjs [--json]';
const SECRET_PLACEHOLDER_PATTERN = /(?:secret_store|replace_me|change-me|your_|your-|todo|tbd|pending|placeholder)/i;

function result(status, stdout = '', stderr = '') {
  return { status, stdout, stderr };
}

function jsonResult(status, payload) {
  return result(status, `${JSON.stringify(payload, null, 2)}\n`, '');
}

function parseArgs(argv) {
  const options = { json: false };
  for (const arg of argv) {
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      return { ...options, help: true };
    }
    return { error: `Unknown option: ${arg}` };
  }
  return options;
}

function trimmed(env, key) {
  return String(env[key] ?? '').trim();
}

function looksLikePlaceholderSecret(value) {
  return SECRET_PLACEHOLDER_PATTERN.test(String(value ?? ''));
}

function requireCanonicalOrigin({ env, key, expected, label, issues }) {
  const value = trimmed(env, key);
  if (!value) {
    issues.push(`${key} must be supplied for deployed browser QA.`);
    return null;
  }

  try {
    const url = new URL(value);
    const originOnly = url.origin === value.replace(/\/+$/, '');
    if (url.protocol !== 'https:' || !originOnly || url.origin !== expected) {
      issues.push(`${key} must be the canonical deployed ${label} origin ${expected}.`);
      return null;
    }
    return url.origin;
  } catch {
    issues.push(`${key} must be a valid canonical deployed ${label} origin ${expected}.`);
    return null;
  }
}

function collectIssues(env) {
  const issues = [];
  if (trimmed(env, 'E2E_DEPLOYED_QA') !== 'true') {
    issues.push('E2E_DEPLOYED_QA must be true before deployed browser QA runs.');
  }

  const webUrl = requireCanonicalOrigin({
    env,
    key: 'E2E_WEB_URL',
    expected: CANONICAL_PRODUCTION_WEB_ORIGIN,
    label: 'web',
    issues,
  });
  const apiUrl = requireCanonicalOrigin({
    env,
    key: 'E2E_API_URL',
    expected: CANONICAL_PRODUCTION_API_ORIGIN,
    label: 'API',
    issues,
  });

  const ownerEmail = trimmed(env, 'E2E_OWNER_EMAIL');
  const ownerPassword = trimmed(env, 'E2E_OWNER_PASSWORD');
  let credentialsReady = true;

  if (!ownerEmail) {
    issues.push('E2E_OWNER_EMAIL must be supplied from the approved non-sensitive test workspace secret store.');
    credentialsReady = false;
  } else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail) || looksLikePlaceholderSecret(ownerEmail)) {
    issues.push('E2E_OWNER_EMAIL must come from the approved non-sensitive test workspace secret store.');
    credentialsReady = false;
  }
  if (!ownerPassword) {
    issues.push('E2E_OWNER_PASSWORD must be supplied from the approved non-sensitive test workspace secret store.');
    credentialsReady = false;
  } else if (looksLikePlaceholderSecret(ownerPassword)) {
    issues.push('E2E_OWNER_PASSWORD must come from the approved non-sensitive test workspace secret store.');
    credentialsReady = false;
  }

  return { issues, webUrl, apiUrl, credentialsReady };
}

function payloadFor(env, issues, webUrl, apiUrl, credentialsReady) {
  return {
    ok: issues.length === 0,
    issueCount: issues.length,
    issues,
    webUrl,
    apiUrl,
    credentialsPresent: credentialsReady === true,
    requiredEnvironment: [
      'E2E_DEPLOYED_QA=true',
      `E2E_WEB_URL=${CANONICAL_PRODUCTION_WEB_ORIGIN}`,
      `E2E_API_URL=${CANONICAL_PRODUCTION_API_ORIGIN}`,
      'E2E_OWNER_EMAIL from the approved non-sensitive test workspace secret store',
      'E2E_OWNER_PASSWORD from the approved non-sensitive test workspace secret store',
    ],
    recommendedCommands: [
      'npm run test:e2e:responsive',
      'npm run test:e2e -- tests/accessibility.spec.ts',
      'npm run test:e2e:deployed:responsive:cross-browser',
      'npm run test:e2e:deployed:accessibility:cross-browser',
    ],
    evidenceTarget: 'Record redacted transcripts under browserQa.checks.* in the launch evidence ledger.',
    secretValuesPrinted: false,
  };
}

function renderText(payload) {
  if (!payload.ok) {
    return [
      `Deployed browser QA environment preflight failed (${payload.issueCount} issue${payload.issueCount === 1 ? '' : 's'}):`,
      ...payload.issues.map((issue) => `- ${issue}`),
      '',
      'Required environment:',
      ...payload.requiredEnvironment.map((entry) => `- ${entry}`),
      '',
    ].join('\n');
  }

  return [
    'Deployed browser QA environment preflight passed.',
    `Web origin: ${payload.webUrl}`,
    `API origin: ${payload.apiUrl}`,
    'Credentials: present (values not printed).',
    'Recommended deployed QA commands:',
    ...payload.recommendedCommands.map((command) => `- ${command}`),
    `Evidence target: ${payload.evidenceTarget}`,
    '',
  ].join('\n');
}

export function runDeployedBrowserQaEnvCheckFromArgs(args = process.argv.slice(2), { env = process.env } = {}) {
  const options = parseArgs(args);
  if (options.error) return result(2, '', `${USAGE_TEXT}\n${options.error}\n`);
  if (options.help) return result(0, `${USAGE_TEXT}\n`, '');

  const { issues, webUrl, apiUrl, credentialsReady } = collectIssues(env);
  const payload = payloadFor(env, issues, webUrl, apiUrl, credentialsReady);
  if (options.json) return jsonResult(payload.ok ? 0 : 1, payload);
  return payload.ok ? result(0, renderText(payload), '') : result(1, '', renderText(payload));
}

function main() {
  const checkResult = runDeployedBrowserQaEnvCheckFromArgs();
  process.stdout.write(checkResult.stdout);
  process.stderr.write(checkResult.stderr);
  process.exitCode = checkResult.status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
