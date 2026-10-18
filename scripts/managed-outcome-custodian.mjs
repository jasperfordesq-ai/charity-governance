import {createServer,createConnection} from 'node:net';
import {mkdtempSync,chmodSync,lstatSync,realpathSync,readdirSync,rmSync,readFileSync,existsSync,rmdirSync} from 'node:fs';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {tmpdir} from 'node:os';
import {dirname,basename,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {claimOriginalOutcomeAuthority} from './managed-outcome-claim-channel.mjs';
import {containmentUnit,inspectContainmentUnit,currentContainmentBootId} from './managed-proof-systemd-containment.mjs';
import {verifyContainedExecutorSource} from './managed-proof-systemd-runner.mjs';
const no=()=>new Error('Original outcome custody unresolved; preserve evidence without retry');
const hash=v=>createHash('sha256').update(v).digest('hex');
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
function endpointShape(v){
 if(!exact(v,'root,path,device,inode,capability')||typeof v.root!=='string'||v.path!==join(v.root,'outcome.sock')||!hex(v.capability)
  ||!Number.isSafeInteger(v.device)||v.device<0||!Number.isSafeInteger(v.inode)||v.inode<1)throw no();return v;
}
function endpointRoot(v){
 endpointShape(v);if(process.platform!=='linux'||process.getuid()===0||dirname(v.root)!==resolve(tmpdir())
  ||!/^charitypilot-outcome-custody-[A-Za-z0-9]{6}$/.test(basename(v.root))||realpathSync(v.root)!==v.root)throw no();
 const s=lstatSync(v.root);if(!s.isDirectory()||s.uid!==process.getuid()||(s.mode&0o777)!==0o700||s.dev!==v.device||s.ino!==v.inode)throw no();return s;
}
export function prepareOutcomeCustodyEndpoint(){
 if(process.platform!=='linux'||process.getuid()===0)throw no();
 const root=mkdtempSync(join(tmpdir(),'charitypilot-outcome-custody-'));chmodSync(root,0o700);const s=lstatSync(root);
 const binding={root,path:join(root,'outcome.sock'),device:s.dev,inode:s.ino,capability:randomBytes(32).toString('hex')};endpointRoot(binding);
 return{binding:()=>({...binding}),close:()=>{if(!existsSync(root))return;endpointRoot(binding);if(readdirSync(root).length)throw no();rmdirSync(root);}};
}
export function validateOutcomeCustodianInput(raw){
 if(!exact(raw,'format,kind,jobId,receiverId,sourceSha,claim,endpoint,ticket')||raw.format!==1||raw.kind!=='MANAGED_OUTCOME_CUSTODIAN_INPUT_V1'
  ||!uuid(raw.jobId)||!uuid(raw.receiverId)||raw.jobId===raw.receiverId||typeof raw.sourceSha!=='string'||!/^[a-f0-9]{40}$/.test(raw.sourceSha)
  ||!exact(raw.claim,'path,capability')||typeof raw.claim.path!=='string'||basename(raw.claim.path)!=='claim.sock'||!hex(raw.claim.capability)
  ||!raw.ticket||typeof raw.ticket!=='object'||Array.isArray(raw.ticket)||Buffer.byteLength(JSON.stringify(raw.ticket))>65536
  ||Buffer.byteLength(JSON.stringify(raw))>98304)throw no();endpointShape(raw.endpoint);return structuredClone(raw);
}
function actualIdentity(input,inputDigest){
 if(process.platform!=='linux'||process.getuid()===0)throw no();verifyContainedExecutorSource(input.sourceSha);
 const unit=containmentUnit(input.receiverId),v=inspectContainmentUnit(unit);
 if(v.MainPID!==String(process.pid)||v.InvocationID!==process.env.INVOCATION_ID||v.ActiveState!=='active'||v.SubState!=='running'
  ||readFileSync('/proc/self/cgroup','utf8').trim()!=='0::'+v.ControlGroup)throw no();
 return{format:1,kind:'MANAGED_OUTCOME_RECEIVER_V1',jobId:input.jobId,receiverId:input.receiverId,sourceSha:input.sourceSha,inputDigest,
  identity:{unit,invocationId:v.InvocationID,uid:process.getuid(),mainPid:process.pid,mainStartMonotonic:v.ExecMainStartTimestampMonotonic,
   bootId:currentContainmentBootId(),controlGroup:v.ControlGroup}};
}
const pin=v=>exact(v,'kind,versionId,sha256,byteLength')&&v.kind==='OBSERVATION'&&hex(v.sha256)&&Number.isSafeInteger(v.byteLength)&&v.byteLength>0&&v.byteLength<=16384
 &&typeof v.versionId==='string'&&v.versionId!=='null'&&/^[\x21-\x7e]{1,1024}$/.test(v.versionId);
function reply(request,stored){return{format:1,kind:stored?'MANAGED_OUTCOME_STORED_ACK_V1':'MANAGED_OUTCOME_READY_ACK_V1',jobId:request.jobId,
 receiverId:request.receiverId,sourceSha:request.sourceSha,inputDigest:request.inputDigest,exchangeNonce:request.exchangeNonce,
 ...(stored?{artifactPin:{sha256:request.artifact.sha256,byteLength:request.artifact.byteLength},pin:stored.pin}:{}),
 originalAcknowledgementReconstructed:false,pendingRequestResolved:false,executionAuthorized:false,actionAuthorized:false};}
/** The grant is already activated before listening. A complete authenticated
 * publish remains owned here even if its client disappears during provider IO. */
export async function serveOutcomeCustody({endpoint,receiver,expiresMonotonicNs,grant}){
 endpointRoot(endpoint);if(readdirSync(endpoint.root).length||!hex(receiver?.inputDigest)||!uuid(receiver?.jobId)||!uuid(receiver?.receiverId)
  ||typeof expiresMonotonicNs!=='string'||!/^[0-9]{1,24}$/.test(expiresMonotonicNs)||typeof grant?.publish!=='function'||typeof grant?.revoke!=='function')throw no();
 const expires=BigInt(expiresMonotonicNs),remaining=expires-process.hrtime.bigint();if(remaining<=0n||remaining>120000000000n)throw no();
 let open=true,attempted=false,finished=false,failed=false,probes=0,resolveResult,rejectResult;
 const sockets=new Set(),pending=new Set(),result=new Promise((yes,no)=>{resolveResult=yes;rejectResult=no;});void result.catch(()=>{});
 const active=()=>open&&!failed&&process.hrtime.bigint()<expires;
 const finish=(error,value)=>{if(finished)return;finished=true;open=false;clearTimeout(timer);if(error){failed=true;grant.revoke();rejectResult(no());}else resolveResult(value);};
 const server=createServer(socket=>{
  if(!active()||attempted){socket.destroy();return;}sockets.add(socket);let body=Buffer.alloc(0),received=false,publishing=false;
  const broken=()=>{if(!publishing&&!finished)finish(true);socket.destroy();};socket.setTimeout(15000,broken);socket.on('error',broken);
  socket.on('close',()=>{body.fill(0);sockets.delete(socket);if(!received&&!finished)finish(true);});
  socket.on('data',chunk=>{
   if(received){broken();return;}const next=Buffer.concat([body,chunk]);body.fill(0);body=next;if(body.length>32768){broken();return;}
   const n=body.indexOf(10);if(n<0)return;received=true;
   const task=(async()=>{try{
    if(n!==body.length-1||!active()||attempted)throw no();const v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body.subarray(0,n)));body.fill(0);
    const publish=v?.kind==='MANAGED_OUTCOME_PUBLISH_V1';
    if(!exact(v,publish?'format,kind,jobId,receiverId,sourceSha,inputDigest,capability,exchangeNonce,artifact':'format,kind,jobId,receiverId,sourceSha,inputDigest,capability,exchangeNonce')
     ||v.format!==1||!['MANAGED_OUTCOME_PUBLISH_V1','MANAGED_OUTCOME_PROBE_V1'].includes(v.kind)||v.jobId!==receiver.jobId||v.receiverId!==receiver.receiverId
     ||v.sourceSha!==receiver.sourceSha||v.inputDigest!==receiver.inputDigest||!hex(v.capability)||!hex(v.exchangeNonce)
     ||!timingSafeEqual(Buffer.from(v.capability),Buffer.from(endpoint.capability)))throw no();
    if(!publish){if(++probes>8)throw no();await new Promise((yes,no)=>socket.end(JSON.stringify(reply(v))+'\n',e=>e?no(e):yes()));return;}
    attempted=true;const a=v.artifact;if(!exact(a,'body,sha256,byteLength')||typeof a.body!=='string'||Buffer.byteLength(a.body)>8192||a.byteLength!==Buffer.byteLength(a.body)||a.sha256!==hash(a.body))throw no();
    publishing=true;const stored=await grant.publish(a);if(!pin(stored?.pin)||stored?.pendingRequestResolved!==false||stored?.actionAuthorized!==false)throw no();
    let sent=false;if(active()&&!socket.destroyed&&socket.writable){try{await new Promise((yes,no)=>socket.end(JSON.stringify(reply(v,stored))+'\n',e=>e?no(e):yes()));sent=active();}catch{}}
    finish(false,{outcomeStored:true,acknowledgementSent:sent,originalAcknowledgementReconstructed:false,pendingRequestResolved:false,actionAuthorized:false});
   }catch{finish(true);socket.destroy();}finally{body.fill(0);}})();pending.add(task);void task.finally(()=>pending.delete(task));
  });
 });
 const timer=setTimeout(()=>finish(true),Math.max(1,Number(remaining/1000000n)));server.on('error',()=>finish(true));
 try{await new Promise((yes,no)=>{server.once('error',no);server.listen(endpoint.path,()=>{chmodSync(endpoint.path,0o600);yes();});});}
 catch{finish(true);await new Promise(r=>server.close(()=>r()));throw no();}
 let closing;
 const close=async()=>{
  if(!finished)finish(true);for(const s of sockets)s.destroy();await new Promise(r=>server.close(()=>r()));let wait;
  const settled=await Promise.race([Promise.allSettled([...pending]).then(()=>true),new Promise(r=>{wait=setTimeout(()=>r(false),15000);})]);clearTimeout(wait);
  if(!settled)throw no();endpointRoot(endpoint);if(readdirSync(endpoint.root).some(n=>n!=='outcome.sock'))throw no();rmSync(endpoint.root,{recursive:true,force:true});grant.revoke();
 };
 return{result,snapshot:()=>({publishAttempted:attempted,finished,failed,probes,inFlight:pending.size}),close:()=>closing??=close()};
}
export async function requestOutcomeCustody({endpoint,receiver,artifact}){
 endpointRoot(endpoint);const s=lstatSync(endpoint.path);if(!s.isSocket()||s.uid!==process.getuid()||(s.mode&0o777)!==0o600)throw no();
 const request={format:1,kind:artifact?'MANAGED_OUTCOME_PUBLISH_V1':'MANAGED_OUTCOME_PROBE_V1',jobId:receiver.jobId,receiverId:receiver.receiverId,
  sourceSha:receiver.sourceSha,inputDigest:receiver.inputDigest,capability:endpoint.capability,exchangeNonce:randomBytes(32).toString('hex'),...(artifact?{artifact}:{})};
 const packet=Buffer.from(JSON.stringify(request)+'\n');if(packet.length>32768)throw no();const deadline=performance.now()+20000;
 try{return await new Promise((yes,nope)=>{
  const socket=createConnection(endpoint.path);let body='',done=false;
  const finish=value=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();value?yes(value):nope(no());};
  const timer=setTimeout(()=>finish(),20000);socket.once('error',()=>finish());socket.once('connect',()=>socket.write(packet));
  socket.on('data',b=>{body+=b.toString('utf8');if(Buffer.byteLength(body)>4096)finish();});
  socket.once('end',()=>{try{const v=JSON.parse(body);if(performance.now()>=deadline||body!==JSON.stringify(reply(request,artifact?{pin:v.pin}:undefined))+'\n'||artifact&&!pin(v.pin))throw no();finish(artifact?{pin:v.pin,originalAcknowledgementReconstructed:false,pendingRequestResolved:false,actionAuthorized:false}:true);}catch{finish();}});
  socket.once('close',()=>{if(!done)finish();});
 });}finally{packet.fill(0);}
}
async function acceptSdk(ticket,claim){
 const path=fileURLToPath(new URL('../apps/api/dist/services/managed-daemon-intent-custody.js',import.meta.url));if(realpathSync(path)!==path)throw no();
 const {ManagedDaemonIntentCustody}=await import(pathToFileURL(path).href);return ManagedDaemonIntentCustody.acceptOwnerOutcomeTransfer(ticket,claim);
}
/** Test seams are function arguments only; CLI always uses actual identity and
 * the existing fixed AWS SDK writer, with no endpoint or command selector. */
