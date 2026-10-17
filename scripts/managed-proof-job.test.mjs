import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,chmodSync,readFileSync,writeFileSync,renameSync,mkdirSync,copyFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,basename} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createManagedCaptureWorkspace,openManagedCaptureWorkspace} from './managed-capture-workspace.mjs';
import {recordManagedProofJob,inspectManagedProofJob} from './managed-proof-job.mjs';
const scope={kind:'COMMON_CANDIDATE',bindingDigest:'a'.repeat(64),requestPinDigest:'b'.repeat(64),sourceSha:'c'.repeat(40)};
const acl=fileURLToPath(new URL('./personal-server-windows-acl.ps1',import.meta.url));
async function setup(){
 const parent=mkdtempSync(join(tmpdir(),'charitypilot-job-test-'));
 if(process.platform==='win32'){const r=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',acl,'-Path',parent,'-Kind','Directory'],{windowsHide:true,encoding:'utf8',timeout:30000});assert.equal(r.status,0,r.stderr);}
 else chmodSync(parent,0o700);
 const workspace=await createManagedCaptureWorkspace(parent);
 const request={format:1,kind:'MANAGED_IMPORTED_PROOF_JOB_V1',jobId:randomUUID(),scope,sourceSha:'c'.repeat(40),workspaceDigest:workspace.identityDigest(),snapshotDigest:'d'.repeat(64),argumentsDigest:'e'.repeat(64),createdAt:new Date().toISOString(),state:'REQUESTED_ONLY',executionAuthorized:false,publicationAuthorized:false,actionAuthorized:false};
 return{parent,workspace,request,async close(){await workspace.close();assert.equal(dirname(resolve(parent)),resolve(tmpdir()));assert.ok(basename(parent).startsWith('charitypilot-job-test-'));rmSync(parent,{recursive:true,force:true});}};
}
test('durable baseline and observation survive fresh read-only handles and an independent reader process',async()=>{
 const f=await setup();let reopened;
 try{
  const job=await recordManagedProofJob(f.workspace,f.request);const result=await job.observe('WORKER_EXIT_ACK_OBSERVED',true);
  const root=f.workspace.root,expected={requestPin:job.requestPin,expectedScope:scope,observationPin:result.pin};await f.workspace.close();
  reopened=await openManagedCaptureWorkspace(f.parent,root);const receipt=await inspectManagedProofJob(reopened,expected);
  assert.equal(receipt.state,'WORKER_EXIT_ACK_OBSERVED');assert.equal(receipt.executionAuthorized,false);assert.equal(receipt.publicationAuthorized,false);
  await assert.rejects(reopened.createCiphertextDestination('replacement-job.json'));await assert.rejects(reopened.pinProducedFile('proof-job.request.json'));
  const code=`import {openManagedCaptureWorkspace} from './scripts/managed-capture-workspace.mjs';import {inspectManagedProofJob} from './scripts/managed-proof-job.mjs';let body='';for await(const b of process.stdin)body+=b;const v=JSON.parse(body),w=await openManagedCaptureWorkspace(v.parent,v.root);try{process.stdout.write(JSON.stringify(await inspectManagedProofJob(w,v.expected)));}finally{await w.close();}`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:fileURLToPath(new URL('..',import.meta.url)),input:JSON.stringify({parent:f.parent,root,expected}),encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:8192});
  assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),receipt);
  const saved=readFileSync(join(root,'proof-job.request.json'),'utf8');assert.ok(!saved.includes('postgresql:'));assert.ok(!saved.includes('snapshotId'));assert.ok(!saved.includes(root));
 }finally{await reopened?.close();await f.close();}
});
test('missing observation remains requested-only and neither duplicate baseline nor result retries are allowed',async()=>{
 const f=await setup();try{
  const job=await recordManagedProofJob(f.workspace,f.request),expected={requestPin:job.requestPin,expectedScope:scope};
  await assert.rejects(recordManagedProofJob(f.workspace,{...f.request,jobId:randomUUID()}));
  await assert.rejects(job.observe('RETRY_ALLOWED',false));await assert.rejects(job.observe('WORKER_EXIT_ACK_OBSERVED',true));
  const result=await inspectManagedProofJob(f.workspace,expected);assert.equal(result.state,'REQUESTED_ONLY');assert.equal(result.resultSupplied,false);assert.equal(result.actionAuthorized,false);
  assert.equal(existsSync(join(f.workspace.root,'proof-job.observation.json')),false);
 }finally{await f.close();}
});
test('unknown worker outcome stays unresolved despite later observed container absence',async()=>{
 const f=await setup();try{
  const job=await recordManagedProofJob(f.workspace,f.request),result=await job.observe('UNRESOLVED',true);
  const observed=await inspectManagedProofJob(f.workspace,{requestPin:job.requestPin,expectedScope:scope,observationPin:result.pin});
  assert.equal(observed.state,'UNRESOLVED');assert.equal(observed.jobContainersObservedAbsent,true);assert.equal(observed.executionAuthorized,false);
  await assert.rejects(job.observe('WORKER_EXIT_ACK_OBSERVED',true));
 }finally{await f.close();}
});
test('different original request, altered file and wrong exact version digest cannot be accepted',async()=>{
 const f=await setup();try{
  const job=await recordManagedProofJob(f.workspace,f.request),expected={requestPin:job.requestPin,expectedScope:scope};
  await assert.rejects(inspectManagedProofJob(f.workspace,{...expected,expectedScope:{...scope,requestPinDigest:'f'.repeat(64)}}));
  await assert.rejects(inspectManagedProofJob(f.workspace,{...expected,requestPin:{...job.requestPin,sha256:'0'.repeat(64)}}));
  const path=join(f.workspace.root,'proof-job.request.json'),original=readFileSync(path,'utf8');writeFileSync(path,original.replace(f.request.jobId,randomUUID()));
  await assert.rejects(inspectManagedProofJob(f.workspace,expected));
 }finally{await f.close();}
});
test('copying the exact request into a substituted workspace cannot preserve its identity binding',async()=>{
 const f=await setup();let reopened;
 try{
  const job=await recordManagedProofJob(f.workspace,f.request),root=f.workspace.root,moved=join(f.parent,'moved');await f.workspace.close();renameSync(root,moved);mkdirSync(root,{mode:0o700});
  if(process.platform==='win32'){const r=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',acl,'-Path',root,'-Kind','Directory'],{windowsHide:true,timeout:30000});assert.equal(r.status,0);}
  copyFileSync(join(moved,'proof-job.request.json'),join(root,'proof-job.request.json'));reopened=await openManagedCaptureWorkspace(f.parent,root);
  await assert.rejects(inspectManagedProofJob(reopened,{requestPin:job.requestPin,expectedScope:scope}));
 }finally{await reopened?.close();await f.close();}
});
test('records reject secrets, authority flags and scope substitution before creating a baseline',async()=>{
 const f=await setup();try{
  for(const request of [{...f.request,sourceSha:'f'.repeat(40)},{...f.request,executionAuthorized:true},{...f.request,databaseUrl:'postgresql://private-secret'},
   {...f.request,scope:{...scope,rawSnapshot:'private-secret'}},{...f.request,workspaceDigest:'0'.repeat(64)}])await assert.rejects(recordManagedProofJob(f.workspace,request));
  assert.equal(existsSync(join(f.workspace.root,'proof-job.request.json')),false);
 }finally{await f.close();}
});
function serviceInput(f){
 const args=['prove-restore','--synthetic-only'],snapshot={kind:'synthetic-private-snapshot'},hash=v=>createHash('sha256').update(v).digest('hex');
 f.request.argumentsDigest=hash(JSON.stringify(args));f.request.snapshotDigest=hash('CHARITYPILOT_MANAGED_EXPORTED_SNAPSHOT_V1\n'+JSON.stringify(snapshot));
 const input=Buffer.from(JSON.stringify({args,snapshot,jobId:f.request.jobId}));
 const identity={format:1,kind:'MANAGED_GUARDIAN_LIVE_BINDING_V1',jobId:f.request.jobId,unit:'charitypilot-containment-'+f.request.jobId+'.service',
  invocationId:'a'.repeat(32),uid:1000,mainPid:123,mainStartMonotonic:'456789',sourceSha:f.request.sourceSha,inputDigest:hash(input),executionAuthorized:false,actionAuthorized:false};
 return{input,identity};
}
test('service binding is durable, linked to the exact baseline and readable without execution authority',async()=>{
 const f=await setup();let reopened;const {input,identity}=serviceInput(f);
 try{
  const job=await recordManagedProofJob(f.workspace,f.request),bound=await job.bindService(identity,input);
  await assert.rejects(job.bindService(identity,input));const expected={requestPin:job.requestPin,expectedScope:scope,servicePin:bound.pin};
  await f.workspace.close();reopened=await openManagedCaptureWorkspace(f.parent,f.workspace.root);const found=await inspectManagedProofJob(reopened,expected);
  assert.deepEqual(found.serviceIdentity,identity);assert.equal(found.serviceSupplied,true);assert.equal(found.state,'REQUESTED_ONLY');assert.equal(found.executionAuthorized,false);
  const body=readFileSync(join(f.workspace.root,'proof-job.service.json'),'utf8');assert.ok(!body.includes('synthetic-private-snapshot'));assert.ok(!body.includes('--synthetic-only'));
  await assert.rejects(inspectManagedProofJob(reopened,{...expected,servicePin:{...bound.pin,sha256:'0'.repeat(64)}}));
 }finally{input.fill(0);await reopened?.close();await f.close();}
});
test('substituted input, scope, unit, process or authority consumes the service attempt without a file',async()=>{
 for(const change of [{inputDigest:'0'.repeat(64)},{sourceSha:'f'.repeat(40)},{unit:'unrelated.service'},{jobId:randomUUID()},{mainPid:0},{uid:0},{executionAuthorized:true},{rawSecret:'private-secret'}]){
  const f=await setup(),{input,identity}=serviceInput(f);
  try{const job=await recordManagedProofJob(f.workspace,f.request);await assert.rejects(job.bindService({...identity,...change},input));await assert.rejects(job.bindService(identity,input));
   assert.equal(existsSync(join(f.workspace.root,'proof-job.service.json')),false);
  }finally{input.fill(0);await f.close();}
 }
 const f=await setup(),{input,identity}=serviceInput(f);try{
  const job=await recordManagedProofJob(f.workspace,f.request),v=JSON.parse(input.toString());v.args.push('substituted');
  await assert.rejects(job.bindService(identity,Buffer.from(JSON.stringify(v))));assert.equal(existsSync(join(f.workspace.root,'proof-job.service.json')),false);
 }finally{input.fill(0);await f.close();}
});
test('a service binding cannot be added after the original outcome has been attempted',async()=>{
 const f=await setup(),{input,identity}=serviceInput(f);try{
  const job=await recordManagedProofJob(f.workspace,f.request);await job.observe('UNRESOLVED',false);await assert.rejects(job.bindService(identity,input));
  assert.equal(existsSync(join(f.workspace.root,'proof-job.service.json')),false);
 }finally{input.fill(0);await f.close();}
});

test('version two service pins retain original boot and cgroup while rejecting malformed scope paths',async()=>{
 for(const invalid of [null,'/other','/user.slice/user-1000.slice/user@1000.service/../bad']){
  const f=await setup(),{input,identity}=serviceInput(f);try{
   const next={...identity,format:2,kind:'MANAGED_GUARDIAN_LIVE_BINDING_V2',bootId:'12345678-1234-1234-1234-123456789012',
    controlGroup:'/user.slice/user-1000.slice/user@1000.service/app.slice/'+identity.unit};
   if(invalid!==null)next.controlGroup=invalid;
   const job=await recordManagedProofJob(f.workspace,f.request);
   if(invalid!==null)await assert.rejects(job.bindService(next,input));
   else{const saved=await job.bindService(next,input),read=await inspectManagedProofJob(f.workspace,{requestPin:job.requestPin,expectedScope:scope,servicePin:saved.pin});assert.deepEqual(read.serviceIdentity,next);}
  }finally{input.fill(0);await f.close();}
 }
});
