import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareConfluenceExecutionLedgerV2 } from '../services/confluence-execution-ledger-v2.js';
import { prepareConfluenceCopyLocalLedger } from '../services/confluence-copy-ledger-snapshot.js';
import { validateConfluenceCopyLedgerRows } from '../services/confluence-copy-ledger-validation.js';
import { ledgerFixture } from './fixtures/confluence-copy-ledger.js';
import { executionLedgerFixture } from './fixtures/confluence-execution-ledger-v2.js';
import { recoveryContextFixture as context } from './fixtures/confluence-copy-recovery-facts.js';
test('V2 retains all eleven original groups and legacy V1 cannot silently read it',()=>{
  const raw=executionLedgerFixture(), value=prepareConfluenceExecutionLedgerV2(raw,context);
  assert.equal(Object.keys(value.ledger.tables).length,11);assert.deepEqual(value.ledger.tables,raw.tables);
  assert.throws(()=>prepareConfluenceCopyLocalLedger(JSON.parse(value.body)));
  assert.equal(value.actionAuthorized,false);assert.equal(value.currentHistoryVerified,false);
});
test('V2 refuses missing/foreign groups, forged links/flags/times and context substitution',()=>{
  for(const [group,changes] of [
    ['ConfluenceCopyExecutionClaim',[{permissionId:'foreign'},{snapshotSha256:'b'.repeat(64)},{claimedAt:'2026-10-15T18:06:01.000Z'}]],
    ['ConfluenceCopyExecutionRequest',[{claimId:'foreign'},{actorUserId:'foreign'},{action:'RETRY'},{preparedAt:'2026-10-15T18:02:00.000Z'},{preparedAt:'2026-10-15T18:06:01.000Z'},{providerIOAuthorised:true}]],
    ['ConfluenceCopyExecutionOutcome',[{requestId:'foreign'},{automaticRetryAllowed:true},{providerAbsenceVerified:true},{allCopiesVerified:true},{reportingBasis:'PROVIDER_VERIFIED'},{rawError:'private'},{reportedAt:'2026-10-15T18:03:00.000Z'}]],
  ] as const) for(const change of changes) {
    const raw=executionLedgerFixture();Object.assign(raw.tables[group]![0]!,change);
    assert.throws(()=>prepareConfluenceExecutionLedgerV2(raw,context));
  }
  for(const change of [{organisationId:'foreign'},{writerEpoch:2},{sourceRevision:'b'.repeat(40)},{operationId:'foreign'}]) {
    assert.throws(()=>prepareConfluenceExecutionLedgerV2(executionLedgerFixture(),{...context,...change}));
  }
  const missing=executionLedgerFixture();delete missing.tables.ConfluenceCopyExecutionOutcome;
  assert.throws(()=>prepareConfluenceExecutionLedgerV2(missing,context));
  const duplicate=executionLedgerFixture();duplicate.tables.ConfluenceCopyExecutionRequest!.push({...duplicate.tables.ConfluenceCopyExecutionRequest![0]!,id:'request-b',requestKey:'other'});
  assert.throws(()=>prepareConfluenceExecutionLedgerV2(duplicate,context));
});

test('V2 preserves original historical epochs without weakening legacy V1 checks or accepting foreign/over-capacity rows',()=>{
  const raw=executionLedgerFixture();raw.writerEpoch=2;
  const value=prepareConfluenceExecutionLedgerV2(raw,{...context,writerEpoch:2});
  assert.deepEqual(value.ledger.tables,raw.tables);
  assert.equal(value.ledger.tables.ConfluenceCopyRecoveryCapture![0]!.writerEpoch,1);
  assert.throws(()=>validateConfluenceCopyLedgerRows(ledgerFixture().body(),{...context,writerEpoch:2}));
  const foreign=executionLedgerFixture();foreign.tables.ConfluenceCopyExecutionOutcome![0]!.organisationId='foreign';
  assert.throws(()=>prepareConfluenceExecutionLedgerV2(foreign,context));
  const full=executionLedgerFixture();full.tables.ConfluenceCopyExecutionClaim=Array.from({length:10001},()=>({...full.tables.ConfluenceCopyExecutionClaim![0]!}));
  assert.throws(()=>prepareConfluenceExecutionLedgerV2(full,context));
});
