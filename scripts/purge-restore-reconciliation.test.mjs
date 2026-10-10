import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { assertNoClaimedLocalObjects } from './purge-restore-reconciliation.mjs';
import { PURGE_RESTORE_TABLES, PURGE_RESTORE_ATTEMPT_TABLES, PURGE_RESTORE_PREVIOUS_TABLES, PURGE_RESTORE_LEGACY_TABLES,
  PURGE_RESTORE_OLDEST_TABLES,
  reconcilePurgeRestore, assertPurgeRestoreLedger } from './purge-restore-reconciliation.mjs';

function snapshot() {
  return {
    format: 7, capturedAt: '2026-09-30T10:00:00.000Z',
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

test('older formats compare only their exact inventory and cannot cross schema versions', () => {
  const old = snapshot();
  old.format = 3;
  old.tables = Object.fromEntries(PURGE_RESTORE_OLDEST_TABLES.map(table => [table,
    table === 'ComplaintPrimaryConflicts' ? [] : [{ id: table, sha256: 'a'.repeat(64) }]]));
  assert.equal(assertPurgeRestoreLedger(old, structuredClone(old)).databaseLedgerMatches, true);
  assert.throws(() => assertPurgeRestoreLedger(old, snapshot()), /schema versions differ/u);
  assert.throws(() => assertPurgeRestoreLedger(snapshot(), old), /schema versions differ/u);
  const previous = snapshot();
  previous.format = 4;
  previous.tables = Object.fromEntries(PURGE_RESTORE_LEGACY_TABLES.map(table => [table,
    table === 'ComplaintPrimaryConflicts' ? [] : [{ id: table, sha256: 'a'.repeat(64) }]]));
  assert.equal(assertPurgeRestoreLedger(previous, structuredClone(previous)).databaseLedgerMatches, true);
  assert.throws(() => assertPurgeRestoreLedger(previous, snapshot()), /schema versions differ/u);
  const lease = snapshot();
  lease.format = 5;
  lease.tables = Object.fromEntries(PURGE_RESTORE_PREVIOUS_TABLES.map(table => [table,
    table === 'ComplaintPrimaryConflicts' ? [] : [{ id: table, sha256: 'a'.repeat(64) }]]));
  assert.equal(assertPurgeRestoreLedger(lease, structuredClone(lease)).databaseLedgerMatches, true);
  assert.throws(() => assertPurgeRestoreLedger(lease, snapshot()), /schema versions differ/u);
  const attempt = snapshot();
  attempt.format = 6;
  attempt.tables = Object.fromEntries(PURGE_RESTORE_ATTEMPT_TABLES.map(table => [table,
    table === 'ComplaintPrimaryConflicts' ? [] : [{ id: table, sha256: 'a'.repeat(64) }]]));
  assert.equal(assertPurgeRestoreLedger(attempt, structuredClone(attempt)).databaseLedgerMatches, true);
  assert.throws(() => assertPurgeRestoreLedger(attempt, snapshot()), /schema versions differ/u);
  assert.throws(() => assertPurgeRestoreLedger(snapshot(), attempt), /schema versions differ/u);
  assert.ok(!PURGE_RESTORE_ATTEMPT_TABLES.includes('DocumentByteProviderObservation'));
  assert.ok(PURGE_RESTORE_TABLES.includes('DocumentByteProviderObservation'));
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

test('restored document preparation must match current independent decision facts', () => {
  const restored = snapshot();
  restored.tables.DocumentRecoveryPreparation[0].sha256 = 'b'.repeat(64);
  assert.throws(() => assertPurgeRestoreLedger(snapshot(), restored), error => {
    assert.equal(error.code, 'PURGE_RESTORE_RECONCILIATION_REQUIRED');
    assert.deepEqual(error.report.differences, [{
      table: 'DocumentRecoveryPreparation', missing: 0, changed: 1, unexpected: 0,
    }]);
    return true;
  });
});

test('document execution, outcome, binding, lease, provider attempt, provider observation and enforcement rows must match current authority', () => {
  for (const table of ['DocumentRecoveryEnforcement', 'DocumentRecoveryExecution', 'DocumentRecoveryOutcome', 'DocumentBytePermitCandidateBinding', 'DocumentByteExecutionLease', 'DocumentByteProviderAttempt', 'DocumentByteProviderObservation']) {
    const restored = snapshot();
    restored.tables[table][0].sha256 = 'b'.repeat(64);
    assert.throws(() => assertPurgeRestoreLedger(snapshot(), restored), error => {
      assert.equal(error.code, 'PURGE_RESTORE_RECONCILIATION_REQUIRED');
      assert.deepEqual(error.report.differences, [{ table, missing: 0, changed: 1, unexpected: 0 }]);
      return true;
    });
  }
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
    s => { delete s.tables.DocumentRecoveryPreparation; },
    s => { s.format = 2; },
    s => { s.format = 3; },
    s => { delete s.tables.DocumentBytePermitCandidateBinding; },
    s => { delete s.tables.DocumentByteExecutionLease; },
    s => { delete s.tables.DocumentByteProviderAttempt; },
    s => { delete s.tables.DocumentByteProviderObservation; },
    s => { delete s.tables.DocumentRecoveryExecution; },
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
