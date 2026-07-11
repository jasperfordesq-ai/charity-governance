#!/usr/bin/env node

import { randomBytes as defaultRandomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_BUCKET = 'documents';
const PROBE_BODY = 'CharityPilot production storage probe\n';
const SAMPLE_SUPABASE_PROJECT_REF_PATTERN = /^(?:configured-project|example|ci-project|test-project|demo-project|sample-project)$/i;

function usage() {
  return [
    'Usage: node scripts/check-production-supabase.mjs --production-env-file <path>',
    '',
  ].join('\n');
}

function result(status, stdout = '', stderr = '') {
  return { status, stdout, stderr };
}

function parseArgs(argv) {
  const options = {
    productionEnvFile: '.env.production',
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
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    !/REPLACE_ME|change-me|your_|your-|project_ref|TODO|TBD|placeholder|secret[-_]?store/i.test(value)
  );
}

function validateEnv(env) {
  const issues = [];
  if (!isConfigured(env.SUPABASE_URL)) {
    issues.push('SUPABASE_URL must be configured for the production Supabase project');
  } else {
    try {
      const url = new URL(env.SUPABASE_URL);
      if (url.protocol !== 'https:' || !url.hostname.endsWith('.supabase.co')) {
        issues.push('SUPABASE_URL must be an HTTPS Supabase project URL');
      } else {
        const projectRef = url.hostname.toLowerCase().slice(0, -'.supabase.co'.length);
        if (SAMPLE_SUPABASE_PROJECT_REF_PATTERN.test(projectRef)) {
          issues.push('SUPABASE_URL must not use a sample Supabase project ref');
        }
      }
    } catch {
      issues.push('SUPABASE_URL must be a valid URL');
    }
  }
  if (!isConfigured(env.SUPABASE_SERVICE_ROLE_KEY)) {
    issues.push('SUPABASE_SERVICE_ROLE_KEY must be configured for a trusted production shell');
  }
  if (!isConfigured(env.SUPABASE_STORAGE_BUCKET)) {
    issues.push('SUPABASE_STORAGE_BUCKET must be configured for the private document bucket');
  }

  return issues;
}

function joinUrl(origin, path) {
  return `${origin.replace(/\/+$/, '')}${path}`;
}

export function redactSupabaseTranscript(value) {
  return String(value)
    .replace(/\b(SUPABASE_SERVICE_ROLE_KEY=)[^\s'")]+/gi, '$1[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/apikey[=:]\s*[A-Za-z0-9._~+/=-]+/gi, 'apikey=[redacted]')
    .replace(/([?&](?:token|signature|apikey|access_token|refresh_token)=)[^&\s'")]+/gi, '$1[redacted]')
    .replace(/\/storage\/v1\/object\/(?:sign|public)?\/?[^?\s'")]+/gi, '/storage/v1/object/[redacted]')
    .replace(/charitypilot-production-check\/[A-Za-z0-9._~:/=-]+/gi, 'charitypilot-production-check/[redacted]');
}

function encodeStoragePath(path) {
  return path.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function authHeaders(serviceRoleKey, extra = {}) {
  return {
    Authorization: `Bearer ${serviceRoleKey}`,
    apikey: serviceRoleKey,
    ...extra,
  };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function statusIssue(step, response) {
  return `${step} failed with HTTP ${response.status}`;
}

async function checkStatus(step, response, issues) {
  if (!response?.ok) {
    issues.push(statusIssue(step, response ?? { status: 'unknown' }));
    return null;
  }
  return readJson(response);
}

function makeProbePath({ now, randomBytes }) {
  const random = typeof randomBytes === 'function'
    ? randomBytes(6).toString('hex')
    : defaultRandomBytes(6).toString('hex');
  return `charitypilot-production-check/${now()}-${random}.txt`;
}

async function deleteProbe({ fetchImpl, origin, bucket, encodedPath, serviceRoleKey }, issues) {
  const deleteResponse = await fetchImpl(joinUrl(origin, `/storage/v1/object/${bucket}/${encodedPath}`), {
    method: 'DELETE',
    headers: authHeaders(serviceRoleKey),
  });
  if (!deleteResponse?.ok) {
    issues.push(statusIssue('probe cleanup', deleteResponse ?? { status: 'unknown' }));
  }
}

async function runSupabaseProbe({
  env,
  fetchImpl,
  now,
  randomBytes,
}) {
  const issues = [];
  const origin = new URL(env.SUPABASE_URL).origin;
  const bucket = env.SUPABASE_STORAGE_BUCKET || DEFAULT_BUCKET;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const probePath = makeProbePath({ now, randomBytes });
  const encodedPath = encodeStoragePath(probePath);
  let uploaded = false;

  const bucketResponse = await fetchImpl(joinUrl(origin, `/storage/v1/bucket/${encodeURIComponent(bucket)}`), {
    method: 'GET',
    headers: authHeaders(serviceRoleKey),
  });
  const bucketBody = await checkStatus('bucket metadata lookup', bucketResponse, issues);
  if (issues.length > 0) return issues;
  if (bucketBody?.public !== false) {
    issues.push(`${bucket} bucket must be private`);
    return issues;
  }

  try {
    const uploadResponse = await fetchImpl(joinUrl(origin, `/storage/v1/object/${bucket}/${encodedPath}`), {
      method: 'POST',
      headers: authHeaders(serviceRoleKey, {
        'content-type': 'text/plain',
        'x-upsert': 'false',
      }),
      body: PROBE_BODY,
    });
    await checkStatus('probe upload', uploadResponse, issues);
    if (issues.length > 0) return issues;
    uploaded = true;

    const authenticatedDownload = await fetchImpl(joinUrl(origin, `/storage/v1/object/${bucket}/${encodedPath}`), {
      method: 'GET',
      headers: authHeaders(serviceRoleKey, { 'cache-control': 'no-store' }),
    });
    if (!authenticatedDownload?.ok) {
      issues.push(statusIssue('service-role probe download', authenticatedDownload ?? { status: 'unknown' }));
    } else {
      const downloadedBody = await authenticatedDownload.text();
      if (downloadedBody !== PROBE_BODY) {
        issues.push('service-role probe download returned unexpected bytes');
      }
    }
    if (issues.length > 0) return issues;

    const publicResponse = await fetchImpl(joinUrl(origin, `/storage/v1/object/public/${bucket}/${encodedPath}`), {
      method: 'GET',
      headers: {},
    });
    if (publicResponse?.ok) {
      issues.push('anonymous direct access to the probe object must be denied');
    }
  } finally {
    if (uploaded) {
      await deleteProbe({ fetchImpl, origin, bucket, encodedPath, serviceRoleKey }, issues);
    }
  }

  return issues;
}

export async function runProductionSupabaseCheckFromArgs(
  args = process.argv.slice(2),
  {
    fetchImpl = globalThis.fetch,
    now = Date.now,
    randomBytes = defaultRandomBytes,
  } = {},
) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    return result(2, '', `${usage()}${error.message}\n`);
  }

  if (typeof fetchImpl !== 'function') {
    return result(1, '', 'Supabase storage check failed: fetch is not available in this runtime.\n');
  }

  let fileEnv;
  try {
    fileEnv = parseEnvFile(resolve(process.cwd(), options.productionEnvFile));
  } catch (error) {
    return result(
      1,
      '',
      `Supabase storage check failed: ${redactSupabaseTranscript(error instanceof Error ? error.message : String(error))}\n`,
    );
  }

  const env = {
    ...process.env,
    ...fileEnv,
  };
  const envIssues = validateEnv(env);
  if (envIssues.length > 0) {
    return result(
      1,
      '',
      [
        `Supabase storage check failed (${envIssues.length} issue${envIssues.length === 1 ? '' : 's'}):`,
        ...envIssues.map((issue) => `- ${issue}`),
        '',
      ].join('\n'),
    );
  }

  let issues;
  try {
    issues = await runSupabaseProbe({
      env,
      fetchImpl,
      now,
      randomBytes,
    });
  } catch (error) {
    const message = redactSupabaseTranscript(error instanceof Error ? error.message : String(error));
    issues = [`Supabase request failed: ${message}`];
  }

  if (issues.length > 0) {
    return result(
      1,
      '',
      [
        `Supabase storage check failed (${issues.length} issue${issues.length === 1 ? '' : 's'}):`,
        ...issues.map((issue) => `- ${issue}`),
        '',
      ].join('\n'),
    );
  }

  return result(
    0,
    'Production Supabase storage check passed: private bucket, service-role upload and download, anonymous access denial, and probe cleanup verified.\n',
  );
}

async function main() {
  const checkResult = await runProductionSupabaseCheckFromArgs();
  if (checkResult.stdout) process.stdout.write(checkResult.stdout);
  if (checkResult.stderr) process.stderr.write(checkResult.stderr);
  process.exit(checkResult.status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
