import {createServer} from 'node:net';
import {randomBytes,timingSafeEqual,createHash} from 'node:crypto';
import {mkdtempSync,chmodSync,lstatSync,realpathSync,writeFileSync,openSync,fsyncSync,closeSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename,resolve} from 'node:path';
const refuse=()=>new Error('Original daemon custody channel unresolved; no dispatch or replay');
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function requireDaemonGateDirectory(root){
 if(process.platform!=='linux'||process.getuid()===0||dirname(root)!==resolve(tmpdir())||!/^charitypilot-daemon-gate-[A-Za-z0-9]{6}$/.test(basename(root))||realpathSync(root)!==root)throw refuse();
 const s=lstatSync(root);if(!s.isDirectory()||s.uid!==process.getuid()||(s.mode&0o777)!==0o700)throw refuse();
 return s;
}
export async function createManagedDaemonCustodyChannel({jobId,inputDigest,sourceSha,onHeader,onIntent,onResponse,onEnd,onOwner,requireIndependentOwner=false}){
 if(typeof jobId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(jobId)||!hex(inputDigest)
  ||typeof sourceSha!=='string'||!/^[a-f0-9]{40}$/.test(sourceSha)||[onHeader,onIntent,onResponse,onEnd].some(f=>typeof f!=='function')
  ||typeof requireIndependentOwner!=='boolean'||onOwner!==undefined&&typeof onOwner!=='function'||requireIndependentOwner&&typeof onOwner!=='function')throw refuse();
 if(process.platform!=='linux'||process.getuid()===0)throw refuse();
 const root=mkdtempSync(join(tmpdir(),'charitypilot-daemon-gate-'));chmodSync(root,0o700);const originalRoot=requireDaemonGateDirectory(root);
 const unchanged=()=>{const current=requireDaemonGateDirectory(root);if(current.dev!==originalRoot.dev||current.ino!==originalRoot.ino)throw refuse();};
 const path=join(root,'gate.sock'),descriptorPath=join(root,'gate.json'),capability=randomBytes(32).toString('hex');
 let open=true,failed=false,headerAcknowledged=false,intentCount=0,responseCount=0,ownerCount=0,endAcknowledged=false,busy=false;const sockets=new Set(),pending=new Set(),nonces=new Set(),owners=new Set();
 const server=createServer(socket=>{
  sockets.add(socket);let bytes=Buffer.alloc(0),received=false;
  const fail=()=>{failed=true;socket.destroy();};socket.setTimeout(20000,fail);socket.on('error',fail);
  socket.on('close',()=>{bytes.fill(0);sockets.delete(socket);if(!received)failed=true;});
  socket.on('data',chunk=>{
   if(received){fail();return;}const merged=Buffer.concat([bytes,chunk]);bytes.fill(0);bytes=merged;
   if(bytes.length>32768){fail();return;}const n=bytes.indexOf(10);if(n<0)return;received=true;
   const task=(async()=>{
    try{
     if(!open||failed||busy||n!==bytes.length-1)throw refuse();busy=true;
     const v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,n)));bytes.fill(0);
     if(!v||Object.keys(v).sort().join(',')!=='artifact,capability,inputDigest,jobId,kind,nonce,sourceSha'||!hex(v.capability)
      ||!timingSafeEqual(Buffer.from(v.capability),Buffer.from(capability))||v.jobId!==jobId||v.inputDigest!==inputDigest||v.sourceSha!==sourceSha
      ||!hex(v.nonce)||nonces.has(v.nonce)||!['HEADER','INTENT','RESPONSE','END','OWNER'].includes(v.kind)||endAcknowledged)throw refuse();
     const a=v.artifact;if(!a||Object.keys(a).sort().join(',')!=='body,byteLength,sha256'||typeof a.body!=='string'||Buffer.byteLength(a.body)<1||Buffer.byteLength(a.body)>8192
      ||a.byteLength!==Buffer.byteLength(a.body)||!hex(a.sha256)||createHash('sha256').update(a.body).digest('hex')!==a.sha256)throw refuse();
     const local=JSON.parse(a.body),ordinal=['HEADER','END'].includes(v.kind)?0:local.sequence;
     if(local.jobId!==jobId)throw refuse();
     if(v.kind==='HEADER'&&(headerAcknowledged||local.inputDigest!==inputDigest||local.kind!=='MANAGED_DAEMON_REQUEST_HEADER_V2'))throw refuse();
     if(v.kind==='INTENT'&&(!headerAcknowledged||local.kind!=='MANAGED_DAEMON_REQUEST_INTENT_V2'||ordinal!==intentCount+1||ordinal>64||responseCount!==intentCount))throw refuse();
     if(v.kind==='OWNER'&&(!onOwner||!headerAcknowledged||local.kind!=='MANAGED_DAEMON_REQUEST_OWNER_V1'||ordinal!==intentCount||ordinal!==responseCount+1||owners.has(ordinal)))throw refuse();
     if(v.kind==='RESPONSE'&&(!headerAcknowledged||local.kind!=='MANAGED_DAEMON_CLIENT_RESPONSE_V1'||ordinal!==intentCount||ordinal!==responseCount+1||requireIndependentOwner&&!owners.has(ordinal)))throw refuse();
     if(v.kind==='END'&&(!headerAcknowledged||local.kind!=='MANAGED_DAEMON_REQUEST_END_V1'||local.requestCount!==intentCount||responseCount!==intentCount))throw refuse();
     nonces.add(v.nonce);const saved=await({HEADER:onHeader,INTENT:onIntent,RESPONSE:onResponse,END:onEnd,OWNER:onOwner}[v.kind](a));
     const completion=v.kind==='RESPONSE'||v.kind==='END';
     if(!open||failed||socket.destroyed||saved?.savedEvidenceAuthorizesDispatch!==false||saved?.actionAuthorized!==false||saved?.pin?.kind!==(completion?'OBSERVATION':'BASELINE')
      ||completion&&saved?.pendingRequestResolved!==false||v.kind==='OWNER'&&saved?.independentOwnerDispatchVerified!==false
      ||!hex(saved.pin.sha256)||!Number.isSafeInteger(saved.pin.byteLength)||saved.pin.byteLength<1||saved.pin.byteLength>16384
      ||typeof saved.pin.versionId!=='string'||saved.pin.versionId==='null'||!(/^[\x21-\x7e]{1,1024}$/).test(saved.pin.versionId))throw refuse();
     if(v.kind==='HEADER')headerAcknowledged=true;else if(v.kind==='INTENT')intentCount=ordinal;else if(v.kind==='OWNER'){owners.add(ordinal);ownerCount++;}else if(v.kind==='RESPONSE')responseCount=ordinal;else endAcknowledged=true;
     socket.end(JSON.stringify({kind:'MANAGED_DAEMON_CUSTODY_ACK_V2',recordKind:v.kind,jobId,inputDigest,sourceSha,nonce:v.nonce,ordinal,localRecordPin:{sha256:a.sha256,byteLength:a.byteLength},savedEvidenceAuthorizesDispatch:false})+'\n');
    }catch{fail();}finally{busy=false;}
   })();pending.add(task);void task.finally(()=>pending.delete(task));
  });
 });
 server.on('error',()=>{failed=true;});
 try{
  await new Promise((yes,no)=>{server.once('error',no);server.listen(path,()=>{chmodSync(path,0o600);yes();});});
  writeFileSync(descriptorPath,JSON.stringify({format:1,kind:'MANAGED_DAEMON_GATE_V1',path,jobId,inputDigest,sourceSha,capability}),{mode:0o600,flag:'wx'});
  for(const target of [descriptorPath,root]){const fd=openSync(target,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
 }catch{
  open=false;for(const socket of sockets)socket.destroy();await new Promise(r=>server.close(()=>r()));
  unchanged();if(pending.size===0&&!readdirSync(root).some(name=>!['gate.json','gate.sock'].includes(name)))rmSync(root,{recursive:true,force:true});throw refuse();
 }
 let closing;
 const close=async()=>{
  open=false;for(const socket of sockets)socket.destroy();await new Promise(r=>server.close(()=>r()));
  let timer;const terminal=await Promise.race([Promise.allSettled([...pending]).then(()=>true),new Promise(r=>{timer=setTimeout(()=>r(false),15000);})]);clearTimeout(timer);
  if(!terminal)throw refuse();unchanged();
  if(readdirSync(root).some(name=>!['gate.json','gate.sock'].includes(name)))throw refuse();rmSync(root,{recursive:true,force:true});
 };
 return{descriptorPath,binding:()=>({format:1,kind:'MANAGED_DAEMON_GATE_BINDING_V1',jobId,inputDigest,sourceSha,descriptorPath,
  device:originalRoot.dev,inode:originalRoot.ino,executionAuthorized:false,actionAuthorized:false}),
  snapshot:()=>({headerAcknowledged,intentCount,responseCount,ownerCount,requireIndependentOwner,endAcknowledged,failed,inFlight:pending.size}),close:()=>closing??=close()};
}
