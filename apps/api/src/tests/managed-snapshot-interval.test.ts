import assert from 'node:assert/strict';
import test from 'node:test';
import {managedSnapshotInterval,assertImportedSnapshotInterval} from '../services/managed-snapshot-interval.js';
import {snapshotIntervalFixture,snapshotContext} from './fixtures/managed-snapshot-interval.js';
test('completed snapshot interval matches the exact imported source context without granting authority',()=>{
 const raw=snapshotIntervalFixture(),v=assertImportedSnapshotInterval(raw,JSON.stringify({importedSnapshot:snapshotContext(raw)}));
 raw.metadataWindow.relations[0]!.name='changed';assert.equal(v.metadataWindow.relations[0]!.name,'objects');
 assert.equal(v.databaseSnapshot.wholeBackendQuiesced,false);assert.equal(v.databaseSnapshot.actionAuthorized,false);
});
test('incomplete, substituted, malformed and changed interval evidence refuses',()=>{
 for(const change of ['hash','window','identity','completion','authority','extra']){
  const v=snapshotIntervalFixture();
  if(change==='hash')v.metadataWindow.observationDigest='3'.repeat(64);
  if(change==='window')v.databaseSnapshot.windowId='11111111-1111-4111-8111-111111111111';
  if(change==='identity')v.databaseSnapshot.databaseOid='1';
  if(change==='completion')Object.assign(v.metadataWindow,{metadataWindowCompleted:false});
  if(change==='authority')Object.assign(v.databaseSnapshot,{actionAuthorized:true});
  if(change==='extra')Object.assign(v.databaseSnapshot,{snapshotId:'raw-token'});
  assert.throws(()=>managedSnapshotInterval(v),/Managed snapshot interval is unresolved/);
 }
});
test('source context substitutions or missing original import cannot satisfy interval binding',()=>{
 const v=snapshotIntervalFixture();for(const change of [{snapshotBindingSha256:'3'.repeat(64)},{databaseOid:'1'},{backendPid:124},
  {originalViewImported:false},{metadataWindowCompletionVerified:true},{unexpected:'raw'}])
  assert.throws(()=>assertImportedSnapshotInterval(v,JSON.stringify({importedSnapshot:{...snapshotContext(v),...change}})),/Managed snapshot interval is unresolved/);
 assert.throws(()=>assertImportedSnapshotInterval(v,'{}'));
});
