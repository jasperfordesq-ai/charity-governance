import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnLocalDockerCommand,validateManagedDaemonOwnerArguments} from './postgres-backup.mjs';
import {containmentUnit,inspectContainmentUnit,currentContainmentBootId} from './managed-proof-systemd-containment.mjs';
import {verifyContainedExecutorSource} from './managed-proof-systemd-runner.mjs';
import {requestManagedDaemonCustody} from './managed-daemon-custody-client.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
const no=()=>new Error('Original daemon owner unresolved; preserve intent without replay');
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const hex=(v,n)=>typeof v==='string'&&new RegExp('^[a-f0-9]{'+n+'}$').test(v);
const artifact=value=>{const body=JSON.stringify(value);return{body,sha256:hash(body),byteLength:Buffer.byteLength(body)};};
export function validateManagedDaemonOwnerInput(raw){
 if(!exact(raw,'format,kind,jobId,ownerId,sourceSha,inputDigest,descriptorPath,intent,args,environment,timeoutMs,maxBuffer')
  ||raw.format!==1||raw.kind!=='MANAGED_DAEMON_OWNER_INPUT_V1'||!hex(raw.sourceSha,40)||!hex(raw.inputDigest,64)
  ||typeof raw.descriptorPath!=='string'||raw.descriptorPath.length>4096||!Array.isArray(raw.args)||raw.args.length>256
  ||raw.args.some(v=>typeof v!=='string'||v.includes('\0')||v.length>16384)||Buffer.byteLength(JSON.stringify(raw))>65536
  ||!Number.isSafeInteger(raw.timeoutMs)||raw.timeoutMs<50||raw.timeoutMs>90000||!Number.isSafeInteger(raw.maxBuffer)||raw.maxBuffer<1||raw.maxBuffer>1048576
  ||!raw.environment||typeof raw.environment!=='object'||Array.isArray(raw.environment)
  ||Object.entries(raw.environment).some(([k,v])=>k!=='PGPASSWORD'||typeof v!=='string'||v.length>8192||v.includes('\0'))
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
export async function runManagedDaemonOwner(raw,{identity=actualIdentity,acknowledge=requestManagedDaemonCustody,execute=spawnLocalDockerCommand}={}){
 const input=validateManagedDaemonOwnerInput(raw),intent=JSON.parse(input.intent.body),owner=artifact({format:1,kind:'MANAGED_DAEMON_REQUEST_OWNER_V1',
  jobId:input.jobId,sequence:intent.sequence,intentPin:{sha256:input.intent.sha256,byteLength:input.intent.byteLength},identity:identity(input)});
 const send=(kind,record)=>acknowledge({kind,artifact:record,descriptorPath:input.descriptorPath,jobId:input.jobId,inputDigest:input.inputDigest,sourceSha:input.sourceSha});
 if(await send('OWNER',owner)!==true)throw no();
 const environment=Object.fromEntries(['PATH','HOME','USER','LOGNAME'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
 Object.assign(environment,input.environment);
 const r=execute(['docker',...input.args],environment,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:input.timeoutMs,maxBuffer:input.maxBuffer,killSignal:'SIGKILL'});
 const stdout=typeof r.stdout==='string'?r.stdout:'',stderr=typeof r.stderr==='string'?r.stderr:'';
 const outcome=artifact({format:1,kind:'MANAGED_DAEMON_OWNER_OUTCOME_V1',jobId:input.jobId,sequence:intent.sequence,
  intentPin:{sha256:input.intent.sha256,byteLength:input.intent.byteLength},ownerPin:{sha256:owner.sha256,byteLength:owner.byteLength},
  ownerInputDigest:JSON.parse(owner.body).identity.inputDigest,status:Number.isSafeInteger(r.status)?r.status:null,transportError:!!r.error,signal:!!r.signal,
  removalAlreadyAbsent:intent.operation==='rm'&&r.status===1&&!r.error&&!r.signal&&stderr.trim()==='Error response from daemon: No such container: '+intent.target,
  stdout:{sha256:hash(stdout),byteLength:Buffer.byteLength(stdout)},stderr:{sha256:hash(stderr),byteLength:Buffer.byteLength(stderr)}});
 if(await send('OUTCOME',outcome)!==true)throw no();
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
