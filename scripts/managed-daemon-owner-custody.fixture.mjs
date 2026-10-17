import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {backend,config,credentials} from '../apps/api/dist/tests/fixtures/archived-custody.js';
import {ManagedProofJobCustody} from '../apps/api/dist/services/managed-proof-job-custody.js';
import {jobScope} from '../apps/api/dist/services/managed-proof-job-contract.js';
import {DEFAULT_POSTGRES_IMAGE,planManagedProofStorage} from './postgres-backup.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
export async function originalOwnerProbeCustody(request,source,args){
 const b=backend(),client=b.s3(),artifact=value=>{const body=JSON.stringify(value);return{body,sha256:hash(body),byteLength:Buffer.byteLength(body)};};
 const binding={format:3,kind:'MANAGED_QUARANTINED_COMMON_CAPTURE_V3',installationId:config.installationId,sourceSha:request.sourceSha,maintenanceEpoch:1,
  candidateId:randomUUID(),attemptId:randomUUID(),controlRevision:'1'.repeat(64),captureConfigurationDigest:'2'.repeat(64),metadataWindowConfigurationDigest:'3'.repeat(64),
  journalConfigurationDigest:'4'.repeat(64),archiveConfigurationDigest:'5'.repeat(64),planDigest:'6'.repeat(64)};
 const original={kind:'BASELINE',versionId:'synthetic-original-candidate',sha256:hash('original synthetic candidate'),byteLength:100};
 let live=true;const create=()=>new ManagedProofJobCustody({installationId:config.installationId,bucket:config.bucket,accountId:config.accountId,kmsKeyArn:config.storageKeyArn},
  binding,credentials,client,p=>live&&JSON.stringify(p)===JSON.stringify(original)),session=create(),inputDigest=hash(JSON.stringify(request));
 try{
  const local=artifact({format:1,kind:'MANAGED_IMPORTED_PROOF_JOB_V1',jobId:request.jobId,scope:jobScope(binding,original),sourceSha:request.sourceSha,
   workspaceDigest:hash('synthetic workspace'),snapshotDigest:hash('synthetic snapshot'),argumentsDigest:hash(JSON.stringify(args)),createdAt:new Date().toISOString(),
   state:'REQUESTED_ONLY',executionAuthorized:false,publicationAuthorized:false,actionAuthorized:false});
  await session.reserve(local,original);
  await session.bindService(artifact({format:1,kind:'MANAGED_IMPORTED_PROOF_SERVICE_V1',jobId:request.jobId,requestPin:{sha256:local.sha256,byteLength:local.byteLength},
   identity:{format:2,kind:'MANAGED_GUARDIAN_LIVE_BINDING_V2',jobId:request.jobId,unit:source.Id,invocationId:source.InvocationID,uid:process.getuid(),mainPid:Number(source.MainPID),
    mainStartMonotonic:source.ExecMainStartTimestampMonotonic,sourceSha:request.sourceSha,inputDigest,bootId:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),
    controlGroup:source.ControlGroup,executionAuthorized:false,actionAuthorized:false},executionAuthorized:false,publicationAuthorized:false,actionAuthorized:false}),original);
  const header=artifact({format:2,kind:'MANAGED_DAEMON_REQUEST_HEADER_V2',jobId:request.jobId,inputDigest,image:DEFAULT_POSTGRES_IMAGE,imageVolumeTargets:['/var/lib/postgresql/data']});
  const intent=artifact({format:2,kind:'MANAGED_DAEMON_REQUEST_INTENT_V2',jobId:request.jobId,sequence:1,previousDigest:header.sha256,
   operation:'run',target:args[args.indexOf('--name')+1],storagePlan:planManagedProofStorage(args,request.jobId),argumentsDigest:hash('CHARITYPILOT_DAEMON_ARGUMENTS_V1\n'+request.jobId+'\n'+JSON.stringify(args))});
  return{header,intent,inputDigest,artifact,session,original,
   async inspect(){live=false;session.closeExecution();const before=b.writes,saved=await create().discover(original);
    if(b.writes!==before||b.generates!==0||saved.daemon?.ownerBindingCount!==1||saved.daemon.independentOwnerDispatchVerified!==false||saved.originalAcknowledgementReconstructed!==false)throw new Error('Synthetic original owner evidence unresolved');return saved;},
   close(){live=false;session.closeExecution();client.destroy();b.close();}};
 }catch(error){client.destroy();b.close();throw error;}
}
