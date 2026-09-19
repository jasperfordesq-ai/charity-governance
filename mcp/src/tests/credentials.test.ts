import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Entry } from '@napi-rs/keyring';
import { createMemoryStore } from '../credentials.js';

test('a fresh store holds nothing', () => {
  assert.equal(createMemoryStore().read(), null);
});

test('write then read returns the token', () => {
  const store = createMemoryStore();
  store.write('refresh_abc');
  assert.equal(store.read(), 'refresh_abc');
});

test('write replaces rather than accumulating, so one account cannot inherit another', () => {
  const store = createMemoryStore();
  store.write('first');
  store.write('second');
  assert.equal(store.read(), 'second');
});

test('clear leaves nothing readable', () => {
  const store = createMemoryStore('existing');
  store.clear();
  assert.equal(store.read(), null);
});

test('clearing an already-empty store is not an error', () => {
  const store = createMemoryStore();
  store.clear();
  assert.equal(store.read(), null);
});

function keyringAvailable(): boolean {
  try {
    const probe = new Entry('charitypilot-mcp-test-probe', 'probe');
    probe.setPassword('probe-value');
    const ok = probe.getPassword() === 'probe-value';
    probe.deletePassword();
    return ok;
  } catch {
    return false;
  }
}

test('the real keyring round-trips, overwrites and deletes', { skip: keyringAvailable() ? false : 'no OS keychain available here' }, () => {
  const entry = new Entry('charitypilot-mcp-test-roundtrip', 'refresh-token');
  try {
    entry.setPassword('first');
    assert.equal(entry.getPassword(), 'first');
    entry.setPassword('second');
    assert.equal(entry.getPassword(), 'second', 'setPassword must overwrite, not accumulate');
    entry.deletePassword();
    let after: string | null = null;
    try { after = entry.getPassword() ?? null; } catch { after = null; }
    assert.equal(after, null, 'deletePassword must actually delete');
  } finally {
    try { entry.deletePassword(); } catch { /* already gone */ }
  }
});

import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { createFileStore, chooseCredentialStore } from '../credentials.js';

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'cp-mcp-cred-')), 'credential.json');
}

test('a file store round-trips, overwrites and clears', () => {
  const path = tempFile();
  try {
    const store = createFileStore(path);
    assert.equal(store.read(), null, 'an absent file holds nothing');
    store.write('refresh_first');
    assert.equal(store.read(), 'refresh_first');
    store.write('refresh_second');
    assert.equal(store.read(), 'refresh_second', 'write must overwrite, not accumulate');
    store.clear();
    assert.equal(store.read(), null);
    assert.equal(existsSync(path), false, 'clear must remove the file');
  } finally {
    rmSync(path, { force: true });
  }
});

test('clearing an absent file store is not an error', () => {
  const path = tempFile();
  const store = createFileStore(path);
  store.clear();
  assert.equal(store.read(), null);
});

test('a corrupt credential file reads as not connected rather than throwing', () => {
  const path = tempFile();
  try {
    writeFileSync(path, 'not json at all');
    assert.equal(createFileStore(path).read(), null);
  } finally {
    rmSync(path, { force: true });
  }
});

test('the file store is written owner-only', { skip: platform() === 'win32' ? 'POSIX modes only' : false }, () => {
  const path = tempFile();
  try {
    createFileStore(path).write('refresh_abc');
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(path, { force: true });
  }
});

test('the keyring is used unless the local profile asks for a file', () => {
  const keyring = createMemoryStore('from-keyring');
  const file = createMemoryStore('from-file');
  const deps = { keyring: () => keyring, file: () => file };

  assert.equal(
    chooseCredentialStore({ profile: 'default', ...deps }).read(),
    'from-keyring',
  );
  assert.equal(
    chooseCredentialStore({ profile: 'local', ...deps }).read(),
    'from-keyring',
    'the local profile alone must not move the credential off the keyring',
  );
  assert.equal(
    chooseCredentialStore({ profile: 'local', credentialFile: '/tmp/x.json', ...deps }).read(),
    'from-file',
  );
});

test('a credential file is refused outside the local profile', () => {
  assert.throws(
    () => chooseCredentialStore({ profile: 'default', credentialFile: '/tmp/x.json' }),
    /--profile local/,
  );
});
