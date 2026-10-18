import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {dirname} from 'node:path';
import {existsSync,readdirSync,lstatSync} from 'node:fs';
import {createOriginalOutcomeClaimChannel,claimOriginalOutcomeAuthority} from './managed-outcome-claim-channel.mjs';
const enabled=process.platform==='linux'&&process.getuid()!==0;
const verified={liveCustodyIdentityVerified:true,executionAuthorized:false,actionAuthorized:false};
function scope(){
 const jobId=randomUUID(),receiverId=randomUUID(),sourceSha='1'.repeat(40),inputDigest='2'.repeat(64),nonce='3'.repeat(64),ticketDigest='4'.repeat(64);
 const receiver={format:1,kind:'MANAGED_OUTCOME_RECEIVER_V1',jobId,sourceSha,receiverId,inputDigest,identity:{unit:`charitypilot-containment-${receiverId}.service`,
  invocationId:'5'.repeat(32),uid:enabled?process.getuid():1000,mainPid:process.pid,mainStartMonotonic:'12345',bootId:'12345678-1234-1234-1234-123456789012',
  controlGroup:`/user.slice/user-${enabled?process.getuid():1000}.slice/user@${enabled?process.getuid():1000}.service/app.slice/charitypilot-containment-${receiverId}.service`}};
 return{jobId,receiverId,sourceSha,inputDigest,nonce,ticketDigest,receiver};
}
test('missing trusted verifier or original issuer refuses before opening any transport',async()=>{
 const s=scope();for(const change of [{},{verifyReceiver:async()=>verified},{transfer:{claim:()=>true,abandon(){}}}])
  await assert.rejects(createOriginalOutcomeClaimChannel({...s,...change}));
 await assert.rejects(claimOriginalOutcomeAuthority({binding:{path:'/tmp/arbitrary.sock',capability:'0'.repeat(64)}}));
});
test('private original claim binds receiver input and runs verification on both sides of the live claim',{skip:!enabled,timeout:10000},async()=>{
 const s=scope(),events=[];let abandoned=0,channel;
 try{
  channel=await createOriginalOutcomeClaimChannel({...s,transfer:{claim:(nonce,digest)=>{events.push('claim');assert.equal(nonce,s.nonce);assert.equal(digest,s.ticketDigest);return true;},abandon(){abandoned++;}},
   verifyReceiver:async receiver=>{events.push('verify');assert.deepEqual(receiver,s.receiver);return verified;}});
  const binding=channel.binding(),root=dirname(binding.path);assert.equal(lstatSync(root).mode&0o777,0o700);assert.equal(lstatSync(binding.path).mode&0o777,0o600);
  assert.deepEqual(readdirSync(root),['claim.sock']);assert.equal(JSON.stringify(channel).includes(binding.capability),false);
  channel.bindInputDigest(s.inputDigest);assert.throws(()=>channel.bindInputDigest(s.inputDigest));
  assert.equal(await claimOriginalOutcomeAuthority({...s,binding}),true);
  const result=await channel.result;assert.deepEqual(events,['verify','claim','verify']);assert.equal(result.claimConsumed,true);
  assert.equal(result.acknowledgementSent,true);assert.equal(result.acknowledgementObservedByReceiver,false);assert.equal(result.executionAuthorized,false);assert.equal(result.actionAuthorized,false);
  await assert.rejects(claimOriginalOutcomeAuthority({...s,binding}));assert.equal(events.filter(v=>v==='claim').length,1);
  await channel.close();assert.equal(abandoned,0);assert.equal(existsSync(root),false);
 }finally{await channel?.close();}
});
test('wrong capability, scope or input and verifier/claim failure refuse without retry',{skip:!enabled,timeout:15000},async()=>{
 for(const mode of ['capability','ticket','input','nonce','verify','verify-after','claim','ack-lost','identity-extra']){
  const s=scope();let checks=0,claims=0,abandoned=0,channel;
  try{
   channel=await createOriginalOutcomeClaimChannel({...s,transfer:{claim:(n,d)=>{claims++;return mode!=='claim'&&n===s.nonce&&d===s.ticketDigest;},abandon(){abandoned++;}},
    verifyReceiver:async()=>{checks++;if(mode==='verify'||mode==='verify-after'&&checks===2)return{...verified,liveCustodyIdentityVerified:false};
     if(mode==='ack-lost'&&checks===2)void channel.close();return verified;}});
   channel.bindInputDigest(s.inputDigest);const binding=channel.binding(),request={...s,binding};
   if(mode==='capability')binding.capability='0'.repeat(64);if(mode==='ticket')request.ticketDigest='0'.repeat(64);
   if(mode==='input')request.receiver={...s.receiver,inputDigest:'0'.repeat(64)};if(mode==='nonce')request.nonce='0'.repeat(64);
   if(mode==='identity-extra')request.receiver={...s.receiver,identity:{...s.receiver.identity,privateCredential:'must-not-send'}};
   await assert.rejects(claimOriginalOutcomeAuthority(request));await channel.close();await assert.rejects(channel.result);
   assert.equal(claims,['nonce','claim','verify-after','ack-lost'].includes(mode)?1:0);assert.ok(abandoned>=1);
   assert.throws(()=>channel.bindInputDigest(s.inputDigest));await assert.rejects(claimOriginalOutcomeAuthority({...s,binding:channel.binding()}));
  }finally{await channel?.close();}
 }
});
test('timeout during verification cannot consume a late claim and another original channel survives',{skip:!enabled,timeout:10000},async()=>{
 const a=scope(),b=scope();let claimsA=0,claimsB=0,first,second;
 try{
  first=await createOriginalOutcomeClaimChannel({...a,timeoutMs:50,transfer:{claim:()=>{claimsA++;return true;},abandon(){}},verifyReceiver:async()=>{await new Promise(r=>setTimeout(r,120));return verified;}});
  second=await createOriginalOutcomeClaimChannel({...b,transfer:{claim:()=>{claimsB++;return true;},abandon(){}},verifyReceiver:async()=>verified});
  first.bindInputDigest(a.inputDigest);second.bindInputDigest(b.inputDigest);
  await assert.rejects(claimOriginalOutcomeAuthority({...a,binding:first.binding()}));await first.close();await assert.rejects(first.result);assert.equal(claimsA,0);
  assert.equal(await claimOriginalOutcomeAuthority({...b,binding:second.binding()}),true);await second.result;assert.equal(claimsB,1);
 }finally{await first?.close();await second?.close();}
});
test('a synchronous verifier cannot delay the timeout callback and then consume expired authority',{skip:!enabled,timeout:10000},async()=>{
 const s=scope();let claims=0,channel;
 try{
  channel=await createOriginalOutcomeClaimChannel({...s,timeoutMs:50,transfer:{claim:()=>{claims++;return true;},abandon(){}},verifyReceiver:async()=>{
   const until=performance.now()+120;while(performance.now()<until){/* simulate a blocked synchronous kernel probe */}return verified;
  }});
  channel.bindInputDigest(s.inputDigest);await assert.rejects(claimOriginalOutcomeAuthority({...s,binding:channel.binding()}));
  await assert.rejects(channel.result);assert.equal(claims,0);
 }finally{await channel?.close();}
});
