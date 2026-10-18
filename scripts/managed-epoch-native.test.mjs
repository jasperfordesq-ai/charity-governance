import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {config as defaults} from '../apps/api/dist/tests/fixtures/archived-custody.js';
import {readSyntheticEpochBootstrap,validateOriginalSyntheticEpochAck} from './managed-epoch-native.fixture.mjs';
import {syntheticEpochAckLossModes,matchesSyntheticEpochAckLoss} from './synthetic-epoch-ack-loss.mjs';
import {syntheticCustodyAllowed} from './synthetic-custody-policy.mjs';
import {syntheticEpochReadFaultModes,applySyntheticEpochReadFault} from './synthetic-epoch-read-fault.mjs';
test('synthetic epoch read faults preserve bytes/ETag, scope and first observations while changing only the named provider boundary',()=>{
 const config={installationId:'synthetic-native-epochs'},prefix=`managed-maintenance/${config.installationId}/recovery-epochs/heads/`,headers={'x-amz-version-id':'physical-original',etag:'"same-etag"'};
 const listed=Buffer.from('<ListBucketResult><KeyCount>3</KeyCount>'+[0,1,2].map(n=>`<Contents><Key>${prefix}${String(n).padStart(5,'0')}.json</Key></Contents>`).join('')+'</ListBucketResult>');
 const listing={method:'GET',path:'/',query:{'list-type':'2',prefix}},current={method:'GET',path:'/'+prefix+'00002.json',query:{}};
 for(const mode of syntheticEpochReadFaultModes){
  const fault={mode,listReads:0,currentReads:0,applied:0};assert.equal(syntheticCustodyAllowed('recovery',{op:'flag',name:'epochReadFault',value:mode,role:'owner'}),false);
  assert.deepEqual(applySyntheticEpochReadFault(fault,{installationId:'other'},listing,headers,listed),{headers,bytes:listed});assert.equal(fault.applied,0);
  if(mode==='HEAD_2_PHYSICAL_VERSION_DRIFT'){
   const bytes=Buffer.from('{"canonical":"unchanged"}');assert.deepEqual(applySyntheticEpochReadFault(fault,config,current,headers,bytes),{headers,bytes});
   assert.deepEqual(applySyntheticEpochReadFault(fault,config,{...current,query:{versionId:'physical-original'}},headers,bytes),{headers,bytes});
   const changed=applySyntheticEpochReadFault(fault,config,current,headers,bytes);assert.deepEqual(changed.bytes,bytes);assert.equal(changed.headers.etag,headers.etag);assert.notEqual(changed.headers['x-amz-version-id'],headers['x-amz-version-id']);
  }else{
   const first=applySyntheticEpochReadFault(fault,config,listing,headers,listed);if(mode==='HEAD_LIST_DRIFT')assert.deepEqual(first.bytes,listed);
   const changed=mode==='HEAD_LIST_DRIFT'?applySyntheticEpochReadFault(fault,config,listing,headers,listed):first;
   assert.ok(changed.bytes.toString().includes('<KeyCount>2</KeyCount>'));assert.equal(changed.bytes.toString().includes('00002.json'),false);assert.deepEqual(changed.headers,headers);
  }
  assert.ok(fault.applied>0);
 }
});
test('epoch ACK-loss hooks match only the second fixed slot and exact readback in the disposable namespace',()=>{
 for(const mode of syntheticEpochAckLossModes){
  const config={installationId:'synthetic-native-epochs'},method=mode.includes('_PUT_')?'PUT':'GET',kind=mode.startsWith('ENTRY_')?'entries':'heads';
  const request={method,path:`/managed-maintenance/${config.installationId}/recovery-epochs/${kind}/00002.json`,query:method==='GET'?{versionId:'original-version'}:{}};
  assert.equal(matchesSyntheticEpochAckLoss(mode,config,request),true);
  for(const change of [{method:'DELETE'},{method:'HEAD'},{path:request.path.replace('00002','00001')},{path:request.path+'/extra'},...(method==='GET'?[{query:{}},{query:{versionId:''}}]:[])])assert.equal(matchesSyntheticEpochAckLoss(mode,config,{...request,...change}),false);
  assert.equal(matchesSyntheticEpochAckLoss(mode,{installationId:'another-installation'},request),false);
  assert.equal(syntheticCustodyAllowed('recovery',{op:'flag',name:'epochAckLoss',value:mode,role:'owner'}),false);
 }
 assert.equal(matchesSyntheticEpochAckLoss('unknown',{installationId:'synthetic-native-epochs'},{method:'GET'}),false);
});
test('original synthetic epoch receipt binds sequence, source and checkpoint without accepting added IDs or recovered-ACK flags',()=>{
 const value={kind:'ORIGINAL_SYNTHETIC_EPOCH_ACK_V1',sequence:1,maintenanceEpoch:1,entrySha256:'a'.repeat(64),headRevision:'original-provider-revision',sourceSha:'b'.repeat(40)};
 assert.deepEqual(validateOriginalSyntheticEpochAck(value,1,value.sourceSha),value);
 for(const change of [{sequence:2},{maintenanceEpoch:2},{sourceSha:'c'.repeat(40)},{entrySha256:'invalid'},{headRevision:''},{candidateId:'copied-from-source'},{originalAcknowledgementReconstructed:true}])assert.throws(()=>validateOriginalSyntheticEpochAck({...value,...change},1,value.sourceSha));
});
test('externally retained epoch bootstrap requires protected original routing/configuration and rejects scope, checkpoint, file and permission substitution',{skip:process.platform!=='linux'},()=>{
 const root=mkdtempSync(join(tmpdir(),'charitypilot-synthetic-custody-'));chmodSync(root,0o700);const path=join(root,'epoch-bootstrap.json');
 const value={kind:'SYNTHETIC_NATIVE_EPOCH_BOOTSTRAP_V1',sessionId:'11111111-1111-4111-8111-111111111111',archiveConfiguration:{...defaults,installationId:'synthetic-native-epochs'},storeConfigurationDigest:'a'.repeat(64),genesisHeadSha256:'b'.repeat(64),trustedCheckpoint:{sequence:0,sha256:'b'.repeat(64)}};
 const save=v=>writeFileSync(path,JSON.stringify(v),{mode:0o600});
 try{
  save(value);assert.deepEqual(readSyntheticEpochBootstrap(path),value);
  for(const change of [{kind:'PRODUCTION'},{sessionId:'not-a-session'},{archiveConfiguration:{...value.archiveConfiguration,installationId:'other'}},{trustedCheckpoint:{sequence:0,sha256:'c'.repeat(64)}},{trustedCheckpoint:{sequence:2,sha256:'bad'}},{candidateId:'copied-source-id'},{capability:'should-not-be-here'}]){save({...value,...change});assert.throws(()=>readSyntheticEpochBootstrap(path));}
  save(value);chmodSync(path,0o644);assert.throws(()=>readSyntheticEpochBootstrap(path));chmodSync(path,0o600);
  chmodSync(root,0o755);assert.throws(()=>readSyntheticEpochBootstrap(path));chmodSync(root,0o700);
  writeFileSync(path,'x'.repeat(8193));assert.throws(()=>readSyntheticEpochBootstrap(path));
  save(value);const original=join(root,'retained.json');writeFileSync(original,JSON.stringify(value),{mode:0o600});rmSync(path);symlinkSync(original,path);assert.throws(()=>readSyntheticEpochBootstrap(path));
 }finally{rmSync(root,{recursive:true,force:true});}
});
