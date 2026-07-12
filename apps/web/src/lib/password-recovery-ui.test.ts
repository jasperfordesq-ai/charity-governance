import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = process.cwd();
const app = (path: string) => readFileSync(join(WEB, 'src', 'app', path), 'utf8');

test('forgot-password stays enumeration-neutral and does not couple public recovery to session refresh', () => {
  const page = app('(auth)/forgot-password/page.tsx');

  assert.match(page, /api\.post<PasswordRecoveryAcceptedResponse>/);
  assert.match(page, /skipAuthRefresh: true/);
  assert.match(page, /skipAuthRedirect: true/);
  assert.match(page, /If an active account exists for the address you entered/);
  assert.match(page, /Repeated requests may be silently limited for security/);
  assert.match(page, /role="status" aria-live="polite"/);
  assert.doesNotMatch(page, /we have sent a password reset link/i);
  assert.doesNotMatch(page, />\{email\}<\/span>/);
  assert.match(page, /NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE === 'personal-server'/);
  assert.match(page, /Email recovery is disabled on this private CharityPilot server/);
  assert.match(page, /trusted host operator/);
});

test('reset-password waits for its fragment token and explains full session revocation', () => {
  const page = app('(auth)/reset-password/page.tsx');

  assert.match(page, /const \{ token, isReady \} = useSensitiveQueryToken\(\)/);
  assert.match(page, /if \(!isReady\)/);
  assert.match(page, /Reset link required/);
  assert.match(page, /href="\/forgot-password"/);
  assert.match(page, /resetPasswordIssue\(password\)/);
  assert.match(page, /api\.post<PasswordResetResponse>/);
  assert.match(page, /skipAuthRefresh: true/);
  assert.match(page, /skipAuthRedirect: true/);
  assert.match(page, /every existing session has been signed out/);
  assert.match(page, /Completing this reset signs out every[\s\S]*existing CharityPilot session/);
  assert.match(page, /resetLinkRejected[\s\S]*INVALID_RESET_TOKEN/);
  assert.match(page, /personalServer[\s\S]*valid one-time link from its trusted host operator/);
  assert.match(page, /resetLinkRejected && !personalServer/);
});
