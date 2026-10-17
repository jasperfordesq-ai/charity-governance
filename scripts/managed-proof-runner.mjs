import {recordManagedProofJob} from './managed-proof-job.mjs';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {prepareLocalDockerCommand,captureHelperImplementationBinding} from './postgres-backup.mjs';
import {superviseContainedManagedProof} from './managed-proof-systemd-runner.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const worker=fileURLToPath(new URL('./managed-proof-worker.mjs',import.meta.url));
const jobPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const unresolved=()=>new Error('Managed source proof unresolved; preserve quarantine and partial artifacts');
function requireJob(id){if(typeof id!=='string'||!jobPattern.test(id))throw unresolved();return id;}
function docker(args,env){
 const p=prepareLocalDockerCommand(['docker',...args],env);
 const r=spawnSync(p.command[0],p.command.slice(1),{env:p.environment,encoding:'utf8',windowsHide:true,stdio:'pipe',timeout:15000,maxBuffer:65536});
 if(r.status!==0||r.error||typeof r.stdout!=='string')throw unresolved();return r.stdout;
}
/** Remove only this live invocation's exact labelled IDs, never a source container. */
export function reconcileManagedProofContainers(jobId,env,{run=docker}={}){
 requireJob(jobId);const list=()=>{
  const body=run(['ps','-a','--no-trunc','--filter','label=charitypilot.restore-proof=true','--filter','label=charitypilot.managed-proof-job='+jobId,'--format','{{.ID}}'],env);
  if(typeof body!=='string'||body.length>65536)throw unresolved();
  const ids=body.trim()?body.trim().split(/\r?\n/):[];
  if(ids.length>16||new Set(ids).size!==ids.length||ids.some(id=>!(/^[a-f0-9]{64}$/).test(id)))throw unresolved();return ids;
 };
 const ids=list();for(const id of ids){
  const raw=run(['inspect','--format','{{json .}}',id],env);if(typeof raw!=='string'||raw.length>65536)throw unresolved();
  const v=JSON.parse(raw),labels=v.Config?.Labels;
  if(v.Id!==id||labels?.['charitypilot.restore-proof']!=='true'||labels?.['charitypilot.managed-proof-job']!==jobId
   ||!(/^\/charitypilot-(source-snapshot|dump-descriptor|isolated-restore|restore-loader|restored-snapshot)-[0-9]+-[0-9]+-[a-f0-9]{8}$/).test(v.Name))throw unresolved();
 }
 // Refuse the whole batch before mutation if any member is not this job's tool.
 for(const id of ids)run(['rm','--force',id],env);
 if(list().length)throw unresolved();return{removedCount:ids.length,observedJobContainersAbsent:true,actionAuthorized:false};
}
async function killOwnedTree(child){
 if(!child.pid)return;
 if(process.platform==='win32'){
  // Tree termination must target the still-owned live parent, never a saved PID.
  if(child.exitCode!==null||child.signalCode!==null)return;
  await new Promise((resolve,reject)=>{
   const k=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
   const timer=setTimeout(()=>{k.kill();reject(unresolved());},10000);
   k.once('error',()=>{clearTimeout(timer);reject(unresolved());});
   k.once('close',code=>{clearTimeout(timer);if(code===0||child.exitCode!==null||child.signalCode!==null)resolve();else reject(unresolved());});
  });
 }else{
  try{process.kill(-child.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw unresolved();}
 }
}
/** Internal supervisor. Dependencies are for actual-process synthetic fault tests. */
export async function superviseManagedProofProcess({input,env,signal,timeoutMs=90000},{start=spawn,terminate=killOwnedTree,onStderr}={}){
 if(!Buffer.isBuffer(input)||input.length<1||input.length>16384||!Number.isSafeInteger(timeoutMs)||timeoutMs<50||timeoutMs>1200000)throw unresolved();
 signal?.throwIfAborted();let child;
 try{child=start(process.execPath,[worker],{cwd:root,env,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});}catch{throw unresolved();}
 return new Promise((resolve,reject)=>{
  let stopped=false,exited=false,closed=false,settled=false,outputBytes=0,errorBytes=0,killPromise,finishTimer;const chunks=[];
  const fail=()=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(finishTimer);signal?.removeEventListener('abort',stop);child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();reject(unresolved());};
  const stop=()=>{if(stopped)return;stopped=true;child.stdin.destroy();
   killPromise=Promise.resolve().then(()=>terminate(child));void killPromise.catch(()=>{});
   finishTimer=setTimeout(fail,15000);
  };
  const timer=setTimeout(stop,timeoutMs);
  child.stdin.on('error',stop);child.stdout.on('error',stop);child.stderr.on('error',stop);
  child.once('error',stop);
  child.stdout.on('data',b=>{outputBytes+=b.length;if(outputBytes>4096)stop();else chunks.push(Buffer.from(b));});
  child.stderr.on('data',b=>{errorBytes+=b.length;if(onStderr&&errorBytes<=65536){const copy=Buffer.from(b);try{onStderr(copy);}catch{stop();}finally{copy.fill(0);}}if(errorBytes>65536)stop();});
  child.once('exit',()=>{exited=true;if(!closed){finishTimer??=setTimeout(stop,1000);}});
  child.once('close',async(code,exitSignal)=>{
   closed=true;clearTimeout(timer);clearTimeout(finishTimer);signal?.removeEventListener('abort',stop);
   try{
    if(killPromise)await killPromise;
    if(stopped||signal?.aborted||!exited||code!==0||exitSignal||errorBytes||outputBytes>4096)throw unresolved();
    const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(JSON.stringify(value)!==JSON.stringify({format:1,kind:'MANAGED_IMPORTED_PROOF_WORKER_V1',ok:true}))throw unresolved();
    if(!settled){settled=true;resolve({workerExited:true,workerAcknowledged:true,actionAuthorized:false});}
   }catch{fail();}finally{for(const b of chunks)b.fill(0);}
  });
  signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
  if(!stopped)child.stdin.end(input);
 });
}
/** The calling process never kills a recovered PID. A live IPC guardian owns
 * the worker handle and performs cancellation/cleanup after parent loss. */
