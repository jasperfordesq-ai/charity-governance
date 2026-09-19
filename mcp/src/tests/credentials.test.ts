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
