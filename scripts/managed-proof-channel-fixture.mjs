import {fileURLToPath} from 'node:url';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {createManagedGuardianChannel,connectManagedGuardianParent} from './managed-proof-channel.mjs';
import {runManagedProofGuardian} from './managed-proof-guardian.mjs';
// Synthetic transport/guardian cohort only; no Docker/provider/application calls.
if(process.argv[2]==='--service'&&process.argv.length===4){
 const parent=await connectManagedGuardianParent(process.argv[3]);
 const receive=parent.receive;parent.receive=async()=>{const request=await receive();return{...request,env:{...request.env,CHARITYPILOT_SYNTHETIC_CHANNEL_SOCKET:process.argv[3]}};};
 await runManagedProofGuardian({parent,workerPath:fileURLToPath(new URL('./managed-proof-channel-worker-fixture.mjs',import.meta.url)),
  reconcile:()=>({removedCount:0,observedJobContainersAbsent:true,actionAuthorized:false}),
  onTerminal:value=>writeFileSync(join(dirname(process.argv[3]),'guardian-result.json'),JSON.stringify(value),{flag:'wx',mode:0o600})});
}else if(process.argv[2]==='--parent'&&process.argv.length===5){
 const jobId=process.argv[3],mode=process.argv[4];if(!['success','hold','deny'].includes(mode))throw new Error();
 const input=Buffer.from(JSON.stringify({jobId,mode:mode==='deny'?'success':mode}));let channel;
 try{
  channel=await createManagedGuardianChannel({jobId,sourceSha:'1'.repeat(40),input,env:{PATH:process.env.PATH??'/usr/bin:/bin'},timeoutMs:30000,
   authorizeInvocation:identity=>{writeFileSync(join(dirname(channel.path),'identity-observed.json'),JSON.stringify(identity),{flag:'wx',mode:0o600});return mode!=='deny';}});
  process.stdout.write(JSON.stringify({path:channel.path,unit:channel.unit})+'\n');
  const result=await channel.result;
  process.stdout.write(JSON.stringify({acknowledged:result.guardianAcknowledged,identity:result.identity,terminal:JSON.parse(readFileSync(join(dirname(channel.path),'guardian-result.json'),'utf8'))})+'\n');
 }catch{if(mode==='deny'&&channel)process.stdout.write(JSON.stringify({refusedBeforeWorker:!existsSync(join(dirname(channel.path),'worker.ready.json')),identityObserved:existsSync(join(dirname(channel.path),'identity-observed.json'))})+'\n');process.exitCode=1;}
 finally{input.fill(0);await channel?.close();}
}else throw new Error('Synthetic channel arguments refused');
