import { test } from 'node:test';
import assert from 'node:assert/strict';
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
