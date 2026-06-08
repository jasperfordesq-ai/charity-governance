import assert from 'node:assert/strict';
import test from 'node:test';
import { isProtectedAppPath } from './protected-routes';

test('matches dashboard application routes that require an auth cookie', () => {
  assert.equal(isProtectedAppPath('/dashboard'), true);
  assert.equal(isProtectedAppPath('/dashboard/settings'), true);
  assert.equal(isProtectedAppPath('/compliance/standard-1'), true);
  assert.equal(isProtectedAppPath('/documents'), true);
  assert.equal(isProtectedAppPath('/export?year=2026'), true);
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
