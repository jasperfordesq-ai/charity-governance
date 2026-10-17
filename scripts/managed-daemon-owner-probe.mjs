import {spawnSync,execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,chmodSync,realpathSync,lstatSync,fstatSync,readFileSync,writeFileSync,openSync,closeSync,fsyncSync,existsSync,rmSync,constants} from 'node:fs';
import {join,dirname,basename,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {DEFAULT_POSTGRES_IMAGE,PROOF_CLIENT_DATA_TMPFS,prepareLocalDockerCommand,spawnLocalDockerCommand,captureHelperImplementationBinding} from './postgres-backup.mjs';
import {containmentUnit,inspectContainmentUnit,observeOriginalControlGroup,verifyIndependentDaemonOwner} from './managed-proof-systemd-containment.mjs';
import {verifyContainedExecutorSource} from './managed-proof-systemd-runner.mjs';
import {createManagedDaemonCustodyChannel} from './managed-daemon-custody-channel.mjs';
import {requestManagedDaemonCustody} from './managed-daemon-custody-client.mjs';
const self=fileURLToPath(import.meta.url),repo=resolve(dirname(self),'..'),no=()=>new Error('Synthetic independent daemon owner unresolved; preserve original scope');
const hash=v=>createHash('sha256').update(v).digest('hex'),pause=ms=>new Promise(r=>setTimeout(r,ms));
const safeEnv=()=>Object.fromEntries(['PATH','HOME','USER','LOGNAME','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
const command=(name,args)=>{const r=spawnSync(name,args,{env:safeEnv(),encoding:'utf8',timeout:15000,maxBuffer:65536});if(r.status!==0||r.error)throw no();return r.stdout.trim();};
function source(){const v=captureHelperImplementationBinding();if(!v.sourceMatchesCommit||!v.canonicalRepositoryMatched)throw no();
 verifyContainedExecutorSource(v.commitSha);for(const name of ['managed-daemon-owner-probe.mjs','managed-daemon-owner-custody.fixture.mjs']){
  const path=join(repo,'scripts',name);if(realpathSync(path)!==path||!readFileSync(path).equals(execFileSync('git',['-C',repo,'show',v.commitSha+':scripts/'+name],{maxBuffer:65536})))throw no();}return v.commitSha;}
function rootIdentity(root){if(process.platform!=='linux'||process.getuid()===0||dirname(root)!==resolve(tmpdir())||!/^charitypilot-owner-probe-[A-Za-z0-9]{6}$/.test(basename(root))||realpathSync(root)!==root)throw no();
 const s=lstatSync(root);if(!s.isDirectory()||s.uid!==process.getuid()||(s.mode&0o777)!==0o700)throw no();return{device:s.dev,inode:s.ino};}
function write(root,name,value){rootIdentity(root);const body=JSON.stringify(value),fd=openSync(join(root,name),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{writeFileSync(fd,body);fsyncSync(fd);}finally{closeSync(fd);}const d=openSync(root,'r');try{fsyncSync(d);}finally{closeSync(d);}return hash(body);}
function read(root,name){rootIdentity(root);const fd=openSync(join(root,name),constants.O_RDONLY|constants.O_NOFOLLOW);try{
 const s=fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&0o777)!==0o600||s.size>16384)throw no();
 return JSON.parse(readFileSync(fd,'utf8'));}finally{closeSync(fd);}}
async function waitFor(fn){for(let i=0;i<150;i++){const value=fn();if(value)return value;await pause(100);}throw no();}
const loaded=unit=>{const r=spawnSync('systemctl',['--user','show',unit,'--property=LoadState','--value'],{env:safeEnv(),encoding:'utf8',timeout:15000,maxBuffer:4096});
 if(!r.error&&[0,1,4].includes(r.status)&&r.stdout.trim()==='not-found')return'not-found';
 if(r.status!==0||r.error||r.stdout.trim()!=='loaded')throw no();return'loaded';};
export function independentOwnerProbeTarget(jobId){containmentUnit(jobId);return'charitypilot-source-snapshot-0-'+BigInt('0x'+jobId.replaceAll('-','')).toString()+'-'+jobId.slice(-8);}
export function independentOwnerProbeArguments(jobId){containmentUnit(jobId);return['run','--rm','--pull=never','--name',independentOwnerProbeTarget(jobId),
 '--label','io.charitypilot.owner-probe='+jobId,'--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges',
 '--memory=64m','--cpus=0.25','--pids-limit=32','--tmpfs',PROOF_CLIENT_DATA_TMPFS,'--entrypoint','sh',DEFAULT_POSTGRES_IMAGE,'-c','sleep 6; printf SYNTHETIC_OWNER_COMPLETE'];}
export function ownerProbeInspectAbsent(result,target){
 return result?.status===1&&!result.error&&!result.signal&&typeof result.stdout==='string'&&result.stdout.trim()==='[]'
  &&['error: no such object: '+target,'Error: No such object: '+target,'Error response from daemon: No such container: '+target].includes(result.stderr?.trim());
}
function launch(unit,role,root){if(loaded(unit)!=='not-found')throw no();command('systemd-run',['--user','--quiet','--unit='+unit,'--service-type=exec',
 '--property=RemainAfterExit=yes','--property=KillMode=control-group','--property=Restart=no','--property=RuntimeMaxSec=30s','--property=TimeoutStopSec=2s',
 '--property=NoNewPrivileges=yes','--property=MemoryMax=128M','--property=TasksMax=32','--property=CPUQuota=50%',
 '--property=UnsetEnvironment=NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH','--property=StandardOutput=null','--property=StandardError=null',process.execPath,self,role,root]);}
function checkedScope(root){const v=read(root,'request.json');if(v.kind!=='SYNTHETIC_INDEPENDENT_OWNER_PROBE_V1'||v.sourceSha!==source()
 ||JSON.stringify(v.rootIdentity)!==JSON.stringify(rootIdentity(root))||v.ownerUnit!==containmentUnit(v.ownerId)||v.callerUnit!==containmentUnit(v.jobId)||v.ownerId===v.jobId)throw no();return v;}
async function actor(role,root){const v=checkedScope(root);
 if(role==='--caller'){write(root,'caller.ready.json',{pid:process.pid,invocationId:process.env.INVOCATION_ID});launch(v.ownerUnit,'--owner',root);setInterval(()=>{},1000);return;}
 if(role!=='--owner')throw no();const identity=inspectContainmentUnit(v.ownerUnit);
 if(Number(identity.MainPID)!==process.pid||identity.InvocationID!==process.env.INVOCATION_ID||identity.ActiveState!=='active')throw no();
 const ready={kind:'SYNTHETIC_DAEMON_OWNER_READY_V1',sourceSha:v.sourceSha,jobId:v.jobId,ownerId:v.ownerId,identity,bootId:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()};
 const digest=write(root,'owner.ready.json',ready);await waitFor(()=>existsSync(join(root,'permit.json')));
 const permit=read(root,'permit.json');if(permit.ownerReadyDigest!==digest||permit.requestDigest!==hash(JSON.stringify(v)))throw no();
 write(root,'dispatch.json',{requestDigest:permit.requestDigest,ownerReadyDigest:digest,argumentsDigest:hash(JSON.stringify(independentOwnerProbeArguments(v.jobId)))});
 const result=spawnLocalDockerCommand(['docker',...independentOwnerProbeArguments(v.jobId)],process.env,{encoding:'utf8',timeout:15000,maxBuffer:65536,windowsHide:true});
 write(root,'response.json',{kind:'SYNTHETIC_DAEMON_OWNER_RESPONSE_V1',requestDigest:permit.requestDigest,ownerReadyDigest:digest,
  status:result.status,transportError:!!result.error,signal:!!result.signal,stdoutSha256:hash(result.stdout??''),stdoutBytes:Buffer.byteLength(result.stdout??''),pendingRequestResolved:false,actionAuthorized:false});
 if(result.status!==0||result.error||result.signal||result.stdout!=='SYNTHETIC_OWNER_COMPLETE')throw no();
}
/** Fixed synthetic acceptance only. No production request, credential or command
 * is accepted, and no original S3 ACK or queue fence is manufactured. */
export async function probeIndependentDaemonOwner(mode='caller-loss'){
 if(!['caller-loss','owner-loss','owner-ack-lost'].includes(mode)||process.platform!=='linux'||process.getuid()===0)throw no();
 prepareLocalDockerCommand(['docker','version'],process.env);const sourceSha=source(),jobId=randomUUID(),ownerId=randomUUID();
 const root=mkdtempSync(join(tmpdir(),'charitypilot-owner-probe-'));chmodSync(root,0o700);
 const request={kind:'SYNTHETIC_INDEPENDENT_OWNER_PROBE_V1',jobId,ownerId,callerUnit:containmentUnit(jobId),ownerUnit:containmentUnit(ownerId),sourceSha,rootIdentity:rootIdentity(root)};
 let launched=false,container,ownerReady,completed=false,custody,gate;
 const docker=args=>spawnLocalDockerCommand(['docker',...args],process.env,{encoding:'utf8',timeout:15000,maxBuffer:65536});
 const inspect=target=>{const r=docker(['inspect',target]);if(r.status!==0){if(ownerProbeInspectAbsent(r,target))return null;throw no();}return JSON.parse(r.stdout)[0];};
 const exact=value=>{if(!value||value.Name!=='/'+independentOwnerProbeTarget(jobId)||value.Config.Image!==DEFAULT_POSTGRES_IMAGE||value.Config.Labels['io.charitypilot.owner-probe']!==jobId
  ||value.Mounts.some(m=>m.Type!=='tmpfs'||m.Destination!=='/var/lib/postgresql/data')||value.HostConfig.Privileged||value.HostConfig.NetworkMode!=='none'
  ||value.HostConfig.ReadonlyRootfs!==true||Object.keys(value.HostConfig.Tmpfs??{}).join(',')!=='/var/lib/postgresql/data')throw no();return value;};
 try{
  write(root,'request.json',request);if(loaded(request.ownerUnit)!=='not-found'||loaded(request.callerUnit)!=='not-found')throw no();
  launched=true;launch(request.callerUnit,'--caller',root);await waitFor(()=>existsSync(join(root,'owner.ready.json')));ownerReady=read(root,'owner.ready.json');
  const owner=inspectContainmentUnit(request.ownerUnit),caller=inspectContainmentUnit(request.callerUnit);
  if(JSON.stringify(ownerReady.identity)!==JSON.stringify(owner)||owner.ControlGroup===caller.ControlGroup||owner.ControlGroup.startsWith(caller.ControlGroup+'/'))throw no();
  for(const identity of [owner,caller]){const c='/sys/fs/cgroup'+identity.ControlGroup;
   if(readFileSync(join(c,'memory.max'),'utf8').trim()!=='134217728'||readFileSync(join(c,'pids.max'),'utf8').trim()!=='32'
    ||!/^NoNewPrivs:\s+1$/m.test(readFileSync('/proc/'+identity.MainPID+'/status','utf8')))throw no();
   const cpu=readFileSync(join(c,'cpu.max'),'utf8').trim().split(/\s+/).map(Number);if(cpu.length!==2||!cpu.every(Number.isSafeInteger)||cpu[0]<1||cpu[1]<1||cpu[0]*2>cpu[1])throw no();}
  const {originalOwnerProbeCustody}=await import('./managed-daemon-owner-custody.fixture.mjs');
  custody=await originalOwnerProbeCustody(request,caller,independentOwnerProbeArguments(jobId));
  const localOwner=custody.artifact({format:1,kind:'MANAGED_DAEMON_REQUEST_OWNER_V1',jobId,sequence:1,
   intentPin:{sha256:custody.intent.sha256,byteLength:custody.intent.byteLength},identity:{ownerId,unit:owner.Id,invocationId:owner.InvocationID,uid:process.getuid(),
    mainPid:Number(owner.MainPID),mainStartMonotonic:owner.ExecMainStartTimestampMonotonic,sourceSha,inputDigest:custody.inputDigest,bootId:ownerReady.bootId,controlGroup:owner.ControlGroup}});
  gate=await createManagedDaemonCustodyChannel({jobId,inputDigest:custody.inputDigest,sourceSha,requireIndependentOwner:true,
   onHeader:a=>custody.session.reserveDaemonHeader(a,custody.original),onIntent:a=>custody.session.reserveDaemonIntent(a,custody.original),
   onOwner:async a=>{const options={source:caller,sourceSha,ownerInputDigest:custody.inputDigest,expectedCommandLine:[process.execPath,self,'--owner',root],synthetic:true};
    verifyIndependentDaemonOwner(JSON.parse(a.body),options);const saved=await custody.session.bindDaemonOwner(a,custody.original);
    verifyIndependentDaemonOwner(JSON.parse(a.body),options);if(mode==='owner-ack-lost')void gate.close();return saved;},
   onResponse:async()=>{throw no();},onEnd:async()=>{throw no();}});
  const send=(kind,artifact)=>requestManagedDaemonCustody({kind,artifact,descriptorPath:gate.descriptorPath,jobId,inputDigest:custody.inputDigest,sourceSha});
  await send('HEADER',custody.header);await send('INTENT',custody.intent);
  if(mode==='owner-ack-lost'){
   let refused=false;try{await send('OWNER',localOwner);}catch{refused=true;}
   if(!refused||existsSync(join(root,'permit.json'))||existsSync(join(root,'dispatch.json'))||inspect(independentOwnerProbeTarget(jobId))!==null)throw no();
   await custody.inspect();completed=true;
   return{kind:'SYNTHETIC_ORIGINAL_OWNER_ACK_LOSS_V1',ownerBindingStored:true,originalOwnerAcknowledgementObserved:false,requestDispatched:false,
    originalAcknowledgementReconstructed:false,productionIntegrated:false,sourceHostLossProven:false,pendingRequestResolved:false,actionAuthorized:false};
  }
  await send('OWNER',localOwner);if(gate.snapshot().ownerCount!==1)throw no();
  write(root,'permit.json',{requestDigest:hash(JSON.stringify(request)),ownerReadyDigest:hash(JSON.stringify(ownerReady))});
  container=await waitFor(()=>{const value=inspect(independentOwnerProbeTarget(jobId));return value?.State.Running?exact(value):null;});
  command('systemctl',['--user','stop',request.callerUnit]);
  if(observeOriginalControlGroup(caller.ControlGroup,request.callerUnit,process.getuid())==='POPULATED')throw no();
  const surviving=inspectContainmentUnit(request.ownerUnit);if(surviving.InvocationID!==owner.InvocationID||surviving.MainPID!==owner.MainPID||surviving.ActiveState!=='active'||!exact(inspect(container.Id)).State.Running)throw no();
  if(mode==='owner-loss')command('systemctl',['--user','stop',request.ownerUnit]);else await waitFor(()=>existsSync(join(root,'response.json')));
  if(mode==='caller-loss'){const response=read(root,'response.json');if(response.status!==0||response.transportError||response.signal||response.stdoutSha256!==hash('SYNTHETIC_OWNER_COMPLETE'))throw no();
   await waitFor(()=>{const v=inspectContainmentUnit(request.ownerUnit);return v.MainPID==='0'&&v.InvocationID===owner.InvocationID&&v.SubState==='exited';});
  }else if(existsSync(join(root,'response.json')))throw no();
  await custody.inspect();completed=true;return{kind:'SYNTHETIC_INDEPENDENT_DAEMON_OWNER_OBSERVATION_V1',mode,callerStopped:true,ownerIndependent:true,originalOwnerAcknowledgementObserved:true,recordedOwnerResponse:mode==='caller-loss',
   requestArgumentsSelectable:false,productionIntegrated:false,independentProvider:false,sourceHostLossProven:false,pendingRequestResolved:false,completeResourceInventory:false,cleanupAuthorized:false,actionAuthorized:false};
 }finally{
  let channelClosed=true;try{await gate?.close();}catch{channelClosed=false;completed=false;}finally{custody?.close();}
  if(launched)for(const unit of [request.callerUnit,request.ownerUnit]){if(loaded(unit)==='loaded'){const current=inspectContainmentUnit(unit);
   if(unit===request.ownerUnit&&ownerReady&&current.InvocationID!==ownerReady.identity.InvocationID)throw no();command('systemctl',['--user','stop',unit]);
   if(current.ControlGroup&&observeOriginalControlGroup(current.ControlGroup,unit,process.getuid())==='POPULATED')throw no();}
   const r=spawnSync('systemctl',['--user','reset-failed',unit],{env:safeEnv(),encoding:'utf8',timeout:15000,maxBuffer:4096});if(r.status!==0&&!/not loaded|not found/.test(r.stderr??''))throw no();}
  if(container){const current=inspect(container.Id);if(current){exact(current);if(docker(['rm','-f',container.Id]).status!==0)throw no();}}
  if(container&&inspect(container.Id)!==null)throw no();
  if(JSON.stringify(request.rootIdentity)!==JSON.stringify(rootIdentity(root)))throw no();
  if(completed)rmSync(root,{recursive:true,force:true});else process.stderr.write('Synthetic owner probe evidence preserved at '+root+'\n');
  if(!channelClosed)throw no();
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{
 if(process.argv.length!==4||!['--caller','--owner'].includes(process.argv[2]))throw no();await actor(process.argv[2],process.argv[3]);
}catch{process.stderr.write('Synthetic independent owner unresolved\n');process.exitCode=1;}}
