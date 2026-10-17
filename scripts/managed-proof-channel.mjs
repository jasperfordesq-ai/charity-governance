import {createServer,createConnection} from 'node:net';
import {mkdtempSync,chmodSync,lstatSync,realpathSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {containmentUnit,inspectContainmentUnit} from './managed-proof-systemd-containment.mjs';
const refuse=()=>new Error('Managed guardian channel unresolved; no execution or recovery authority inferred');
const ACK={format:1,kind:'MANAGED_IMPORTED_PROOF_WORKER_V1',ok:true};
function ownedDirectory(root){
 if(process.platform!=='linux'||process.getuid()===0||dirname(root)!==resolve(tmpdir())||!/^charitypilot-managed-channel-[A-Za-z0-9]{6}$/.test(basename(root))||realpathSync(root)!==root)throw refuse();
 const s=lstatSync(root);if(!s.isDirectory()||s.uid!==process.getuid()||(s.mode&0o777)!==0o700)throw refuse();
}
function send(socket,value){if(socket.destroyed||!socket.writable)throw refuse();socket.write(JSON.stringify(value)+'\n');}
function frames(socket,onValue,onFailure){
 let pending=Buffer.alloc(0);socket.on('data',chunk=>{
  try{const merged=Buffer.concat([pending,chunk]);pending.fill(0);pending=merged;if(pending.length>196608)throw refuse();
   let n;while((n=pending.indexOf(10))!==-1){const line=Buffer.from(pending.subarray(0,n)),rest=Buffer.from(pending.subarray(n+1));pending.fill(0);pending=rest;
    try{onValue(JSON.parse(line.toString('utf8')));}finally{line.fill(0);}}
  }catch{onFailure();}
 });
 socket.on('close',()=>{pending.fill(0);onFailure();});socket.on('error',onFailure);
}
function exact(value,keys){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys.split(',').sort().join(',');}
/** Private live transport only: a saved socket path or HELLO is never a lease.
 * Caller must durably acknowledge the fresh manager identity before REQUEST. */
export async function createManagedGuardianChannel({jobId,sourceSha,input,env,authorizeInvocation,timeoutMs=90000,signal}){
 if(process.platform!=='linux'||process.getuid()===0||typeof sourceSha!=='string'||!/^[a-f0-9]{40}$/.test(sourceSha)
  ||!Buffer.isBuffer(input)||input.length<1||input.length>16384||typeof authorizeInvocation!=='function'
  ||!Number.isSafeInteger(timeoutMs)||timeoutMs<50||timeoutMs>1200000||!env||typeof env!=='object'||Array.isArray(env))throw refuse();
 try{if(JSON.parse(input.toString('utf8'))?.jobId!==jobId)throw refuse();}catch{throw refuse();}
 const unit=containmentUnit(jobId),inputDigest=createHash('sha256').update(input).digest('hex'),payload=Buffer.from(JSON.stringify({kind:'MANAGED_GUARDIAN_REQUEST_V1',input:input.toString('base64'),env,timeoutMs}));
 if(payload.length>131072||Object.entries(env).some(([k,v])=>typeof v!=='string'||k.includes('\0')||v.includes('\0')||/^(NODE_OPTIONS|NODE_PATH|INVOCATION_ID|LISTEN_FDS|LISTEN_PID)$/i.test(k))){payload.fill(0);throw refuse();}
 signal?.throwIfAborted();const root=mkdtempSync(join(tmpdir(),'charitypilot-managed-channel-'));chmodSync(root,0o700);ownedDirectory(root);
 const path=join(root,'guardian.sock');let connection,received=false,finished=false,started=false,identity;
 let resolveResult,rejectResult;const result=new Promise((a,b)=>{resolveResult=a;rejectResult=b;});void result.catch(()=>{});
 const server=createServer(socket=>{
  if(received||finished){socket.destroy();return;}received=true;connection=socket;
  const fail=()=>finish(false);frames(socket,value=>{
   if(finished)return;
   if(!started){
    started=true;
    void(async()=>{try{
     if(!exact(value,'kind,unit,invocationId,mainPid,uid')||value.kind!=='MANAGED_GUARDIAN_HELLO_V1'||value.unit!==unit||value.uid!==process.getuid())throw refuse();
     const current=inspectContainmentUnit(unit);
     if(current.ActiveState!=='active'||current.SubState!=='running'||current.InvocationID!==value.invocationId||Number(current.MainPID)!==value.mainPid||!current.ControlGroup)throw refuse();
     const members=readFileSync('/sys/fs/cgroup'+current.ControlGroup+'/cgroup.procs','utf8').trim().split(/\s+/);
     if(!members.includes(String(value.mainPid)))throw refuse();
     identity={format:1,kind:'MANAGED_GUARDIAN_LIVE_BINDING_V1',jobId,unit,invocationId:value.invocationId,uid:value.uid,mainPid:value.mainPid,mainStartMonotonic:current.ExecMainStartTimestampMonotonic,sourceSha,
      inputDigest,executionAuthorized:false,actionAuthorized:false};
     const acknowledged=await authorizeInvocation(Object.freeze({...identity}));
     if(acknowledged!==true||finished||signal?.aborted||socket.destroyed)throw refuse();
     // Re-read after the asynchronous original custody ACK, before sending work.
     const after=inspectContainmentUnit(unit);if(after.InvocationID!==identity.invocationId||Number(after.MainPID)!==identity.mainPid||after.ExecMainStartTimestampMonotonic!==identity.mainStartMonotonic||after.ActiveState!=='active')throw refuse();
     const frame=Buffer.concat([payload,Buffer.from('\n')]);socket.write(frame,()=>frame.fill(0));payload.fill(0);
    }catch{fail();}})();return;
   }
   if(!identity||!payload.every(b=>b===0)||JSON.stringify(value)!==JSON.stringify(ACK)){fail();return;}finish(true);
  },fail);
 });
 const finish=ok=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);payload.fill(0);
  if(!ok){try{if(connection&&!connection.destroyed)send(connection,{kind:'CANCEL_MANAGED_PROOF_V1'});}catch{}}
  connection?.destroy();server.close(()=>{});ok?resolveResult({guardianAcknowledged:true,identity,actionAuthorized:false}):rejectResult(refuse());
 };
 server.on('error',()=>finish(false));
 const cancel=()=>finish(false),timer=setTimeout(cancel,timeoutMs);signal?.addEventListener('abort',cancel,{once:true});
 try{await new Promise((yes,no)=>{server.once('error',no);server.listen(path,()=>{chmodSync(path,0o600);yes();});});if(signal?.aborted)cancel();}
 catch{finish(false);ownedDirectory(root);rmSync(root,{recursive:true,force:true});throw refuse();}
 return{path,unit,result,close:async({preserve=false}={})=>{finish(false);await new Promise(r=>server.close(()=>r()));ownedDirectory(root);if(!preserve)rmSync(root,{recursive:true,force:true});}};
}
/** Fixed service-side connection. No commands, source paths or worker selectors. */
export async function connectManagedGuardianParent(path){
 if(typeof path!=='string'||basename(path)!=='guardian.sock')throw refuse();ownedDirectory(dirname(path));
 const s=lstatSync(path);if(!s.isSocket()||s.uid!==process.getuid()||(s.mode&0o777)!==0o600)throw refuse();
 const cgroup=readFileSync('/proc/self/cgroup','utf8').trim();if(!cgroup.startsWith('0::'))throw refuse();
 const unit=basename(cgroup.slice(3)),jobId=unit.slice('charitypilot-containment-'.length,-8);if(containmentUnit(jobId)!==unit)throw refuse();
 const invocationId=process.env.INVOCATION_ID;if(!/^[a-f0-9]{32}$/.test(invocationId??''))throw refuse();
 const socket=createConnection(path);await new Promise((yes,no)=>{socket.once('connect',yes);socket.once('error',no);});
 let connected=true,requested=false,inputResolve,inputReject;const cancelListeners=new Set();
 const input=new Promise((a,b)=>{inputResolve=a;inputReject=b;});void input.catch(()=>{});
 const cancel=()=>{if(!connected)return;connected=false;inputReject(refuse());for(const fn of cancelListeners)fn();socket.destroy();};
 frames(socket,value=>{
  if(requested){cancel();return;}requested=true;
  if(!exact(value,'kind,input,env,timeoutMs')||value.kind!=='MANAGED_GUARDIAN_REQUEST_V1'||typeof value.input!=='string'
   ||!(/^[A-Za-z0-9+/]+={0,2}$/).test(value.input)||!value.env||typeof value.env!=='object'||Array.isArray(value.env)
   ||Object.entries(value.env).some(([k,v])=>typeof v!=='string'||k.includes('\0')||v.includes('\0')||/^(NODE_OPTIONS|NODE_PATH|INVOCATION_ID|LISTEN_FDS|LISTEN_PID)$/i.test(k))
   ||!Number.isSafeInteger(value.timeoutMs)||value.timeoutMs<50||value.timeoutMs>1200000){cancel();return;}
  const data=Buffer.from(value.input,'base64');if(data.length<1||data.length>16384||data.toString('base64')!==value.input){data.fill(0);cancel();return;}
  try{if(JSON.parse(data.toString('utf8'))?.jobId!==jobId)throw refuse();}catch{data.fill(0);cancel();return;}
  inputResolve({input:data,env:value.env,timeoutMs:value.timeoutMs});
 },cancel);
 send(socket,{kind:'MANAGED_GUARDIAN_HELLO_V1',unit,invocationId,mainPid:process.pid,uid:process.getuid()});
 return{get connected(){return connected;},receive:()=>input,onCancel:fn=>{cancelListeners.add(fn);return()=>cancelListeners.delete(fn);},
  writeError:()=>{throw refuse();},acknowledge:()=>new Promise((yes,no)=>{if(!connected){no(refuse());return;}socket.write(JSON.stringify(ACK)+'\n',error=>error?no(refuse()):yes());}),
  close:()=>{connected=false;inputReject(refuse());cancelListeners.clear();socket.end();}};
}
