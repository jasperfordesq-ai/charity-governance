import test from 'node:test';
import assert from 'node:assert/strict';
import {fork,spawn,spawnSync,execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {containmentUnit,inspectContainmentUnit,observeOriginalControlGroup,currentContainmentBootId} from './managed-proof-systemd-containment.mjs';
import {verifyContainedExecutorSource} from './managed-proof-systemd-runner.mjs';
import {requestOutcomeCustody} from './managed-outcome-custodian.mjs';
import {callSyntheticCustody} from './synthetic-custody-wire.mjs';
import {connectSyntheticCustody} from './synthetic-custody-client.mjs';
import {config,credentials} from '../apps/api/dist/tests/fixtures/archived-custody.js';
import {ManagedProofJobCustody} from '../apps/api/dist/services/managed-proof-job-custody.js';
const file=n=>fileURLToPath(new URL('./'+n,import.meta.url)),actor=file('managed-outcome-transfer-issuer.fixture.mjs');
const env=()=>Object.fromEntries(['PATH','HOME','USER','LOGNAME','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
const command=args=>{const r=spawnSync('systemctl',['--user',...args],{env:env(),encoding:'utf8',timeout:15000,maxBuffer:16384});assert.equal(r.status,0);return r.stdout;};
const terminal=child=>{const p=new Promise((yes,no)=>{child.once('error',no);child.once('close',(code,signal)=>yes({code,signal}));});void p.catch(()=>{});return p;};
function start(id,role,input){
 const unit=containmentUnit(id),r=spawnSync('systemctl',['--user','show',unit,'--property=LoadState','--value'],{env:env(),encoding:'utf8',timeout:15000});assert.equal(r.stdout.trim(),'not-found');
 const child=spawn('systemd-run',['--user','--quiet','--collect','--pipe','--unit='+unit,'--service-type=exec','--property=KillMode=control-group',
  '--property=NoNewPrivileges=yes','--property=MemoryMax=128M','--property=TasksMax=32','--property=CPUQuota=50%',
  '--property=RuntimeMaxSec=150s','--property=UnsetEnvironment=NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH',process.execPath,actor,role],{env:env(),stdio:['pipe','pipe','pipe']});
 const done=terminal(child);let stderr='';child.stderr.on('data',b=>{stderr+=b;if(stderr.length>4096)child.stderr.destroy();});
 const ready=new Promise((yes,no)=>{let body='';const timer=setTimeout(()=>no(Error('Synthetic issuer readiness expired')),20000);
  child.stdout.on('data',b=>{body+=b;if(body.length>32768){clearTimeout(timer);no(Error('Synthetic issuer output exceeded bound'));return;}
   if(body.endsWith('\n')){clearTimeout(timer);try{yes(JSON.parse(body));}catch{no(Error('Synthetic issuer readiness malformed'));}}});
  void done.then(()=>{clearTimeout(timer);no(Error('Synthetic issuer exited: '+stderr));},no);
 });void ready.catch(()=>{});child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(input));return{child,done,ready};
}
async function waitEmpty(identity){for(let i=0;i<100;i++){if(observeOriginalControlGroup(identity.ControlGroup,identity.Id,process.getuid())!=='POPULATED')return;await new Promise(r=>setTimeout(r,25));}throw Error('Original group remains populated');}
function stop(id,identity){
 const unit=containmentUnit(id),r=spawnSync('systemctl',['--user','show',unit,'--property=LoadState','--value'],{env:env(),encoding:'utf8',timeout:15000});
 if(r.stdout.trim()==='not-found')return;assert.ok(identity);const current=inspectContainmentUnit(unit);assert.equal(current.InvocationID,identity.InvocationID);command(['stop',unit]);
}
for(const mode of ['complete','readback-ack-lost','receiver-loss','claim-ack-lost','expiry','other-job'])test('original issuer SIGKILL retains bounded SDK outcome custody: '+mode,{
 skip:process.platform!=='linux'||process.env.CHARITYPILOT_TEST_OUTCOME_TRANSFER!=='1',timeout:150000
},async()=>{
 assert.notEqual(process.getuid(),0);const sourceSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();verifyContainedExecutorSource(sourceSha);
 for(const name of ['managed-outcome-transfer-issuer.fixture.mjs','managed-daemon-owner-custody.fixture.mjs','synthetic-custody-client.mjs','synthetic-custody-wire.mjs','synthetic-custody-service.fixture.mjs']){
  const path=file(name);assert.equal(realpathSync(path),path);assert.ok(readFileSync(path).equals(execFileSync('git',['show',sourceSha+':scripts/'+name])));
 }
 let keeper,keeperDone,owner,ownerIdentity,issuer,issuerIdentity,ready,client,controlIssuer,controlIdentity,controlReady,controlId,controlClient;
 const ownerId=randomUUID(),jobId=randomUUID();
 try{
  keeper=fork(file('synthetic-custody-service.fixture.mjs'),[],{execArgv:[],env:env(),stdio:['ignore','pipe','pipe','ipc']});keeperDone=terminal(keeper);
  const descriptor=await new Promise((yes,no)=>{const timer=setTimeout(()=>no(Error('Synthetic keeper readiness expired')),15000);keeper.once('message',v=>{clearTimeout(timer);yes(v);});});
  const {id}=await callSyntheticCustody(descriptor,{op:'open',config});const synthetic={descriptor,id,config,...(mode==='readback-ack-lost'?{fault:mode}:{})};
  owner=start(ownerId,'--owner',{ownerId,sourceSha});const originalOwner=await owner.ready;ownerIdentity=inspectContainmentUnit(containmentUnit(ownerId));assert.equal(ownerIdentity.InvocationID,originalOwner.invocationId);
  issuer=start(jobId,'--issuer',{jobId,sourceSha,owner:originalOwner,synthetic,...(mode==='claim-ack-lost'?{claimAckLoss:true}:{})});ready=await issuer.ready;issuerIdentity=inspectContainmentUnit(containmentUnit(jobId));assert.equal(issuerIdentity.InvocationID,ready.source.InvocationID);
  let controlBefore;
  if(mode==='claim-ack-lost'){assert.equal(ready.claimConsumed,true);assert.equal(ready.sdkReady,false);assert.equal(ready.providerReadsAfterClaim,0);assert.equal(ready.providerWritesAfterClaim,0);assert.equal(ready.receiver,undefined);}
  if(mode==='other-job'){
   const opened=await callSyntheticCustody(descriptor,{op:'open',config});controlId=opened.id;assert.notEqual(controlId,id);
   const controlJob=randomUUID();controlIssuer=start(controlJob,'--issuer',{jobId:controlJob,sourceSha,owner:originalOwner,synthetic:{descriptor,id:controlId,config}});
   controlReady=await controlIssuer.ready;controlIdentity=inspectContainmentUnit(controlReady.source.Id);
   assert.notEqual(controlReady.receiver.receiverId,ready.receiver.receiverId);assert.notEqual(controlReady.endpoint.root,ready.endpoint.root);
   assert.notEqual(controlReady.binding.candidateId,ready.binding.candidateId);controlBefore=await callSyntheticCustody(descriptor,{op:'stats',id:controlId});
  }
  const before=await callSyntheticCustody(descriptor,{op:'stats',id});
  command(['kill','--kill-who=main','--signal=SIGKILL',issuerIdentity.Id]);await issuer.done;await waitEmpty(issuerIdentity);
  if(ready.receiver){const receiver=inspectContainmentUnit(ready.receiver.identity.unit);assert.equal(receiver.ActiveState,'active');assert.equal(receiver.InvocationID,ready.receiver.identity.invocationId);
  assert.equal(receiver.MainPID,String(ready.receiver.identity.mainPid));assert.equal(currentContainmentBootId(),ready.receiver.identity.bootId);
  assert.equal(readFileSync('/proc/'+receiver.MainPID+'/cgroup','utf8').trim(),'0::'+ready.receiver.identity.controlGroup);
  if(mode==='expiry'){
   const deadline=BigInt(ready.expiresMonotonicNs);assert.ok(deadline>process.hrtime.bigint());
   console.log('Observing the original 120-second receiver deadline without clock mocking');
   while(process.hrtime.bigint()<deadline-1000000000n){
    const v=inspectContainmentUnit(receiver.Id);assert.equal(v.InvocationID,ready.receiver.identity.invocationId);assert.equal(v.ActiveState,'active');
    await new Promise(r=>setTimeout(r,500));
   }
   while(process.hrtime.bigint()<deadline+10000000n)await new Promise(r=>setTimeout(r,25));
   await waitEmpty(receiver);await assert.rejects(requestOutcomeCustody({endpoint:ready.endpoint,receiver:ready.receiver,artifact:ready.outcome}));
  }else if(mode==='receiver-loss'){
   command(['kill','--kill-who=main','--signal=SIGKILL',receiver.Id]);await waitEmpty(receiver);
   await assert.rejects(requestOutcomeCustody({endpoint:ready.endpoint,receiver:ready.receiver,artifact:ready.outcome}));
   console.log('Original killed receiver socket scope preserved: '+ready.endpoint.root);
  }else if(mode==='readback-ack-lost')await assert.rejects(requestOutcomeCustody({endpoint:ready.endpoint,receiver:ready.receiver,artifact:ready.outcome}));
  else{const ack=await requestOutcomeCustody({endpoint:ready.endpoint,receiver:ready.receiver,artifact:ready.outcome});assert.equal(ack.pendingRequestResolved,false);assert.equal(ack.originalAcknowledgementReconstructed,false);}
  }
  assert.equal(inspectContainmentUnit(ownerIdentity.Id).InvocationID,ownerIdentity.InvocationID);assert.equal(inspectContainmentUnit(ownerIdentity.Id).ActiveState,'active');
  const after=await callSyntheticCustody(descriptor,{op:'stats',id});assert.equal(after.writes,before.writes+(['receiver-loss','claim-ack-lost','expiry'].includes(mode)?0:1));assert.equal(after.generates,before.generates);
  if(ready.receiver)await assert.rejects(requestOutcomeCustody({endpoint:ready.endpoint,receiver:ready.receiver,artifact:ready.outcome}));
  const readonlyDescriptor={...descriptor,capability:descriptor.recoveryCapability};client=connectSyntheticCustody(readonlyDescriptor,id,config).s3();
  const cold=new ManagedProofJobCustody({installationId:config.installationId,bucket:config.bucket,accountId:config.accountId,kmsKeyArn:config.storageKeyArn},ready.binding,credentials,client,()=>false);
  const saved=await cold.discover(ready.original);assert.equal(saved.daemon.ownerOutcomeCount,['receiver-loss','claim-ack-lost','expiry'].includes(mode)?0:1);assert.equal(saved.daemon.independentOwnerDispatchVerified,false);assert.equal(saved.originalAcknowledgementReconstructed,false);
  assert.equal((await callSyntheticCustody(descriptor,{op:'stats',id})).writes,after.writes);
  if(controlReady){
   assert.equal(inspectContainmentUnit(controlIdentity.Id).InvocationID,controlIdentity.InvocationID);assert.equal(inspectContainmentUnit(controlIdentity.Id).ActiveState,'active');
   const c=inspectContainmentUnit(controlReady.receiver.identity.unit);assert.equal(c.InvocationID,controlReady.receiver.identity.invocationId);assert.equal(c.ActiveState,'active');
   const unchanged=await callSyntheticCustody(descriptor,{op:'stats',id:controlId});assert.equal(unchanged.writes,controlBefore.writes);assert.equal(unchanged.generates,controlBefore.generates);
   controlClient=connectSyntheticCustody(readonlyDescriptor,controlId,config).s3();
   const controlCold=new ManagedProofJobCustody({installationId:config.installationId,bucket:config.bucket,accountId:config.accountId,kmsKeyArn:config.storageKeyArn},controlReady.binding,credentials,controlClient,()=>false);
   assert.equal((await controlCold.discover(controlReady.original)).daemon.ownerOutcomeCount,0);
   const controlAck=await requestOutcomeCustody({endpoint:controlReady.endpoint,receiver:controlReady.receiver,artifact:controlReady.outcome});assert.equal(controlAck.pendingRequestResolved,false);
   assert.equal((await controlCold.discover(controlReady.original)).daemon.ownerOutcomeCount,1);assert.equal((await callSyntheticCustody(descriptor,{op:'stats',id:controlId})).writes,controlBefore.writes+1);
  }
  console.log('Actual issuer SIGKILL: '+mode+'; original SDK write count and read-only cold discovery passed; no retry, daemon dispatch or provider/host-loss claim');
 }finally{
  client?.destroy();controlClient?.destroy();if(controlIssuer)stop(controlIdentity.Id.slice('charitypilot-containment-'.length,-8),controlIdentity);if(issuer)stop(jobId,issuerIdentity);if(owner)stop(ownerId,ownerIdentity);
  for(const value of [ready,controlReady].filter(v=>v?.receiver)){const r=spawnSync('systemctl',['--user','show',value.receiver.identity.unit,'--property=LoadState','--value'],{env:env(),encoding:'utf8',timeout:15000});
   if(r.stdout.trim()!=='not-found'){const current=inspectContainmentUnit(value.receiver.identity.unit);assert.equal(current.InvocationID,value.receiver.identity.invocationId);command(['stop',current.Id]);}}
  if(keeper?.connected)keeper.send({kind:'STOP_SYNTHETIC_CUSTODY_V1'});if(keeperDone)await keeperDone;
 }
});
