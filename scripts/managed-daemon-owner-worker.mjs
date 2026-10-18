import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnLocalDockerCommand,prepareLocalDockerCommand,validateManagedDaemonOwnerArguments} from './postgres-backup.mjs';
import {containmentUnit,inspectContainmentUnit,currentContainmentBootId} from './managed-proof-systemd-containment.mjs';
import {verifyContainedExecutorSource} from './managed-proof-systemd-runner.mjs';
import {requestOutcomeCustody,validateOutcomeCustodyHandoff,validateOutcomeCustodyReceipt} from './managed-outcome-custodian.mjs';
import {requestManagedDaemonCustody} from './managed-daemon-custody-client.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
const no=()=>new Error('Original daemon owner unresolved; preserve intent without replay');
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const hex=(v,n)=>typeof v==='string'&&new RegExp('^[a-f0-9]{'+n+'}$').test(v);
const artifact=value=>{const body=JSON.stringify(value);return{body,sha256:hash(body),byteLength:Buffer.byteLength(body)};};
const requestEnvironmentNames=new Set(('PGPASSWORD POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB '+
 'CHARITYPILOT_PROOF_DATABASE_URL CHARITYPILOT_SOURCE_ENDPOINT_IDENTITY_SHA256 CHARITYPILOT_SNAPSHOT_ACTION '+
 'CHARITYPILOT_TEMP_FILE_LIMIT_KB CHARITYPILOT_TEMP_FILE_LIMIT_BYTES CHARITYPILOT_MAX_PUBLIC_TABLES CHARITYPILOT_MAX_ROWS_PER_TABLE '+
 'CHARITYPILOT_MAX_TOTAL_ROWS CHARITYPILOT_MAX_FINGERPRINT_REPORT_BYTES CHARITYPILOT_MAX_DUMP_BYTES CHARITYPILOT_CAPACITY_SAFETY_FACTOR '+
 'CHARITYPILOT_CAPACITY_SAFETY_MARGIN_BYTES CHARITYPILOT_SOURCE_DATABASE_SIZE_BYTES CHARITYPILOT_CAPACITY_REQUIRED_BYTES '+
 'CHARITYPILOT_CAPACITY_PREFLIGHT_VERIFIED CHARITYPILOT_RAW_REPORT_PATH CHARITYPILOT_DUMP_PATH CHARITYPILOT_DUMP_FILE CHARITYPILOT_IMPORTED_SNAPSHOT '+
 'CHARITYPILOT_IMPORTED_DATABASE CHARITYPILOT_IMPORTED_DATABASE_OID CHARITYPILOT_IMPORTED_OBSERVER_OID CHARITYPILOT_IMPORTED_BACKEND_PID '+
 'CHARITYPILOT_RESTORE_DATABASE_URL CHARITYPILOT_RESTORE_QUERY CHARITYPILOT_RESTORE_DUMP_FILE').split(' '));
/** Copy only explicit fixed-helper Docker environment operands, including the
 * safety limits and snapshot program. Never forward ambient cloud credentials. */
export function managedDaemonOwnerEnvironment(args,source){
 const names=args.filter((_,i)=>i>0&&args[i-1]==='-e');
 if(names.some(k=>!requestEnvironmentNames.has(k)||typeof source?.[k]!=='string'))throw no();
 return Object.fromEntries(names.map(k=>[k,source[k]]));
}
export function prepareManagedDaemonOwnerLaunch(raw,source=process.env){
 const input=validateManagedDaemonOwnerInput(raw),unit=containmentUnit(input.ownerId);
 const environment=Object.fromEntries(['PATH','HOME','USER','LOGNAME','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS'].filter(k=>typeof source[k]==='string').map(k=>[k,source[k]]));
 const args=['--user','--quiet','--pipe','--unit='+unit,'--service-type=exec','--property=KillMode=control-group','--property=Restart=no',
  '--property=RuntimeMaxSec='+Math.ceil((input.timeoutMs+30000)/1000)+'s','--property=TimeoutStopSec=2s',
  '--property=NoNewPrivileges=yes','--property=MemoryMax=128M','--property=TasksMax=32','--property=CPUQuota=50%',
  '--property=UnsetEnvironment=NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH',process.execPath,fileURLToPath(import.meta.url),'--stdin'];
 return{unit,args,environment,input:Buffer.from(JSON.stringify(input)),timeout:input.timeoutMs+35000,maxBuffer:input.maxBuffer*8+16384};
}
/** Synchronous caller adapter. A killed client does not fence the daemon or
 * authorise retry. Original owner/outcome custody remains in the live parent. */
