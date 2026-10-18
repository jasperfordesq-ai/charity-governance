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
 try{
  for(const epoch of [1,2]){
   await proveManagedBackendMaintenance({...args,epochFixture:{epoch,custody,recordClosed:async control=>{
    const before=await catalogue.observe(),published=await publisher.publishClosedEpoch(control,custody.journal,custody.archive.configurationDigest(),before.head.revision);
    assert.equal(published.originalEntryAcknowledgementObserved,true);assert.equal(published.originalHeadAcknowledgementObserved,true);
    assert.equal(published.entryCount,epoch);assert.equal(published.latest.plan.maintenanceEpoch,epoch);
    const ack={kind:'ORIGINAL_SYNTHETIC_EPOCH_ACK_V1',sequence:epoch,maintenanceEpoch:epoch,entrySha256:published.head.head.entryPin.sha256,headRevision:published.head.revision,sourceSha:published.latest.plan.sourceSha};
    await new Promise((yes,no)=>process.send(ack,error=>error?no(error):yes()));
   }}});
   const observed=await custody.journal.inspectAnchoredCurrentRecovery(catalogue,new S3ManagedMaintenanceControl(storage(custody.config),credentials,custody.clients.s3),custody.archive);
   assert.equal(observed.epochCatalogue.entryCount,epoch);assert.equal(observed.bootstrap.plan.maintenanceEpoch,epoch);
   assert.equal(observed.records.length,1);assert.equal(observed.records[0].rootStatus,'ARCHIVE_VERIFIED_QUARANTINE_ONLY');assert.equal(observed.unresolvedCommonCandidates,0);
   assert.equal(observed.currentTenantAuthorityVerified,false);assert.equal(observed.actionAuthorized,false);
  }
  console.log('PASS two native epochs: shared original SDK custody, original publication ACKs exported before cold recovery; no production reopening');
 }finally{custody.close();}
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
