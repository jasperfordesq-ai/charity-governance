import assert from 'node:assert/strict';
import test from 'node:test';
import { isProtectedAppPath, renewsItsOwnSession } from './protected-routes';

test('matches dashboard application routes that require an auth cookie', () => {
  assert.equal(isProtectedAppPath('/dashboard'), true);
  assert.equal(isProtectedAppPath('/dashboard/settings'), true);
  assert.equal(isProtectedAppPath('/compliance/standard-1'), true);
  assert.equal(isProtectedAppPath('/documents'), true);
  assert.equal(isProtectedAppPath('/export?year=2026'), true);
  assert.equal(isProtectedAppPath('/integrations'), true);
  assert.equal(isProtectedAppPath('/integrations/confluence/callback'), true);
});

test('matches encoded dashboard application routes before Next normalisation', () => {
  assert.equal(isProtectedAppPath('/dashboard%2Fsettings'), true);
  assert.equal(isProtectedAppPath('/compliance%2Fstandard-1'), true);
  assert.equal(isProtectedAppPath('/documents%5Creports'), true);
});

test('does not match public, auth, or similarly named routes', () => {
  assert.equal(isProtectedAppPath('/'), false);
  assert.equal(isProtectedAppPath('/login'), false);
  assert.equal(isProtectedAppPath('/reset-password?token=secret'), false);
  assert.equal(isProtectedAppPath('/dashboard-public'), false);
  assert.equal(isProtectedAppPath('/documents-public'), false);
});

// ── renewsItsOwnSession: EXACT match, not a prefix ─────────────────────────
//
// Three redirects consult this — the middleware, the dashboard layout and the
// axios 401 interceptor — and a match means "let this through on a dead
// session". A prefix match would hand that exemption to every descendant of a
// registered path. Harmless while exactly one path is registered, which is
// precisely why it needs pinning before a second one is.

test('a path that renews its own session is matched exactly', () => {
  assert.equal(renewsItsOwnSession('/integrations/confluence/callback'), true);
  assert.equal(renewsItsOwnSession('/integrations/confluence/callback?code=live&state=live'), true);
  assert.equal(renewsItsOwnSession('/integrations/confluence/callback#fragment'), true);
});

test('renewsItsOwnSession never exempts a descendant or a lookalike of a registered path', () => {
  // `startsWith` instead of `===` would wrongly exempt every one of these.
  assert.equal(renewsItsOwnSession('/integrations/confluence/callback/extra'), false);
  assert.equal(renewsItsOwnSession('/integrations/confluence/callback-other'), false);
  assert.equal(renewsItsOwnSession('/integrations/confluence/callbackx'), false);
  // And a prefix of it is not it either.
  assert.equal(renewsItsOwnSession('/integrations/confluence'), false);
  assert.equal(renewsItsOwnSession('/integrations'), false);
  assert.equal(renewsItsOwnSession('/dashboard'), false);
  assert.equal(renewsItsOwnSession('/'), false);
});

test('renewsItsOwnSession normalises the encodings an exemption could otherwise be smuggled past', () => {
  // Decoded, so a percent-encoded spelling cannot dodge the exact match in
  // either direction — it resolves to the same answer as the plain one.
  assert.equal(renewsItsOwnSession('/integrations/confluence/%63allback'), true);
  assert.equal(renewsItsOwnSession('/integrations%2Fconfluence%2Fcallback'), true);
  assert.equal(renewsItsOwnSession('\\integrations\\confluence\\callback'), true);
  // A malformed escape must not throw, and must not match.
  assert.equal(renewsItsOwnSession('/integrations/confluence/%zzcallback'), false);
});