export async function runOutcomeCustodian(bytes,{identity=actualIdentity,accept=acceptSdk,onReady}={}){
 let grant,server;
 try{
  if(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>98304)throw no();let input,digest;
  try{digest=hash(bytes);input=validateOutcomeCustodianInput(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}finally{bytes.fill(0);}
  endpointRoot(input.endpoint);if(readdirSync(input.endpoint.root).length)throw no();const receiver=identity(input,digest);
  grant=await accept(input.ticket,(nonce,ticketDigest)=>claimOriginalOutcomeAuthority({binding:input.claim,jobId:input.jobId,sourceSha:input.sourceSha,
   receiverId:input.receiverId,nonce,ticketDigest,receiver}));
  server=await serveOutcomeCustody({endpoint:input.endpoint,receiver,expiresMonotonicNs:input.ticket.expiresMonotonicNs,grant});
  await onReady?.(receiver);return await server.result;
 }finally{if(server)await server.close();else grant?.revoke();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 process.stdout.on('error',()=>{});process.stderr.on('error',()=>{});let size=0;const chunks=[];
 try{if(process.argv.length!==3||process.argv[2]!=='--stdin')throw no();for await(const b of process.stdin){size+=b.length;if(size>98304)throw no();chunks.push(Buffer.from(b));}
  await runOutcomeCustodian(Buffer.concat(chunks));
 }catch{process.stderr.write('Original outcome custody unresolved\n');process.exitCode=1;}finally{for(const b of chunks)b.fill(0);}
}