export function dispatchManagedDaemonOwnerSync(raw){
 if(process.platform!=='linux'||process.getuid()===0)throw no();const input=validateManagedDaemonOwnerInput(raw);
 verifyContainedExecutorSource(input.sourceSha);prepareLocalDockerCommand(['docker','version'],process.env);
 const launch=prepareManagedDaemonOwnerLaunch(input);
 try{
  const state=spawnSync('systemctl',['--user','show',launch.unit,'--property=LoadState','--value'],{env:launch.environment,encoding:'utf8',timeout:15000,maxBuffer:4096});
  if(state.error||![0,1,4].includes(state.status)||state.stdout.trim()!=='not-found')throw no();
  const r=spawnSync('systemd-run',launch.args,{env:launch.environment,input:launch.input,encoding:'utf8',timeout:launch.timeout,maxBuffer:launch.maxBuffer,killSignal:'SIGKILL'});
  if(r.status!==0||r.error||r.signal||r.stderr?.trim())throw no();const value=JSON.parse(r.stdout);
  if(!exact(value,'status,transportError,signal,stdout,stderr')||value.status!==null&&!Number.isSafeInteger(value.status)
   ||typeof value.transportError!=='boolean'||typeof value.signal!=='boolean'||typeof value.stdout!=='string'||typeof value.stderr!=='string'
   ||Buffer.byteLength(value.stdout)>input.maxBuffer||Buffer.byteLength(value.stderr)>input.maxBuffer)throw no();
  return{status:value.status,stdout:value.stdout,stderr:value.stderr,error:value.transportError?no():undefined,signal:value.signal?'UNKNOWN':null};
 }finally{launch.input.fill(0);}
}
export function validateManagedDaemonOwnerInput(raw){
 const retained=raw?.outcomeMode==='RETAINED_SDK_V1';
 if(!exact(raw,'format,kind,jobId,ownerId,sourceSha,inputDigest,descriptorPath,intent,args,environment,timeoutMs,maxBuffer'+(retained?',outcomeMode':''))
  ||raw.format!==1||raw.kind!=='MANAGED_DAEMON_OWNER_INPUT_V1'||!hex(raw.sourceSha,40)||!hex(raw.inputDigest,64)
  ||typeof raw.descriptorPath!=='string'||raw.descriptorPath.length>4096||!Array.isArray(raw.args)||raw.args.length>256
  ||raw.args.some(v=>typeof v!=='string'||v.includes('\0')||v.length>16384)||Buffer.byteLength(JSON.stringify(raw))>65536
  ||!Number.isSafeInteger(raw.timeoutMs)||raw.timeoutMs<50||raw.timeoutMs>90000||!Number.isSafeInteger(raw.maxBuffer)||raw.maxBuffer<1||raw.maxBuffer>1048576
  ||!raw.environment||typeof raw.environment!=='object'||Array.isArray(raw.environment)
  ||Object.entries(raw.environment).some(([k,v])=>!requestEnvironmentNames.has(k)||typeof v!=='string'||v.length>65536||v.includes('\0'))
  ||!exact(raw.intent,'body,sha256,byteLength')||typeof raw.intent.body!=='string'||Buffer.byteLength(raw.intent.body)>8192
  ||raw.intent.byteLength!==Buffer.byteLength(raw.intent.body)||raw.intent.sha256!==hash(raw.intent.body))throw no();
 containmentUnit(raw.jobId);containmentUnit(raw.ownerId);if(raw.jobId===raw.ownerId)throw no();
 const intent=JSON.parse(raw.intent.body);
 if(!exact(intent,'format,kind,jobId,sequence,previousDigest,operation,target,storagePlan,argumentsDigest')||intent.format!==2
  ||intent.kind!=='MANAGED_DAEMON_REQUEST_INTENT_V2'||!Number.isInteger(intent.sequence)||intent.sequence<1||intent.sequence>64||!hex(intent.previousDigest,64))throw no();
 validateManagedDaemonOwnerArguments(raw.args,intent,raw.jobId);
 return structuredClone(raw);
}
function actualIdentity(input){
 if(process.platform!=='linux'||process.getuid()===0)throw no();verifyContainedExecutorSource(input.sourceSha);
 const unit=containmentUnit(input.ownerId),v=inspectContainmentUnit(unit);
 if(v.MainPID!==String(process.pid)||v.InvocationID!==process.env.INVOCATION_ID||v.ActiveState!=='active'||v.SubState!=='running'
  ||basename(readFileSync('/proc/self/cgroup','utf8').trim())!==unit)throw no();
 return{ownerId:input.ownerId,unit,invocationId:v.InvocationID,uid:process.getuid(),mainPid:process.pid,
  mainStartMonotonic:v.ExecMainStartTimestampMonotonic,sourceSha:input.sourceSha,inputDigest:hash(JSON.stringify(input)),
  bootId:currentContainmentBootId(),controlGroup:v.ControlGroup};
}
/** Fixed CLI uses real identity, custody and local Docker. Seams are tests only.
 * Inputs travel on stdin, never a command line, environment file or saved record. */
