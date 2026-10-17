import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,chmodSync,lstatSync,realpathSync,readFileSync,writeFileSync,linkSync,unlinkSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
const self=fileURLToPath(import.meta.url),failure=()=>new Error('Systemd containment is unresolved; no worker or recovery authority is inferred');
const props=['Id','LoadState','ActiveState','SubState','MainPID','ControlGroup','KillMode','Type','Transient','InvocationID','ExecMainStartTimestampMonotonic','Result','ExecMainCode','ExecMainStatus','NoNewPrivileges'];
export function containmentUnit(jobId){if(typeof jobId!=='string'||!(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/).test(jobId))throw failure();return'charitypilot-containment-'+jobId+'.service';}
function requireUnit(name){if(typeof name!=='string'||!/^charitypilot-containment-[a-f0-9-]{36}\.service$/.test(name)||containmentUnit(name.slice('charitypilot-containment-'.length,-8))!==name)throw failure();return name;}
export function parseScopeProperties(text,unit,uid){
 requireUnit(unit);if(typeof text!=='string'||text.length>16384||!Number.isSafeInteger(uid)||uid<1)throw failure();
 const out={};for(const row of text.trim().split(/\r?\n/)){const i=row.indexOf('=');if(i<1)throw failure();const key=row.slice(0,i);if(!props.includes(key)||key in out)throw failure();out[key]=row.slice(i+1);}
 if(Object.keys(out).length!==props.length||out.Id!==unit||out.LoadState!=='loaded'||out.Type!=='exec'||out.Transient!=='yes'||out.KillMode!=='control-group'||out.NoNewPrivileges!=='yes'
  ||!(/^[a-f0-9]{32}$/).test(out.InvocationID)||!(/^[0-9]+$/).test(out.MainPID)||!Number.isSafeInteger(Number(out.MainPID))||!(/^[0-9]+$/).test(out.ExecMainStartTimestampMonotonic))throw failure();
 if(out.ControlGroup&&(out.ControlGroup.includes('/../')||!out.ControlGroup.startsWith('/user.slice/user-'+uid+'.slice/user@'+uid+'.service/')||!out.ControlGroup.endsWith('/'+unit)))throw failure();
 return out;
}
function execute(command,args){const r=spawnSync(command,args,{encoding:'utf8',stdio:'pipe',timeout:15000,maxBuffer:65536,env:process.env});if(r.status!==0||r.error)throw failure();return r.stdout.trim();}
function info(unit){return parseScopeProperties(execute('systemctl',['--user','show',requireUnit(unit),'--no-pager',...props.flatMap(p=>['--property',p])]),unit,process.getuid());}
export function inspectContainmentUnit(unit){if(process.platform!=='linux'||process.getuid()===0)throw failure();return info(unit);}
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
