import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ListObjectsV2Command,GetObjectCommand} from '@aws-sdk/client-s3';
import {readSyntheticCustodyDescriptor,callSyntheticCustody} from './synthetic-custody-wire.mjs';
import {connectSyntheticCustody} from './synthetic-custody-client.mjs';
import {ArchivedRecoverySets} from '../apps/api/dist/services/archived-recovery-set.js';
import {ManagedCandidateCaptureJournal} from '../apps/api/dist/services/managed-candidate-capture-journal.js';
import {S3ManagedMaintenanceControl} from '../apps/api/dist/services/managed-maintenance-control.js';
import {credentials} from '../apps/api/dist/tests/fixtures/archived-custody.js';
const descriptor=readSyntheticCustodyDescriptor(process.env.CHARITYPILOT_TEST_CUSTODY_SESSION_FILE);
const sessions=await callSyntheticCustody(descriptor,{op:'sessions'});assert.ok(sessions.length>=1&&sessions.length<=32);
let roots=0,records=0,services=0,killedSourceServices=0,currentInspections=0,currentVerifiedRoots=0,currentUnresolved=0,daemonCatalogues=0,daemonCompleted=0,daemonUnresolved=0;
for(const session of sessions){
 const b=connectSyntheticCustody(descriptor,session.id,session.config),before={writes:b.writes,generates:b.generates},clients={s3:b.s3(),kms:b.kms()};
 try{
  const listed=await clients.s3.send(new ListObjectsV2Command({Bucket:session.config.bucket,ExpectedBucketOwner:session.config.accountId,Prefix:'',MaxKeys:1000}));assert.equal(listed.IsTruncated,false);
  const rows=listed.Contents??[];assert.ok(rows.length<=256);records+=rows.length;
  let sessionRoots=0,sessionServices=0;
  for(const row of rows.filter(v=>v.Key?.endsWith('.json'))){
   const version=String(row.ETag).replaceAll('"',''),stored=await clients.s3.send(new GetObjectCommand({Bucket:session.config.bucket,ExpectedBucketOwner:session.config.accountId,Key:row.Key,VersionId:version,ChecksumMode:'ENABLED'}));
   assert.equal(stored.VersionId,version);const bytes=Buffer.from(await stored.Body.transformToByteArray()),sha256=createHash('sha256').update(bytes).digest('hex');
   assert.equal(stored.ChecksumSHA256,Buffer.from(sha256,'hex').toString('base64'));assert.equal(stored.ServerSideEncryption,'aws:kms');assert.equal(stored.SSEKMSKeyId,session.config.storageKeyArn);const value=JSON.parse(bytes.toString('utf8'));
   if(value.kind==='MANAGED_SOURCE_JOB_SERVICE_V1'){
    const body=Buffer.from(value.localService.body);assert.equal(createHash('sha256').update(body).digest('hex'),value.localService.sha256);assert.equal(body.length,value.localService.byteLength);sessionServices++;services++;
   }
   if(!row.Key.endsWith('/root.json'))continue;
   const verified=await new ArchivedRecoverySets(session.config,credentials,clients).verifySet({scope:value.manifest.scope,sha256},version);
   assert.equal(verified.restoreMode,'QUARANTINE_ONLY');assert.equal(verified.completedIntervalBindingVerified,true);assert.equal(verified.actionAuthorized,false);roots++;sessionRoots++;
  }
  if(session.id===sessions.at(-1).id){assert.equal(sessionRoots,0);assert.ok(sessionServices>=1);killedSourceServices=sessionServices;}
  if(session.controlSessionId){
   const originalControl=sessions.find(v=>v.id===session.controlSessionId);assert.ok(originalControl);
   const controlBackend=connectSyntheticCustody(descriptor,originalControl.id,originalControl.config),controlClient=controlBackend.s3();
   const storage=c=>({installationId:c.installationId,bucket:c.bucket,accountId:c.accountId,kmsKeyArn:c.storageKeyArn});
   try{
    const journal=new ManagedCandidateCaptureJournal(storage(session.config),credentials,clients.s3);
    const observation=await journal.inspectCurrentRecovery(new S3ManagedMaintenanceControl(storage(originalControl.config),credentials,controlClient),1,new ArchivedRecoverySets(session.config,credentials,clients));
    assert.equal(observation.currentTenantAuthorityVerified,false);assert.equal(observation.atomicSnapshotVerified,false);assert.equal(observation.actionAuthorized,false);
    assert.equal(observation.records.filter(r=>r.kind==='COMMON_CAPTURE_RECOVERY_OBSERVATION').length,1);
    for(const record of observation.records.filter(r=>r.kind==='COMMON_CAPTURE_RECOVERY_OBSERVATION')){
     if(!record.job?.daemon)continue;const daemon=record.job.daemon;daemonCatalogues++;
     assert.deepEqual(daemon.protocolOrdinalRange,{first:0,last:64});assert.equal(daemon.listingStableAtBoundaries,true);
     for(const field of ['historyCompletenessVerified','pendingRequestResolved','completeResourceInventory','originalAcknowledgementReconstructed','savedEvidenceAuthorizesDispatch','cleanupAuthorized','actionAuthorized'])assert.equal(daemon[field],false);
     if(daemon.state==='RECORDED_CLIENT_RESPONSES'){daemonCompleted++;assert.ok(daemon.endPin);assert.equal(daemon.records.length,daemon.responseCount);}
     else daemonUnresolved++;
     if(!record.unresolved){assert.equal(daemon.state,'RECORDED_CLIENT_RESPONSES');assert.ok(daemon.records.length>0);}
    }
    currentInspections++;currentVerifiedRoots+=observation.records.filter(r=>r.rootStatus==='ARCHIVE_VERIFIED_QUARANTINE_ONLY').length;currentUnresolved+=observation.unresolvedCommonCandidates;
   }finally{controlClient.destroy();}
  }
  assert.equal(b.writes,before.writes);assert.equal(b.generates,before.generates);
 }finally{clients.s3.destroy();clients.kms.destroy();}
}
const report={kind:'SYNTHETIC_COLD_CUSTODY_READER_V1',sessions:sessions.length,records,verifiedRoots:roots,verifiedSourceServiceRecords:services,killedSourceServiceRecords:killedSourceServices,
 currentInspections,currentVerifiedRoots,currentUnresolved,daemonCatalogues,daemonCompleted,daemonUnresolved,
 suppliedSourceIdsOrPins:false,executionAuthorized:false,realProvider:false,sourceHostLossProven:false};
if(process.connected){await new Promise((yes,no)=>process.send(report,error=>error?no(error):yes()));process.disconnect();}
else process.stdout.write(JSON.stringify(report)+'\n');