export async function runManagedDaemonOwner(raw,{identity=actualIdentity,acknowledge=requestManagedDaemonCustody,execute=spawnLocalDockerCommand,probeRetained=requestOutcomeCustody,publishRetained=requestOutcomeCustody}={}){
 const input=validateManagedDaemonOwnerInput(raw),intent=JSON.parse(input.intent.body),owner=artifact({format:1,kind:'MANAGED_DAEMON_REQUEST_OWNER_V1',
  jobId:input.jobId,sequence:intent.sequence,intentPin:{sha256:input.intent.sha256,byteLength:input.intent.byteLength},identity:identity(input)});
 const send=(kind,record,receipt)=>acknowledge({kind,artifact:record,descriptorPath:input.descriptorPath,jobId:input.jobId,inputDigest:input.inputDigest,sourceSha:input.sourceSha,...(kind==='OWNER'?{ownerInput:input}:{}),...(receipt?{receipt}:{})});
 const acknowledged=await send('OWNER',owner);let retained;
 if(input.outcomeMode==='RETAINED_SDK_V1'){retained=validateOutcomeCustodyHandoff(acknowledged,input);if(await probeRetained({endpoint:retained.endpoint,receiver:retained.receiver})!==true)throw no();}
 else if(acknowledged!==true)throw no();
 const environment=Object.fromEntries(['PATH','HOME','USER','LOGNAME'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
 Object.assign(environment,input.environment);
 const r=execute(['docker',...input.args],environment,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:input.timeoutMs,maxBuffer:input.maxBuffer,killSignal:'SIGKILL'});
 const stdout=typeof r.stdout==='string'?r.stdout:'',stderr=typeof r.stderr==='string'?r.stderr:'';
 const outcome=artifact({format:1,kind:'MANAGED_DAEMON_OWNER_OUTCOME_V1',jobId:input.jobId,sequence:intent.sequence,
  intentPin:{sha256:input.intent.sha256,byteLength:input.intent.byteLength},ownerPin:{sha256:owner.sha256,byteLength:owner.byteLength},
  ownerInputDigest:JSON.parse(owner.body).identity.inputDigest,status:Number.isSafeInteger(r.status)?r.status:null,transportError:!!r.error,signal:!!r.signal,
  removalAlreadyAbsent:intent.operation==='rm'&&r.status===1&&!r.error&&!r.signal&&stderr.trim()==='Error response from daemon: No such container: '+intent.target,
  stdout:{sha256:hash(stdout),byteLength:Buffer.byteLength(stdout)},stderr:{sha256:hash(stderr),byteLength:Buffer.byteLength(stderr)}});
 const receipt=retained?validateOutcomeCustodyReceipt(await publishRetained({endpoint:retained.endpoint,receiver:retained.receiver,artifact:outcome})):undefined;
 if(await send('OUTCOME',outcome,receipt)!==true)throw no();
 return{status:Number.isSafeInteger(r.status)?r.status:null,transportError:!!r.error,signal:!!r.signal,stdout,stderr};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 process.stdout.on('error',()=>{});process.stderr.on('error',()=>{});let bytes=0;const chunks=[];
 try{
  if(process.argv.length!==3||process.argv[2]!=='--stdin')throw no();
  for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>65536)throw no();chunks.push(chunk);}
  const body=Buffer.concat(chunks);let input;try{input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));}finally{body.fill(0);for(const b of chunks)b.fill(0);}
  const result=await runManagedDaemonOwner(input);process.stdout.write(JSON.stringify(result)+'\n');
 }catch{process.stderr.write('Original daemon owner unresolved\n');process.exitCode=1;}finally{for(const b of chunks)b.fill(0);}
}
