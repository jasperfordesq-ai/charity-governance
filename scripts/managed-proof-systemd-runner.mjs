import {spawnSync} from 'node:child_process';
import {readFileSync,realpathSync,existsSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createManagedGuardianChannel} from './managed-proof-channel.mjs';
import {containmentUnit,inspectContainmentUnit} from './managed-proof-systemd-containment.mjs';
const sourceRoot=fileURLToPath(new URL('..',import.meta.url)),guardian=fileURLToPath(new URL('./managed-proof-guardian.mjs',import.meta.url));
const modules=['managed-proof-systemd-runner.mjs','managed-proof-runner.mjs','managed-proof-guardian.mjs','managed-proof-worker.mjs','managed-proof-channel.mjs','managed-proof-systemd-containment.mjs','managed-proof-job.mjs','postgres-backup.mjs'];
const no=()=>new Error('Contained source proof unresolved; preserve job and original scope without replay');
function command(binary,args){const r=spawnSync(binary,args,{cwd:sourceRoot,encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024,
 env:Object.fromEntries(Object.entries(process.env).filter(([k])=>!(/^(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH)$/i).test(k)))});if(r.error||r.status!==0)throw no();return r.stdout.trim();}
export function verifyContainedExecutorSource(sourceSha){
 if(typeof sourceSha!=='string'||!/^[a-f0-9]{40}$/.test(sourceSha)||command('git',['rev-parse','HEAD'])!==sourceSha
  ||!['https://github.com/jasperfordesq-ai/charity-governance','https://github.com/jasperfordesq-ai/charity-governance.git'].includes(command('git',['remote','get-url','origin'])))throw no();
 for(const name of modules){
  const path=join(sourceRoot,'scripts',name);if(realpathSync(path)!==path)throw no();
  const bytes=spawnSync('git',['show',sourceSha+':scripts/'+name],{cwd:sourceRoot,timeout:15000,maxBuffer:2*1024*1024,stdio:'pipe'});
  if(bytes.status!==0||bytes.error||!Buffer.isBuffer(bytes.stdout)||!readFileSync(path).equals(bytes.stdout))throw no();
 }
}
function groupEmpty(path){
 if(!path)return false;const root='/sys/fs/cgroup'+path;
 try{if(!existsSync(root))return true;if(realpathSync(root)!==root)throw no();return readFileSync(join(root,'cgroup.procs'),'utf8').trim()==='';}
 catch(e){if(e.code==='ENOENT')return true;throw no();}
}
function managerState(unit){
 const r=spawnSync('systemctl',['--user','show',unit,'--property=LoadState','--value'],{encoding:'utf8',timeout:15000,maxBuffer:4096});
 if(!r.error&&[0,1,4].includes(r.status)&&r.stdout.trim()==='not-found')return'ABSENT';
 if(r.status!==0||r.error||r.stdout.trim()!=='loaded')throw no();return'LOADED';
}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
/** Fixed production launcher; dependency seams belong to source-only fixtures. */
export async function superviseContainedManagedProof({jobId,sourceSha,input,env,authorizeInvocation,timeoutMs=90000,signal},{assertSource=verifyContainedExecutorSource,guardianPath=guardian,onScope,launch=args=>command('systemd-run',args)}={}){
 if(process.platform!=='linux'||process.getuid()===0||!Number.isSafeInteger(timeoutMs)||timeoutMs<50||timeoutMs>1200000)throw no();
 signal?.throwIfAborted();const unit=containmentUnit(jobId);assertSource(sourceSha);
 command('systemctl',['--user','show','--property=Version','--value']);if(!readFileSync('/sys/fs/cgroup/cgroup.controllers','utf8').trim()||managerState(unit)!=='ABSENT')throw no();
 const workerEnv=Object.fromEntries(Object.entries(env??{}).filter(([k])=>!(/^(NODE_OPTIONS|NODE_PATH|INVOCATION_ID|LISTEN_FDS|LISTEN_PID|LD_PRELOAD|LD_LIBRARY_PATH|CHARITYPILOT_INTERNAL_GUARDIAN_TIMEOUT_MS)$/i).test(k)));
 let channel,attempted=false,identity,originalGroup,cohortTerminated=false,normal=false,cleanupCertain=false,result;
 try{
  channel=await createManagedGuardianChannel({jobId,sourceSha,input,env:workerEnv,timeoutMs,signal,authorizeInvocation:async value=>{
   const current=inspectContainmentUnit(unit);if(current.InvocationID!==value.invocationId||Number(current.MainPID)!==value.mainPid||!current.ControlGroup)throw no();
   identity=value;originalGroup=current.ControlGroup;
   // Verify actual kernel resource caps before releasing any work.
   const root='/sys/fs/cgroup'+originalGroup;
   if(!/^NoNewPrivs:\s+1$/m.test(readFileSync('/proc/'+value.mainPid+'/status','utf8')))throw no();
   if(readFileSync(join(root,'memory.max'),'utf8').trim()!=='1073741824'||readFileSync(join(root,'pids.max'),'utf8').trim()!=='128')throw no();
   const cpu=readFileSync(join(root,'cpu.max'),'utf8').trim().split(/\s+/).map(Number);if(cpu.length!==2||!cpu.every(Number.isSafeInteger)||cpu[0]<1||cpu[1]<1||cpu[0]>cpu[1])throw no();
   return await authorizeInvocation(value);
  }});
  writeFileSync(join(dirname(channel.path),'launch-request.json'),JSON.stringify({format:1,kind:'MANAGED_CONTAINED_LAUNCH_REQUEST_V1',jobId,unit,sourceSha,executionAuthorized:false,actionAuthorized:false}),{flag:'wx',mode:0o600});
  await onScope?.({unit,path:channel.path});signal?.throwIfAborted();attempted=true;
  launch(['--user','--quiet','--unit='+unit,'--service-type=exec',
   '--property=RemainAfterExit=yes','--property=KillMode=control-group','--property=Restart=no','--property=RuntimeMaxSec='+Math.ceil((timeoutMs+15000)/1000)+'s',
   '--property=TimeoutStopSec=5s','--property=NoNewPrivileges=yes','--property=MemoryMax=1G','--property=TasksMax=128','--property=CPUQuota=100%',
   '--property=UnsetEnvironment=NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH','--property=StandardOutput=null','--property=StandardError=null',
   process.execPath,guardianPath,'--systemd-socket',channel.path]);
  result=await channel.result;
  // RemainAfterExit retains the exact invocation until terminal observation.
  for(let i=0;i<100;i++){
   signal?.throwIfAborted();const value=inspectContainmentUnit(unit);
   if(!identity||value.InvocationID!==identity.invocationId||value.ExecMainStartTimestampMonotonic!==identity.mainStartMonotonic)throw no();
   if(value.MainPID==='0'){
    if(value.ActiveState!=='active'||value.SubState!=='exited'||value.Result!=='success'||value.ExecMainCode!=='1'||value.ExecMainStatus!=='0'||!groupEmpty(originalGroup))throw no();
    cohortTerminated=true;normal=true;break;
   }
   await pause(100);
  }
  if(!normal)throw no();
 }catch{normal=false;}
 finally{
  // Closing the live socket first asks a surviving guardian to cancel. Stop is
  // manager scoped, never an action on a recovered numeric process identifier.
  let channelClosed=true;try{await channel?.close({preserve:true});}catch{channelClosed=false;}
  try{
   if(attempted&&managerState(unit)==='LOADED'){
    const current=inspectContainmentUnit(unit);if(identity&&current.InvocationID!==identity.invocationId)throw no();
    originalGroup??=current.ControlGroup||undefined;command('systemctl',['--user','stop',unit]);
   }
   if(managerState(unit)==='LOADED'){
    const stopped=inspectContainmentUnit(unit);if(stopped.MainPID!=='0'||!['inactive','failed'].includes(stopped.ActiveState)||(identity&&stopped.InvocationID!==identity.invocationId))throw no();
   }
   if(originalGroup&&!groupEmpty(originalGroup))throw no();
   cohortTerminated=attempted&&!!originalGroup&&groupEmpty(originalGroup);cleanupCertain=channelClosed&&(!attempted||cohortTerminated);
   if(attempted){const reset=spawnSync('systemctl',['--user','reset-failed',unit],{encoding:'utf8',timeout:15000,maxBuffer:4096});if(reset.status!==0&&!/not loaded|not found/.test(reset.stderr??''))throw no();}
  }catch{cleanupCertain=false;cohortTerminated=false;}
  if(cleanupCertain)await channel?.close();
 }
 if(!normal||!cleanupCertain||!cohortTerminated){const error=no();error.cohortTerminated=cohortTerminated;throw error;}
 return{...result,kernelContained:true,serviceTerminated:true,originalCgroupEmpty:true,daemonFenced:false,sourceHostLossProven:false,actionAuthorized:false};
}