export async function superviseManagedProofGuardian(options,{guardianPath=fileURLToPath(new URL('./managed-proof-guardian.mjs',import.meta.url)),onStderr}={}){
 const terminate=child=>new Promise((resolve,reject)=>{
  if(child.exitCode!==null||child.signalCode!==null){resolve();return;}
  let settled=false;const done=error=>{if(settled)return;settled=true;clearTimeout(timer);child.removeListener('close',closed);error?reject(unresolved()):resolve();};
  const closed=()=>done();const timer=setTimeout(()=>{if(child.connected)child.disconnect();done(unresolved());},12000);
  child.once('close',closed);
  if(child.connected)child.send({kind:'CANCEL_MANAGED_PROOF_V1'},error=>{if(error&&!child.connected){/* disconnect also cancels in guardian */}});
 });
 return superviseManagedProofProcess(options,{onStderr,terminate,start(command,_args,settings){
  const env=Object.fromEntries(Object.entries(settings.env??process.env).filter(([key])=>key.toUpperCase()!=='CHARITYPILOT_INTERNAL_GUARDIAN_TIMEOUT_MS'));
  return spawn(command,[guardianPath],{...settings,env:{...env,CHARITYPILOT_INTERNAL_GUARDIAN_TIMEOUT_MS:String(options.timeoutMs??90000)},detached:true,windowsHide:true,stdio:['pipe','pipe','pipe','ipc']});
 }});
}
/** Dedicated original helper runner, not an arbitrary command execution API. */
export async function runManagedImportedProof({args,snapshot,databaseUrl,workspace,scope={kind:'STANDALONE_INTERNAL_PROOF'},jobCustody,diagnostics,signal,timeoutMs=90000,executionMode='KERNEL_CONTAINED'}){
 if(!['KERNEL_CONTAINED','INTERNAL_IPC_PROOF'].includes(executionMode)||(executionMode==='KERNEL_CONTAINED'&&(process.platform!=='linux'||process.getuid()===0)))throw unresolved();
 if(scope?.kind==='COMMON_CANDIDATE'&&(!jobCustody||typeof jobCustody.reserve!=='function'||typeof jobCustody.observe!=='function'))throw unresolved();
 if(executionMode==='KERNEL_CONTAINED'&&scope?.kind==='COMMON_CANDIDATE'&&typeof jobCustody?.bindService!=='function')throw unresolved();
 const jobId=randomUUID();let success=false,cleanup;
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!(/^(NODE_OPTIONS|NODE_PATH|DATABASE_URL)$/i).test(k)));
 env.DATABASE_URL=databaseUrl;
 if(typeof databaseUrl!=='string'||databaseUrl.length>8192||!Array.isArray(args)||args.some(v=>typeof v!=='string')||args[0]!=='prove-restore')throw unresolved();
 // Validate the original local Docker boundary before starting any worker.
 prepareLocalDockerCommand(['docker','version'],env);
 const helper=captureHelperImplementationBinding();if(!helper.sourceMatchesCommit||!helper.canonicalRepositoryMatched)throw unresolved();
 const hash=v=>createHash('sha256').update(v).digest('hex');
 const job=await recordManagedProofJob(workspace,{format:1,kind:'MANAGED_IMPORTED_PROOF_JOB_V1',jobId,scope,sourceSha:helper.commitSha,
  workspaceDigest:workspace.identityDigest(),snapshotDigest:hash('CHARITYPILOT_MANAGED_EXPORTED_SNAPSHOT_V1\n'+JSON.stringify(snapshot)),
  argumentsDigest:hash(JSON.stringify(args)),createdAt:new Date().toISOString(),state:'REQUESTED_ONLY',
  executionAuthorized:false,publicationAuthorized:false,actionAuthorized:false},signal);
 if(jobCustody)await jobCustody.reserve(job.requestArtifact);
 let result,boundService,cohortTerminated=executionMode==='INTERNAL_IPC_PROOF';
 const input=Buffer.from(JSON.stringify({args,snapshot,jobId}));
 try{
  if(executionMode==='KERNEL_CONTAINED'){
   await superviseContainedManagedProof({jobId,sourceSha:helper.commitSha,input,env,signal,timeoutMs,diagnostics,authorizeInvocation:async identity=>{
    boundService=await job.bindService(identity,input);if(jobCustody)await jobCustody.bindService(boundService.artifact);signal?.throwIfAborted();return true;
   }});cohortTerminated=true;
  }else await superviseManagedProofGuardian({input,env,signal,timeoutMs},{onStderr:diagnostics});success=true;
 }
 catch(error){if(executionMode==='KERNEL_CONTAINED')cohortTerminated=error?.cohortTerminated===true;throw unresolved();}
 finally{
  input.fill(0);
  if(!cohortTerminated){
   try{const failed=await job.observe('UNRESOLVED',false);if(jobCustody)await jobCustody.observe(failed.artifact);}catch{}throw unresolved();
  }
  try{cleanup=reconcileManagedProofContainers(jobId,env);}catch{
   try{const failed=await job.observe('UNRESOLVED',false);if(jobCustody)await jobCustody.observe(failed.artifact);}catch{}throw unresolved();
  }
  try{result=await job.observe(success&&cleanup.removedCount===0?'WORKER_EXIT_ACK_OBSERVED':'UNRESOLVED',true);if(jobCustody)await jobCustody.observe(result.artifact);}catch{throw unresolved();}
  // Residue after an apparently successful worker is an unresolved outcome too.
  if(success&&cleanup.removedCount!==0)throw unresolved();
 }
 return{jobId,requestPin:job.requestPin,observationPin:result.pin,servicePin:boundService?.pin??null,kernelContained:executionMode==='KERNEL_CONTAINED',
  directoryFlushSupported:job.directoryFlushSupported,workerExited:true,observedJobContainersAbsent:true,actionAuthorized:false};
}
