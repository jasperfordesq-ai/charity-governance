import assert from 'node:assert/strict';
import test from 'node:test';
import {buildConfluenceExecutionV2ReconciliationPlan} from '../services/confluence-execution-v2-reconciliation.js';
import {executionLedgerFixture} from './fixtures/confluence-execution-ledger-v2.js';
import {prepareConfluenceExecutionLedgerV2,CONFLUENCE_EXECUTION_LEDGER_V2_TABLES as names} from '../services/confluence-execution-ledger-v2.js';
import {recoveryContextFixture as context} from './fixtures/confluence-copy-recovery-facts.js';
function fixture(){const raw=executionLedgerFixture(),prepared=prepareConfluenceExecutionLedgerV2(raw,context);
 return{raw,local:structuredClone(raw.tables),archive:{body:prepared.body,archiveAtObservedHead:true as const,archivePrefixVerified:true as const,
 entryGeneration:4,entryDigest:'d'.repeat(64),envelopeDigest:'e'.repeat(64),revision:'observed-head'}};}
test('V2 plans every original group in dependency order without granting recovery or action authority',()=>{
 const h=fixture(),plan=buildConfluenceExecutionV2ReconciliationPlan(context,h.archive,Object.fromEntries(names.map(name=>[name,[]])));
 assert.equal(plan.inserts.length,12);assert.equal(plan.inserts.at(-3)?.table,'ConfluenceCopyExecutionClaim');
 assert.equal(plan.inserts.at(-2)?.table,'ConfluenceCopyExecutionRequest');assert.equal(plan.inserts.at(-1)?.table,'ConfluenceCopyExecutionOutcome');
 assert.equal(plan.inserts.at(-1)?.record.recordedByDatabaseRole,'cp_runtime');
 for(const flag of ['actionAuthorized','currentHistoryVerified','reopeningAuthorised','transportStateReconciled','independentlyPreserved'])assert.equal(plan[flag as keyof typeof plan],false);
});
for(const name of names)test(`V2 refuses later or changed original ${name}`,()=>{
 const h=fixture();h.local[name]![0]!.id='later-unarchived-evidence';assert.throws(()=>buildConfluenceExecutionV2ReconciliationPlan(context,h.archive,h.local));
 const changed=fixture();changed.local[name]![0]!.unexpected='private-value';assert.throws(()=>buildConfluenceExecutionV2ReconciliationPlan(context,changed.archive,changed.local));
});
test('V2 subset validation permits missing parents but never invents history or ignores extra groups',()=>{
 const h=fixture();h.local.ConfluenceCopyExecutionClaim=[];h.local.ConfluenceCopyExecutionRequest=[];
 const plan=buildConfluenceExecutionV2ReconciliationPlan(context,h.archive,h.local);assert.equal(plan.inserts.length,2);
 assert.equal(plan.matchingRecords,10);const reordered=JSON.parse(JSON.stringify(h.local),(_k,v)=>v&&!Array.isArray(v)&&typeof v==='object'?Object.fromEntries(Object.entries(v).reverse()):v);
 reordered.ConfluenceCopyRecoveryCapture.reverse();assert.deepEqual(buildConfluenceExecutionV2ReconciliationPlan(context,h.archive,reordered),plan);
 h.local.Extra=[];assert.throws(()=>buildConfluenceExecutionV2ReconciliationPlan(context,h.archive,h.local));
 const missing=fixture();delete missing.local.ConfluenceCopyExecutionOutcome;assert.throws(()=>buildConfluenceExecutionV2ReconciliationPlan(context,missing.archive,missing.local));
});
