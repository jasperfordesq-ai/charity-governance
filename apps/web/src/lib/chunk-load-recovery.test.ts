import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHUNK_LOAD_RELOAD_STORAGE_KEY,
  clearChunkLoadReloadAttempt,
  isRecoverableChunkLoadError,
  shouldAttemptChunkLoadReload,
} from './chunk-load-recovery';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

test('recognises webpack chunk load failures as recoverable', () => {
  assert.equal(
    isRecoverableChunkLoadError(
      new Error('Loading chunk _app-pages-browser_node_modules_heroui_dom-animation_dist_index_mjs failed.'),
    ),
    true,
  );
  assert.equal(
    isRecoverableChunkLoadError({
      name: 'ChunkLoadError',
      message: 'Loading chunk app-pages-internals failed.',
    }),
    true,
  );
});

test('recognises dynamic import failures as recoverable', () => {
  assert.equal(
    isRecoverableChunkLoadError('Failed to fetch dynamically imported module: http://localhost:3003/_next/static/chunk.js'),
    true,
  );
  assert.equal(
    isRecoverableChunkLoadError('Importing a module script failed.'),
    true,
  );
});

test('ignores unrelated runtime errors', () => {
  assert.equal(isRecoverableChunkLoadError(new Error('Request failed with status code 403')), false);
  assert.equal(isRecoverableChunkLoadError({ name: 'AxiosError', message: 'Network Error' }), false);
  assert.equal(isRecoverableChunkLoadError(null), false);
});

test('attempts only one reload for a recoverable chunk failure', () => {
  const storage = new MemoryStorage();

  assert.equal(shouldAttemptChunkLoadReload(new Error('Loading chunk app failed.'), storage), true);
  assert.equal(storage.getItem(CHUNK_LOAD_RELOAD_STORAGE_KEY), 'true');
  assert.equal(shouldAttemptChunkLoadReload(new Error('Loading chunk app failed.'), storage), false);
});

test('clears the reload attempt marker after a stable page mount', () => {
  const storage = new MemoryStorage();

  assert.equal(shouldAttemptChunkLoadReload('Failed to fetch dynamically imported module', storage), true);
  clearChunkLoadReloadAttempt(storage);

  assert.equal(storage.getItem(CHUNK_LOAD_RELOAD_STORAGE_KEY), null);
  assert.equal(shouldAttemptChunkLoadReload('Failed to fetch dynamically imported module', storage), true);
});
