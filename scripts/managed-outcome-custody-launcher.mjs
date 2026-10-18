import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createOriginalOutcomeClaimChannel} from './managed-outcome-claim-channel.mjs';
import {prepareOutcomeCustodyEndpoint,validateOutcomeCustodianInput,requestOutcomeCustody} from './managed-outcome-custodian.mjs';
import {containmentUnit,inspectContainmentUnit,currentContainmentBootId,verifyOutcomeCustodyReceiver} from './managed-proof-systemd-containment.mjs';
import {verifyContainedExecutorSource} from './managed-proof-systemd-runner.mjs';
const no=()=>new Error('Original outcome custody launch unresolved; preserve original scope without retry');
const hash=v=>createHash('sha256').update(v).digest('hex');
const safeEnvironment=source=>Object.fromEntries(['PATH','HOME','USER','LOGNAME','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS'].filter(k=>typeof source[k]==='string').map(k=>[k,source[k]]));
/** Fixed command and OS-only environment. The private ticket travels on stdin. */
export function prepareOutcomeCustodyLaunch(raw,environment=process.env){
 const input=validateOutcomeCustodianInput(raw),unit=containmentUnit(input.receiverId);
 return{unit,environment:safeEnvironment(environment),input:Buffer.from(JSON.stringify(input)),args:[
  '--user','--quiet','--pipe','--unit='+unit,'--service-type=exec','--property=KillMode=control-group','--property=Restart=no',
  '--property=RuntimeMaxSec=120s','--property=TimeoutStopSec=2s','--property=NoNewPrivileges=yes','--property=MemoryMax=128M',
  '--property=TasksMax=32','--property=CPUQuota=50%','--property=UnsetEnvironment=NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH',
  process.execPath,fileURLToPath(new URL('./managed-outcome-custodian.mjs',import.meta.url)),'--stdin']};
}
function requireAbsent(unit,environment){
 const r=spawnSync('systemctl',['--user','show',unit,'--property=LoadState','--value'],{env:environment,encoding:'utf8',timeout:15000,maxBuffer:4096});
 if(r.error||![0,1,4].includes(r.status)||r.stdout.trim()!=='not-found')throw no();
}
function stopOriginal(receiver,environment){
 if(currentContainmentBootId()!==receiver.identity.bootId)throw no();
 const state=spawnSync('systemctl',['--user','show',receiver.identity.unit,'--property=LoadState','--value'],{env:environment,encoding:'utf8',timeout:15000,maxBuffer:4096});
 if(!state.error&&[0,1,4].includes(state.status)&&state.stdout.trim()==='not-found')return;
 if(state.error||state.status!==0||state.stdout.trim()!=='loaded')throw no();
 const v=inspectContainmentUnit(receiver.identity.unit),i=receiver.identity;
 if(v.InvocationID!==i.invocationId||v.ExecMainStartTimestampMonotonic!==i.mainStartMonotonic)throw no();
 if(v.MainPID!=='0'&&(v.MainPID!==String(i.mainPid)||v.ControlGroup!==i.controlGroup
  ||readFileSync('/proc/'+i.mainPid+'/cgroup','utf8').trim()!=='0::'+i.controlGroup))throw no();
 const r=spawnSync('systemctl',['--user','stop',i.unit],{env:environment,encoding:'utf8',timeout:15000,maxBuffer:4096});
 if(r.error||r.status!==0)throw no();
}
/** Called only by the original live context. Claim success is not SDK readiness:
 * no endpoint is returned until its single ready probe and fresh kernel check.
 * No generic executable, provider URL or recovery-ticket path is accepted. */
export async function launchOriginalOutcomeCustody({jobId,sourceSha,source,transfer,signal}){
 if(process.platform!=='linux'||process.getuid()===0||signal?.aborted||typeof transfer?.take!=='function'
  ||typeof transfer?.claim!=='function'||typeof transfer?.abandon!=='function')throw no();
 verifyContainedExecutorSource(sourceSha);
 if(source?.Id!==containmentUnit(jobId))throw no();
 const receiverId=randomUUID(),unit=containmentUnit(receiverId),environment=safeEnvironment(process.env);
 requireAbsent(unit,environment);
 let endpoint,channel,prepared,child,receiver,terminal,ended=false,failed=false,closing;
 const check=()=>{if(signal?.aborted||failed||ended)throw no();};
 const options={jobId,sourceSha,receiverId,source};
 const verify=value=>{const checked=verifyOutcomeCustodyReceiver(value,options);receiver=structuredClone(value);return checked;};
 const close=async()=>{
  let error=false;try{await channel?.close();}catch{error=true;}
  // Unknown launch/claim identities are deliberately not adopted for cleanup.
  if(child){if(receiver){try{stopOriginal(receiver,environment);}catch{error=true;}}else if(!ended)error=true;}
  if(terminal&&!ended){let timer;try{await Promise.race([terminal,new Promise((_,reject)=>{timer=setTimeout(()=>reject(no()),5000);})]);}catch{error=true;}finally{clearTimeout(timer);}}
  try{endpoint?.close();}catch{error=true;}if(error)throw no();
 };
 const closeOnce=()=>closing??=close();
 try{
  endpoint=prepareOutcomeCustodyEndpoint();const ticket=transfer.take(),ticketDigest=hash(JSON.stringify(ticket));
  channel=await createOriginalOutcomeClaimChannel({jobId,sourceSha,receiverId,ticketDigest,transfer,verifyReceiver:verify});
  prepared=prepareOutcomeCustodyLaunch({format:1,kind:'MANAGED_OUTCOME_CUSTODIAN_INPUT_V1',jobId,receiverId,sourceSha,
   claim:channel.binding(),endpoint:endpoint.binding(),ticket},environment);
  options.inputDigest=hash(prepared.input);channel.bindInputDigest(options.inputDigest);check();
  child=spawn('systemd-run',prepared.args,{env:prepared.environment,stdio:['pipe','pipe','pipe']});
  terminal=new Promise((yes,reject)=>{child.once('error',()=>{failed=true;ended=true;reject(no());});child.once('close',(code,signal)=>{
   ended=true;if(code!==0||signal||failed)reject(no());else yes({serviceExited:true,originalAcknowledgementReconstructed:false,pendingRequestResolved:false,actionAuthorized:false});
  });});void terminal.catch(()=>{});
  // The service has no stdout protocol; generic stderr is failure, never evidence.
  child.stdout.on('data',()=>{failed=true;});child.stderr.on('data',()=>{failed=true;});
  child.stdin.on('error',()=>{failed=true;});const privateInput=prepared.input;child.stdin.end(privateInput,()=>privateInput.fill(0));
  const claim=await Promise.race([channel.result,terminal.then(()=>{throw no();})]);receiver=claim.receiver;check();verify(receiver);
  const deadline=performance.now()+15000;
  while(!existsSync(endpoint.binding().path)){check();if(performance.now()>=deadline)throw no();await new Promise(r=>setTimeout(r,25));}
  check();await requestOutcomeCustody({endpoint:endpoint.binding(),receiver});check();verify(receiver);
  await channel.close();check();
  let publishing=false;
  return Object.freeze({receiver:structuredClone(receiver),binding:()=>endpoint.binding(),terminal,
   async publish(artifact){if(publishing)throw no();publishing=true;check();verify(receiver);
    return requestOutcomeCustody({endpoint:endpoint.binding(),receiver,artifact});},close:closeOnce});
 }catch{try{transfer.abandon();}catch{}try{await closeOnce();}catch{}throw no();}
 finally{prepared?.input.fill(0);}
}
