import {createServer,createConnection} from 'node:net';
import {mkdtempSync,chmodSync,lstatSync,realpathSync,readdirSync,rmSync} from 'node:fs';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,dirname,basename,resolve} from 'node:path';
const refuse=()=>new Error('Original outcome claim unavailable; preserve uncertainty without retry');
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const sha=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
export function requireOutcomeClaimDirectory(root){
 if(process.platform!=='linux'||process.getuid()===0||dirname(root)!==resolve(tmpdir())||!/^charitypilot-outcome-claim-[A-Za-z0-9]{6}$/.test(basename(root))||realpathSync(root)!==root)throw refuse();
 const s=lstatSync(root);if(!s.isDirectory()||s.uid!==process.getuid()||(s.mode&0o777)!==0o700)throw refuse();return s;
}
function receiverMetadata(v,jobId,sourceSha,receiverId,inputDigest){
 if(!exact(v,'format,kind,jobId,sourceSha,receiverId,inputDigest,identity')||v.format!==1||v.kind!=='MANAGED_OUTCOME_RECEIVER_V1'
  ||v.jobId!==jobId||v.sourceSha!==sourceSha||v.receiverId!==receiverId||v.inputDigest!==inputDigest)throw refuse();
 const i=v.identity;if(!exact(i,'unit,invocationId,uid,mainPid,mainStartMonotonic,bootId,controlGroup')
  ||i.unit!==`charitypilot-containment-${receiverId}.service`||!(/^[a-f0-9]{32}$/).test(i.invocationId)
  ||!Number.isSafeInteger(i.uid)||i.uid!==process.getuid()||!Number.isSafeInteger(i.mainPid)||i.mainPid<1
  ||!(/^[1-9][0-9]{0,19}$/).test(i.mainStartMonotonic)||!(/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/).test(i.bootId)
  ||typeof i.controlGroup!=='string'||i.controlGroup.length>1024||!i.controlGroup.startsWith(`/user.slice/user-${i.uid}.slice/user@${i.uid}.service/`)
  ||!i.controlGroup.endsWith('/'+i.unit)||!i.controlGroup.slice(1).split('/').every(p=>p!=='.'&&p!=='..'&&/^[A-Za-z0-9_.@:-]+$/.test(p)))throw refuse();
 return structuredClone(v);
}
function acknowledgement(v){return{format:1,kind:'MANAGED_OUTCOME_CLAIM_ACK_V1',jobId:v.jobId,sourceSha:v.sourceSha,receiverId:v.receiverId,
 inputDigest:v.receiver.inputDigest,ticketDigest:v.ticketDigest,exchangeNonce:v.exchangeNonce,receiverDigest:sha(v.receiver),
 originalAcknowledgementReconstructed:false,executionAuthorized:false,actionAuthorized:false};}
/** Original same-user private bootstrap only. The mandatory verifier is an
 * internal kernel/source check, never a flag or callback selected by input. */
