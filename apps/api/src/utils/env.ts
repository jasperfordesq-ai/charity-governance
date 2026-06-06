import { AppError } from './errors.js';
import { parsePort } from './port.js';

const PLACEHOLDER_PATTERNS = [
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
] as const;

export function isConfiguredSecret(value: string | undefined): value is string {
  if (!value?.trim()) return false;
  return !PLACEHOLDER_PATTERNS.some((placeholder) => value.includes(placeholder));
}

function requireConfiguredEnv(name: string, issues: string[]): string | undefined {
  const value = process.env[name];
  if (!isConfiguredSecret(value)) {
    issues.push(`${name} is missing or still contains a placeholder value`);
    return undefined;
  }
  return value;
}

function requireUrl(name: string, issues: string[], options: { requireHttps?: boolean } = {}) {
  const value = requireConfiguredEnv(name, issues);
  if (!value) return;

  try {
    const url = new URL(value);
    if (options.requireHttps && url.protocol !== 'https:') {
      issues.push(`${name} must use https:// in production`);
    }
    if (isLocalHost(url.hostname)) {
      issues.push(`${name} must not point at localhost in production`);
    }
  } catch {
    issues.push(`${name} must be a valid URL`);
  }
}

function isLocalHost(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(normalizedHostname);
}

function requireDatabaseUrl(name: string, issues: string[]) {
  const value = requireConfiguredEnv(name, issues);
  if (!value) return;

  try {
    const url = new URL(value);
    if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
      issues.push(`${name} must use a PostgreSQL connection URL`);
    }
    if (isLocalHost(url.hostname)) {
      issues.push(`${name} must not point at localhost in production`);
    }
  } catch {
    issues.push(`${name} must be a valid PostgreSQL connection URL`);
  }
}

function requirePrefix(name: string, prefix: string, label: string, issues: string[]) {
  const value = requireConfiguredEnv(name, issues);
  if (value && !value.startsWith(prefix)) {
    issues.push(`${name} must use a ${label} in production`);
  }
}

function requireMinLength(name: string, minLength: number, issues: string[]) {
  const value = requireConfiguredEnv(name, issues);
  if (value && value.length < minLength) {
    issues.push(`${name} must be at least ${minLength} characters`);
  }
}

export function validateProductionEnv(): void {
  if (process.env.NODE_ENV !== 'production') return;

  const issues: string[] = [];

  try {
    requireConfiguredEnv('PORT', issues);
    parsePort(process.env.PORT, 3002);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : 'PORT must be an integer from 1 to 65535');
  }

  requireDatabaseUrl('DATABASE_URL', issues);
  requireMinLength('JWT_SECRET', 32, issues);
  requireUrl('FRONTEND_URL', issues, { requireHttps: true });

  requirePrefix('STRIPE_SECRET_KEY', 'sk_live_', 'live Stripe secret key', issues);
  requireConfiguredEnv('STRIPE_WEBHOOK_SECRET', issues);
  requireConfiguredEnv('STRIPE_ESSENTIALS_MONTHLY_PRICE_ID', issues);
  requireConfiguredEnv('STRIPE_ESSENTIALS_YEARLY_PRICE_ID', issues);
  requireConfiguredEnv('STRIPE_COMPLETE_MONTHLY_PRICE_ID', issues);
  requireConfiguredEnv('STRIPE_COMPLETE_YEARLY_PRICE_ID', issues);

  requireConfiguredEnv('RESEND_API_KEY', issues);
  requireConfiguredEnv('EMAIL_FROM', issues);

  requireUrl('SUPABASE_URL', issues, { requireHttps: true });
  requireConfiguredEnv('SUPABASE_SERVICE_ROLE_KEY', issues);
  requireConfiguredEnv('SUPABASE_STORAGE_BUCKET', issues);

  if (issues.length) {
    throw new AppError(
      500,
      'PRODUCTION_ENV_INVALID',
      'Production environment is not ready',
      issues,
    );
  }
}
