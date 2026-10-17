import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {superviseManagedProofProcess,reconcileManagedProofContainers} from './managed-proof-runner.mjs';
const actualWorker=fileURLToPath(new URL('./managed-proof-worker.mjs',import.meta.url));
/** Fixed production CLI; dependency paths/callbacks are only for source fixtures.
 * IPC loss is cancellation, never permission to start or resume another job. */
export async function runManagedProofGuardian({workerPath=actualWorker,onTerminal}={}){
 if(!process.channel||!process.connected||typeof process.send!=='function'){process.exitCode=1;return;}
 const timeout=process.env.CHARITYPILOT_INTERNAL_GUARDIAN_TIMEOUT_MS??'90000',workerTimeoutMs=Number(timeout);
 if(!/^[0-9]+$/.test(timeout)||!Number.isSafeInteger(workerTimeoutMs)||workerTimeoutMs<50||workerTimeoutMs>1200000){process.exitCode=1;return;}
 const controller=new AbortController();let parentDisconnected=false,cancelled=false,owned,jobId,input,success=false,cleanup;
 const cancel=()=>{cancelled=true;controller.abort();};
 const disconnected=()=>{parentDisconnected=true;cancel();process.stdin.destroy();};
 const message=value=>{if(value?.kind==='CANCEL_MANAGED_PROOF_V1'&&Object.keys(value).length===1)cancel();else cancel();};
 process.on('disconnect',disconnected);process.on('message',message);
 // A dead parent also closes the output pipes; that must not bypass cleanup.
 const broken=()=>{if(!process.connected)disconnected();else cancel();};
 process.stdout.on('error',broken);process.stderr.on('error',broken);process.stdin.on('error',()=>{});
 const startup=setTimeout(()=>{cancel();process.stdin.destroy();},15000);
 const chunks=[];let size=0;
 try{
  for await(const b of process.stdin){size+=b.length;if(size>16384)throw new Error();chunks.push(Buffer.from(b));}
  clearTimeout(startup);controller.signal.throwIfAborted();if(!process.connected)throw new Error();
  input=Buffer.concat(chunks);const value=JSON.parse(input.toString('utf8'));
  if(typeof value?.jobId!=='string'||!(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/).test(value.jobId))throw new Error();jobId=value.jobId;
  await superviseManagedProofProcess({input,env:process.env,signal:controller.signal,timeoutMs:workerTimeoutMs},{
   start(command,_args,settings){owned=spawn(command,[workerPath],settings);return owned;},
   onStderr:b=>{if(process.connected)process.stderr.write(b.toString('utf8'));}
  });success=true;
 }catch{success=false;}
 finally{
  clearTimeout(startup);input?.fill(0);for(const b of chunks)b.fill(0);
  const workerTerminal=!!owned&&(owned.exitCode!==null||owned.signalCode!==null);
  // Never infer terminal ownership from a stored PID or process-name lookup.
  if(jobId&&workerTerminal){try{cleanup=reconcileManagedProofContainers(jobId,process.env);}catch{success=false;}}
  else success=false;
  if(!cleanup||cleanup.removedCount!==0||cancelled||parentDisconnected||!process.connected)success=false;
  const observed={format:1,kind:'MANAGED_PROOF_GUARDIAN_TERMINAL_V1',workerTimeoutMs,parentDisconnected,cancellationRequested:cancelled,
   workerTerminal,jobContainersObservedAbsent:cleanup?.observedJobContainersAbsent??false,cleanupRemovedCount:cleanup?.removedCount??null,
   outcome:success?'WORKER_EXIT_ACK_OBSERVED':'UNRESOLVED',executionAuthorized:false,publicationAuthorized:false,actionAuthorized:false};
  try{await onTerminal?.(observed);}catch{success=false;}
  process.removeListener('disconnect',disconnected);process.removeListener('message',message);
  if(success&&process.connected)process.stdout.write(JSON.stringify({format:1,kind:'MANAGED_IMPORTED_PROOF_WORKER_V1',ok:true}));
  process.exitCode=success?0:1;
  if(process.connected)process.disconnect();
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await runManagedProofGuardian();
