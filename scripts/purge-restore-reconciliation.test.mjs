import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { assertNoClaimedLocalObjects } from './purge-restore-reconciliation.mjs';
import { PURGE_RESTORE_TABLES, reconcilePurgeRestore, assertPurgeRestoreLedger } from './purge-restore-reconciliation.mjs';

function snapshot() {
  return {
    format: 1, capturedAt: '2026-09-30T10:00:00.000Z',
    tables: Object.fromEntries(PURGE_RESTORE_TABLES.map(table => [table, table==='ComplaintPrimaryConflicts'?[]:[{ id: table, sha256: 'a'.repeat(64) }]])),
    claims: [{ organisationId: 'charity-a', documentId: 'removed-document' }], documents: [],
  };
}

test('restored local files cannot reintroduce claimed keys even with changed bytes', () => {
  const hash = createHash('sha256').update('charity-a/file.pdf').digest('hex');
  assert.throws(() => assertNoClaimedLocalObjects([hash], [{ path: 'charity-a/file.pdf', sha256: 'different' }]),
    { code: 'PURGE_RESTORE_LOCAL_OBJECTS_PRESENT' });
  assert.equal(assertNoClaimedLocalObjects([hash], [{ path: 'charity-b/file.pdf' }]).claimedLocalObjectsPresent, 0);
  for (const path of ['../file', '/file', 'a//b', 'a/./b', 'a\\b', 'a\nb']) {
    assert.throws(() => assertNoClaimedLocalObjects([], [{ path }]));
  }
  assert.throws(() => assertNoClaimedLocalObjects([hash, hash], []));
});

test('matching database history still requires file and external-copy reconciliation', () => {
  const result = assertPurgeRestoreLedger(snapshot(), snapshot());
  assert.equal(result.databaseLedgerMatches, true);
  assert.equal(result.objectAndExternalCopyReconciliationRequired, true);
});

test('changed decisions, missing evidence and unexpected authority all refuse reconciliation', () => {
  for (const table of PURGE_RESTORE_TABLES) {
    const altered = snapshot();
    altered.tables[table] = [{ id: table, sha256: 'b'.repeat(64) }];
    assert.throws(() => assertPurgeRestoreLedger(snapshot(), altered), { code: 'PURGE_RESTORE_RECONCILIATION_REQUIRED' });
  }
  const missing = snapshot();
  missing.tables.DocumentPurgeDispositionEvent = [];
  assert.equal(reconcilePurgeRestore(snapshot(), missing).differences[0].missing, 1);
  const extra = snapshot();
  extra.tables.DocumentPurgeAuthorization.push({ id: 'unexpected', sha256: 'c'.repeat(64) });
  assert.equal(reconcilePurgeRestore(snapshot(), extra).differences[0].unexpected, 1);
});

test('even matching snapshots cannot accept a claimed complaint still present in the primary database',()=>{
  const conflicting=snapshot();
  conflicting.tables.ComplaintPrimaryConflicts=[{id:'claimed-but-present',sha256:'a'.repeat(64)}];
  assert.throws(()=>assertPurgeRestoreLedger(conflicting,conflicting),{code:'PURGE_RESTORE_RECONCILIATION_REQUIRED'});
});

test('resurrection comparison respects charity scope and rejects conflicting source', () => {
  const target = snapshot();
  target.documents = [{ organisationId: 'charity-b', documentId: 'removed-document' }];
  assert.equal(reconcilePurgeRestore(snapshot(), target).databaseLedgerMatches, true);
  target.documents.push(...target.claims);
  assert.equal(reconcilePurgeRestore(snapshot(), target).resurrectedDocuments, 1);
  assert.equal(reconcilePurgeRestore(target, snapshot()).sourceConflicts, 1);
  const scope = snapshot();
  scope.claims[0].organisationId = 'charity-b';
  assert.equal(reconcilePurgeRestore(snapshot(), scope).claimScopeDifferences, 2);
});

test('malformed or incomplete evidence fails closed', () => {
  for (const mutate of [
    s => { s.tables.ClaimedPrimaryJobs = []; },
    s => { s.claims.push(s.claims[0]); },
    s => { s.tables.DocumentPurgeClaim.push(s.tables.DocumentPurgeClaim[0]); },
    s => { s.tables.DocumentPurgeClaim[0].sha256 = 'invalid'; },
    s => { delete s.tables.DocumentPurgeDispositionEvent; },
    s => { delete s.tables.ComplaintHoldEvent; },
    s => { delete s.tables.ComplaintRecoveryState; },
    s => { delete s.tables.DocumentRecoveryState; },
    s => { s.capturedAt = 'not-a-date'; },
    s => { s.capturedAt = '2026-02-30T10:00:00.000Z'; },
  ]) {
    const malformed = snapshot(); mutate(malformed);
    assert.throws(() => reconcilePurgeRestore(snapshot(), malformed));
    assert.throws(() => reconcilePurgeRestore(malformed, snapshot()));
  }
});
