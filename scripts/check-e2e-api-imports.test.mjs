import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findForbiddenImports } from './check-e2e-api-imports.mjs';

/**
 * These assert the live repository, not a fixture, because the thing worth
 * protecting is this repository's import graph. The failure they prevent is
 * invisible locally — module resolution walks up to the root node_modules and
 * resolves everything — and only appears in CI, twice over and in two different
 * disguises. See the header of check-e2e-api-imports.mjs.
 */

test('no apps/api module the E2E harness reaches imports a third-party package', async () => {
  const { violations } = await findForbiddenImports();

  assert.deepEqual(
    violations.map(({ chain, specifier }) => `${chain[chain.length - 1]} imports ${specifier}`),
    [],
    'The E2E harness must only share dependency-free apps/api modules.',
  );
});

test('the harness still reaches the shared modules it depends on', async () => {
  const { reached } = await findForbiddenImports();

  // A guard that passes because it found nothing would be worthless: if these
  // edges disappear, the check above is no longer proving anything.
  for (const expected of [
    'apps/api/src/utils/totp.ts',
    'apps/api/src/services/operator-totp-crypto.ts',
  ]) {
    assert.ok(
      reached.some((file) => file.split('\\').join('/') === expected),
      `Expected the harness to reach ${expected}; reached: ${reached.join(', ')}`,
    );
  }
});
