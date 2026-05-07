#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';

const PLACEHOLDERS = [
  'REPLACE_ME',
  'change-me',
  'your_',
  'your-',
  'sk_test_...',
  'pk_test_...',
  'whsec_...',
  'price_...',
  're_...',
  'eyJ...',
  'https://your-project.supabase.co',
];

const REQUIRED = [
  'DATABASE_URL',
  'JWT_SECRET',
  'FRONTEND_URL',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID',
  'STRIPE_ESSENTIALS_YEARLY_PRICE_ID',
  'STRIPE_COMPLETE_MONTHLY_PRICE_ID',
  'STRIPE_COMPLETE_YEARLY_PRICE_ID',
  'RESEND_API_KEY',
  'EMAIL_FROM',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_STORAGE_BUCKET',
  'NEXT_PUBLIC_API_URL',
  'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
];

function parseEnvFile(path) {
  if (!existsSync(path)) return {};

  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const index = line.indexOf('=');
        const key = line.slice(0, index).trim();
        const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
        return [key, value];
      }),
  );
}

function envValue(env, key) {
  return env[key] ?? process.env[key] ?? '';
}

function isConfigured(value) {
  return Boolean(value.trim()) && !PLACEHOLDERS.some((placeholder) => value.includes(placeholder));
}

function requireUrl(env, key, issues) {
  const value = envValue(env, key);
  if (!isConfigured(value)) return;

  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') {
      issues.push(`${key} must use https:// for production`);
    }
    if (['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname)) {
      issues.push(`${key} must not point at localhost for production`);
    }
  } catch {
    issues.push(`${key} must be a valid URL`);
  }
}

const envFileArg = process.argv.find((arg) => arg.startsWith('--env-file='));
const envFile = envFileArg ? envFileArg.slice('--env-file='.length) : '.env.production';
const env = parseEnvFile(envFile);
const issues = [];

for (const key of REQUIRED) {
  if (!isConfigured(envValue(env, key))) {
    issues.push(`${key} is missing or still contains a placeholder value`);
  }
}

for (const key of ['JWT_SECRET']) {
  const value = envValue(env, key);
  if (isConfigured(value) && value.length < 32) {
    issues.push(`${key} must be at least 32 characters`);
  }
}

requireUrl(env, 'FRONTEND_URL', issues);
requireUrl(env, 'SUPABASE_URL', issues);
requireUrl(env, 'NEXT_PUBLIC_API_URL', issues);

if (issues.length) {
  console.error(`Production preflight failed (${issues.length} issue${issues.length === 1 ? '' : 's'}):`);
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  process.exit(1);
}

console.log(`Production preflight passed using ${envFile}`);
