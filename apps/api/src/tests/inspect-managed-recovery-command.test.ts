import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inspectManagedRecovery,summariseManagedRecoveryInspection} from '../jobs/inspect-managed-recovery.js';
import {config as archive} from './fixtures/archived-custody.js';
import type {ManagedCandidateCaptureJournal} from '../services/managed-candidate-capture-journal.js';
type Inspection=Awaited<ReturnType<ManagedCandidateCaptureJournal['inspectCurrentRecovery']>>;
const configuration={archive,control:{installationId:archive.installationId,bucket:archive.bucket,accountId:archive.accountId,kmsKeyArn:archive.storageKeyArn},
 minimumEpoch:1,credentials:{accessKeyId:'synthetic',secretAccessKey:'SYNTHETIC_CREDENTIAL_DO_NOT_LOG'}};
function observation(unresolved=false,empty=false){return{
 kind:'MANAGED_CURRENT_RECOVERY_INSPECTION_V1',restoreMode:'QUARANTINE_ONLY',actionAuthorized:false,executionAuthorized:false,archivedSetAdmitted:false,
 bootstrap:{plan:{installationId:'fixture',sourceSha:'1'.repeat(40),maintenanceEpoch:1},head:{revision:'2'.repeat(64),value:{planDigest:'3'.repeat(64)}},
  PRIVATE_EXTRA_DOCUMENT:'SYNTHETIC_PRIVATE_BODY'},
 records:empty?[]:[{kind:'COMMON_CAPTURE_RECOVERY_OBSERVATION',candidateId:'11111111-1111-4111-8111-111111111111',jobStatus:unresolved?'UNRESOLVED':'SAVED_RECORDS_VERIFIED',
  rootStatus:'ARCHIVE_VERIFIED_QUARANTINE_ONLY',unresolved,job:{PRIVATE_SECRET:'SYNTHETIC_CREDENTIAL_DO_NOT_LOG'},root:{PRIVATE_CONTENT:'SYNTHETIC_PRIVATE_BODY'}}],
 unresolvedCommonCandidates:unresolved?1:0,
 } as unknown as Inspection;}

test('diagnostic summary keeps failures quarantined and excludes credentials, provider payloads and document bodies',async()=>{
 for(const [unresolved,empty] of [[false,false],[true,false],[false,true]]){
  const summary=await inspectManagedRecovery(configuration,async()=>observation(unresolved,empty));
  assert.equal(summary.diagnosticStatus,unresolved||empty?'QUARANTINED_UNRESOLVED':'AVAILABLE_EVIDENCE_VERIFIED');
  const body=JSON.stringify(summary);for(const secret of ['SYNTHETIC_CREDENTIAL','SYNTHETIC_PRIVATE_BODY','PRIVATE_EXTRA_DOCUMENT'])assert.equal(body.includes(secret),false);
  for(const key of ['currentTenantAuthorityVerified','sourceHostLossProven','writerFencingVerified','daemonRequestsAccountedFor','archivedSetAdmitted','cleanupAuthorized','executionAuthorized','actionAuthorized'] as const)assert.equal(summary[key],false);
 }
 assert.throws(()=>summariseManagedRecoveryInspection({...observation(),unresolvedCommonCandidates:1}));
 assert.throws(()=>summariseManagedRecoveryInspection({...observation(),actionAuthorized:true} as unknown as Inspection));
});

test('invalid scope, missing explicit credentials, epoch, endpoint and local pin injection refuse before inspection',async()=>{
 let calls=0;const inspect=async()=>{calls++;return observation();};
 for(const bad of [{...configuration,credentials:undefined},{...configuration,minimumEpoch:0},{...configuration,minimumEpoch:1.5},
  {...configuration,endpoint:'http://localhost'},{...configuration,candidateId:'local-guess'},
  {...configuration,control:{...configuration.control,installationId:'another'}},
  {...configuration,credentials:{...configuration.credentials,secretAccessKey:'SYNTHETIC\nDO_NOT_LOG'}},
  {...configuration,archive:{...archive,storageKeyArn:archive.dataKeyArn}}])await assert.rejects(inspectManagedRecovery(bad,inspect));
 assert.equal(calls,0);
});

test('real command refuses malformed/oversized input with generic errors and no secret echo or ambient credential fallback',()=>{
 const path=fileURLToPath(new URL('../jobs/inspect-managed-recovery.js',import.meta.url));
 const run=(input:string,args=['--stdin'])=>spawnSync(process.execPath,[path,...args],{input,encoding:'utf8',timeout:10000,
  env:{...process.env,AWS_ACCESS_KEY_ID:'synthetic-ambient',AWS_SECRET_ACCESS_KEY:'SYNTHETIC_AMBIENT_MUST_NOT_BE_USED'}});
 for(const body of ['{"credentials":"SYNTHETIC_DO_NOT_ECHO"}',JSON.stringify({...configuration,credentials:undefined}),'x'.repeat(17000)]){
  const result=run(body);assert.equal(result.status,1);assert.equal(result.stdout,'');assert.equal(result.stderr,'Managed recovery inspection refused; retain quarantine\n');
 }
 assert.equal(run('',[]).status,1);
});
