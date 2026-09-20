import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Entry } from '@napi-rs/keyring';
import {
  createMemoryStore,
  createHostScopedStore,
  bindCredentialToOrigin,
  originOf,
  type CredentialStore,
} from '../credentials.js';

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

test('a credential is refused to a host other than the one that issued it', () => {
  const backing = createMemoryStore();
  const issued = bindCredentialToOrigin(backing, 'https://charitypilot.example.ts.net');
  issued.write('refresh_live');

  const elsewhere = bindCredentialToOrigin(backing, 'https://evil.example');

  assert.throws(() => elsewhere.read(), (err: unknown) => {
    assert.match((err as Error).message, /charitypilot\.example\.ts\.net/);
    assert.match((err as Error).message, /evil\.example/);
    return true;
  }, 'a redirected base URL must be loud, not silently unauthenticated');
});

test('a credential is returned to the host that issued it, however the URL is spelled', () => {
  const backing = createMemoryStore();
  bindCredentialToOrigin(backing, 'https://CharityPilot.Example.ts.net/').write('refresh_live');

  assert.equal(
    bindCredentialToOrigin(backing, 'https://charitypilot.example.ts.net').read(),
    'refresh_live',
    'case and a trailing slash are the same host, not a different one',
  );
});

test('a port is part of the identity, so two local stacks cannot share a credential', () => {
  const backing = createMemoryStore();
  bindCredentialToOrigin(backing, 'http://localhost:3002').write('refresh_dev');

  assert.throws(() => bindCredentialToOrigin(backing, 'http://localhost:3302').read());
});

test('a plain-string entry from an older connector still reads, so nobody is logged out by an upgrade', () => {
  const backing = createMemoryStore('refresh_from_before_the_upgrade');

  assert.equal(
    bindCredentialToOrigin(backing, 'https://charitypilot.example.ts.net').read(),
    'refresh_from_before_the_upgrade',
  );
});

test('the next write after an upgrade binds the entry, so the gap closes on its own', () => {
  const backing = createMemoryStore('legacy');
  const bound = bindCredentialToOrigin(backing, 'https://a.example');
  bound.write('rotated');

  assert.throws(() => bindCredentialToOrigin(backing, 'https://b.example').read());
  assert.equal(bindCredentialToOrigin(backing, 'https://a.example').read(), 'rotated');
});

test('clearing a bound store clears the entry itself, not a rewritten copy of it', () => {
  const backing = createMemoryStore();
  const bound = bindCredentialToOrigin(backing, 'https://a.example');
  bound.write('r1');
  bound.clear();

  assert.equal(backing.read(), null);
  assert.equal(bound.read(), null);
});

test('a bound store with nothing in it reads as not connected, not as a mismatch', () => {
  assert.equal(bindCredentialToOrigin(createMemoryStore(), 'https://a.example').read(), null);
});

test('a base URL that is not a URL is refused before anything is stored', () => {
  assert.throws(
    () => bindCredentialToOrigin(createMemoryStore(), 'not a url'),
    /not a valid URL/i,
  );
});

/* --- Phase E: one credential per host ------------------------------------ */

function fakeKeyring(initial: Record<string, string | null> = {}) {
  const slots: Record<string, string | null> = { ...initial };
  return {
    slots,
    make(account = 'refresh-token'): CredentialStore {
      return {
        read: () => slots[account] ?? null,
        write: (token: string) => { slots[account] = token; },
        clear: () => { slots[account] = null; },
      };
    },
  };
}

const VM = 'https://charitypilot.tailae0b07.ts.net';
const LOCAL = 'http://localhost:3002';

function boundEntry(origin: string, token: string): string {
  return JSON.stringify({ v: 1, origin, refreshToken: token });
}

test('each host keeps its own credential', () => {
  const keyring = fakeKeyring();
  const vm = bindCredentialToOrigin(createHostScopedStore(originOf(VM), keyring.make), VM);
  const local = bindCredentialToOrigin(createHostScopedStore(originOf(LOCAL), keyring.make), LOCAL);

  vm.write('vm-token');
  local.write('local-token');

  assert.equal(vm.read(), 'vm-token');
  assert.equal(local.read(), 'local-token', 'connecting to one host must not evict the other');
});

test('the single entry written before this change is still honoured, for its own host', () => {
  const keyring = fakeKeyring({ 'refresh-token': boundEntry(originOf(VM), 'old-token') });
  const vm = bindCredentialToOrigin(createHostScopedStore(originOf(VM), keyring.make), VM);

  assert.equal(vm.read(), 'old-token', 'upgrading must not sign anybody out');
});

test('another host ignores the old entry rather than refusing over it', () => {
  const keyring = fakeKeyring({ 'refresh-token': boundEntry(originOf(VM), 'old-token') });
  const local = bindCredentialToOrigin(createHostScopedStore(originOf(LOCAL), keyring.make), LOCAL);

  assert.equal(
    local.read(),
    null,
    'a host that never had a credential is not connected; it has not been redirected',
  );
});

test('disconnecting clears this host, and leaves another host alone', () => {
  const keyring = fakeKeyring({ 'refresh-token': boundEntry(originOf(VM), 'old-token') });
  const local = bindCredentialToOrigin(createHostScopedStore(originOf(LOCAL), keyring.make), LOCAL);
  local.write('local-token');
  local.clear();

  assert.equal(local.read(), null);
  assert.equal(
    keyring.slots['refresh-token'],
    boundEntry(originOf(VM), 'old-token'),
    'the other host was not asked to disconnect',
  );
});

test('disconnecting clears the old entry when it belongs to this host', () => {
  const keyring = fakeKeyring({ 'refresh-token': boundEntry(originOf(VM), 'old-token') });
  const vm = bindCredentialToOrigin(createHostScopedStore(originOf(VM), keyring.make), VM);

  vm.clear();

  assert.equal(vm.read(), null, 'a credential left behind by disconnect is worse than none');
  assert.equal(keyring.slots['refresh-token'], null);
});
