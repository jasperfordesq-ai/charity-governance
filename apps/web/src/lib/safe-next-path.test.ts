import assert from 'node:assert/strict';
import test from 'node:test';
import { safeNextPath } from './safe-next-path';

const origin = 'https://app.charitypilot.ie';

test('allows same-origin protected app next paths', () => {
  assert.equal(safeNextPath('/dashboard?tab=deadlines', origin), '/dashboard?tab=deadlines');
  assert.equal(safeNextPath('/documents/report#latest', origin), '/documents/report#latest');
});

test('rejects cross-origin and encoded network-path next values', () => {
  for (const nextPath of [
    'https://evil.example/dashboard',
    '//evil.example/dashboard',
    '/\\evil.example',
    '/%5C%5Cevil.example',
    '/%2F%2Fevil.example',
  ]) {
    assert.equal(safeNextPath(nextPath, origin), '/dashboard', nextPath);
  }
});

test('rejects public local next paths', () => {
  assert.equal(safeNextPath('/login', origin), '/dashboard');
  assert.equal(safeNextPath('/reset-password?token=secret', origin), '/dashboard');
});
