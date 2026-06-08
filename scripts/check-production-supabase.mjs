#!/usr/bin/env node

import { randomBytes as defaultRandomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_BUCKET = 'documents';
const DEFAULT_SIGNED_URL_TTL_SECONDS = 60;

function usage() {
  return [
    'Usage: node scripts/check-production-supabase.mjs --production-env-file <path> [--signed-url-ttl <seconds>]',
    '',
  ].join('\n');
}

function result(status, stdout = '', stderr = '') {
  return { status, stdout, stderr };
}

function parsePositiveInteger(value, flagName) {
  if (!/^[1-9]\d*$/.test(value ?? '')) {
    throw new Error(`${flagName} must be a positive integer number of seconds`);
  }
  return Number(value);
}

function parseArgs(argv) {
  const options = {
    productionEnvFile: '.env.production',
    signedUrlTtlSeconds: DEFAULT_SIGNED_URL_TTL_SECONDS,
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
    if (arg === '--signed-url-ttl') {
      const value = argv[index + 1];
      if (!value) throw new Error('--signed-url-ttl requires a value');
      options.signedUrlTtlSeconds = parsePositiveInteger(value, '--signed-url-ttl');
      index += 1;
      continue;
    }
    if (arg.startsWith('--signed-url-ttl=')) {
      options.signedUrlTtlSeconds = parsePositiveInteger(arg.slice('--signed-url-ttl='.length), '--signed-url-ttl');
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
  return typeof value === 'string' && value.trim().length > 0 && !/REPLACE_ME|TODO|TBD|placeholder/i.test(value);
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
  signedUrlTtlSeconds,
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
      body: 'CharityPilot production storage probe\n',
    });
    await checkStatus('probe upload', uploadResponse, issues);
    if (issues.length > 0) return issues;
    uploaded = true;

    const signedResponse = await fetchImpl(joinUrl(origin, `/storage/v1/object/sign/${bucket}/${encodedPath}`), {
      method: 'POST',
      headers: authHeaders(serviceRoleKey, {
        'content-type': 'application/json',
      }),
      body: JSON.stringify({ expiresIn: signedUrlTtlSeconds }),
    });
    const signedBody = await checkStatus('signed URL creation', signedResponse, issues);
    const signedUrl = signedBody?.signedURL ?? signedBody?.signedUrl;
    if (issues.length === 0 && !isConfigured(signedUrl)) {
      issues.push('signed URL creation did not return a signed URL');
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
    return result(1, '', `Supabase storage check failed: ${error.message}\n`);
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
      signedUrlTtlSeconds: options.signedUrlTtlSeconds,
    });
  } catch (error) {
    issues = [`Supabase request failed: ${error.message}`];
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
    'Production Supabase storage check passed: private bucket, service-role probe upload, signed URL creation, anonymous access denial, and probe cleanup verified.\n',
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
