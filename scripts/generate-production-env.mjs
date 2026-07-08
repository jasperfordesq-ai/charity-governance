#!/usr/bin/env node

// Generates a starting .env.production from .env.production.example for a human
// operator. It fills in ONLY the values that are pure high-entropy random
// secrets (which a beginner should not have to hand-craft) and deliberately
// leaves every external/provider value as its REPLACE_ME placeholder, so the
// existing `npm run check:production` gate still correctly refuses to launch
// until those real values are supplied. It never overwrites an existing file
// without --force, and it prints exactly what the operator must still provide.

import crypto from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');

// Keys this tool can safely auto-generate: opaque random secrets only.
export const AUTO_GENERATED_KEYS = ['JWT_SECRET', 'READINESS_API_KEY'];
// Keys forced to a fixed correct production value.
const FIXED_VALUES = { NODE_ENV: 'production' };

// External values the operator must supply (with where to get each). Used only
// for the human-facing summary - they are left as placeholders in the file.
export const OPERATOR_SUPPLIED_KEYS = [
  ['DATABASE_URL', 'Managed production PostgreSQL URL with sslmode=require (Step 3)'],
  ['FRONTEND_URL', 'Public HTTPS web app origin, e.g. https://app.charitypilot.ie (Step 1/4)'],
  ['NEXT_PUBLIC_API_URL', 'Public HTTPS API origin, e.g. https://api.charitypilot.ie (Step 4)'],
  ['CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL', 'Docker Compose web runtime API origin; must match NEXT_PUBLIC_API_URL (Step 4/6)'],
  ['NEXT_PUBLIC_SUPABASE_URL', 'Supabase project URL, https://<ref>.supabase.co (Step 2)'],
  ['CHARITYPILOT_WEB_NEXT_PUBLIC_SUPABASE_URL', 'Docker Compose web runtime Supabase origin; must match NEXT_PUBLIC_SUPABASE_URL (Step 2/6)'],
  ['SUPABASE_URL', 'Same Supabase project URL (Step 2)'],
  ['SUPABASE_SERVICE_ROLE_KEY', 'Supabase service role key - secret store only (Step 2)'],
  ['STRIPE_SECRET_KEY', 'Stripe live secret key from the Stripe secret store (Step 2)'],
  ['STRIPE_WEBHOOK_SECRET', 'Stripe live webhook signing secret from the Stripe dashboard (Step 2)'],
  ['NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'Stripe live publishable key from the Stripe dashboard (Step 2)'],
  ['STRIPE_ESSENTIALS_MONTHLY_PRICE_ID', 'Stripe live Essentials monthly recurring price ID (Step 2)'],
  ['STRIPE_ESSENTIALS_YEARLY_PRICE_ID', 'Stripe live Essentials yearly recurring price ID (Step 2)'],
  ['STRIPE_COMPLETE_MONTHLY_PRICE_ID', 'Stripe live Complete monthly recurring price ID (Step 2)'],
  ['STRIPE_COMPLETE_YEARLY_PRICE_ID', 'Stripe live Complete yearly recurring price ID (Step 2)'],
  ['RESEND_API_KEY', 'Resend production API key from the secret store (Step 2)'],
  ['EMAIL_FROM', 'Verified sender, e.g. noreply@charitypilot.ie (Step 2)'],
  ['ERROR_ALERT_WEBHOOK_URL', 'HTTPS incident webhook (Slack etc.) (Step 2)'],
  ['TRUSTED_PROXY_ADDRESSES', 'Reverse-proxy IP/CIDR in front of the API (Step 4)'],
  ['AUTH_COOKIE_DOMAIN', 'Shared cookie domain for split app/API hosts; use .charitypilot.ie (Step 4)'],
  ['CADDY_ACME_EMAIL', 'Operations email for Let\'s Encrypt certificate registration (Step 4)'],
  ['CHARITYPILOT_WEB_DOMAIN', 'Caddy TLS hostname for the web app; use app.charitypilot.ie (Step 4)'],
  ['CHARITYPILOT_API_DOMAIN', 'Caddy TLS hostname for the API; use api.charitypilot.ie (Step 4)'],
  ['CHARITYPILOT_API_IMAGE', 'Digest-pinned API image ref from release-image-digests.env (Step 6)'],
  ['CHARITYPILOT_WEB_IMAGE', 'Digest-pinned web image ref from release-image-digests.env (Step 6)'],
  ['CHARITYPILOT_MIGRATION_IMAGE', 'Digest-pinned migration image ref from release-image-digests.env (Step 6)'],
  ['CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL', 'Web image build API origin copied from release-image-digests.env (Step 6)'],
  ['CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_SUPABASE_URL', 'Web image build Supabase origin copied from release-image-digests.env (Step 6)'],
];

export function generateSecret() {
  // 48 random bytes -> 64 url-safe chars: high entropy, well over the 32-char floor.
  return crypto.randomBytes(48).toString('base64url');
}

/**
 * Build the .env.production content from the example, filling auto-generatable
 * secrets and fixed values, preserving comments, blank lines, and every other
 * placeholder unchanged.
 */
export function buildProductionEnv(exampleContent, makeSecret = generateSecret) {
  const lines = exampleContent.split('\n');
  const out = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=(.*?)(\r?)$/);
    if (!match) return line; // comment, blank, or non-assignment line
    const key = match[1];
    const lineEnding = match[3];
    if (AUTO_GENERATED_KEYS.includes(key)) return `${key}=${makeSecret()}${lineEnding}`;
    if (Object.prototype.hasOwnProperty.call(FIXED_VALUES, key)) return `${key}=${FIXED_VALUES[key]}${lineEnding}`;
    return line; // leave everything else (incl. REPLACE_ME placeholders) untouched
  });
  return out.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const examplePath = join(repoRoot, '.env.production.example');
  const targetPath = join(repoRoot, '.env.production');

  if (!existsSync(examplePath)) {
    console.error('Cannot find .env.production.example at the repository root.');
    process.exit(1);
  }

  if (existsSync(targetPath) && !force) {
    console.error('.env.production already exists. Refusing to overwrite. Re-run with --force to replace it.');
    process.exit(1);
  }

  const content = buildProductionEnv(readFileSync(examplePath, 'utf8'));
  writeFileSync(targetPath, content, { mode: 0o600 });

  console.log('Created .env.production (gitignored - never commit it).');
  console.log('');
  console.log(`Auto-generated for you: ${AUTO_GENERATED_KEYS.join(', ')} (high-entropy secrets) and NODE_ENV=production.`);
  console.log('');
  console.log('You still need to fill in these real values (see docs/LAUNCH-GUIDE.md):');
  for (const [key, hint] of OPERATOR_SUPPLIED_KEYS) {
    console.log(`  - ${key}: ${hint}`);
  }
  console.log('');
  console.log('When done, verify with:');
  console.log('  npm run check:production -- --production-env-file=.env.production');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
