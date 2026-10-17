import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,chmodSync,readFileSync,existsSync,rmSync,realpathSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename,resolve} from 'node:path';
import {createManagedCaptureWorkspace} from './managed-capture-workspace.mjs';
import {recordManagedProofJob,inspectManagedProofJob} from './managed-proof-job.mjs';
import {superviseContainedManagedProof} from './managed-proof-systemd-runner.mjs';
import {containmentUnit,inspectContainmentUnit} from './managed-proof-systemd-containment.mjs';
const fixture=fileURLToPath(new URL('./managed-proof-channel-fixture.mjs',import.meta.url)),hash=v=>createHash('sha256').update(v).digest('hex');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function execute(binary,args){const r=spawnSync(binary,args,{encoding:'utf8',timeout:15000,maxBuffer:4096});assert.equal(r.status,0,'Synthetic manager operation refused');return r.stdout;}
async function until(fn){for(let i=0;i<150;i++){const r=fn();if(r)return r;await pause(100);}throw new Error('Synthetic containment observation expired');}
test('fixed launcher requires original binding, actual service exit and empty cgroup without disturbing another service',{
 skip:process.platform!=='linux'||process.env.CHARITYPILOT_TEST_SYSTEMD_RUNNER!=='1',timeout:120000
},async()=>{
 assert.notEqual(process.getuid(),0);const control=containmentUnit(randomUUID());
 execute('systemd-run',['--user','--quiet','--unit='+control,'--service-type=exec','--property=NoNewPrivileges=yes','--property=KillMode=control-group',
  '--property=RuntimeMaxSec=60s','--property=MemoryMax=128M','--property=TasksMax=32',process.execPath,'-e','setInterval(()=>{},1000)']);
 const controlIdentity=inspectContainmentUnit(control);
 try{
  const controlJob=control.slice('charitypilot-containment-'.length,-8);let scopes=0;
  await assert.rejects(superviseContainedManagedProof({jobId:controlJob,sourceSha:'1'.repeat(40),timeoutMs:30000,input:Buffer.from(JSON.stringify({jobId:controlJob,args:['prove-restore','success'],snapshot:{kind:'synthetic'}})),env:{PATH:process.env.PATH},authorizeInvocation:async()=>true},
   {assertSource:()=>{},onScope:()=>{scopes++;}}));assert.equal(scopes,0);assert.equal(inspectContainmentUnit(control).InvocationID,controlIdentity.InvocationID);
  for(const mode of ['success','deny','cancel','guardian-loss','lost-launch-ack','worker-error','worker-error-default','pending-request']){
   const parent=mkdtempSync(join(tmpdir(),'charitypilot-contained-test-'));chmodSync(parent,0o700);
   const workspace=await createManagedCaptureWorkspace(parent),jobId=randomUUID(),scope={kind:'STANDALONE_INTERNAL_PROOF'},args=['prove-restore',mode.startsWith('worker-error')?'error':['success','deny','pending-request'].includes(mode)?'success':'hold'],snapshot={kind:'SYNTHETIC_CONTAINED_TEST'};
   const input=Buffer.from(JSON.stringify({args,snapshot,jobId})),marker=join(workspace.root,'contained-worker.json'),controller=new AbortController();let binding,scopePath,pending,observedDiagnostic='',diagnosticCopy;
   try{
    const job=await recordManagedProofJob(workspace,{format:1,kind:'MANAGED_IMPORTED_PROOF_JOB_V1',jobId,scope,sourceSha:'1'.repeat(40),workspaceDigest:workspace.identityDigest(),
     argumentsDigest:hash(JSON.stringify(args)),snapshotDigest:hash('CHARITYPILOT_MANAGED_EXPORTED_SNAPSHOT_V1\n'+JSON.stringify(snapshot)),createdAt:new Date().toISOString(),state:'REQUESTED_ONLY',executionAuthorized:false,publicationAuthorized:false,actionAuthorized:false});
    pending=superviseContainedManagedProof({jobId,sourceSha:'1'.repeat(40),input,env:{PATH:process.env.PATH,CHARITYPILOT_SYNTHETIC_CONTAINED_MARKER:marker,...(mode==='pending-request'?{CHARITYPILOT_SYNTHETIC_UNRESOLVED_REQUEST:'1'}:{})},signal:controller.signal,timeoutMs:30000,
     ...(mode==='worker-error'?{diagnostics:copy=>{observedDiagnostic+=copy.toString('utf8');diagnosticCopy=copy;}}:{}),
     authorizeInvocation:async identity=>{binding=await job.bindService(identity,input);return mode!=='deny';}},
     {assertSource:()=>{},guardianPath:fixture,onScope:value=>{scopePath=value.path;},...(mode==='lost-launch-ack'?{launch:parameters=>{execute('systemd-run',parameters);throw new Error('Synthetic original launch ACK lost');}}:{})});void pending.catch(()=>{});
    if(mode==='cancel'||mode==='guardian-loss'){
     await until(()=>existsSync(marker));const before=inspectContainmentUnit(containmentUnit(jobId));
     assert.equal(before.ActiveState,'active');if(mode==='cancel')controller.abort();else execute('systemctl',['--user','kill','--kill-who=main','--signal=SIGKILL',containmentUnit(jobId)]);
    }
    if(mode==='success'){
     const result=await pending;assert.equal(result.kernelContained,true);assert.equal(result.serviceTerminated,true);assert.equal(result.originalCgroupEmpty,true);assert.equal(result.daemonFenced,false);
     assert.equal(existsSync(marker),true);
    }else{await assert.rejects(pending,e=>typeof e.cohortTerminated==='boolean'&&(mode==='lost-launch-ack'||e.cohortTerminated));assert.equal(existsSync(marker),mode==='cancel'||mode==='guardian-loss'||mode.startsWith('worker-error')||mode==='pending-request');}
    if(mode==='worker-error'){assert.equal(observedDiagnostic,'synthetic-contained-worker-error');assert.ok(diagnosticCopy.every(b=>b===0));}else assert.equal(observedDiagnostic,'');
    const found=await inspectManagedProofJob(workspace,{requestPin:job.requestPin,expectedScope:scope,servicePin:binding?.pin});
    assert.equal(found.serviceSupplied,mode!=='lost-launch-ack');assert.equal(found.executionAuthorized,false);assert.equal(found.state,'REQUESTED_ONLY');
    if(mode!=='lost-launch-ack')assert.equal(existsSync(dirname(scopePath)),false);
    const current=inspectContainmentUnit(control);assert.equal(current.ActiveState,'active');assert.equal(current.InvocationID,controlIdentity.InvocationID);
   }finally{
    controller.abort();await pending?.catch(()=>{});input.fill(0);await workspace.close();
    if(scopePath&&existsSync(dirname(scopePath))){const root=dirname(scopePath);assert.equal(dirname(root),resolve(tmpdir()));assert.match(basename(root),/^charitypilot-managed-channel-[A-Za-z0-9]{6}$/);assert.equal(realpathSync(root),root);assert.equal(lstatSync(root).uid,process.getuid());assert.equal(JSON.parse(readFileSync(join(root,'launch-request.json'),'utf8')).jobId,jobId);rmSync(root,{recursive:true,force:true});}
    assert.equal(dirname(parent),resolve(tmpdir()));assert.ok(basename(parent).startsWith('charitypilot-contained-test-'));assert.equal(realpathSync(parent),parent);rmSync(parent,{recursive:true,force:true});
   }
  }
 }finally{execute('systemctl',['--user','stop',control]);spawnSync('systemctl',['--user','reset-failed',control],{stdio:'ignore',timeout:15000});}
});
