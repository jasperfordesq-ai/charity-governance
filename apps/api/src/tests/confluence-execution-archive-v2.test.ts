import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareConfluenceExecutionLedgerV2 } from '../services/confluence-execution-ledger-v2.js';
import { sealConfluenceExecutionArchiveV2,openConfluenceExecutionArchiveV2,preservePreparedConfluenceExecutionArchiveV2,
  readConfluenceExecutionArchiveV2 } from '../services/confluence-execution-archive-v2.js';
import { openConfluenceCopyLedgerArchive } from '../services/confluence-copy-ledger-envelope.js';
import type { RecoveryDataKeys } from '../services/recovery-preparation-envelope.js';
import { executionLedgerFixture } from './fixtures/confluence-execution-ledger-v2.js';
import { recoveryContextFixture as context } from './fixtures/confluence-copy-recovery-facts.js';
function fixture() {
 const buffers:Buffer[]=[];let generations=0;
 const keys:RecoveryDataKeys={generate:async supplied=>{generations++;const key=Buffer.alloc(32,7);buffers.push(key);return{key,keyId:supplied.keyId,wrappedKey:Buffer.from('synthetic-wrapped-key').toString('base64')};},
  unwrap:async(_wrapped,supplied)=>{const key=Buffer.alloc(32,7);buffers.push(key);return{key,keyId:supplied.keyId};}};
 const binding={context,observedControl:{format:2,installationId:context.installationId,organisationId:context.organisationId,
  writerId:'writer-a',writerEpoch:1,generation:0,digest:null,activeOperation:null,revision:'synthetic-predecessor'}};
 const ledger=prepareConfluenceExecutionLedgerV2(executionLedgerFixture(),context);
 return{keys,binding,ledger,buffers,generations:()=>generations};
}
test('V2 encrypts/opens exact eleven-group bytes, zeroes keys and cannot be read as V1',async()=>{
 const h=fixture(),sealed=await sealConfluenceExecutionArchiveV2(h.ledger.body,h.binding,h.keys);
 assert.equal((await openConfluenceExecutionArchiveV2(sealed.envelope,h.binding,h.keys)).body,h.ledger.body);
 assert.equal(sealed.currentHistoryVerified,false);assert.equal(sealed.reopeningAuthorised,false);
 assert.equal(h.buffers.every(buffer=>buffer.every(byte=>byte===0)),true);
 await assert.rejects(openConfluenceCopyLedgerArchive(sealed.envelope,h.binding,h.keys));
 for(const change of [{operationId:'other'},{sourceRevision:'b'.repeat(40)},{writerEpoch:2},{organisationId:'other'}]) {
  await assert.rejects(openConfluenceExecutionArchiveV2(sealed.envelope,{...h.binding,context:{...context,...change}},h.keys));
 }
 const forged=JSON.parse(sealed.envelope);forged.sealed.ciphertext=Buffer.from('forged ciphertext').toString('base64');
 await assert.rejects(openConfluenceExecutionArchiveV2(JSON.stringify(forged),h.binding,h.keys));
});
test('pre-publication lost acknowledgement retries exact original candidate; expected-digest reads never recreate missing objects',async()=>{
 const h=fixture(),sealed=await sealConfluenceExecutionArchiveV2(h.ledger.body,h.binding,h.keys);
 let saved:string|null=null,writes=0;
 const store={readExecutionLedgerV2:async()=>saved,createExecutionLedgerV2:async(_context:unknown,envelope:string)=>{
  writes++;saved=envelope;throw new Error('PRIVATE-LOST-ACK');}};
 const original={body:h.ledger.body,digest:h.ledger.digest,binding:h.binding};
 await assert.rejects(preservePreparedConfluenceExecutionArchiveV2(original,sealed,h.keys,store),error=>{
  assert.equal(String(error).includes('PRIVATE-LOST-ACK'),false);return true;
 });
 const retried=await preservePreparedConfluenceExecutionArchiveV2(original,sealed,h.keys,store);
 assert.equal(retried.replayed,true);assert.equal(writes,1);assert.equal(h.generations(),1);
 assert.equal((await readConfluenceExecutionArchiveV2(sealed.digest,h.binding,h.keys,store)).body,h.ledger.body);
 const other=await sealConfluenceExecutionArchiveV2(h.ledger.body,h.binding,h.keys);
 await assert.rejects(preservePreparedConfluenceExecutionArchiveV2(original,other,h.keys,store));
 saved=null;await assert.rejects(readConfluenceExecutionArchiveV2(sealed.digest,h.binding,h.keys,store));assert.equal(writes,1);
});
