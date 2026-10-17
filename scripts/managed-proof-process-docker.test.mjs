import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID,randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,chmodSync,existsSync,readFileSync,rmSync} from 'node:fs';
import {join,dirname,resolve,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createManagedCaptureWorkspace} from './managed-capture-workspace.mjs';
import {DEFAULT_POSTGRES_IMAGE,PROOF_CLIENT_DATA_TMPFS,prepareLocalDockerCommand} from './postgres-backup.mjs';
import {superviseManagedProofProcess,superviseManagedProofGuardian,reconcileManagedProofContainers} from './managed-proof-runner.mjs';
const fixture=fileURLToPath(new URL('./managed-proof-docker-fixture.mjs',import.meta.url));
function docker(args){const p=prepareLocalDockerCommand(['docker',...args],process.env);const r=spawnSync(p.command[0],p.command.slice(1),{env:p.environment,windowsHide:true,encoding:'utf8',timeout:15000,maxBuffer:65536});assert.equal(r.status,0,'Synthetic local Docker command unresolved');return r.stdout.trim();}
const name=kind=>`charitypilot-${kind}-${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}`;
function create(job,tool){const id=docker(['run','--detach','--rm','--name',tool,'--network','none','--read-only','--tmpfs',PROOF_CLIENT_DATA_TMPFS,
 '--label','charitypilot.restore-proof=true','--label','charitypilot.managed-proof-job='+job,
 '--label','charitypilot.proof-created-at-ms='+Date.now(),'--entrypoint','sh',DEFAULT_POSTGRES_IMAGE,'-eu','-c','sleep 120']);assert.match(id,/^[a-f0-9]{64}$/);return id;}
function running(id){return docker(['inspect','--format','{{.State.Running}}',id])==='true';}
async function waitForClient(id){for(let i=0;i<20;i++){if(docker(['exec',id,'sh','-eu','-c','if test -f /var/lib/postgresql/data/guardian-exec-started; then printf ready; else printf waiting; fi'])==='ready')return;await new Promise(r=>setTimeout(r,100));}throw new Error('Synchronous synthetic Docker client did not start');}
function cleanup(ids){for(const id of ids){if(!/^[a-f0-9]{64}$/.test(id))throw new Error('Unsafe synthetic cleanup ID');
 const all=docker(['ps','-a','--no-trunc','--format','{{.ID}}']).split(/\r?\n/);if(all.includes(id))docker(['rm','--force',id]);}}
