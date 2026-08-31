import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// Only these files may reference NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE
// directly. Everything else must key on one of the capability axes in
// deployment-profile.ts (webTenancyIsMulti / webRegistrationIsOpen /
// webEmailDelivery / webBillingMode) instead of the mode itself. Mirrors
// apps/api/src/tests/deployment-profile-structure.test.ts.
const ALLOWED = new Set([
  'lib/deployment-profile.ts', // the axis module itself: this IS the mode-to-default derivation
  'lib/api-config.ts', // resolves the internal Docker-network API base URL, appliance-only
  'lib/api.ts', // forwards the raw mode value as a request header for the API's own appliance checks
  'lib/auth-error-message.ts', // appliance-specific wording for an auth error banner
  'lib/url-security.ts', // appliance loopback-origin trust decisions in CSP/redirect validation
  'app/robots.ts', // appliance sites are never crawled: disallow-all is a lifecycle decision, not a capability
  'app/layout.tsx', // root <html> metadata differs between appliance and hosted branding
  'app/(dashboard)/layout.tsx', // appliance dashboard shell hides hosted-only chrome (billing/marketing nav)
  'app/(marketing)/layout.tsx', // appliance mode never renders the public marketing shell at all
  'app/sitemap.ts', // appliance sites are never crawled: sitemap returns [] for personal-server outright
  'proxy.ts', // the Node-runtime proxy forwards the raw mode value through several request paths
]);

const SRC = path.join(process.cwd(), 'src');

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      if (!/\.tsx?$/.test(entry.name) || entry.name.includes('.test.')) return [];
      return [full];
    }),
  );
  return files.flat();
}

test('only allowlisted files reference NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE directly', async () => {
  const files = await sourceFiles(SRC);
  const offenders: string[] = [];

  for (const file of files) {
    const relative = path.relative(SRC, file).split(path.sep).join('/');
    if (ALLOWED.has(relative)) continue;

    const source = await readFile(file, 'utf8');
    if (source.includes('NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE')) offenders.push(relative);
  }

  assert.deepEqual(
    offenders,
    [],
    `unexpected direct reference(s) to NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE outside the allowlist (key on a capability axis instead, or add here with a reason): ${offenders.join(', ')}`,
  );
});