export async function createOriginalOutcomeClaimChannel({jobId,sourceSha,receiverId,ticketDigest,transfer,verifyReceiver,timeoutMs=15000}){
 if(!uuid(jobId)||!uuid(receiverId)||jobId===receiverId||typeof sourceSha!=='string'||!/^[a-f0-9]{40}$/.test(sourceSha)||!hex(ticketDigest)
  ||typeof transfer?.claim!=='function'||typeof transfer?.abandon!=='function'||typeof verifyReceiver!=='function'
  ||!Number.isSafeInteger(timeoutMs)||timeoutMs<50||timeoutMs>15000)throw refuse();
 if(process.platform!=='linux'||process.getuid()===0)throw refuse();
 const root=mkdtempSync(join(tmpdir(),'charitypilot-outcome-claim-'));chmodSync(root,0o700);const original=requireOutcomeClaimDirectory(root),path=join(root,'claim.sock'),capability=randomBytes(32).toString('hex');
 const deadline=performance.now()+timeoutMs;
 let open=true,attempted=false,claimed=false,sent=false,failed=false,inputDigest,connection,resolveResult,rejectResult;
 const active=()=>open&&!failed&&performance.now()<deadline;
 const pending=new Set(),result=new Promise((yes,no)=>{resolveResult=yes;rejectResult=no;});void result.catch(()=>{});
 const unchanged=()=>{const s=requireOutcomeClaimDirectory(root);if(s.dev!==original.dev||s.ino!==original.ino)throw refuse();};
 const fail=()=>{if(sent)return;failed=true;open=false;clearTimeout(timer);try{transfer.abandon();}catch{}connection?.destroy();rejectResult(refuse());};
 const verified=async receiver=>{if(!active())throw refuse();const v=await verifyReceiver(receiver);if(!active()||v?.liveCustodyIdentityVerified!==true||v?.executionAuthorized!==false||v?.actionAuthorized!==false)throw refuse();};
 const server=createServer(socket=>{
  if(!active()||attempted||!inputDigest){socket.destroy();fail();return;}attempted=true;connection=socket;let body=Buffer.alloc(0),received=false;
  socket.setTimeout(timeoutMs,fail);socket.on('error',fail);socket.on('close',()=>{body.fill(0);if(!sent)fail();});
  socket.on('data',chunk=>{
   if(received){fail();return;}const next=Buffer.concat([body,chunk]);body.fill(0);body=next;
   if(body.length>8192){fail();return;}const n=body.indexOf(10);if(n<0)return;received=true;
   const task=(async()=>{try{
    if(n!==body.length-1)throw refuse();unchanged();const v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body.subarray(0,n)));body.fill(0);
    if(!exact(v,'format,kind,jobId,sourceSha,receiverId,capability,nonce,ticketDigest,exchangeNonce,receiver')||v.format!==1||v.kind!=='MANAGED_OUTCOME_CLAIM_V1'
     ||v.jobId!==jobId||v.sourceSha!==sourceSha||v.receiverId!==receiverId||v.ticketDigest!==ticketDigest||!hex(v.capability)||!hex(v.nonce)||!hex(v.exchangeNonce)
     ||!timingSafeEqual(Buffer.from(v.capability),Buffer.from(capability)))throw refuse();
    const receiver=receiverMetadata(v.receiver,jobId,sourceSha,receiverId,inputDigest);await verified(receiver);
    if(!active()||socket.destroyed)throw refuse();if(await transfer.claim(v.nonce,ticketDigest)!==true)throw refuse();claimed=true;
    await verified(receiver);if(!active()||socket.destroyed)throw refuse();unchanged();
    await new Promise((yes,no)=>socket.end(JSON.stringify(acknowledgement(v))+'\n',error=>error?no(error):yes()));
    if(!active())throw refuse();sent=true;open=false;clearTimeout(timer);
    resolveResult({claimConsumed:true,acknowledgementSent:true,acknowledgementObservedByReceiver:false,receiver,
     originalAcknowledgementReconstructed:false,executionAuthorized:false,actionAuthorized:false});
   }catch{fail();}finally{body.fill(0);}})();pending.add(task);void task.finally(()=>pending.delete(task));
  });
 });
 const timer=setTimeout(fail,timeoutMs);server.on('error',fail);
 try{await new Promise((yes,no)=>{server.once('error',no);server.listen(path,()=>{chmodSync(path,0o600);yes();});});}
 catch{fail();await new Promise(r=>server.close(()=>r()));unchanged();if(!readdirSync(root).some(n=>n!=='claim.sock'))rmSync(root,{recursive:true,force:true});throw refuse();}
 let closing;
 const close=async()=>{
  if(!sent)fail();connection?.destroy();await new Promise(r=>server.close(()=>r()));let wait;
  const settled=await Promise.race([Promise.allSettled([...pending]).then(()=>true),new Promise(r=>{wait=setTimeout(()=>r(false),15000);})]);clearTimeout(wait);
  if(!settled)throw refuse();unchanged();if(readdirSync(root).some(n=>n!=='claim.sock'))throw refuse();rmSync(root,{recursive:true,force:true});
 };
 return{binding:()=>({path,capability}),bindInputDigest:value=>{if(!active()||attempted||inputDigest||!hex(value))throw refuse();inputDigest=value;},
  result,snapshot:()=>({attempted,claimConsumed:claimed,acknowledgementSent:sent,failed,inFlight:pending.size}),close:()=>closing??=close()};
}
/** Credential-free client. It sends only the transfer nonce/digest and receiver
 * identity; the ticket and cloud credentials never enter this wire message. */
export async function claimOriginalOutcomeAuthority({binding,jobId,sourceSha,receiverId,nonce,ticketDigest,receiver}){
 if(!exact(binding,'path,capability')||typeof binding.path!=='string'||basename(binding.path)!=='claim.sock'||!hex(binding.capability)
  ||!uuid(jobId)||!uuid(receiverId)||typeof sourceSha!=='string'||!/^[a-f0-9]{40}$/.test(sourceSha)||!hex(nonce)||!hex(ticketDigest)||!hex(receiver?.inputDigest))throw refuse();
 const root=dirname(binding.path),before=requireOutcomeClaimDirectory(root),s=lstatSync(binding.path);
 if(!s.isSocket()||s.uid!==process.getuid()||(s.mode&0o777)!==0o600)throw refuse();
 const metadata=receiverMetadata(receiver,jobId,sourceSha,receiverId,receiver.inputDigest),after=requireOutcomeClaimDirectory(root);
 if(before.dev!==after.dev||before.ino!==after.ino)throw refuse();
 const request={format:1,kind:'MANAGED_OUTCOME_CLAIM_V1',jobId,sourceSha,receiverId,capability:binding.capability,nonce,ticketDigest,
  exchangeNonce:randomBytes(32).toString('hex'),receiver:metadata},packet=Buffer.from(JSON.stringify(request)+'\n');if(packet.length>8192)throw refuse();
 const deadline=performance.now()+15000;
 try{return await new Promise((yes,no)=>{
  const socket=createConnection(binding.path);let response='',done=false;
  const finish=ok=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();ok&&performance.now()<deadline?yes(true):no(refuse());};
  const timer=setTimeout(()=>finish(false),15000);socket.once('error',()=>finish(false));socket.once('connect',()=>socket.write(packet));
  socket.on('data',b=>{response+=b.toString('utf8');if(Buffer.byteLength(response)>2048)finish(false);});
  socket.once('end',()=>finish(response===JSON.stringify(acknowledgement(request))+'\n'));socket.once('close',()=>{if(!done)finish(false);});
 });}finally{packet.fill(0);}
}
