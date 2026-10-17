import {createHash} from 'node:crypto';
import {finished} from 'node:stream/promises';
import {requireOriginalControlGroup} from './managed-proof-systemd-containment.mjs';
const failure=()=>new Error('Managed proof job record unresolved; inspect without execution or publication');
const sha=v=>createHash('sha256').update(v).digest('hex');
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const keys=(v,expected)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===expected.split(',').sort().join(',');
function scope(raw){
 if(keys(raw,'kind')&&raw.kind==='STANDALONE_INTERNAL_PROOF')return{kind:raw.kind};
 if(!keys(raw,'kind,bindingDigest,requestPinDigest,sourceSha')||raw.kind!=='COMMON_CANDIDATE'||!hex(raw.bindingDigest)||!hex(raw.requestPinDigest)||typeof raw.sourceSha!=='string'||!/^[a-f0-9]{40}$/.test(raw.sourceSha))throw failure();
 return{kind:raw.kind,bindingDigest:raw.bindingDigest,requestPinDigest:raw.requestPinDigest,sourceSha:raw.sourceSha};
}
function pin(raw){if(!keys(raw,'sha256,byteLength')||!hex(raw.sha256)||!Number.isSafeInteger(raw.byteLength)||raw.byteLength<1||raw.byteLength>8192)throw failure();return{sha256:raw.sha256,byteLength:raw.byteLength};}
function request(raw){
 if(!keys(raw,'format,kind,jobId,scope,sourceSha,workspaceDigest,snapshotDigest,argumentsDigest,createdAt,state,executionAuthorized,publicationAuthorized,actionAuthorized')
  ||raw.format!==1||raw.kind!=='MANAGED_IMPORTED_PROOF_JOB_V1'||typeof raw.jobId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(raw.jobId)
  ||typeof raw.sourceSha!=='string'||!/^[a-f0-9]{40}$/.test(raw.sourceSha)||![raw.workspaceDigest,raw.snapshotDigest,raw.argumentsDigest].every(hex)
  ||typeof raw.createdAt!=='string'||!Number.isFinite(Date.parse(raw.createdAt))||new Date(raw.createdAt).toISOString()!==raw.createdAt
  ||raw.state!=='REQUESTED_ONLY'||raw.executionAuthorized!==false||raw.publicationAuthorized!==false||raw.actionAuthorized!==false)throw failure();
 const bound=scope(raw.scope);if(bound.kind==='COMMON_CANDIDATE'&&bound.sourceSha!==raw.sourceSha)throw failure();
 return{...raw,scope:bound};
}
function observation(raw,original){
 if(!keys(raw,'format,kind,jobId,requestPin,state,jobContainersObservedAbsent,executionAuthorized,publicationAuthorized,actionAuthorized')
  ||raw.format!==1||raw.kind!=='MANAGED_IMPORTED_PROOF_JOB_OBSERVATION_V1'||raw.jobId!==original.jobId
  ||!['WORKER_EXIT_ACK_OBSERVED','UNRESOLVED'].includes(raw.state)||typeof raw.jobContainersObservedAbsent!=='boolean'
  ||(raw.state==='WORKER_EXIT_ACK_OBSERVED'&&!raw.jobContainersObservedAbsent)
  ||raw.executionAuthorized!==false||raw.publicationAuthorized!==false||raw.actionAuthorized!==false)throw failure();
 return{...raw,requestPin:pin(raw.requestPin)};
}
function service(raw,original,requestPin){
 if(!keys(raw,'format,kind,jobId,requestPin,identity,executionAuthorized,publicationAuthorized,actionAuthorized')||raw.format!==1||raw.kind!=='MANAGED_IMPORTED_PROOF_SERVICE_V1'
  ||raw.jobId!==original.jobId||JSON.stringify(pin(raw.requestPin))!==JSON.stringify(pin(requestPin))||raw.executionAuthorized!==false||raw.publicationAuthorized!==false||raw.actionAuthorized!==false)throw failure();
 const v=raw.identity;
 const version2=v?.format===2&&v?.kind==='MANAGED_GUARDIAN_LIVE_BINDING_V2';
 if(!keys(v,'format,kind,jobId,unit,invocationId,uid,mainPid,mainStartMonotonic,sourceSha,inputDigest,executionAuthorized,actionAuthorized'+(version2?',bootId,controlGroup':''))||(!version2&&(v.format!==1||v.kind!=='MANAGED_GUARDIAN_LIVE_BINDING_V1'))
  ||v.jobId!==original.jobId||v.unit!=='charitypilot-containment-'+original.jobId+'.service'||!(/^[a-f0-9]{32}$/).test(v.invocationId)
  ||!Number.isSafeInteger(v.uid)||v.uid<1||v.uid>2147483647||!Number.isSafeInteger(v.mainPid)||v.mainPid<1||v.mainPid>2147483647
  ||typeof v.mainStartMonotonic!=='string'||!(/^[1-9][0-9]{0,19}$/).test(v.mainStartMonotonic)||v.sourceSha!==original.sourceSha||!hex(v.inputDigest)
  ||v.executionAuthorized!==false||v.actionAuthorized!==false)throw failure();
 if(version2){if(typeof v.bootId!=='string'||!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v.bootId))throw failure();requireOriginalControlGroup(v.controlGroup,v.unit,v.uid);}
 return{...raw,requestPin:pin(raw.requestPin)};
}
async function read(workspace,filename,expected,signal){
 const want=pin(expected);await workspace.pinExistingFile(filename,signal);
 const input=await workspace.openVerifiedSource(filename,want,signal),chunks=[];let count=0;
 try{for await(const b of input.stream){count+=b.length;if(count>8192)throw failure();chunks.push(Buffer.from(b));}
  await input.verified;return JSON.parse(Buffer.concat(chunks).toString('utf8'));
 }finally{input.stream.destroy();for(const b of chunks)b.fill(0);}
}
async function write(workspace,filename,value,signal){
 const data=Buffer.from(JSON.stringify(value));if(data.length>8192)throw failure();const expected={sha256:sha(data),byteLength:data.length};
 try{const output=await workspace.createCiphertextDestination(filename,signal);output.stream.end(data);await finished(output.stream);await output.complete(expected);
  const flush=await workspace.syncDirectory();const saved=await read(workspace,filename,expected,signal);
  if(JSON.stringify(saved)!==JSON.stringify(value))throw failure();return{pin:expected,...flush,artifact:{body:JSON.stringify(value),...expected}};
 }finally{data.fill(0);}
}
/** Baseline readback must finish before any worker is started. Never retry it. */
export async function recordManagedProofJob(workspace,raw,signal){
 try{const value=request(raw);if(value.workspaceDigest!==workspace.identityDigest())throw failure();const saved=await write(workspace,'proof-job.request.json',value,signal);
  let attempted=false,serviceAttempted=false;
  return{requestPin:saved.pin,requestArtifact:saved.artifact,directoryFlushSupported:saved.directoryFlushSupported,
   bindService:async(identity,input)=>{
    if(serviceAttempted||attempted)throw failure();serviceAttempted=true;
    try{
    if(!Buffer.isBuffer(input)||input.length<1||input.length>16384)throw failure();
    const v=JSON.parse(input.toString('utf8'));
    if(!keys(v,v.daemonCustodyRequired===true?'args,snapshot,jobId,daemonCustodyRequired':'args,snapshot,jobId')||v.jobId!==value.jobId||!Array.isArray(v.args)||v.args.some(a=>typeof a!=='string')
     ||sha(JSON.stringify(v.args))!==value.argumentsDigest||sha('CHARITYPILOT_MANAGED_EXPORTED_SNAPSHOT_V1\n'+JSON.stringify(v.snapshot))!==value.snapshotDigest||identity?.inputDigest!==sha(input))throw failure();
    const body=service({format:1,kind:'MANAGED_IMPORTED_PROOF_SERVICE_V1',jobId:value.jobId,requestPin:saved.pin,identity,
     executionAuthorized:false,publicationAuthorized:false,actionAuthorized:false},value,saved.pin);
    return await write(workspace,'proof-job.service.json',body,signal);
    }catch{throw failure();}
   },
   observe:async(state,jobContainersObservedAbsent)=>{
    if(attempted)throw failure();attempted=true;
    const body=observation({format:1,kind:'MANAGED_IMPORTED_PROOF_JOB_OBSERVATION_V1',jobId:value.jobId,requestPin:saved.pin,state,jobContainersObservedAbsent,
     executionAuthorized:false,publicationAuthorized:false,actionAuthorized:false},value);
    return write(workspace,'proof-job.observation.json',body);
   }};
 }catch{throw failure();}
}
/** Requires an independently retained baseline pin and expected original scope.
 * A missing result remains REQUESTED_ONLY; it never creates a replacement job. */
export async function inspectManagedProofJob(workspace,{requestPin,expectedScope,observationPin,servicePin},signal){
 try{
  const original=request(await read(workspace,'proof-job.request.json',requestPin,signal));
  if(original.workspaceDigest!==workspace.identityDigest()||JSON.stringify(original.scope)!==JSON.stringify(scope(expectedScope)))throw failure();
  let result;
  if(observationPin){result=observation(await read(workspace,'proof-job.observation.json',observationPin,signal),original);
   if(JSON.stringify(result.requestPin)!==JSON.stringify(pin(requestPin)))throw failure();}
  const serviceRecord=servicePin?service(await read(workspace,'proof-job.service.json',servicePin,signal),original,requestPin):null;
  return{jobId:original.jobId,sourceSha:original.sourceSha,scope:original.scope,requestPin:pin(requestPin),
   serviceIdentity:serviceRecord?.identity??null,serviceSupplied:!!serviceRecord,
   state:result?.state??'REQUESTED_ONLY',resultSupplied:!!result,jobContainersObservedAbsent:result?.jobContainersObservedAbsent??false,
   executionAuthorized:false,publicationAuthorized:false,actionAuthorized:false};
 }catch{throw failure();}
}
