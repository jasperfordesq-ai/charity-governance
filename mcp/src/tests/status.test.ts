import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatStatus } from '../status.js';

const me = { email: 'o@x.ie', name: 'Owner', role: 'OWNER', organisation: { name: 'Harness Charity' } };

test('status prints the level the API reports, not the flag the process was started with', () => {
  const text = formatStatus(
    me,
    { accessLevel: 'read', dataScope: 'withheld', role: 'OWNER' },
    // The flag says otherwise, and must lose: the session is what holds the
    // scope now.
    true,
  );
  assert.match(text, /Access level: READ/);
  assert.match(text, /Organisation: Harness Charity/);
  assert.match(text, /Personal data: withheld by this session/);
});

test('status reports a session that may see personal data as the session, not the flag', () => {
  const text = formatStatus(
    me,
    { accessLevel: 'admin', dataScope: 'full', role: 'OWNER' },
    false,
  );
  assert.match(text, /Personal data: ALLOWED by this session/);
});

test('an API too old to hold a scope falls back to the flag, and says so', () => {
  const text = formatStatus(me, { accessLevel: 'write', dataScope: null, role: 'OWNER' }, true);
  assert.match(text, /Personal data: ALLOWED by this process/);
  assert.match(text, /holds no scope/);
});

test('status says when the level cannot be read', () => {
  const text = formatStatus(me, null, true);
  assert.match(text, /Access level: unknown/);
  assert.match(text, /predates/);
  assert.match(text, /Personal data: ALLOWED by this process/);
});
