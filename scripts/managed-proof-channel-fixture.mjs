import {fileURLToPath} from 'node:url';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {createManagedGuardianChannel,connectManagedGuardianParent} from './managed-proof-channel.mjs';
import {runManagedProofGuardian} from './managed-proof-guardian.mjs';
import {createHash} from 'node:crypto';
import {createManagedCaptureWorkspace} from './managed-capture-workspace.mjs';
import {recordManagedProofJob,inspectManagedProofJob} from './managed-proof-job.mjs';
// Synthetic transport/guardian cohort only; no Docker/provider/application calls.
if(['--service','--systemd-socket'].includes(process.argv[2])&&process.argv.length===4){
 const parent=await connectManagedGuardianParent(process.argv[3]);
 let unresolvedRequests=false;
 const receive=parent.receive;parent.receive=async()=>{const request=await receive();unresolvedRequests=request.env.CHARITYPILOT_SYNTHETIC_UNRESOLVED_REQUEST==='1';return{...request,env:{...request.env,CHARITYPILOT_SYNTHETIC_CHANNEL_SOCKET:process.argv[3]}};};
 await runManagedProofGuardian({parent,workerPath:fileURLToPath(new URL('./managed-proof-channel-worker-fixture.mjs',import.meta.url)),
  reconcile:()=>({removedCount:0,observedJobContainersAbsent:true,actionAuthorized:false}),
  inspectRequests:()=>({mutatingRequestsObservedSuccessful:!unresolvedRequests}),
  onTerminal:value=>writeFileSync(join(dirname(process.argv[3]),'guardian-result.json'),JSON.stringify(value),{flag:'wx',mode:0o600})});
}else if(process.argv[2]==='--parent'&&process.argv.length===5){
 const jobId=process.argv[3],mode=process.argv[4];if(!['success','hold','deny'].includes(mode))throw new Error();
 const args=['prove-restore',mode==='deny'?'success':mode],snapshot={kind:'SYNTHETIC_CHANNEL_SNAPSHOT_V1'},hash=value=>createHash('sha256').update(value).digest('hex');
 const input=Buffer.from(JSON.stringify({args,snapshot,jobId}));let channel,workspace,job,bound;
 try{
  channel=await createManagedGuardianChannel({jobId,sourceSha:'1'.repeat(40),input,env:{PATH:process.env.PATH??'/usr/bin:/bin'},timeoutMs:30000,
   authorizeInvocation:async identity=>{
    if(!job)throw new Error();bound=await job.bindService(identity,input);
    const found=await inspectManagedProofJob(workspace,{requestPin:job.requestPin,expectedScope:{kind:'STANDALONE_INTERNAL_PROOF'},servicePin:bound.pin});
    if(!found.serviceSupplied||found.serviceIdentity.invocationId!==identity.invocationId||found.executionAuthorized!==false)throw new Error();
    writeFileSync(join(dirname(channel.path),'identity-observed.json'),JSON.stringify(identity),{flag:'wx',mode:0o600});return mode!=='deny';}});
  workspace=await createManagedCaptureWorkspace(dirname(channel.path));
  job=await recordManagedProofJob(workspace,{format:1,kind:'MANAGED_IMPORTED_PROOF_JOB_V1',jobId,scope:{kind:'STANDALONE_INTERNAL_PROOF'},sourceSha:'1'.repeat(40),
   workspaceDigest:workspace.identityDigest(),snapshotDigest:hash('CHARITYPILOT_MANAGED_EXPORTED_SNAPSHOT_V1\n'+JSON.stringify(snapshot)),argumentsDigest:hash(JSON.stringify(args)),
   createdAt:new Date().toISOString(),state:'REQUESTED_ONLY',executionAuthorized:false,publicationAuthorized:false,actionAuthorized:false});
  process.stdout.write(JSON.stringify({path:channel.path,unit:channel.unit})+'\n');
  const result=await channel.result;
  process.stdout.write(JSON.stringify({acknowledged:result.guardianAcknowledged,serviceBound:!!bound,identity:result.identity,terminal:JSON.parse(readFileSync(join(dirname(channel.path),'guardian-result.json'),'utf8'))})+'\n');
 }catch{if(mode==='deny'&&channel)process.stdout.write(JSON.stringify({refusedBeforeWorker:!existsSync(join(dirname(channel.path),'worker.ready.json')),identityObserved:existsSync(join(dirname(channel.path),'identity-observed.json'))})+'\n');process.exitCode=1;}
 finally{input.fill(0);await workspace?.close();await channel?.close();}
}else throw new Error('Synthetic channel arguments refused');
