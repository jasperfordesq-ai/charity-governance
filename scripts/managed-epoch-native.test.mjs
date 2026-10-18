import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {config as defaults} from '../apps/api/dist/tests/fixtures/archived-custody.js';
import {readSyntheticEpochBootstrap,validateOriginalSyntheticEpochAck} from './managed-epoch-native.fixture.mjs';
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
