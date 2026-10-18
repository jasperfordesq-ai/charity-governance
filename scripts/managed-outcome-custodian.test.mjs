import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {existsSync,lstatSync,writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {createConnection} from 'node:net';
import {prepareOutcomeCustodyEndpoint,serveOutcomeCustody,requestOutcomeCustody,validateOutcomeCustodianInput,runOutcomeCustodian} from './managed-outcome-custodian.mjs';
const enabled=process.platform==='linux'&&process.getuid()!==0;
const receiver=()=>({jobId:randomUUID(),receiverId:randomUUID(),sourceSha:'1'.repeat(40),inputDigest:'2'.repeat(64)});
const artifact=()=>{const body='synthetic original outcome';return{body,sha256:createHash('sha256').update(body).digest('hex'),byteLength:Buffer.byteLength(body)};};
const stored=()=>({pin:{kind:'OBSERVATION',versionId:'synthetic-version',sha256:'3'.repeat(64),byteLength:200},pendingRequestResolved:false,actionAuthorized:false});
const expires=ms=>(process.hrtime.bigint()+BigInt(ms)*1000000n).toString();
test('malformed bootstrap refuses before any SDK activation',async()=>{
 for(const v of [null,{}, {format:1,kind:'MANAGED_OUTCOME_CUSTODIAN_INPUT_V1',command:'arbitrary'}])assert.throws(()=>validateOutcomeCustodianInput(v));
 let called=false;await assert.rejects(runOutcomeCustodian(Buffer.from('{}'),{accept:()=>{called=true;}}));assert.equal(called,false);
});
test('protected endpoint refuses unexpected contents and preserves them',{skip:!enabled},()=>{
 const endpoint=prepareOutcomeCustodyEndpoint(),binding=endpoint.binding();assert.equal(lstatSync(binding.root).mode&0o777,0o700);
 const other=join(binding.root,'other');writeFileSync(other,'synthetic');assert.throws(()=>endpoint.close());assert.equal(existsSync(other),true);unlinkSync(other);endpoint.close();assert.equal(existsSync(binding.root),false);
});
test('ready probe and one original outcome ACK keep uncertainty flags false',{skip:!enabled},async()=>{
 const endpoint=prepareOutcomeCustodyEndpoint(),r=receiver();let writes=0;
 const service=await serveOutcomeCustody({endpoint:endpoint.binding(),receiver:r,expiresMonotonicNs:expires(3000),grant:{publish:async a=>{writes++;assert.deepEqual(a,artifact());return stored();},revoke(){}}});
 try{assert.equal(await requestOutcomeCustody({endpoint:endpoint.binding(),receiver:r}),true);
  const ack=await requestOutcomeCustody({endpoint:endpoint.binding(),receiver:r,artifact:artifact()});assert.deepEqual(ack.pin,stored().pin);assert.equal(ack.pendingRequestResolved,false);
  assert.equal((await service.result).outcomeStored,true);assert.equal(writes,1);
  await assert.rejects(requestOutcomeCustody({endpoint:endpoint.binding(),receiver:r,artifact:artifact()}));assert.equal(writes,1);
 }finally{await service.close();endpoint.close();}
});
test('wrong capability or bytes refuse without provider write; other job survives',{skip:!enabled},async()=>{
 for(const change of ['capability','bytes']){
  const endpoint=prepareOutcomeCustodyEndpoint(),other=prepareOutcomeCustodyEndpoint(),r=receiver();let writes=0;
  const service=await serveOutcomeCustody({endpoint:endpoint.binding(),receiver:r,expiresMonotonicNs:expires(3000),grant:{publish:async()=>{writes++;return stored();},revoke(){}}});
  try{const a=artifact();if(change==='bytes')a.body+='changed';
   await assert.rejects(requestOutcomeCustody({endpoint:{...endpoint.binding(),...(change==='capability'?{capability:'0'.repeat(64)}:{})},receiver:r,artifact:a}));
   await assert.rejects(service.result);assert.equal(writes,0);assert.equal(existsSync(other.binding().root),true);
  }finally{await service.close();endpoint.close();other.close();}
 }
});
test('client death after complete publish does not cancel original in-flight SDK outcome',{skip:!enabled},async()=>{
 const endpoint=prepareOutcomeCustodyEndpoint(),r=receiver();let release,started;const active=new Promise(yes=>{started=yes;});let revoked=0,writes=0;
 const service=await serveOutcomeCustody({endpoint:endpoint.binding(),receiver:r,expiresMonotonicNs:expires(3000),grant:{publish:async()=>{writes++;started();await new Promise(yes=>{release=yes;});return stored();},revoke(){revoked++;}}});
 try{const b=endpoint.binding(),socket=createConnection(b.path);await new Promise((yes,no)=>{socket.once('error',no);socket.once('connect',yes);});
  socket.write(JSON.stringify({format:1,kind:'MANAGED_OUTCOME_PUBLISH_V1',...r,capability:b.capability,exchangeNonce:'4'.repeat(64),artifact:artifact()})+'\n');
  await active;socket.destroy();await new Promise(yes=>setTimeout(yes,20));assert.equal(revoked,0);release();
  const result=await service.result;assert.equal(result.outcomeStored,true);assert.equal(result.acknowledgementSent,false);assert.equal(writes,1);
 }finally{release?.();await service.close();endpoint.close();}
});
test('original expiry revokes without extending or authorising work',{skip:!enabled},async()=>{
 const endpoint=prepareOutcomeCustodyEndpoint();let revoked=0;
 const service=await serveOutcomeCustody({endpoint:endpoint.binding(),receiver:receiver(),expiresMonotonicNs:expires(30),grant:{publish(){throw Error('must not write');},revoke(){revoked++;}}});
 try{await assert.rejects(service.result);assert.equal(revoked,1);}finally{await service.close();endpoint.close();}
});
