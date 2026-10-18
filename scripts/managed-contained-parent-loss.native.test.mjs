import test from 'node:test';
import assert from 'node:assert/strict';
import {fork,spawn,spawnSync} from 'node:child_process';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdtempSync,chmodSync,writeFileSync,readFileSync,realpathSync,lstatSync,rmSync,existsSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DEFAULT_POSTGRES_IMAGE,prepareLocalDockerCommand,captureHelperImplementationBinding,inspectProofContainerInventory} from './postgres-backup.mjs';
import {inspectContainmentUnit,containmentUnit} from './managed-proof-systemd-containment.mjs';
import {inspectOriginalProofStorage} from './managed-proof-storage-inspect.mjs';
import {requireDaemonGateDirectory} from './managed-daemon-custody-channel.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function docker(args,input){const p=prepareLocalDockerCommand(['docker',...args],process.env),r=spawnSync(p.command[0],p.command.slice(1),{env:p.environment,input,encoding:'utf8',timeout:15000,maxBuffer:65536});assert.equal(r.status,0,'Synthetic Docker operation refused');return r.stdout.trim();}
function manager(args){const r=spawnSync('systemctl',['--user',...args],{encoding:'utf8',timeout:15000,maxBuffer:4096});assert.equal(r.status,0,'Synthetic manager operation refused');return r.stdout;}
async function until(fn){for(let i=0;i<100;i++){const value=await fn();if(value)return value;await pause(100);}throw new Error('Synthetic original source observation expired');}
function protectedRemove(path,prefix){if(!existsSync(path))return;assert.equal(dirname(path),resolve(tmpdir()));assert.ok(basename(path).startsWith(prefix));assert.equal(realpathSync(path),path);assert.equal(lstatSync(path).uid,process.getuid());assert.equal(lstatSync(path).mode&0o777,0o700);rmSync(path,{recursive:true,force:true});}
test('real source caller loss stops its cohort while the original independent request owner and unresolved quarantine survive',{
 skip:process.platform!=='linux'||process.env.CHARITYPILOT_TEST_CONTAINED_PARENT!=='1',timeout:120000
},async()=>{
 assert.notEqual(process.getuid(),0);const helper=captureHelperImplementationBinding();assert.equal(helper.sourceMatchesCommit,true);assert.equal(helper.canonicalRepositoryMatched,true);
 const root=mkdtempSync(join(tmpdir(),'charitypilot-parent-observer-'));chmodSync(root,0o700);
 let producer,producerTerminal,locker,lockerTerminal,control,ready,held,unit,originalOwner,verifiedSource,channelRoot,originalGroup,daemonGateBinding,output='',errors='';const observedClientIds=[],ownedVolumes=[],volumeOwner=randomUUID();let attachedVolume,emptyVolume,controlPlannedName;
 const saveOwnership=(name,value)=>{writeFileSync(join(root,name),JSON.stringify(value),{flag:'wx',mode:0o600});const fd=openSync(join(root,name),'r');try{fsyncSync(fd);}finally{closeSync(fd);}const dir=openSync(root,'r');try{fsyncSync(dir);}finally{closeSync(dir);}};
 try{
  const otherJob=randomUUID(),controlName=`charitypilot-isolated-restore-${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}`;
  controlPlannedName=controlName;attachedVolume='charitypilot-synthetic-storage-'+randomUUID();saveOwnership('fixture-ownership.json',{volumeOwner,attachedVolume,controlName,otherJob});
  assert.equal(docker(['volume','create','--label','charitypilot.synthetic-owner='+volumeOwner,'--label','charitypilot.managed-proof-job='+otherJob,attachedVolume]),attachedVolume);ownedVolumes.push(attachedVolume);
  control=docker(['run','--detach','--rm','--name',controlName,'--network','none','--read-only','--tmpfs','/var/lib/postgresql/data:rw,noexec,nosuid,size=1m',
   '--mount','type=volume,source='+attachedVolume+',target=/synthetic-storage-control',
   '--label','charitypilot.restore-proof=true','--label','charitypilot.proof-created-at-ms='+(Date.now()-7_200_000),'--label','charitypilot.managed-proof-job='+otherJob,'--entrypoint','sh',DEFAULT_POSTGRES_IMAGE,'-eu','-c','sleep 120']);assert.match(control,/^[a-f0-9]{64}$/);
  const before=inspectProofContainerInventory({jobId:otherJob});assert.equal(before.containers.length,1);assert.equal(before.containers[0].id,control);assert.equal(before.containers[0].ageClass,'OLDER_THAN_PROOF_TIMEOUT');assert.equal(before.cleanupAuthorized,false);
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!['NODE_TEST_CONTEXT','NODE_OPTIONS','NODE_PATH'].includes(key)));
  producer=fork(fileURLToPath(new URL('./managed-database-writer-fence-postgres.test.mjs',import.meta.url)),[],{execArgv:[],env:{...env,CHARITYPILOT_TEST_CONTAINED_SOURCE:'1',CHARITYPILOT_TEST_SOURCE_PARENT_FIXTURE:'1'},stdio:['ignore','pipe','pipe','ipc']});
  producer.stdout.on('data',b=>{output+=b.toString();if(output.length>65536)producer.kill('SIGKILL');});producer.stderr.on('data',b=>{errors+=b.toString();if(errors.length>65536)producer.kill('SIGKILL');});
  producer.on('message',value=>{if(value?.kind==='ORIGINAL_CONTAINED_OWNER_READY_V1'&&!originalOwner)originalOwner=value.owner;});
  producerTerminal=new Promise((yes,no)=>{producer.once('error',no);producer.once('close',(code,signal)=>yes({code,signal}));});void producerTerminal.catch(()=>{});
  ready=await new Promise((yes,no)=>{const timer=setTimeout(()=>no(new Error('Original source barrier missing: '+output.slice(-2000))),30000);
   producer.once('message',value=>{clearTimeout(timer);yes(value);});producer.once('exit',()=>{clearTimeout(timer);no(new Error('Original source exited before barrier: '+output.slice(-2000)));});});
  assert.equal(ready.kind,'ORIGINAL_CONTAINED_SOURCE_READY_V1');assert.equal(ready.sourceSha,helper.commitSha);assert.match(ready.sourceId,/^[a-f0-9]{64}$/);assert.match(ready.database,/^managed_writer_[a-f0-9]{32}$/);
  assert.equal(ready.executionAuthorized,false);assert.equal(ready.actionAuthorized,false);unit=containmentUnit(ready.jobId);assert.equal(ready.identity.unit,unit);
  const original=inspectContainmentUnit(unit);assert.equal(original.InvocationID,ready.identity.invocationId);assert.equal(Number(original.MainPID),ready.identity.mainPid);assert.equal(original.ActiveState,'active');assert.ok(original.ControlGroup);
  assert.equal(ready.identity.format,2);assert.equal(ready.identity.controlGroup,original.ControlGroup);assert.match(ready.identity.bootId,/^[a-f0-9-]{36}$/);
  originalGroup=original.ControlGroup;
  const command=readFileSync('/proc/'+ready.identity.mainPid+'/cmdline','utf8').split('\0').filter(Boolean);
  assert.deepEqual(command.slice(0,3),[process.execPath,fileURLToPath(new URL('./managed-proof-guardian.mjs',import.meta.url)),'--systemd-socket']);assert.equal(command.length,4);
  const observedChannelRoot=dirname(command[3]);assert.equal(basename(command[3]),'guardian.sock');assert.equal(dirname(observedChannelRoot),resolve(tmpdir()));assert.match(basename(observedChannelRoot),/^charitypilot-managed-channel-[A-Za-z0-9]{6}$/);
  assert.equal(realpathSync(observedChannelRoot),observedChannelRoot);assert.equal(lstatSync(observedChannelRoot).uid,process.getuid());assert.equal(lstatSync(observedChannelRoot).mode&0o777,0o700);assert.equal(lstatSync(command[3]).isSocket(),true);channelRoot=observedChannelRoot;
  const b=JSON.parse(readFileSync(join(channelRoot,'daemon-gate-binding.json'),'utf8'));
  assert.equal(b.kind,'MANAGED_DAEMON_GATE_BINDING_V1');assert.equal(b.jobId,ready.jobId);assert.equal(b.inputDigest,ready.identity.inputDigest);assert.equal(b.sourceSha,helper.commitSha);
  assert.equal(basename(b.descriptorPath),'gate.json');const gateStat=requireDaemonGateDirectory(dirname(b.descriptorPath));assert.equal(gateStat.dev,b.device);assert.equal(gateStat.ino,b.inode);
  daemonGateBinding=b;saveOwnership('original-daemon-gate.json',b);
  const source=JSON.parse(docker(['inspect','--format','{{json .}}',ready.sourceId]));assert.equal(source.Id,ready.sourceId);assert.match(source.Name,/^\/charitypilot-managed-writer-[a-f0-9-]{36}$/);assert.equal(source.State.Running,true);
  assert.ok(source.Config.Env.includes('POSTGRES_DB='+ready.database));assert.ok(source.Config.Env.includes('POSTGRES_PASSWORD=synthetic-maintenance-only'));verifiedSource=source.Id;
  emptyVolume='charitypilot-synthetic-storage-'+randomUUID();saveOwnership('fixture-empty-volume.json',{volumeOwner,emptyVolume,jobId:ready.jobId});
  assert.equal(docker(['volume','create','--label','charitypilot.synthetic-owner='+volumeOwner,'--label','charitypilot.managed-proof-job='+ready.jobId,emptyVolume]),emptyVolume);ownedVolumes.push(emptyVolume);
  held={...ready,originalControlGroup:original.ControlGroup,kind:'HELD_SYNTHETIC_SOURCE_OBSERVATION_V1'};
  writeFileSync(join(root,'original-pins.json'),JSON.stringify(held),{flag:'wx',mode:0o600});const fd=openSync(join(root,'original-pins.json'),'r');try{fsyncSync(fd);}finally{closeSync(fd);}
  const endpoint=prepareLocalDockerCommand(['docker','version'],process.env),sql="BEGIN; LOCK TABLE public.synthetic_snapshot_public IN ACCESS EXCLUSIVE MODE; SELECT 'ORIGINAL_LOCK_ACK'; SELECT pg_sleep(60); ROLLBACK;\n";
  locker=spawn(endpoint.command[0],[...endpoint.command.slice(1,-1),'exec','-i',ready.sourceId,'psql','--no-psqlrc','--quiet','--tuples-only','--no-align','--set=ON_ERROR_STOP=1','-U','postgres','-d',ready.database],{env:endpoint.environment,stdio:['pipe','pipe','pipe']});
  let lockOutput='';locker.stdout.on('data',b=>{lockOutput+=b.toString();});locker.stderr.resume();locker.stdin.on('error',()=>{});locker.stdin.end(sql);
  lockerTerminal=new Promise((yes,no)=>{locker.once('error',no);locker.once('close',(code,signal)=>yes({code,signal}));});void lockerTerminal.catch(()=>{});
  await until(()=>lockOutput.includes('ORIGINAL_LOCK_ACK'));producer.send({kind:'RELEASE_SYNTHETIC_CONTAINED_SOURCE_V1',jobId:ready.jobId});
  let lastClientCount=0,lastWaiterCount=0;
  try{await until(()=>{
   if(producer.exitCode!==null||producer.signalCode!==null)throw new Error('Original source exited before fault: '+output.slice(-4096)+' '+errors.slice(-1024));
   const ids=docker(['ps','--no-trunc','--filter','label=charitypilot.restore-proof=true','--filter','label=charitypilot.managed-proof-job='+ready.jobId,'--format','{{.ID}}']);
   const rows=ids?ids.split(/\r?\n/):[];lastClientCount=rows.length;assert.ok(rows.length<=16);for(const id of rows){assert.match(id,/^[a-f0-9]{64}$/);if(!observedClientIds.includes(id))observedClientIds.push(id);}
   const waiting=docker(['exec',ready.sourceId,'psql','-U','postgres','-d',ready.database,'-At','-v','ON_ERROR_STOP=1','-c',"SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'"]);
   lastWaiterCount=Number(waiting);return rows.length>0&&lastWaiterCount>0;
  });}catch(error){throw new Error('Original work observation failed: clients='+lastClientCount+' waiters='+lastWaiterCount+'; '+error.message+'; '+output.slice(-4096)+' '+errors.slice(-1024));}
  const live=inspectContainmentUnit(unit);assert.equal(live.InvocationID,held.identity.invocationId);assert.notEqual(Number(live.MainPID),producer.pid);
  assert.equal(originalOwner?.jobId,ready.jobId);assert.equal(originalOwner.sequence,1);const owner=originalOwner.identity;
  assert.equal(owner.sourceSha,helper.commitSha);assert.notEqual(owner.unit,unit);assert.notEqual(owner.controlGroup,originalGroup);
  const liveOwner=inspectContainmentUnit(owner.unit);assert.equal(liveOwner.InvocationID,owner.invocationId);assert.equal(liveOwner.MainPID,String(owner.mainPid));assert.equal(liveOwner.ActiveState,'active');
  saveOwnership('original-owner.json',originalOwner);
  const storage=inspectOriginalProofStorage({root:ready.workspaceRoot,jobId:ready.jobId,inputDigest:ready.identity.inputDigest});
  assert.ok(storage.containers.some(v=>observedClientIds.includes(v.id)&&v.state==='ORIGINAL_PLAN_MATCHES_CURRENT_MOUNTS'));
  assert.equal(storage.completeResourceInventory,false);assert.ok(storage.volumes.every(v=>v.cleanupAuthorized===false));
  assert.equal(storage.volumes.find(v=>v.name===attachedVolume)?.attachmentState,'ATTACHMENTS_OBSERVED');assert.ok(storage.volumes.find(v=>v.name===attachedVolume).containerIds.includes(control));
  const empty=storage.volumes.find(v=>v.name===emptyVolume);assert.equal(empty?.attachmentState,'NO_ATTACHMENTS_OBSERVED');assert.equal(empty.attribution,'JOB_LABEL_ONLY_UNVERIFIED');
  const members=readFileSync('/sys/fs/cgroup'+held.originalControlGroup+'/cgroup.procs','utf8').trim().split(/\s+/);
  assert.ok(members.includes(String(held.identity.mainPid)));assert.ok(members.length>=2);
  assert.equal(producer.exitCode,null);producer.kill('SIGKILL');const death=await producerTerminal;assert.equal(death.signal,'SIGKILL');
  const terminal=await until(()=>{try{const value=inspectContainmentUnit(unit);return value.MainPID==='0'&&value.ActiveState==='failed'?value:null;}catch{return null;}});
  assert.equal(terminal.InvocationID,held.identity.invocationId);assert.equal(terminal.ExecMainStartTimestampMonotonic,held.identity.mainStartMonotonic);
  assert.ok(!existsSync('/sys/fs/cgroup'+held.originalControlGroup+'/cgroup.procs')||readFileSync('/sys/fs/cgroup'+held.originalControlGroup+'/cgroup.procs','utf8').trim()==='');
  const survivingOwner=inspectContainmentUnit(owner.unit);assert.equal(survivingOwner.InvocationID,owner.invocationId);assert.equal(survivingOwner.MainPID,String(owner.mainPid));assert.equal(survivingOwner.ActiveState,'active');
  const retained=docker(['ps','-a','--no-trunc','--filter','label=charitypilot.restore-proof=true','--filter','label=charitypilot.managed-proof-job='+ready.jobId,'--format','{{.ID}}']).split(/\r?\n/);
  assert.ok(observedClientIds.every(id=>retained.includes(id)));assert.ok(retained.length>0);
  assert.equal(docker(['inspect','--format','{{.State.Running}}',ready.sourceId]),'true');assert.equal(docker(['inspect','--format','{{.State.Running}}',control]),'true');
  const after=inspectProofContainerInventory({jobId:otherJob});assert.equal(after.containers.length,1);assert.equal(after.containers[0].id,control);assert.equal(after.containers[0].running,true);assert.equal(after.completeResourceInventory,false);assert.equal(after.executionAuthorized,false);
  const code=`import {openManagedCaptureWorkspace} from './scripts/managed-capture-workspace.mjs';import {inspectManagedProofJob} from './scripts/managed-proof-job.mjs';import {inspectOriginalProofCohort} from './scripts/managed-proof-orphan.mjs';let input='';for await(const b of process.stdin)input+=b;const v=JSON.parse(input),w=await openManagedCaptureWorkspace(v.parentDirectory,v.workspaceRoot);try{const r=await inspectManagedProofJob(w,{requestPin:v.requestPin,expectedScope:v.scope,servicePin:v.servicePin});let denied=false;try{await w.createCiphertextDestination('replay-refused.json');}catch{denied=true;}process.stdout.write(JSON.stringify({...r,cohort:inspectOriginalProofCohort(r.serviceIdentity),replayWriteRefused:denied}));}finally{await w.close();}`;
  const fresh=spawnSync(process.execPath,['--input-type=module','-e',code],{input:readFileSync(join(root,'original-pins.json')),encoding:'utf8',timeout:10000,maxBuffer:16384});assert.equal(fresh.status,0);
  const read=JSON.parse(fresh.stdout);assert.equal(read.jobId,ready.jobId);assert.equal(read.state,'REQUESTED_ONLY');assert.equal(read.resultSupplied,false);assert.deepEqual(read.serviceIdentity,ready.identity);assert.equal(read.replayWriteRefused,true);assert.equal(read.executionAuthorized,false);
  assert.equal(read.cohort.state,'ORIGINAL_COHORT_EMPTY');assert.equal(read.cohort.cleanupAuthorized,false);assert.equal(read.cohort.completeResourceInventory,false);
  const operator=spawnSync(process.execPath,['scripts/managed-proof-orphan.mjs'],{input:JSON.stringify({parentDirectory:ready.parentDirectory,workspaceRoot:ready.workspaceRoot,
   requestPin:ready.requestPin,expectedScope:ready.scope,servicePin:ready.servicePin}),encoding:'utf8',timeout:10000,maxBuffer:16384});assert.equal(operator.status,0);
  const inspected=JSON.parse(operator.stdout);assert.equal(inspected.cohort.state,'ORIGINAL_COHORT_EMPTY');assert.equal(inspected.cleanupAuthorized,false);assert.equal(inspected.executionAuthorized,false);
  assert.equal(inspected.daemonRequests.state,'UNRESOLVED_REQUESTS');assert.equal(inspected.daemonRequests.mutatingRequestsObservedSuccessful,false);assert.ok(inspected.daemonRequests.requestCount>=1);
  assert.equal(inspected.daemonRequests.declaredImageVolumesCovered,true);assert.equal(inspected.daemonRequests.completeResourceInventory,false);
  assert.ok(inspected.storage.containers.some(v=>v.state==='ORIGINAL_PLAN_MATCHES_CURRENT_MOUNTS'));assert.equal(inspected.storage.cleanupAuthorized,false);
  console.log('PASS genuine source parent SIGKILL: empty original source cgroup, original independent owner/client survive, unresolved request/resources retained, source/control alive, fresh local reader refuses replay/cleanup; fixture teardown uses original ownership only; no provider/host-loss claim');
 }finally{
  if(producer&&producer.exitCode===null&&producer.signalCode===null)producer.kill('SIGKILL');await producerTerminal?.catch(()=>{});
  if(unit){const state=spawnSync('systemctl',['--user','show',unit,'--property=LoadState','--value'],{encoding:'utf8',timeout:10000,maxBuffer:4096});
   if(state.stdout?.trim()==='loaded'){const current=inspectContainmentUnit(unit);if(held)assert.equal(current.InvocationID,held.identity.invocationId);manager(['stop',unit]);}
   else assert.equal(state.stdout?.trim(),'not-found');spawnSync('systemctl',['--user','reset-failed',unit],{stdio:'ignore',timeout:10000});}
  if(originalOwner){const owner=originalOwner.identity,current=inspectContainmentUnit(owner.unit);
   assert.equal(current.InvocationID,owner.invocationId);assert.equal(current.ExecMainStartTimestampMonotonic,owner.mainStartMonotonic);
   if(current.MainPID!=='0'){assert.equal(current.MainPID,String(owner.mainPid));assert.equal(current.ControlGroup,owner.controlGroup);manager(['stop',owner.unit]);}
   assert.ok(!existsSync('/sys/fs/cgroup'+owner.controlGroup+'/cgroup.procs')||readFileSync('/sys/fs/cgroup'+owner.controlGroup+'/cgroup.procs','utf8').trim()==='');
   spawnSync('systemctl',['--user','reset-failed',owner.unit],{stdio:'ignore',timeout:10000});}
  for(const id of observedClientIds){const listed=docker(['ps','-a','--no-trunc','--filter','id='+id,'--format','{{.ID}}']);if(listed)docker(['rm','--force',id]);}
  if(channelRoot){assert.ok(!existsSync('/sys/fs/cgroup'+originalGroup+'/cgroup.procs')||readFileSync('/sys/fs/cgroup'+originalGroup+'/cgroup.procs','utf8').trim()==='');protectedRemove(channelRoot,'charitypilot-managed-channel-');}
  if(daemonGateBinding&&existsSync(dirname(daemonGateBinding.descriptorPath))){const path=dirname(daemonGateBinding.descriptorPath),s=requireDaemonGateDirectory(path);
   assert.equal(s.dev,daemonGateBinding.device);assert.equal(s.ino,daemonGateBinding.inode);protectedRemove(path,'charitypilot-daemon-gate-');}
  if(verifiedSource)docker(['rm','--force',verifiedSource]);if(control)docker(['rm','--force',control]);await lockerTerminal?.catch(()=>{});
  for(const name of ownedVolumes){assert.match(name,/^charitypilot-synthetic-storage-[a-f0-9-]{36}$/);const v=JSON.parse(docker(['volume','inspect','--format','{{json .}}',name]));assert.equal(v.Name,name);assert.equal(v.Labels['charitypilot.synthetic-owner'],volumeOwner);assert.equal(docker(['ps','-a','--no-trunc','--filter','volume='+name,'--format','{{.ID}}']),'');docker(['volume','rm',name]);}
  const remainingVolumes=docker(['volume','ls','--format','{{.Name}}']).split(/\r?\n/);assert.ok(![attachedVolume,emptyVolume].filter(Boolean).some(v=>remainingVolumes.includes(v)));
  if(controlPlannedName)assert.equal(docker(['ps','-a','--filter','name='+controlPlannedName,'--format','{{.Names}}']),'');
  if(verifiedSource){protectedRemove(ready.parentDirectory,'charitypilot-imported-proof-');protectedRemove(dirname(ready.certificate),'charitypilot-managed-writer-tls-');}
  protectedRemove(root,'charitypilot-parent-observer-');
 }
});
