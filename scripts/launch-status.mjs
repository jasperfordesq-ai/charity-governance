#!/usr/bin/env node

// "Where am I, and what do I do next?" for the launch process. It inspects local
// state only (no secrets, no network) and prints the current phase plus the
// single next action. It deliberately does not claim the platform is launch-ready
// — the external gates (hosting, legal, pentest, sign-off) live in
// docs/LAUNCH-GUIDE.md and docs/production-launch-checklist.md.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');

function placeholderKeys(envContent) {
  const keys = [];
  for (const line of envContent.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && /REPLACE_ME/.test(m[2])) keys.push(m[1]);
  }
  return keys;
}

/**
 * Decide the current launch phase from local state.
 * @param {{ envExists: boolean, envContent?: string }} state
 */
export function assessLaunchState(state) {
  if (!state.envExists) {
    return {
      phase: 'NO_ENV',
      headline: 'You have not created a production environment file yet.',
      remainingKeys: [],
      nextActions: [
        'Run:  npm run setup:production-env',
        'It creates .env.production and auto-generates the secret values for you.',
        'Read docs/LAUNCH-GUIDE.md for the provider accounts you will need.',
      ],
    };
  }

  const remainingKeys = placeholderKeys(state.envContent ?? '');
  if (remainingKeys.length > 0) {
    return {
      phase: 'ENV_INCOMPLETE',
      headline: `.env.production exists but ${remainingKeys.length} value(s) still need real data.`,
      remainingKeys,
      nextActions: [
        'Open .env.production and replace each REPLACE_ME value listed below.',
        'docs/LAUNCH-GUIDE.md says where each value comes from (Stripe, Supabase, domain, hosting).',
        'Then run:  npm run check:production -- --production-env-file=.env.production',
      ],
    };
  }

  return {
    phase: 'ENV_COMPLETE',
    headline: '.env.production has no remaining placeholders. Validate it next.',
    remainingKeys: [],
    nextActions: [
      'Run:  npm run check:production -- --production-env-file=.env.production',
      'If it passes, follow docs/production-runbook.md to deploy.',
      'Remember the non-code gates in docs/production-launch-checklist.md:',
      '  legal policy approval, external penetration test, and the four sign-offs.',
    ],
  };
}

function main() {
  const envPath = join(repoRoot, '.env.production');
  const envExists = existsSync(envPath);
  const state = assessLaunchState({
    envExists,
    envContent: envExists ? readFileSync(envPath, 'utf8') : '',
  });

  console.log('CharityPilot launch status');
  console.log('==========================');
  console.log('');
  console.log(state.headline);
  console.log('');
  if (state.remainingKeys.length > 0) {
    console.log('Values still needed:');
    for (const key of state.remainingKeys) console.log(`  - ${key}`);
    console.log('');
  }
  console.log('Next:');
  for (const action of state.nextActions) console.log(`  ${action}`);
  console.log('');
  console.log('Full map: docs/LAUNCH-GUIDE.md');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