test('actual worker cancellation leaves a daemon workload which exact job cleanup removes while another job survives',{timeout:90000},async()=>{
 docker(['image','inspect',DEFAULT_POSTGRES_IMAGE,'--format','{{.Id}}']);const job=randomUUID(),other=randomUUID(),tool=name('source-snapshot'),ids=[];
 const controller=new AbortController();let child,pending;let readyResolve;const ready=new Promise(r=>{readyResolve=r;});
 try{
  const control=create(other,name('isolated-restore'));ids.push(control);
  pending=superviseManagedProofProcess({input:Buffer.from(JSON.stringify({jobId:job,name:tool})),env:process.env,signal:controller.signal,timeoutMs:45000},
   {start(_command,_args,options){child=spawn(process.execPath,[fixture],options);let body='';child.stdout.on('data',b=>{body+=b;if(body.length<=4096){try{const v=JSON.parse(body);if(typeof v.containerId==='string'&&/^[a-f0-9]{64}$/.test(v.containerId))readyResolve(v.containerId);}catch{}}});return child;}});
  void pending.catch(()=>{});let timer;
  const id=await Promise.race([ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Synthetic worker readiness unresolved')),40000);})]).finally(()=>clearTimeout(timer));
  assert.equal(typeof id,'string');ids.push(id);
  const inspected=JSON.parse(docker(['inspect','--format','{{json .}}',id]));assert.equal(inspected.HostConfig.NetworkMode,'none');assert.equal(inspected.HostConfig.ReadonlyRootfs,true);assert.ok(inspected.Mounts.every(m=>m.Type==='tmpfs'));assert.deepEqual(inspected.HostConfig.Tmpfs,{'/var/lib/postgresql/data':'rw,noexec,nosuid,size=1m'});
  await waitForClient(id);controller.abort();await assert.rejects(pending);assert.ok(child.exitCode!==null||child.signalCode!==null);
  assert.equal(running(id),true);assert.equal(running(control),true);
  const result=reconcileManagedProofContainers(job,process.env);assert.equal(result.removedCount,1);assert.equal(result.actionAuthorized,false);
  assert.equal(running(control),true);assert.equal(reconcileManagedProofContainers(job,process.env).removedCount,0);
 }finally{controller.abort();if(pending)await pending.catch(()=>{});
  // If readiness was lost, resolve only this fixture's exact preselected name.
  const residue=docker(['ps','-a','--no-trunc','--filter','name=^/'+tool+'$','--format','{{.ID}}']);if(residue&&!ids.includes(residue)){assert.match(residue,/^[a-f0-9]{64}$/);ids.push(residue);}cleanup(ids);
 }
});
test('actual labelled mismatch refuses the entire ordered batch before removal with a running positive control',{timeout:60000},()=>{
 const job=randomUUID(),ids=[];
 try{
  const good=create(job,name('source-snapshot'));ids.push(good);const bad=create(job,'charitypilot-synthetic-control-'+randomUUID());ids.push(bad);
  assert.throws(()=>reconcileManagedProofContainers(job,process.env,{run:args=>args[0]==='ps'?good+'\n'+bad:docker(args)}));
  assert.equal(running(good),true);assert.equal(running(bad),true);
 }finally{cleanup(ids);}
});

async function resultWorkspace(){
 const parent=mkdtempSync(join(tmpdir(),'charitypilot-guardian-test-'));
 if(process.platform==='win32'){const acl=fileURLToPath(new URL('./personal-server-windows-acl.ps1',import.meta.url));
  const r=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',acl,'-Path',parent,'-Kind','Directory'],{windowsHide:true,timeout:30000});assert.equal(r.status,0);}
 else chmodSync(parent,0o700);
 const workspace=await createManagedCaptureWorkspace(parent);return{parent,workspace,receipt:join(workspace.root,'guardian-result.json'),async close(){await workspace.close();assert.equal(dirname(resolve(parent)),resolve(tmpdir()));assert.ok(basename(parent).startsWith('charitypilot-guardian-test-'));rmSync(parent,{recursive:true,force:true});}};
}
async function waitForContainer(tool){for(let i=0;i<35;i++){const id=docker(['ps','-a','--no-trunc','--filter','name=^/'+tool+'$','--format','{{.ID}}']);
 if(id){assert.match(id,/^[a-f0-9]{64}$/);assert.equal(running(id),true);return id;}await new Promise(r=>setTimeout(r,100));}throw new Error('Synthetic guardian workload readiness unresolved');}
async function waitForReceipt(path){for(let i=0;i<60;i++){if(existsSync(path))return JSON.parse(readFileSync(path,'utf8'));await new Promise(r=>setTimeout(r,250));}throw new Error('Synthetic guardian terminal receipt unresolved');}
for(const mode of ['cancel','parent-kill'])test('live guardian stops owned worker and workload after '+mode+' while a separate job survives',{timeout:90000},async()=>{
 const f=await resultWorkspace(),job=randomUUID(),tool=name('source-snapshot'),ids=[],controller=new AbortController();let parent,pending;
 const env={...process.env,CHARITYPILOT_SYNTHETIC_GUARDIAN_RECEIPT:f.receipt},input=Buffer.from(JSON.stringify({jobId:job,name:tool}));
 try{
  const control=create(randomUUID(),name('isolated-restore'));ids.push(control);
  if(mode==='parent-kill'){
   parent=spawn(process.execPath,[fileURLToPath(new URL('./managed-proof-parent-fixture.mjs',import.meta.url))],{env,windowsHide:true,stdio:['pipe','ignore','ignore']});
   parent.stdin.on('error',()=>{});parent.stdin.end(input);
  }else{
   pending=superviseManagedProofGuardian({input,env,signal:controller.signal,timeoutMs:45000},{guardianPath:fileURLToPath(new URL('./managed-proof-guardian-fixture.mjs',import.meta.url))});void pending.catch(()=>{});
  }
  const id=await waitForContainer(tool);ids.push(id);await waitForClient(id);
  if(mode==='parent-kill'){
   assert.equal(parent.exitCode,null);const closed=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Owned synthetic parent did not close')),10000);parent.once('close',()=>{clearTimeout(timer);resolve();});});
   parent.kill('SIGKILL');await closed;
  }else{controller.abort();await assert.rejects(pending);}
  const observed=await waitForReceipt(f.receipt);
  assert.equal(observed.workerTimeoutMs,45000);assert.equal(observed.workerTerminal,true);assert.equal(observed.parentDisconnected,mode==='parent-kill');assert.equal(observed.cancellationRequested,true);
  assert.equal(observed.jobContainersObservedAbsent,true);assert.equal(observed.cleanupRemovedCount,1);assert.equal(observed.outcome,'UNRESOLVED');assert.equal(observed.actionAuthorized,false);
  assert.equal(docker(['ps','-a','--no-trunc','--filter','name=^/'+tool+'$','--format','{{.ID}}']), '');assert.equal(running(control),true);
 }finally{
  controller.abort();if(pending)await pending.catch(()=>{});if(parent&&parent.exitCode===null&&parent.signalCode===null)parent.kill('SIGKILL');
  const residue=docker(['ps','-a','--no-trunc','--filter','name=^/'+tool+'$','--format','{{.ID}}']);if(residue&&!ids.includes(residue)){assert.match(residue,/^[a-f0-9]{64}$/);ids.push(residue);}cleanup(ids);await f.close();
 }
});
