import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readFileSync,existsSync,lstatSync,realpathSync,rmSync} from 'node:fs';
import {dirname,basename,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {containmentUnit,inspectContainmentUnit} from './managed-proof-systemd-containment.mjs';
const fixture=fileURLToPath(new URL('./managed-proof-channel-fixture.mjs',import.meta.url));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function command(args){const r=spawnSync('systemctl',['--user',...args],{encoding:'utf8',timeout:15000,maxBuffer:65536});if(r.status!==0)throw new Error('Synthetic scope operation refused');return r.stdout;}
function stopUnit(unit){const r=spawnSync('systemctl',['--user','stop',unit],{encoding:'utf8',timeout:15000,maxBuffer:4096});if(r.status!==0&&!/not loaded|not found/.test(r.stderr??''))throw new Error('Synthetic cleanup unresolved');}
function service(unit,args){
 const child=spawn('systemd-run',['--user','--quiet','--wait','--pipe','--unit='+unit,'--service-type=exec',
  '--property=KillMode=control-group','--property=Restart=no','--property=RuntimeMaxSec=45s','--property=TimeoutStopSec=5s',
  '--property=NoNewPrivileges=yes','--property=MemoryMax=256M','--property=TasksMax=64','--property=CPUQuota=50%',process.execPath,...args],{stdio:['ignore','pipe','pipe']});
 let size=0;for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{size+=b.length;if(size>65536)child.kill();});
 const terminal=new Promise((yes,no)=>{child.once('error',no);child.once('close',(code,signal)=>yes({code,signal}));});void terminal.catch(()=>{});return{child,terminal};
}
async function until(read){for(let i=0;i<150;i++){const value=read();if(value)return value;await wait(100);}throw new Error('Synthetic observation expired');}
function parent(job,mode){
 const child=spawn(process.execPath,[fixture,'--parent',job,mode],{stdio:['ignore','pipe','pipe']});let body='',errors='';
 child.stdout.on('data',b=>{body+=b.toString('utf8');if(body.length>65536)child.kill();});child.stderr.on('data',b=>{errors+=b.toString('utf8');if(errors.length>65536)child.kill();});
 const terminal=new Promise((yes,no)=>{child.once('error',no);child.once('close',(code,signal)=>yes({code,signal}));});void terminal.catch(()=>{});
 return{child,terminal,errorText:()=>errors.slice(0,4096),first:()=>until(()=>body.includes('\n')?JSON.parse(body.split('\n')[0]):null),lines:()=>body.trim().split('\n').map(v=>JSON.parse(v))};
}
function cleanRoot(path){const root=dirname(path);assert.equal(dirname(root),resolve(tmpdir()));assert.match(basename(root),/^charitypilot-managed-channel-[A-Za-z0-9]{6}$/);
 if(existsSync(root)){assert.equal(realpathSync(root),root);assert.equal(lstatSync(root).uid,process.getuid());assert.equal(lstatSync(root).mode&0o777,0o700);rmSync(root,{recursive:true,force:true});}}
test('real systemd guardian transport binds before work, refuses denied ACK and survives parent/guardian loss',{
 skip:process.platform!=='linux'||process.env.CHARITYPILOT_TEST_SYSTEMD_CHANNEL!=='1',timeout:120000
},async()=>{
 assert.notEqual(process.getuid(),0);const control=containmentUnit(randomUUID()),attempted=new Set([control]);let controlService;const roots=[];
 try{
  controlService=service(control,['-e','setInterval(()=>{},1000)']);const controlBefore=await until(()=>{try{const i=inspectContainmentUnit(control);return i.ActiveState==='active'?i:null;}catch{return null;}});
  for(const mode of ['success','deny','parent-loss','guardian-loss']){
   const job=randomUUID(),p=parent(job,mode==='success'||mode==='deny'?mode:'hold'),first=await p.first();roots.push(first.path);attempted.add(first.unit);
   const unit=service(first.unit,[fixture,'--service',first.path]);let before;
   try{
    if(mode==='success'){
     assert.equal((await p.terminal).code,0,'success parent: '+p.errorText());assert.equal((await unit.terminal).code,0);
     const result=p.lines()[1];assert.equal(result.acknowledged,true);assert.equal(result.identity.jobId,job);assert.equal(result.identity.unit,first.unit);
     assert.equal(result.identity.executionAuthorized,false);assert.equal(result.terminal.workerTerminal,true);assert.equal(result.terminal.outcome,'WORKER_EXIT_ACK_OBSERVED');
    }else if(mode==='deny'){
     assert.equal((await p.terminal).code,1);assert.notEqual((await unit.terminal).code,0);assert.deepEqual(p.lines()[1],{refusedBeforeWorker:true,identityObserved:true});
    }else{
     const readyPath=dirname(first.path)+'/worker.ready.json';const ready=await until(()=>existsSync(readyPath)?JSON.parse(readFileSync(readyPath,'utf8')):null);
     assert.equal(ready.jobId,job);before=inspectContainmentUnit(first.unit);const bound=JSON.parse(readFileSync(dirname(first.path)+'/identity-observed.json','utf8'));
     assert.equal(bound.invocationId,before.InvocationID);assert.equal(bound.mainPid,Number(before.MainPID));
     assert.ok(readFileSync('/sys/fs/cgroup'+before.ControlGroup+'/cgroup.procs','utf8').trim().split(/\s+/).includes(String(ready.pid)));
     if(mode==='parent-loss'){
      p.child.kill('SIGKILL');await p.terminal;assert.notEqual((await unit.terminal).code,0);
      const receipt=JSON.parse(readFileSync(dirname(first.path)+'/guardian-result.json','utf8'));
      assert.equal(receipt.parentDisconnected,true);assert.equal(receipt.workerTerminal,true);assert.equal(receipt.outcome,'UNRESOLVED');assert.equal(receipt.actionAuthorized,false);
     }else{
      command(['kill','--kill-who=main','--signal=SIGKILL',first.unit]);assert.notEqual((await unit.terminal).code,0);assert.equal((await p.terminal).code,1);
     }
     assert.ok(!existsSync('/sys/fs/cgroup'+before.ControlGroup+'/cgroup.procs')||readFileSync('/sys/fs/cgroup'+before.ControlGroup+'/cgroup.procs','utf8').trim()==='');
     assert.equal(p.lines().length,1);
    }
    const current=inspectContainmentUnit(control);assert.equal(current.ActiveState,'active');assert.equal(current.InvocationID,controlBefore.InvocationID);
   }finally{if(p.child.exitCode===null&&p.child.signalCode===null){p.child.kill('SIGKILL');await p.terminal;}stopUnit(first.unit);await unit.terminal;}
  }
 }finally{
  for(const unit of attempted){stopUnit(unit);spawnSync('systemctl',['--user','reset-failed',unit],{stdio:'ignore',timeout:15000});}
  await controlService?.terminal;for(const root of roots)cleanRoot(root);
 }
});
