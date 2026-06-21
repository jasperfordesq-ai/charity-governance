import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Concern: input-validation parity. The auth forms must validate with the SAME
// @charitypilot/shared Zod schemas the server uses — wired through @/lib/form-schemas,
// which re-exports them and derives the shared password rule. This source-scan fails the
// moment a form drops the shared validator and reverts to an ad-hoc rule that could drift
// from the server (the exact "weak-but-long password" class of bug this closed).
//
// (A source-scan, not a module-load: the shared package is ESM-only and the web suite is
// CommonJS. The schemas' own accept/reject behaviour is proven on the API surface, and
// the rendered inline-block behaviour is proven by the Playwright auth journey.)

const WEB = process.cwd(); // apps/web
const authFile = (p: string) => readFileSync(join(WEB, 'src', 'app', '(auth)', p), 'utf8');

test('form-schemas sources its rules from @charitypilot/shared (single source of truth)', () => {
  const src = readFileSync(join(WEB, 'src', 'lib', 'form-schemas.ts'), 'utf8');
  assert.match(src, /from '@charitypilot\/shared'/);
  // The shared password field is re-used directly, so client and server cannot diverge.
  assert.match(src, /registerSchema\.shape\.password/);
});

const FORMS: Array<[string, string]> = [
  ['login/page.tsx', 'loginSchema'],
  ['register/page.tsx', 'registerSchema'],
  ['forgot-password/page.tsx', 'forgotPasswordSchema'],
  ['reset-password/page.tsx', 'passwordIssue'],
  ['accept-invite/page.tsx', 'passwordIssue'],
];

for (const [file, marker] of FORMS) {
  test(`${file} validates with the shared schema (no client/server drift)`, () => {
    const src = authFile(file);
    assert.match(src, /from '@\/lib\/form-schemas'/, `${file} must import the shared-schema validators`);
    assert.ok(src.includes(marker), `${file} must use ${marker}`);
  });
}

test('the password forms no longer gate on a bare length-only check', () => {
  for (const file of ['register/page.tsx', 'reset-password/page.tsx', 'accept-invite/page.tsx']) {
    const src = authFile(file);
    assert.ok(/passwordIssue/.test(src), `${file} must use the shared password rule`);
    // The old ad-hoc submit gate that let weak-but-long passwords through must be gone.
    assert.ok(
      !/setError\('Password must be at least 8 characters\.'\)/.test(src),
      `${file} must not keep the ad-hoc length-only submit gate`,
    );
  }
});
