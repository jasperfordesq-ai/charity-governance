import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatStatus } from '../status.js';

const me = { email: 'o@x.ie', name: 'Owner', role: 'OWNER', organisation: { name: 'Harness Charity' } };

test('status prints the level the API reports, not the flag the process was started with', () => {
  const text = formatStatus(me, { accessLevel: 'read', role: 'OWNER' }, false);
  assert.match(text, /Access level: READ/);
  assert.match(text, /Organisation: Harness Charity/);
  assert.match(text, /Personal data: withheld/);
});

test('status says when the level cannot be read', () => {
  const text = formatStatus(me, null, true);
  assert.match(text, /Access level: unknown/);
  assert.match(text, /predates/);
  assert.match(text, /Personal data: ALLOWED/);
});
