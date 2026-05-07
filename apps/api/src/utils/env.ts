import { AppError } from './errors.js';

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
  } catch {
    issues.push(`${name} must be a valid URL`);
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

  requireConfiguredEnv('DATABASE_URL', issues);
  requireMinLength('JWT_SECRET', 32, issues);
  requireUrl('FRONTEND_URL', issues, { requireHttps: true });

  requireConfiguredEnv('STRIPE_SECRET_KEY', issues);
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
