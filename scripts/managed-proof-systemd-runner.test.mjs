import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyContainedExecutorSource,superviseContainedManagedProof} from './managed-proof-systemd-runner.mjs';
import {runManagedImportedProof} from './managed-proof-runner.mjs';
test('source identities cannot select a revision, command, or another checkout',()=>{
 for(const value of [null,'HEAD','../main','0'.repeat(40),'a'.repeat(40)+';echo'])assert.throws(()=>verifyContainedExecutorSource(value),/unresolved/);
});
test('invalid containment bounds and modes refuse before invoking any launch dependency',async()=>{
 let calls=0;for(const timeoutMs of [0,1200001,NaN])await assert.rejects(superviseContainedManagedProof({timeoutMs},{assertSource(){calls++;}}));
 assert.equal(calls,0);await assert.rejects(runManagedImportedProof({executionMode:'AUTOMATIC_FALLBACK'}));
});
test('unsupported hosts do not silently downgrade the default to IPC',{skip:process.platform==='linux'&&process.getuid()!==0},async()=>{
 let touched=false;const args=['prove-restore'];Object.defineProperty(args,0,{get(){touched=true;throw new Error('Synthetic proof work entered');}});
 await assert.rejects(runManagedImportedProof({args,databaseUrl:'postgresql://synthetic:synthetic@127.0.0.1/synthetic'}));assert.equal(touched,false);
});
