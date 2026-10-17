import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID,randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {DEFAULT_POSTGRES_IMAGE,PROOF_CLIENT_DATA_TMPFS,prepareLocalDockerCommand} from './postgres-backup.mjs';
import {superviseManagedProofProcess,reconcileManagedProofContainers} from './managed-proof-runner.mjs';
const fixture=fileURLToPath(new URL('./managed-proof-docker-fixture.mjs',import.meta.url));
function docker(args){const p=prepareLocalDockerCommand(['docker',...args],process.env);const r=spawnSync(p.command[0],p.command.slice(1),{env:p.environment,windowsHide:true,encoding:'utf8',timeout:15000,maxBuffer:65536});assert.equal(r.status,0,'Synthetic local Docker command unresolved');return r.stdout.trim();}
const name=kind=>`charitypilot-${kind}-${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}`;
function create(job,tool){const id=docker(['run','--detach','--rm','--name',tool,'--network','none','--read-only','--tmpfs',PROOF_CLIENT_DATA_TMPFS,
 '--label','charitypilot.restore-proof=true','--label','charitypilot.managed-proof-job='+job,
 '--label','charitypilot.proof-created-at-ms='+Date.now(),'--entrypoint','sh',DEFAULT_POSTGRES_IMAGE,'-eu','-c','sleep 120']);assert.match(id,/^[a-f0-9]{64}$/);return id;}
function running(id){return docker(['inspect','--format','{{.State.Running}}',id])==='true';}
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
  controller.abort();await assert.rejects(pending);assert.ok(child.exitCode!==null||child.signalCode!==null);
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
