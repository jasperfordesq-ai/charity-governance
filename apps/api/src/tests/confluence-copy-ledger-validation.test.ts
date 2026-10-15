import assert from 'node:assert/strict';
import test from 'node:test';
import { validateConfluenceCopyLedgerRows } from '../services/confluence-copy-ledger-validation.js';
import { ledgerFixture } from './fixtures/confluence-copy-ledger.js';
import { recoveryContextFixture as context } from './fixtures/confluence-copy-recovery-facts.js';


test('all eight original rows validate with exact capture lineage and historical withdrawn/expired decisions', () => {
  const f = ledgerFixture(), result = validateConfluenceCopyLedgerRows(f.body(),context);
  assert.equal(result.ledgerRowsVerified,true); assert.equal(result.currentHistoryVerified,false);
  assert.equal(result.reopeningAuthorised,false); assert.equal(result.actionAuthorized,false);
  assert.equal(result.ledger.tables.ConfluenceCopyRecoveryCapture!.length,2);
});

for (const [label,change] of Object.entries({
  missingWithdrawal: (f: ReturnType<typeof ledgerFixture>) => { f.raw.tables.ConfluenceRetainedCopyPermissionWithdrawal = []; },
  orphanScope: (f: ReturnType<typeof ledgerFixture>) => { f.raw.tables.ConfluenceSyntheticCopyScope![0]!.reviewId = 'missing'; },
  duplicatedReviewScope: (f: ReturnType<typeof ledgerFixture>) => { f.raw.tables.ConfluenceSyntheticCopyScope!.push({ ...f.raw.tables.ConfluenceSyntheticCopyScope![0]!, id: 'another-scope' }); },
  orphanPermission: (f: ReturnType<typeof ledgerFixture>) => { f.raw.tables.ConfluenceRetainedCopyPermission![0]!.scopeId = 'missing'; },
  changedDecision: (f: ReturnType<typeof ledgerFixture>) => { f.raw.tables.ConfluenceRetainedCopyReviewWithdrawal![0]!.reason = 'Changed original immutable reason'; },
  missingCapture: (f: ReturnType<typeof ledgerFixture>) => { f.raw.tables.ConfluenceCopyRecoveryCapture!.shift(); },
  captureScalar: (f: ReturnType<typeof ledgerFixture>) => { f.raw.tables.ConfluenceCopyRecoveryCapture![0]!.factsRevision = 3; },
  captureUnknownField: (f: ReturnType<typeof ledgerFixture>) => { f.raw.tables.ConfluenceCopyRecoveryCapture![0]!.invented = true; },
  orphanPlan: (f: ReturnType<typeof ledgerFixture>) => { f.raw.tables.ConfluenceCopyPublicationPlan![0]!.captureId = 'missing'; },
  duplicatePlan: (f: ReturnType<typeof ledgerFixture>) => { f.raw.tables.ConfluenceCopyPublicationPlan!.push({ ...f.raw.tables.ConfluenceCopyPublicationPlan![0]!, id: 'another-plan' }); },
  orphanReceipt: (f: ReturnType<typeof ledgerFixture>) => { f.raw.tables.ConfluenceCopyPublicationReceipt![0]!.planId = 'missing'; },
  receiptGeneration: (f: ReturnType<typeof ledgerFixture>) => { f.raw.tables.ConfluenceCopyPublicationReceipt![0]!.entryGeneration = 2; },
  futureTimestamp: (f: ReturnType<typeof ledgerFixture>) => { f.raw.tables.ConfluenceCopyPublicationReceipt![0]!.recordedAt = '2026-10-16T22:00:00.000Z'; },
  brokenReceiptChronology: (f: ReturnType<typeof ledgerFixture>) => { f.raw.tables.ConfluenceCopyPublicationReceipt![0]!.recordedAt = '2026-10-15T18:00:00.000Z'; },
})) test(`complete-ledger semantics refuse ${label}`, () => {
  const f = ledgerFixture(); change(f); assert.throws(() => validateConfluenceCopyLedgerRows(f.body(),context),/Invalid Confluence ledger relationships/);
});

test('unpublished withdrawals after the last capture are preserved, never treated as invalid omissions', () => {
  const f = ledgerFixture(); f.raw.tables.ConfluenceCopyRecoveryCapture!.pop();
  assert.equal(validateConfluenceCopyLedgerRows(f.body(),context).ledgerRowsVerified,true);
});

test('foreign installation/epoch/source and noncanonical duplicate-key bodies refuse', () => {
  const f = ledgerFixture();
  for (const change of [{ installationId: 'foreign' },{ writerEpoch: 2 },{ sourceRevision: 'd'.repeat(40) }]) {
    assert.throws(() => validateConfluenceCopyLedgerRows(f.body(),{ ...context, ...change }));
  }
  assert.throws(() => validateConfluenceCopyLedgerRows(f.body().replace('{','{"format":1,'),context));
});
