import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,chmodSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {createManagedDaemonCustodyChannel} from './managed-daemon-custody-channel.mjs';
import {requestManagedDaemonCustody} from './managed-daemon-custody-client.mjs';
const producer=fileURLToPath(new URL('./managed-daemon-custody-producer.fixture.mjs',import.meta.url));
const enabled=process.platform==='linux'&&process.getuid()!==0;
const saved=(kind='BASELINE')=>({pin:{kind,versionId:'synthetic-version',sha256:'a'.repeat(64),byteLength:100},savedEvidenceAuthorizesDispatch:false,pendingRequestResolved:false,actionAuthorized:false});
async function child(path,input,env){
 const p=spawn(process.execPath,[path],{env:env??Object.fromEntries(['PATH','HOME','TMPDIR'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]])),stdio:['pipe','pipe','pipe']});
 let body='';for(const s of [p.stdout,p.stderr])s.on('data',b=>{body+=b;if(body.length>8192)p.kill('SIGKILL');});
 const result=new Promise((yes,no)=>{p.once('error',no);p.once('close',(code,signal)=>yes({code,signal,body}));});p.stdin.on('error',()=>{});p.stdin.end(JSON.stringify(input));return result;
}
test('separate synchronous source client waits for original custody before dispatch and fails closed on lost/refused ACK',{skip:!enabled,timeout:30000},async()=>{
 for(const mode of ['success','header-refused','intent-refused','intent-ACK-lost','response-refused','response-ACK-lost','end-refused','end-ACK-lost']){
  const root=mkdtempSync(join(tmpdir(),'charitypilot-daemon-barrier-test-'));chmodSync(root,0o700);
  const scope={root,jobId:randomUUID(),inputDigest:'b'.repeat(64)},sourceSha='1'.repeat(40);let headers=0,intents=0,responses=0,ends=0,gate;
  try{
   gate=await createManagedDaemonCustodyChannel({...scope,sourceSha,onHeader:async()=>{
    headers++;assert.equal(existsSync(join(root,'synthetic-dispatched.txt')),false);if(mode==='header-refused')throw new Error('synthetic lost header ACK');return saved();
   },onIntent:async()=>{
    intents++;assert.equal(existsSync(join(root,'synthetic-dispatched.txt')),false);
    if(mode==='intent-refused')throw new Error('synthetic unknown intent ACK');
    if(mode==='intent-ACK-lost')void gate.close();return saved();
   },onResponse:async()=>{
    responses++;assert.equal(existsSync(join(root,'synthetic-dispatched.txt')),true);
    if(mode==='response-refused')throw new Error('synthetic response refused');
    if(mode==='response-ACK-lost')void gate.close();return saved('OBSERVATION');
   },onEnd:async()=>{
    ends++;assert.equal(responses,1);
    if(mode==='end-refused')throw new Error('synthetic end refused');
    if(mode==='end-ACK-lost')void gate.close();return saved('OBSERVATION');
   }});
   const result=await child(producer,{scope,descriptorPath:gate.descriptorPath,sourceSha});
   assert.equal(result.code,mode==='success'?0:1,result.body);assert.equal(headers,1);assert.equal(intents,mode==='header-refused'?0:1);
   assert.equal(existsSync(join(root,'synthetic-dispatched.txt')),mode==='success'||mode.startsWith('response-')||mode.startsWith('end-'));
   assert.equal(responses,['success','response-refused','response-ACK-lost','end-refused','end-ACK-lost'].includes(mode)?1:0);
   assert.equal(ends,['success','end-refused','end-ACK-lost'].includes(mode)?1:0);
   if(mode==='success')assert.deepEqual(gate.snapshot(),{headerAcknowledged:true,intentCount:1,responseCount:1,ownerCount:0,ownerOutcomeCount:0,requireIndependentOwner:false,requireIndependentOutcome:false,endAcknowledged:true,failed:false,inFlight:0});
  }finally{await gate?.close();assert.equal(dirname(root),resolve(tmpdir()));assert.match(basename(root),/^charitypilot-daemon-barrier-test-[A-Za-z0-9]{6}$/);rmSync(root,{recursive:true,force:true});}
 }
});

test('OWNER wire acknowledgement is ordered, nonce-bound and failure-sticky before the participating source dispatches',{skip:!enabled,timeout:30000},async()=>{
 for(const mode of ['success','refused','ACK-lost']){
  const root=mkdtempSync(join(tmpdir(),'charitypilot-daemon-barrier-test-'));chmodSync(root,0o700);
  const scope={root,jobId:randomUUID(),inputDigest:'b'.repeat(64)},sourceSha='1'.repeat(40);let ownerCalls=0,gate;
  try{
   gate=await createManagedDaemonCustodyChannel({...scope,sourceSha,requireIndependentOwner:true,onHeader:async()=>saved(),onIntent:async()=>saved(),
    onOwner:async()=>{ownerCalls++;assert.equal(existsSync(join(root,'synthetic-dispatched.txt')),false);if(mode==='refused')throw new Error('synthetic owner refused');
     if(mode==='ACK-lost')void gate.close();return{...saved(),independentOwnerDispatchVerified:false};},
    onResponse:async()=>saved('OBSERVATION'),onEnd:async()=>saved('OBSERVATION')});
   const result=await child(producer,{scope,sourceSha,descriptorPath:gate.descriptorPath,owner:true});
   assert.equal(result.code,mode==='success'?0:1,result.body);assert.equal(ownerCalls,1);assert.equal(existsSync(join(root,'synthetic-dispatched.txt')),mode==='success');
   if(mode==='success'){assert.equal(gate.snapshot().ownerCount,1);assert.equal(gate.snapshot().requireIndependentOwner,true);}
  }finally{await gate?.close();assert.equal(dirname(root),resolve(tmpdir()));assert.match(basename(root),/^charitypilot-daemon-barrier-test-[A-Za-z0-9]{6}$/);rmSync(root,{recursive:true,force:true});}
 }
});

