import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,chmodSync,lstatSync,realpathSync,readFileSync,writeFileSync,linkSync,unlinkSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
const self=fileURLToPath(import.meta.url),failure=()=>new Error('Systemd containment is unresolved; no worker or recovery authority is inferred');
const props=['Id','LoadState','ActiveState','SubState','MainPID','ControlGroup','KillMode','Type','Transient','InvocationID','ExecMainStartTimestampMonotonic','Result','ExecMainCode','ExecMainStatus','NoNewPrivileges'];
export function containmentUnit(jobId){if(typeof jobId!=='string'||!(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/).test(jobId))throw failure();return'charitypilot-containment-'+jobId+'.service';}
export function requireOriginalControlGroup(path,unit,uid){
 requireUnit(unit);if(!Number.isSafeInteger(uid)||uid<1||typeof path!=='string'||path.length>1024
  ||!path.startsWith('/user.slice/user-'+uid+'.slice/user@'+uid+'.service/')||!path.endsWith('/'+unit)
  ||path.slice(1).split('/').some(p=>!p||p==='.'||p==='..'||!/^[A-Za-z0-9_.@:-]+$/.test(p)))throw failure();return path;
}
export function currentContainmentBootId(){
 if(process.platform!=='linux'||process.getuid()===0)throw failure();
 const id=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();if(!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))throw failure();return id;
}
export function parseCgroupPopulation(body){
 if(typeof body!=='string'||body.length>4096)throw failure();const values=Object.create(null);
 for(const row of body.trim().split('\n')){const m=/^([a-z_]+) ([0-9]+)$/.exec(row);if(!m||Object.hasOwn(values,m[1]))throw failure();values[m[1]]=m[2];}
 if(!['0','1'].includes(values.populated))throw failure();return values.populated==='0'?'EMPTY':'POPULATED';
}
/** Recursive kernel observation, including nested cgroups. Never a cleanup lease. */
export function observeOriginalControlGroup(path,unit,uid,{realpath=realpathSync,read=readFileSync}={}){
 requireOriginalControlGroup(path,unit,uid);const root='/sys/fs/cgroup'+path;
 try{if(realpath(root)!==root)throw failure();return parseCgroupPopulation(read(join(root,'cgroup.events'),'utf8'));}
 catch(error){if(error.code==='ENOENT')return'ABSENT';throw failure();}
}
function requireUnit(name){if(typeof name!=='string'||!/^charitypilot-containment-[a-f0-9-]{36}\.service$/.test(name)||containmentUnit(name.slice('charitypilot-containment-'.length,-8))!==name)throw failure();return name;}
export function parseScopeProperties(text,unit,uid){
 requireUnit(unit);if(typeof text!=='string'||text.length>16384||!Number.isSafeInteger(uid)||uid<1)throw failure();
 const out={};for(const row of text.trim().split(/\r?\n/)){const i=row.indexOf('=');if(i<1)throw failure();const key=row.slice(0,i);if(!props.includes(key)||key in out)throw failure();out[key]=row.slice(i+1);}
 if(Object.keys(out).length!==props.length||out.Id!==unit||out.LoadState!=='loaded'||out.Type!=='exec'||out.Transient!=='yes'||out.KillMode!=='control-group'||out.NoNewPrivileges!=='yes'
  ||!(/^[a-f0-9]{32}$/).test(out.InvocationID)||!(/^[0-9]+$/).test(out.MainPID)||!Number.isSafeInteger(Number(out.MainPID))||!(/^[0-9]+$/).test(out.ExecMainStartTimestampMonotonic))throw failure();
 if(out.ControlGroup)requireOriginalControlGroup(out.ControlGroup,unit,uid);
 return out;
}
function execute(command,args){const r=spawnSync(command,args,{encoding:'utf8',stdio:'pipe',timeout:15000,maxBuffer:65536,env:process.env});if(r.status!==0||r.error)throw failure();return r.stdout.trim();}
function info(unit){return parseScopeProperties(execute('systemctl',['--user','show',requireUnit(unit),'--no-pager',...props.flatMap(p=>['--property',p])]),unit,process.getuid());}
export function inspectContainmentUnit(unit){if(process.platform!=='linux'||process.getuid()===0)throw failure();return info(unit);}
/** Readiness only. A verified live process is not an execution or recovery grant. */
export function assertIndependentOwnerObservation(value,{source,sourceSha,ownerInputDigest,expectedCommandLine},actual){
 const v=value?.identity;if(!v||value.kind!=='MANAGED_DAEMON_REQUEST_OWNER_V1'||value.format!==1||!Number.isInteger(value.sequence)||value.sequence<1||value.sequence>64
  ||containmentUnit(value.jobId)!==source.Id||v.unit!==containmentUnit(v.ownerId)||v.unit===source.Id||v.uid!==actual.uid||v.sourceSha!==sourceSha
  ||!(/^[a-f0-9]{40}$/).test(sourceSha)||!(/^[a-f0-9]{64}$/).test(ownerInputDigest)||v.inputDigest!==ownerInputDigest
  ||v.bootId!==actual.bootId||!Number.isSafeInteger(v.mainPid)||v.mainPid<1)throw failure();
 const unit=parseScopeProperties(Object.entries(actual.unit).map(([k,v])=>k+'='+v).join('\n'),v.unit,actual.uid);
 const fresh=parseScopeProperties(Object.entries(actual.source).map(([k,v])=>k+'='+v).join('\n'),source.Id,actual.uid);
 for(const key of ['Id','InvocationID','MainPID','ExecMainStartTimestampMonotonic','ControlGroup'])if(fresh[key]!==source[key])throw failure();
 if(fresh.ActiveState!=='active'||fresh.SubState!=='running'||unit.ActiveState!=='active'||unit.SubState!=='running'||unit.MainPID!==String(v.mainPid)
  ||unit.InvocationID!==v.invocationId||unit.ExecMainStartTimestampMonotonic!==v.mainStartMonotonic||unit.ControlGroup!==v.controlGroup
  ||unit.MainPID===source.MainPID||unit.InvocationID===source.InvocationID||unit.ControlGroup===source.ControlGroup
  ||unit.ControlGroup.startsWith(source.ControlGroup+'/')||source.ControlGroup.startsWith(unit.ControlGroup+'/'))throw failure();
 if(JSON.stringify(actual.commandLine)!==JSON.stringify(expectedCommandLine)||actual.processGroup.trim()!=='0::'+unit.ControlGroup
  ||!/^NoNewPrivs:\s+1$/m.test(actual.status))throw failure();
 const ids=/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(actual.status);
 if(!ids||ids.slice(1).some(id=>Number(id)!==actual.uid))throw failure();
 const memory=Number(actual.memory.trim()),pids=Number(actual.pids.trim()),cpu=actual.cpu.trim().split(/\s+/).map(Number);
 if(!Number.isSafeInteger(memory)||memory<1||memory>1073741824||!Number.isSafeInteger(pids)||pids<1||pids>128
  ||cpu.length!==2||!cpu.every(Number.isSafeInteger)||cpu[0]<1||cpu[1]<1||cpu[0]>cpu[1]
  ||['NODE_OPTIONS','NODE_PATH','LD_PRELOAD','LD_LIBRARY_PATH'].some(k=>!actual.unsetEnvironment.trim().split(/\s+/).includes(k)))throw failure();
 return{liveOwnerIdentityVerified:true,independentOwnerDispatchVerified:false,executionAuthorized:false,actionAuthorized:false};
}
export function verifyIndependentDaemonOwner(value,options){
 if(process.platform!=='linux'||process.getuid()===0)throw failure();
 const v=value?.identity;if(!v||!Number.isSafeInteger(v.mainPid)||v.mainPid<1||v.unit!==containmentUnit(v.ownerId))throw failure();
 const expected=options.expectedCommandLine,worker=fileURLToPath(new URL('./managed-daemon-owner-worker.mjs',import.meta.url));
 const probe=fileURLToPath(new URL('./managed-daemon-owner-probe.mjs',import.meta.url));
 if(!Array.isArray(expected)||expected[0]!==process.execPath||(expected[1]!==worker&&!(options.synthetic===true&&expected[1]===probe))||expected.some(v=>typeof v!=='string'))throw failure();
 const unit=inspectContainmentUnit(v.unit),source=inspectContainmentUnit(options.source.Id),path='/sys/fs/cgroup'+unit.ControlGroup;
 if(observeOriginalControlGroup(unit.ControlGroup,v.unit,process.getuid())!=='POPULATED')throw failure();
 const command=readFileSync('/proc/'+v.mainPid+'/cmdline');if(command.length>16384||command.at(-1)!==0)throw failure();
 return assertIndependentOwnerObservation(value,options,{uid:process.getuid(),bootId:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),unit,source,
  commandLine:command.toString('utf8').slice(0,-1).split('\0'),status:readFileSync('/proc/'+v.mainPid+'/status','utf8'),processGroup:readFileSync('/proc/'+v.mainPid+'/cgroup','utf8'),
  memory:readFileSync(join(path,'memory.max'),'utf8'),pids:readFileSync(join(path,'pids.max'),'utf8'),cpu:readFileSync(join(path,'cpu.max'),'utf8'),
  unsetEnvironment:execute('systemctl',['--user','show',v.unit,'--property=UnsetEnvironment','--value'])});
}
function members(path){if(!path)return[];const target='/sys/fs/cgroup'+path;
 if(!existsSync(target))return[];try{if(realpathSync(target)!==target)throw failure();}catch(e){if(e.code==='ENOENT')return[];throw e;}
 let body;try{body=readFileSync(join(target,'cgroup.procs'),'utf8');}catch(e){if(e.code==='ENOENT')return[];throw e;}if(body.length>4096)throw failure();return body.trim()?body.trim().split(/\s+/).map(v=>{if(!/^[1-9][0-9]*$/.test(v))throw failure();return Number(v);}):[];}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function start(unit,root,ready){
 requireUnit(unit);execute('systemd-run',['--user','--quiet','--unit='+unit,'--service-type=exec',
  '--property=KillMode=control-group','--property=Restart=no','--property=RuntimeMaxSec=90s','--property=TimeoutStopSec=5s',
  '--property=NoNewPrivileges=yes','--property=MemoryMax=128M','--property=TasksMax=32','--property=CPUQuota=20%',
  process.execPath,self,'--fixture-main',join(root,ready)]);
}
async function ready(path){for(let i=0;i<100;i++){if(existsSync(path))return JSON.parse(readFileSync(path,'utf8'));await pause(100);}throw failure();}
function active(unit,data){const v=info(unit);if(v.ActiveState!=='active'||v.SubState!=='running'||Number(v.MainPID)!==data.mainPid||data.uid!==process.getuid()||!v.ControlGroup||BigInt(v.ExecMainStartTimestampMonotonic)<1n)throw failure();
 const pids=members(v.ControlGroup);if(!pids.includes(data.mainPid)||!pids.includes(data.childPid)||data.childPid===data.mainPid)throw failure();
 const stat=readFileSync('/proc/'+data.childPid+'/stat','utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
 if(Number(fields[2])!==data.childPid||Number(fields[3])!==data.childPid)throw failure();
 for(const pid of [data.mainPid,data.childPid]){const status=readFileSync('/proc/'+pid+'/status','utf8');if(!/^NoNewPrivs:\s+1$/m.test(status))throw failure();}
 const group='/sys/fs/cgroup'+v.ControlGroup;
 if(readFileSync(join(group,'memory.max'),'utf8').trim()!=='134217728'||readFileSync(join(group,'pids.max'),'utf8').trim()!=='32')throw failure();
 const cpu=readFileSync(join(group,'cpu.max'),'utf8').trim().split(/\s+/).map(Number);
 if(cpu.length!==2||!cpu.every(Number.isSafeInteger)||cpu[0]<1||cpu[1]<1||cpu[0]*5>cpu[1])throw failure();return v;}
/** Kernel capability acceptance only. No application/daemon/provider stop. */
export async function probeSystemdContainment(){
 if(process.platform!=='linux'||process.getuid()===0)throw failure();execute('systemctl',['--user','show','--property=Version','--value']);
 if(!readFileSync('/sys/fs/cgroup/cgroup.controllers','utf8').trim())throw failure();
 const root=mkdtempSync(join(tmpdir(),'charitypilot-kernel-probe-'));chmodSync(root,0o700);
 if(realpathSync(root)!==root||lstatSync(root).uid!==process.getuid())throw failure();
 const target=containmentUnit(randomUUID()),control=containmentUnit(randomUUID());let targetStarted=false,controlStarted=false;
 try{
  writeFileSync(join(root,'scope-request.json'),JSON.stringify({target,control,uid:process.getuid(),executionAuthorized:false,actionAuthorized:false}),{flag:'wx',mode:0o600});
  // An unknown launch ACK still requires cleanup of the exact freshly proposed unit.
  targetStarted=true;start(target,root,'main.ready.json');controlStarted=true;start(control,root,'control.ready.json');
  const first=await ready(join(root,'main.ready.json')),second=await ready(join(root,'control.ready.json'));
  const a=active(target,first),b=active(control,second);
  // The service manager resolves its current MainPID; no saved numeric PID kill.
  execute('systemctl',['--user','kill','--kill-who=main','--signal=SIGKILL',target]);
  let after;for(let i=0;i<100;i++){after=info(target);if(after.ActiveState==='failed'&&members(a.ControlGroup).length===0)break;await pause(100);}
  if(after?.InvocationID!==a.InvocationID||after.MainPID!=='0'||after.ActiveState!=='failed'||after.Result!=='signal'||after.ExecMainStatus!=='9'||members(a.ControlGroup).length!==0)throw failure();
  const controlAfter=active(control,second);if(controlAfter.InvocationID!==b.InvocationID)throw failure();
  return{format:1,kind:'SYSTEMD_USER_CONTAINMENT_PROBE_V1',moduleSha256:createHash('sha256').update(readFileSync(self)).digest('hex'),uid:process.getuid(),
   targetUnit:target,controlUnit:control,targetInvocationId:a.InvocationID,controlInvocationId:b.InvocationID,
   detachedChildInOriginalCgroup:true,cgroupResourceLimitsVerified:true,noNewPrivilegesKernelVerified:true,mainSignalObserved:true,targetCgroupEmpty:true,controlStillRunning:true,
   applicationStateChanged:false,dockerDaemonFenced:false,sourceHostLossProven:false,executionAuthorized:false,actionAuthorized:false};
 }finally{
  const cleanup=[];let cleanupFailed=false;for(const [unit,started] of [[target,targetStarted],[control,controlStarted]])if(started){
   try{execute('systemctl',['--user','stop',requireUnit(unit)]);cleanup.push(unit);}catch{cleanupFailed=true;}
  }
  for(const unit of cleanup){const r=spawnSync('systemctl',['--user','reset-failed',requireUnit(unit)],{encoding:'utf8',timeout:15000,maxBuffer:4096});
   if(r.status!==0&&!/not loaded|not found/.test(r.stderr??''))cleanupFailed=true;}
  if(cleanupFailed)throw failure();
  if(dirname(resolve(root))!==resolve(tmpdir())||!basename(root).startsWith('charitypilot-kernel-probe-')||realpathSync(root)!==root)throw failure();rmSync(root,{recursive:true,force:true});
 }
}
async function fixtureMain(path){
 if(process.platform!=='linux'||process.getuid()===0||!['main.ready.json','control.ready.json'].includes(basename(path))||!basename(dirname(path)).startsWith('charitypilot-kernel-probe-')||realpathSync(dirname(path))!==dirname(path)||lstatSync(dirname(path)).uid!==process.getuid()||(lstatSync(dirname(path)).mode&0o777)!==0o700)throw failure();
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});if(!child.pid)throw failure();
 const pending=path+'.pending';writeFileSync(pending,JSON.stringify({mainPid:process.pid,childPid:child.pid,uid:process.getuid()}),{flag:'wx',mode:0o600});linkSync(pending,path);unlinkSync(pending);setInterval(()=>{},1000);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{if(process.argv.length===3&&process.argv[2]==='--probe')console.log(JSON.stringify(await probeSystemdContainment()));
  else if(process.argv.length===4&&process.argv[2]==='--fixture-main')await fixtureMain(process.argv[3]);else throw failure();
 }catch{process.stderr.write('Systemd containment probe unresolved; preserve scope and inspect owned units.\n');process.exitCode=1;}
}
