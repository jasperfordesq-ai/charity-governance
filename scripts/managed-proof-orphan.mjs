import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {containmentUnit,requireOriginalControlGroup,currentContainmentBootId,inspectContainmentUnit,observeOriginalControlGroup} from './managed-proof-systemd-containment.mjs';
import {openManagedCaptureWorkspace} from './managed-capture-workspace.mjs';
import {inspectManagedProofJob} from './managed-proof-job.mjs';
import {inspectManagedDaemonRequests} from './postgres-backup.mjs';
const refuse=()=>new Error('Original cohort inspection unresolved; preserve original records without cleanup or replay');
function currentUnit(unit){
 const r=spawnSync('systemctl',['--user','show',unit,'--property=LoadState','--value'],{encoding:'utf8',timeout:15000,maxBuffer:4096});
 if(!r.error&&[0,1,4].includes(r.status)&&r.stdout.trim()==='not-found')return null;
 if(r.error||r.status!==0||r.stdout.trim()!=='loaded')throw refuse();return inspectContainmentUnit(unit);
}
/** Read-only after original byte-pin validation. No stop, reset, PID signal,
 * daemon reconciliation or inferred original acknowledgement is permitted. */
export function inspectOriginalProofCohort(identity,{
 platform=process.platform,uid=process.getuid?.(),boot=currentContainmentBootId,unitState=currentUnit,population=observeOriginalControlGroup,
}={}){
 const unit=containmentUnit(identity?.jobId);if(identity?.unit!==unit)throw refuse();
 const report=state=>({format:1,kind:'MANAGED_ORIGINAL_COHORT_OBSERVATION_V1',jobId:identity.jobId,unit,state,
  completeResourceInventory:false,pendingDaemonRequestsAccountedFor:false,cleanupAuthorized:false,executionAuthorized:false,actionAuthorized:false});
 if(identity.format===1&&identity.kind==='MANAGED_GUARDIAN_LIVE_BINDING_V1')return report('LEGACY_BINDING_UNVERIFIABLE');
 if(identity.format!==2||identity.kind!=='MANAGED_GUARDIAN_LIVE_BINDING_V2'||platform!=='linux'||!Number.isSafeInteger(uid)||uid<1||identity.uid!==uid
  ||typeof identity.bootId!=='string'||!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(identity.bootId))throw refuse();
 requireOriginalControlGroup(identity.controlGroup,unit,uid);
 if(boot()!==identity.bootId)return report('DIFFERENT_BOOT');
 const matches=value=>value===null||(value.InvocationID===identity.invocationId&&value.ExecMainStartTimestampMonotonic===identity.mainStartMonotonic
  &&(!value.ControlGroup||value.ControlGroup===identity.controlGroup)&&(value.MainPID==='0'||Number(value.MainPID)===identity.mainPid));
 const before=unitState(unit);if(!matches(before))return report('UNIT_IDENTITY_CHANGED');
 const group=population(identity.controlGroup,unit,uid);if(!['EMPTY','ABSENT','POPULATED'].includes(group))throw refuse();
 const after=unitState(unit);
 if(boot()!==identity.bootId||!matches(after)||JSON.stringify(before)!==JSON.stringify(after))return report('OBSERVATION_CHANGED');
 if(group==='POPULATED')return report(before?'ORIGINAL_COHORT_POPULATED':'UNIT_ABSENT_GROUP_POPULATED');
 if(before&&before.MainPID!=='0')return report('OBSERVATION_INCONSISTENT');
 return report(before?'ORIGINAL_COHORT_EMPTY':'UNIT_ABSENT_GROUP_EMPTY');
}
export async function inspectSavedProofOrphan(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['parentDirectory','workspaceRoot','requestPin','expectedScope','servicePin','observationPin'].includes(k))
  ||typeof input.parentDirectory!=='string'||typeof input.workspaceRoot!=='string')throw refuse();
 const workspace=await openManagedCaptureWorkspace(input.parentDirectory,input.workspaceRoot);
 try{
  const job=await inspectManagedProofJob(workspace,input);
  return {...job,cohort:job.serviceIdentity?inspectOriginalProofCohort(job.serviceIdentity):null,
   daemonRequests:job.serviceIdentity?inspectManagedDaemonRequests({root:input.workspaceRoot,jobId:job.jobId,inputDigest:job.serviceIdentity.inputDigest}):null,
   completeResourceInventory:false,cleanupAuthorized:false};
 }finally{await workspace.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  if(process.argv.length!==2)throw refuse();const chunks=[];let size=0;
  try{for await(const b of process.stdin){size+=b.length;if(size>16384)throw refuse();chunks.push(Buffer.from(b));}
   const report=await inspectSavedProofOrphan(JSON.parse(Buffer.concat(chunks).toString('utf8')));process.stdout.write(JSON.stringify(report)+'\n');
  }finally{for(const b of chunks)b.fill(0);}
 }catch{process.stderr.write(refuse().message+'\n');process.exitCode=1;}
}
