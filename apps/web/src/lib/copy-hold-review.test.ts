import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentCopyHold } from './copy-hold-review';

test('copy hold review requires complete loaded history and matches the exact scope', () => {
  const rows = [
    { area: 'BACKUPS', scopeRef: 'SET-001', revision: 1, held: true },
    { area: 'BACKUPS', scopeRef: 'SET-001', revision: 2, held: false },
    { area: 'EXPORTS', scopeRef: 'SET-001', revision: 9, held: true },
    { area: 'BACKUPS', scopeRef: 'SET-002', revision: 8, held: true },
  ];
  assert.equal(currentCopyHold(null, null, 'BACKUPS', 'SET-001'), null);
  assert.equal(currentCopyHold(rows, 'older', 'BACKUPS', 'SET-001'), null);
  assert.deepEqual(currentCopyHold(rows, null, 'BACKUPS', 'SET-001'), { revision: 2, held: false });
  assert.deepEqual(currentCopyHold(rows, null, 'EXPORTS', 'SET-001'), { revision: 9, held: true });
  assert.deepEqual(currentCopyHold([], null, 'BACKUPS', 'NEW-001'), { revision: 0, held: false });
});
