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

// ── what else this machine holds ───────────────────────────────────────────

const VM = 'https://charitypilot.tailae0b07.ts.net';
const PROD = 'https://api.charitypilot.ie';

test('one credential needs no explaining, so nothing extra is printed', () => {
  const printed = formatStatus(me, null, false, [{ origin: VM, present: true }], VM);
  assert.ok(!printed.includes('holds credentials for'));
});

test('two credentials are listed, and the one in use is marked', () => {
  // Every command acts on whichever host --base-url names, so an operator who
  // has connected to two needs to see which one this invocation is about.
  const printed = formatStatus(
    me,
    null,
    false,
    [{ origin: VM, present: true }, { origin: PROD, present: true }],
    PROD,
  );

  // Compared as whole lines rather than with a regex: these are URLs, and a
  // pattern built from one is mostly escaping.
  const lines = printed.split('\n').map((line) => line.trim());
  assert.match(printed, /holds credentials for/);
  assert.ok(lines.includes(VM), `expected a line for ${VM}`);
  assert.ok(lines.includes(`${PROD}  (this one)`), 'the host in use must be marked');
  assert.match(printed, /acts on whichever host/);
});

test('a host with no credential is not listed as one', () => {
  const printed = formatStatus(
    me,
    null,
    false,
    [{ origin: VM, present: true }, { origin: PROD, present: false }],
    VM,
  );
  assert.ok(!printed.includes(PROD));
  assert.ok(!printed.includes('holds credentials for'), 'one present host is still one');
});

test('status never prints a token, because presence is the whole question', () => {
  // The type carries no token at all; this pins the reason so nobody adds one
  // to make the output more helpful.
  const printed = formatStatus(
    me,
    null,
    false,
    [{ origin: VM, present: true }, { origin: PROD, present: true }],
    VM,
  );
  assert.ok(!printed.toLowerCase().includes('token'));
  assert.ok(!printed.toLowerCase().includes('refresh'));
});
