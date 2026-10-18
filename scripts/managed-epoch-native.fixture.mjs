import assert from 'node:assert/strict';
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {dirname,basename,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {PutObjectCommand,GetObjectCommand} from '@aws-sdk/client-s3';
import {config as defaults,credentials} from '../apps/api/dist/tests/fixtures/archived-custody.js';
import {ManagedRecoveryEpochCatalogue,ManagedRecoveryEpochPublisher,managedRecoveryEpochSchemas} from '../apps/api/dist/services/managed-recovery-epoch-catalogue.js';
import {S3ManagedRecoveryEpochReader,S3ManagedRecoveryEpochWriter} from '../apps/api/dist/services/managed-recovery-epoch-s3.js';
import {S3ManagedMaintenanceControl} from '../apps/api/dist/services/managed-maintenance-control.js';
import {ManagedCandidateCaptureJournal} from '../apps/api/dist/services/managed-candidate-capture-journal.js';
import {ArchivedRecoverySets} from '../apps/api/dist/services/archived-recovery-set.js';
import {readSyntheticCustodyDescriptor,callSyntheticCustody} from './synthetic-custody-wire.mjs';
import {connectSyntheticCustody} from './synthetic-custody-client.mjs';
import {managedCommonCustodyBackend} from './managed-common-custody-postgres-proof.mjs';
import {proveManagedBackendMaintenance} from './managed-backend-maintenance-postgres-proof.mjs';
import {syntheticEpochAckLossModes} from './synthetic-epoch-ack-loss.mjs';
const installationId='synthetic-native-epochs';
const hash=body=>createHash('sha256').update(body).digest('hex');
const storage=config=>({installationId:config.installationId,bucket:config.bucket,accountId:config.accountId,kmsKeyArn:config.storageKeyArn});
const keys=(value,names)=>assert.deepEqual(Object.keys(value).sort(),names.sort());
function validate(raw){
 keys(raw,['kind','sessionId','archiveConfiguration','storeConfigurationDigest','genesisHeadSha256','trustedCheckpoint']);
 assert.equal(raw.kind,'SYNTHETIC_NATIVE_EPOCH_BOOTSTRAP_V1');assert.match(raw.sessionId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
 assert.deepEqual(raw.archiveConfiguration,{...defaults,installationId});
 managedRecoveryEpochSchemas.configuration.parse({installationId,storeConfigurationDigest:raw.storeConfigurationDigest,genesisHeadSha256:raw.genesisHeadSha256,trustedCheckpoint:raw.trustedCheckpoint});
 return raw;
}
/** Operator-retained synthetic provider routing/configuration, never source
 * candidate IDs, archive pins, credentials or a checkpoint reconstructed by GET. */
export function readSyntheticEpochBootstrap(path){
 assert.equal(process.platform,'linux');const root=dirname(path);
 assert.equal(dirname(root),resolve(tmpdir()));assert.match(basename(root),/^charitypilot-synthetic-custody-[A-Za-z0-9]{6}$/);
 assert.equal(basename(path),'epoch-bootstrap.json');assert.equal(realpathSync(root),root);
 for(const [target,mode] of [[root,0o700],[path,0o600]]){
  const s=lstatSync(target);assert.equal(s.isSymbolicLink(),false);assert.equal(s.uid,process.getuid());assert.equal(s.mode&0o777,mode);
  assert.ok(target===root?s.isDirectory():s.isFile()&&s.size>0&&s.size<=8192);
 }
 const body=readFileSync(path);assert.ok(body.length<=8192);return validate(JSON.parse(body.toString('utf8')));
}
export function epochCatalogueConfiguration(bootstrap){
 validate(bootstrap);return{installationId,storeConfigurationDigest:bootstrap.storeConfigurationDigest,genesisHeadSha256:bootstrap.genesisHeadSha256,trustedCheckpoint:bootstrap.trustedCheckpoint};
}
/** Explicit supervisor-only synthetic genesis provision. No real provider,
 * production bootstrap or reset path is implemented by this fixture. */
export async function provisionSyntheticEpochGenesis(descriptor){
 const config={...defaults,installationId},opened=await callSyntheticCustody(descriptor,{op:'open',config});
 const b=connectSyntheticCustody(descriptor,opened.id,config),client=b.s3();
 try{
  const reader=new S3ManagedRecoveryEpochReader(storage(config),credentials,client),body=JSON.stringify({format:1,kind:'MANAGED_RECOVERY_EPOCH_HEAD_V1',installationId,sequence:0,entryPin:null,publicationId:randomUUID()});
  const request={Bucket:config.bucket,ExpectedBucketOwner:config.accountId,Key:`managed-maintenance/${installationId}/recovery-epochs/heads/00000.json`,Body:body,
   IfNoneMatch:'*',ChecksumSHA256:Buffer.from(hash(body),'hex').toString('base64'),ContentType:'application/json',ServerSideEncryption:'aws:kms',SSEKMSKeyId:config.storageKeyArn,BucketKeyEnabled:false};
  const ack=await client.send(new PutObjectCommand(request));assert.ok(ack.VersionId);assert.equal(ack.ChecksumSHA256,request.ChecksumSHA256);
  assert.equal(ack.ServerSideEncryption,'aws:kms');assert.equal(ack.SSEKMSKeyId,config.storageKeyArn);
  const saved=await client.send(new GetObjectCommand({Bucket:config.bucket,ExpectedBucketOwner:config.accountId,Key:request.Key,VersionId:ack.VersionId,ChecksumMode:'ENABLED'}));
  assert.equal(saved.VersionId,ack.VersionId);assert.equal(await saved.Body.transformToString(),body);
  const observed=await reader.readHead(new AbortController().signal);assert.equal(observed.artifact.body,body);
  return validate({kind:'SYNTHETIC_NATIVE_EPOCH_BOOTSTRAP_V1',sessionId:opened.id,archiveConfiguration:config,storeConfigurationDigest:reader.configurationDigest(),genesisHeadSha256:hash(body),trustedCheckpoint:{sequence:0,sha256:hash(body)}});
 }finally{client.destroy();}
}
export function validateOriginalSyntheticEpochAck(value,sequence,sourceSha){
 keys(value,['kind','sequence','maintenanceEpoch','entrySha256','headRevision','sourceSha']);
 assert.equal(value.kind,'ORIGINAL_SYNTHETIC_EPOCH_ACK_V1');assert.equal(value.sequence,sequence);assert.equal(value.maintenanceEpoch,sequence);
 assert.equal(value.sourceSha,sourceSha);assert.match(value.entrySha256,/^[a-f0-9]{64}$/);assert.match(value.headRevision,/^[\x21-\x7e]{1,1024}$/);return value;
}
export async function proveManagedEpochLifecycle(args){
 assert.equal(process.env.CHARITYPILOT_TEST_CONTAINED_SOURCE,'1');assert.equal(typeof process.send,'function');
 assert.equal(process.env.CHARITYPILOT_TEST_SOURCE_PARENT_FIXTURE,undefined);
 const bootstrap=readSyntheticEpochBootstrap(process.env.CHARITYPILOT_TEST_EPOCH_BOOTSTRAP_FILE);assert.equal(bootstrap.trustedCheckpoint.sequence,0);
 const descriptor=readSyntheticCustodyDescriptor(process.env.CHARITYPILOT_TEST_CUSTODY_SESSION_FILE);
 const b=connectSyntheticCustody(descriptor,bootstrap.sessionId,bootstrap.archiveConfiguration),custody=managedCommonCustodyBackend(installationId,undefined,b);
 const reader=new S3ManagedRecoveryEpochReader(storage(custody.config),credentials,custody.clients.s3),writer=new S3ManagedRecoveryEpochWriter(storage(custody.config),credentials,custody.clients.s3);
 const catalogue=new ManagedRecoveryEpochCatalogue(epochCatalogueConfiguration(bootstrap),reader),publisher=new ManagedRecoveryEpochPublisher(catalogue,reader,writer);
 const lossMode=process.env.CHARITYPILOT_TEST_EPOCH_ACK_LOSS,expectedLoss=new Error('Expected synthetic epoch publication ACK loss');let lossRecorded=false;
 if(lossMode)assert.ok(syntheticEpochAckLossModes.includes(lossMode)&&process.env.CHARITYPILOT_TEST_EPOCH_ONLY==='1');
 try{
  for(const epoch of [1,2]){
   try{await proveManagedBackendMaintenance({...args,epochFixture:{epoch,custody,recordClosed:async control=>{
    const before=await catalogue.observe();
    if(epoch===2&&lossMode){
     await assert.rejects(publisher.publishClosedEpoch(control,custody.journal,custody.archive.configurationDigest(),before.head.revision));
     const fault=await callSyntheticCustody(descriptor,{op:'stats',id:bootstrap.sessionId});
     assert.deepEqual(fault.epochAckLoss,{mode:lossMode,used:true,storedRecordPresent:true,responseLostAfterSdkOperation:true});
     const writes=b.writes,generates=b.generates;
     await assert.rejects(publisher.publishClosedEpoch(control,custody.journal,custody.archive.configurationDigest(),before.head.revision));
     assert.equal(b.writes,writes);assert.equal(b.generates,generates);
     await new Promise((yes,no)=>process.send({kind:'ORIGINAL_SYNTHETIC_EPOCH_UNRESOLVED_V1',mode:lossMode,maintenanceEpoch:2,sourceSha:before.latest.plan.sourceSha,originalAcknowledgementReconstructed:false},error=>error?no(error):yes()));
     throw expectedLoss;
    }
    const published=await publisher.publishClosedEpoch(control,custody.journal,custody.archive.configurationDigest(),before.head.revision);
    assert.equal(published.originalEntryAcknowledgementObserved,true);assert.equal(published.originalHeadAcknowledgementObserved,true);
    assert.equal(published.entryCount,epoch);assert.equal(published.latest.plan.maintenanceEpoch,epoch);
    const ack={kind:'ORIGINAL_SYNTHETIC_EPOCH_ACK_V1',sequence:epoch,maintenanceEpoch:epoch,entrySha256:published.head.head.entryPin.sha256,headRevision:published.head.revision,sourceSha:published.latest.plan.sourceSha};
    await new Promise((yes,no)=>process.send(ack,error=>error?no(error):yes()));
   }}});}catch(error){if(error!==expectedLoss)throw error;lossRecorded=true;break;}
   const observed=await custody.journal.inspectAnchoredCurrentRecovery(catalogue,new S3ManagedMaintenanceControl(storage(custody.config),credentials,custody.clients.s3),custody.archive);
   assert.equal(observed.epochCatalogue.entryCount,epoch);assert.equal(observed.bootstrap.plan.maintenanceEpoch,epoch);
   assert.equal(observed.records.length,1);assert.equal(observed.records[0].rootStatus,'ARCHIVE_VERIFIED_QUARANTINE_ONLY');assert.equal(observed.unresolvedCommonCandidates,0);
   assert.equal(observed.currentTenantAuthorityVerified,false);assert.equal(observed.actionAuthorized,false);
  }
  if(lossMode){assert.equal(lossRecorded,true);console.log('PASS original synthetic epoch publication remains unresolved after '+lossMode+'; no second capture or reconstructed ACK');}
  else console.log('PASS two native epochs: shared original SDK custody, original publication ACKs exported before cold recovery; no production reopening');
 }finally{custody.close();}
}
async function verifySyntheticHistoricalEpoch1(observed,reader,journal,archive){
 const first=observed.latest.sequence===1?observed.latest:managedRecoveryEpochSchemas.entry.parse(JSON.parse((await reader.readEntry(1,JSON.parse(observed.latest.previousHead.body).entryPin,new AbortController().signal)).artifact.body));
 assert.equal(first.sequence,1);assert.equal(first.plan.maintenanceEpoch,1);
 const prior=await journal.discoverCandidates({attemptId:first.closedControl.value.attemptId,planDigest:first.closedControl.value.planDigest,sourceSha:first.plan.sourceSha,maintenanceEpoch:1,controlRevision:first.closedControl.revision});
 assert.equal(prior.records.length,1);const verified=await journal.verifyDiscoveredCommonRoot(prior.records[0].binding,archive);
 assert.equal(verified.root.restoreMode,'QUARANTINE_ONLY');assert.equal(verified.originalAcknowledgementReconstructed,false);assert.equal(verified.actionAuthorized,false);
}
/** Inspect surviving bytes after an original publication response was lost.
 * Readback may verify history, but cannot create the missing original receipt. */
export async function inspectSyntheticEpochLossRecovery(descriptor,path,mode){
 assert.ok(syntheticEpochAckLossModes.includes(mode));const bootstrap=readSyntheticEpochBootstrap(path);assert.equal(bootstrap.trustedCheckpoint.sequence,1);
 const b=connectSyntheticCustody(descriptor,bootstrap.sessionId,bootstrap.archiveConfiguration),before={writes:b.writes,generates:b.generates},clients={s3:b.s3(),kms:b.kms()};
 try{
  const config=bootstrap.archiveConfiguration,s=storage(config),reader=new S3ManagedRecoveryEpochReader(s,credentials,clients.s3),catalogue=new ManagedRecoveryEpochCatalogue(epochCatalogueConfiguration(bootstrap),reader);
  const observed=await catalogue.observe(),headPublished=mode.startsWith('HEAD_');assert.equal(observed.entryCount,headPublished?2:1);
  assert.equal(observed.originalAcknowledgementReconstructed,false);assert.equal(observed.executionAuthorized,false);
  const entryKey=`managed-maintenance/${installationId}/recovery-epochs/entries/00002.json`;
  const read=async(key,version)=>{
   const r=await clients.s3.send(new GetObjectCommand({Bucket:config.bucket,ExpectedBucketOwner:config.accountId,Key:key,ChecksumMode:'ENABLED',...(version?{VersionId:version}:{})}));
   const bytes=Buffer.from(await r.Body.transformToByteArray());assert.ok(r.VersionId);if(version)assert.equal(r.VersionId,version);
   assert.equal(r.ChecksumSHA256,Buffer.from(hash(bytes),'hex').toString('base64'));assert.equal(r.ServerSideEncryption,'aws:kms');assert.equal(r.SSEKMSKeyId,config.storageKeyArn);
   return{bytes,version:r.VersionId,sha256:hash(bytes)};
  };
  const latest=await read(entryKey),exact=await read(entryKey,latest.version);assert.deepEqual(exact,latest);
  const entry=managedRecoveryEpochSchemas.entry.parse(JSON.parse(exact.bytes.toString('utf8')));assert.equal(entry.sequence,2);assert.equal(entry.plan.maintenanceEpoch,2);assert.equal(entry.registryConfigurationDigest,catalogue.configurationDigest());
  const control=new S3ManagedMaintenanceControl(s,credentials,clients.s3),closed=await control.observe();assert.deepEqual(entry.closedControl,{revision:closed.revision,value:closed.value});
  const journal=new ManagedCandidateCaptureJournal(s,credentials,clients.s3),archive=new ArchivedRecoverySets(config,credentials,clients);
  if(headPublished){
   const current=await journal.inspectAnchoredCurrentRecovery(catalogue,control,archive);assert.equal(current.records.length,0);assert.equal(current.bootstrap.plan.maintenanceEpoch,2);
   assert.equal(current.actionAuthorized,false);assert.equal(current.currentTenantAuthorityVerified,false);
  }else await assert.rejects(journal.inspectAnchoredCurrentRecovery(catalogue,control,archive));
  // The verified closed-epoch chain supplies historical discovery context;
  // no candidate ID or archive pin arrives from the source process.
  await verifySyntheticHistoricalEpoch1(observed,reader,journal,archive);
  assert.equal(b.writes,before.writes);assert.equal(b.generates,before.generates);
  return{entries:observed.entryCount,checkpointSequence:1,savedEntry2Visible:true,head2Published:headPublished,verifiedHistoricalRoots:1,currentControlMismatchRefused:!headPublished,
   originalPublicationUnresolved:true,originalAcknowledgementReconstructed:false,executionAuthorized:false,sourceHostLossProven:false};
 }finally{clients.s3.destroy();clients.kms.destroy();}
}
/** Recovery after the original epoch-2 caller was genuinely killed. Current
 * recovery must stay unresolved; an earlier root is historical, not a fallback. */
export async function inspectSyntheticEpochCallerLossRecovery(descriptor,path){
 const bootstrap=readSyntheticEpochBootstrap(path);assert.equal(bootstrap.trustedCheckpoint.sequence,2);
 const b=connectSyntheticCustody(descriptor,bootstrap.sessionId,bootstrap.archiveConfiguration),before={writes:b.writes,generates:b.generates},clients={s3:b.s3(),kms:b.kms()};
 try{
  const s=storage(bootstrap.archiveConfiguration),reader=new S3ManagedRecoveryEpochReader(s,credentials,clients.s3),catalogue=new ManagedRecoveryEpochCatalogue(epochCatalogueConfiguration(bootstrap),reader),journal=new ManagedCandidateCaptureJournal(s,credentials,clients.s3),archive=new ArchivedRecoverySets(bootstrap.archiveConfiguration,credentials,clients);
  const observed=await journal.inspectAnchoredCurrentRecovery(catalogue,new S3ManagedMaintenanceControl(s,credentials,clients.s3),archive);
  assert.equal(observed.epochCatalogue.entryCount,2);assert.equal(observed.bootstrap.plan.maintenanceEpoch,2);assert.equal(observed.records.length,1);assert.equal(observed.unresolvedCommonCandidates,1);
  const record=observed.records[0];assert.equal(record.rootStatus,'NOT_LISTED_AT_BOUNDARY');assert.equal(record.unresolved,true);assert.equal(record.job.state,'REQUESTED_ONLY');assert.equal(record.job.serviceIdentity.format,2);
  const daemon=record.job.daemon;assert.equal(daemon.state,'UNRESOLVED_REQUESTS');assert.equal(daemon.responseCount,0);assert.equal(daemon.ownerBindingCount,1);assert.ok(daemon.ownerOutcomeCount<=1);assert.equal(daemon.endPin,null);
  for(const field of ['pendingRequestResolved','completeResourceInventory','originalAcknowledgementReconstructed','cleanupAuthorized','actionAuthorized'])assert.equal(daemon[field],false);
  for(const field of ['currentTenantAuthorityVerified','sourceHostLossProven','actionAuthorized','reopeningAuthorized','independentEpochProviderVerified'])assert.equal(observed[field],false);
  await verifySyntheticHistoricalEpoch1(observed.epochCatalogue,reader,journal,archive);
  assert.equal(b.writes,before.writes);assert.equal(b.generates,before.generates);
  return{entries:2,latestEpoch:2,checkpointSequence:2,currentUnresolvedCandidates:1,currentVerifiedRoots:0,verifiedHistoricalRoots:1,originalAcknowledgementReconstructed:false,cleanupAuthorized:false,executionAuthorized:false,sourceHostLossProven:false};
 }finally{clients.s3.destroy();clients.kms.destroy();}
}
/** New clients and the recovery-only capability; checkpoint is supplied by the
 * external supervisor from original IPC ACKs, never learned from source storage. */
export async function inspectSyntheticEpochRecovery(descriptor,path){
 const bootstrap=readSyntheticEpochBootstrap(path);assert.equal(bootstrap.trustedCheckpoint.sequence,2);
 const b=connectSyntheticCustody(descriptor,bootstrap.sessionId,bootstrap.archiveConfiguration),before={writes:b.writes,generates:b.generates},clients={s3:b.s3(),kms:b.kms()};
 try{
  const s=storage(bootstrap.archiveConfiguration),reader=new S3ManagedRecoveryEpochReader(s,credentials,clients.s3),catalogue=new ManagedRecoveryEpochCatalogue(epochCatalogueConfiguration(bootstrap),reader);
  const observation=await new ManagedCandidateCaptureJournal(s,credentials,clients.s3).inspectAnchoredCurrentRecovery(catalogue,new S3ManagedMaintenanceControl(s,credentials,clients.s3),new ArchivedRecoverySets(bootstrap.archiveConfiguration,credentials,clients));
  assert.equal(observation.epochCatalogue.entryCount,2);assert.equal(observation.bootstrap.plan.maintenanceEpoch,2);assert.equal(observation.epochCatalogueBoundAtReadBoundaries,true);
  assert.equal(observation.records.length,1);assert.equal(observation.records[0].rootStatus,'ARCHIVE_VERIFIED_QUARANTINE_ONLY');assert.equal(observation.unresolvedCommonCandidates,0);
  for(const field of ['currentTenantAuthorityVerified','sourceHostLossProven','actionAuthorized','reopeningAuthorized','independentEpochProviderVerified'])assert.equal(observation[field],false);
  assert.equal(observation.epochCatalogue.originalAcknowledgementReconstructed,false);assert.equal(observation.epochCatalogue.externalCheckpointEnforced,true);
  assert.equal(b.writes,before.writes);assert.equal(b.generates,before.generates);
  return{entries:observation.epochCatalogue.entryCount,latestEpoch:observation.bootstrap.plan.maintenanceEpoch,verifiedCurrentRoots:1,externalOriginalAckCheckpoint:true};
 }finally{clients.s3.destroy();clients.kms.destroy();}
}
/** Generic cold catalogue probe lets the production catalogue enforce a supplied
 * checkpoint (including a deliberately future one), without a fixture shortcut. */
export async function observeSyntheticEpochCatalogue(descriptor,path){
 const bootstrap=readSyntheticEpochBootstrap(path),b=connectSyntheticCustody(descriptor,bootstrap.sessionId,bootstrap.archiveConfiguration),client=b.s3(),before={writes:b.writes,generates:b.generates};
 try{
  const reader=new S3ManagedRecoveryEpochReader(storage(bootstrap.archiveConfiguration),credentials,client),catalogue=new ManagedRecoveryEpochCatalogue(epochCatalogueConfiguration(bootstrap),reader),observed=await catalogue.observe();
  assert.equal(b.writes,before.writes);assert.equal(b.generates,before.generates);
  return{entries:observed.entryCount,executionAuthorized:observed.executionAuthorized,originalAcknowledgementReconstructed:observed.originalAcknowledgementReconstructed};
 }finally{client.destroy();}
}
