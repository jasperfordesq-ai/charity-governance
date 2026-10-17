import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {superviseManagedProofProcess,reconcileManagedProofContainers} from './managed-proof-runner.mjs';
import {connectManagedGuardianParent} from './managed-proof-channel.mjs';
import {inspectManagedDaemonInvocation} from './postgres-backup.mjs';
const actualWorker=fileURLToPath(new URL('./managed-proof-worker.mjs',import.meta.url));
function ipcParent(){
 if(!process.channel||!process.connected||typeof process.send!=='function')throw new Error();
 const listeners=new Set();let connected=true;
 const cancel=()=>{for(const fn of listeners)fn();process.stdin.destroy();};
 const disconnected=()=>{connected=false;cancel();},message=()=>cancel();process.on('disconnect',disconnected);process.on('message',message);
 const broken=()=>{if(!process.connected)disconnected();else cancel();};
 process.stdout.on('error',broken);process.stderr.on('error',broken);process.stdin.on('error',()=>{});
 return{get connected(){return connected&&process.connected;},onCancel:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
  receive:async()=>{const chunks=[];let size=0;try{for await(const b of process.stdin){size+=b.length;if(size>16384)throw new Error();chunks.push(Buffer.from(b));}
   const timeout=process.env.CHARITYPILOT_INTERNAL_GUARDIAN_TIMEOUT_MS??'90000';if(!/^[0-9]+$/.test(timeout))throw new Error();
   return{input:Buffer.concat(chunks),env:process.env,timeoutMs:Number(timeout)};
  }finally{for(const b of chunks)b.fill(0);}},
  writeError:b=>{if(connected&&process.connected)process.stderr.write(b.toString('utf8'));},
  acknowledge:async()=>{if(!connected||!process.connected)throw new Error();process.stdout.write(JSON.stringify({format:1,kind:'MANAGED_IMPORTED_PROOF_WORKER_V1',ok:true}));},
  close:()=>{listeners.clear();process.stdin.destroy();process.removeListener('disconnect',disconnected);process.removeListener('message',message);if(process.connected)process.disconnect();}};
}
/** Fixed production CLI. Dependency callbacks/paths are source-test seams only.
 * Both private transports treat parent loss as cancellation, never replay. */
export async function runManagedProofGuardian({workerPath=actualWorker,onTerminal,parent,reconcile=reconcileManagedProofContainers,inspectRequests=inspectManagedDaemonInvocation}={}){
 try{parent??=ipcParent();}catch{process.exitCode=1;return;}
 const controller=new AbortController();let parentDisconnected=false,cancelled=false,owned,jobId,input,success=false,cleanup,workerTimeoutMs,workerEnv,requestValue,requests;
 const cancel=()=>{parentDisconnected||=!parent.connected;cancelled=true;controller.abort();};
 const unsubscribe=parent.onCancel(cancel);
 const startup=setTimeout(()=>{cancel();parent.close();},15000);
 try{
  const request=await parent.receive();input=request.input;workerEnv=request.env;workerTimeoutMs=request.timeoutMs;
  clearTimeout(startup);controller.signal.throwIfAborted();if(!parent.connected||!Buffer.isBuffer(input)||input.length<1||input.length>16384
   ||!Number.isSafeInteger(workerTimeoutMs)||workerTimeoutMs<50||workerTimeoutMs>1200000)throw new Error();
  const value=JSON.parse(input.toString('utf8'));requestValue=value;
  if(typeof value?.jobId!=='string'||!(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/).test(value.jobId))throw new Error();jobId=value.jobId;
  await superviseManagedProofProcess({input,env:workerEnv,signal:controller.signal,timeoutMs:workerTimeoutMs},{
   start(command,_args,settings){owned=spawn(command,[workerPath],settings);return owned;},
   onStderr:b=>{if(parent.connected)parent.writeError(b);}
  });success=true;
 }catch{success=false;}
 finally{
  clearTimeout(startup);input?.fill(0);
  const workerTerminal=!!owned&&(owned.exitCode!==null||owned.signalCode!==null);
  // Never infer terminal ownership from a stored PID or process-name lookup.
  if(jobId&&workerTerminal){try{requests=inspectRequests(requestValue);cleanup=reconcile(jobId,workerEnv);}catch{success=false;}}
  else success=false;
  if(!cleanup||cleanup.removedCount!==0||requests?.mutatingRequestsObservedSuccessful!==true||cancelled||parentDisconnected||!parent.connected)success=false;
  const observed={format:1,kind:'MANAGED_PROOF_GUARDIAN_TERMINAL_V1',workerTimeoutMs,parentDisconnected,cancellationRequested:cancelled,
   workerTerminal,daemonMutationsSettled:requests?.mutatingRequestsObservedSuccessful===true,jobContainersObservedAbsent:requests?.mutatingRequestsObservedSuccessful===true&&(cleanup?.observedJobContainersAbsent??false),cleanupRemovedCount:cleanup?.removedCount??null,
   outcome:success?'WORKER_EXIT_ACK_OBSERVED':'UNRESOLVED',executionAuthorized:false,publicationAuthorized:false,actionAuthorized:false};
  try{await onTerminal?.(observed);}catch{success=false;}
  if(success&&parent.connected){try{await parent.acknowledge();}catch{success=false;}}
  unsubscribe();parent.close();process.exitCode=success?0:1;
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{if(process.argv.length===2)await runManagedProofGuardian();
  else if(process.argv.length===4&&process.argv[2]==='--systemd-socket')await runManagedProofGuardian({parent:await connectManagedGuardianParent(process.argv[3])});
  else process.exitCode=1;
 }catch{process.exitCode=1;}
}