test('owner-required accounting refuses a client response without an original OWNER acknowledgement',{skip:!enabled,timeout:15000},async()=>{
 const jobId=randomUUID(),inputDigest='b'.repeat(64),sourceSha='1'.repeat(40);let responses=0;
 const gate=await createManagedDaemonCustodyChannel({jobId,inputDigest,sourceSha,requireIndependentOwner:true,
  onHeader:async()=>saved(),onIntent:async()=>saved(),onOwner:async()=>({...saved(),independentOwnerDispatchVerified:false}),
  onResponse:async()=>{responses++;return saved('OBSERVATION');},onEnd:async()=>saved('OBSERVATION')});
 const send=async(kind,value)=>{const body=JSON.stringify(value);return requestManagedDaemonCustody({descriptorPath:gate.descriptorPath,kind,jobId,inputDigest,sourceSha,
  artifact:{body,sha256:createHash('sha256').update(body).digest('hex'),byteLength:Buffer.byteLength(body)}});};
 try{
  await send('HEADER',{kind:'MANAGED_DAEMON_REQUEST_HEADER_V2',jobId,inputDigest});
  await send('INTENT',{kind:'MANAGED_DAEMON_REQUEST_INTENT_V2',jobId,sequence:1});
  await assert.rejects(send('RESPONSE',{kind:'MANAGED_DAEMON_CLIENT_RESPONSE_V1',jobId,sequence:1}));
  assert.equal(responses,0);assert.equal(gate.snapshot().failed,true);
 }finally{await gate.close();}
});
test('OUTCOME is original-owner-bound, once-only and required before opted-in response accounting',{skip:!enabled,timeout:30000},async()=>{
 for(const mode of ['success','no-owner','wrong-owner','wrong-input','response-first','duplicate','refused','ACK-lost','wrong-ack-pin']){
  const jobId=randomUUID(),inputDigest='b'.repeat(64),sourceSha='1'.repeat(40),ownerInputDigest='c'.repeat(64);let calls=0,responses=0,gate;
  const record=value=>{const body=JSON.stringify(value);return{body,sha256:createHash('sha256').update(body).digest('hex'),byteLength:Buffer.byteLength(body)};};
  const owner=record({kind:'MANAGED_DAEMON_REQUEST_OWNER_V1',jobId,sequence:1,identity:{inputDigest:ownerInputDigest}});
  const outcome=record({kind:'MANAGED_DAEMON_OWNER_OUTCOME_V1',jobId,sequence:1,
   ownerPin:{sha256:mode==='wrong-owner'?'0'.repeat(64):owner.sha256,byteLength:owner.byteLength},ownerInputDigest:mode==='wrong-input'?'0'.repeat(64):ownerInputDigest});
  gate=await createManagedDaemonCustodyChannel({jobId,inputDigest,sourceSha,requireIndependentOwner:true,requireIndependentOutcome:true,
   onHeader:async()=>saved(),onIntent:async()=>saved(),onOwner:async()=>({...saved(),independentOwnerDispatchVerified:false}),
   onOwnerOutcome:async()=>{calls++;if(mode==='refused')throw new Error('synthetic owner outcome refused');if(mode==='ACK-lost')void gate.close();
    return{...saved(mode==='wrong-ack-pin'?'BASELINE':'OBSERVATION'),independentOwnerDispatchVerified:false};},
   onResponse:async()=>{responses++;return saved('OBSERVATION');},onEnd:async()=>saved('OBSERVATION')});
  const send=(kind,artifact)=>requestManagedDaemonCustody({descriptorPath:gate.descriptorPath,kind,jobId,inputDigest,sourceSha,artifact});
  const response=record({kind:'MANAGED_DAEMON_CLIENT_RESPONSE_V1',jobId,sequence:1});
  try{
   await send('HEADER',record({kind:'MANAGED_DAEMON_REQUEST_HEADER_V2',jobId,inputDigest}));
   await send('INTENT',record({kind:'MANAGED_DAEMON_REQUEST_INTENT_V2',jobId,sequence:1}));
   if(mode!=='no-owner')await send('OWNER',owner);
   if(mode==='response-first')await assert.rejects(send('RESPONSE',response));
   else if(['success','duplicate'].includes(mode)){
    await send('OUTCOME',outcome);assert.equal(gate.snapshot().ownerOutcomeCount,1);
    if(mode==='duplicate')await assert.rejects(send('OUTCOME',outcome));
    else{await send('RESPONSE',response);assert.equal(responses,1);}
   }else await assert.rejects(send('OUTCOME',outcome));
   assert.equal(calls,['success','duplicate','refused','ACK-lost','wrong-ack-pin'].includes(mode)?1:0);
   assert.equal(gate.snapshot().requireIndependentOutcome,true);assert.equal(gate.snapshot().failed,mode!=='success');
  }finally{await gate.close();}
 }
});

test('bound worker input refuses missing custody descriptor before any helper mutation',{timeout:15000},async()=>{
 const result=await child(fileURLToPath(new URL('./managed-proof-worker.mjs',import.meta.url)),{args:['prove-restore','--output-dir','/synthetic-not-created'],snapshot:{synthetic:true},jobId:randomUUID(),daemonCustodyRequired:true});
 assert.equal(result.code,1);assert.equal(result.body.includes('MANAGED_IMPORTED_PROOF_WORKER_V1'),false);
});
