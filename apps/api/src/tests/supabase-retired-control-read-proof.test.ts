import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {SupabaseRecoveryCapture} from '../services/supabase-recovery-capture.js';
import {retiredControlReadFixture as fixture} from './fixtures/retired-control-read.js';
import {assertRetiredControlReadBaseline,assertRetiredControlReadObservation} from '../services/retired-control-read-evidence.js';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
test('retired control comparison requires both original readers and bracketing JWT canary reads, exposing no credentials',async()=>{
 for(const status of [401,403]){
  const f=fixture(),probe=f.create(),baseline=await probe.baseline();assert.equal(f.state.requests.length,6);
  f.state.retired=true;f.state.status=status;const observed=await probe.verifyRefusal(baseline.body,baseline.sha256);
  assert.deepEqual(f.state.requests.slice(6),['jwt-bucket','jwt-object','secret-object','jwt-bucket','jwt-object']);
  assert.equal(observed.status,status);assert.equal(observed.retiredControlCanaryGetRefusalObserved,true);assert.equal(observed.positiveJwt.signatureVerified,true);
  assert.equal(observed.positiveJwt.providerKeyCurrentVerified,false);assert.equal(observed.positiveJwt.sqlRoleOidVerified,false);
  for(const key of ['originalBaselineAcknowledgementVerified','credentialRevocationProven','writeRejectionVerified','providerKeyCurrentVerified','sqlPrivilegeWindowHeld','unfilteredVisibilityVerified','wholeStorageQuiesced','actionAuthorized'] as const)assert.equal(observed[key],false);
  assert.equal(JSON.stringify(observed).includes(f.secret),false);assert.equal(JSON.stringify(observed).includes(f.token),false);assert.equal(JSON.stringify(probe),'{}');
  probe.assertRetirementKeyScope({installationId:f.config.installationId,projectRef:f.config.projectRef,captureKeyId:f.config.retiredControl.id});
  assert.throws(()=>probe.assertRetirementKeyScope({installationId:'another',projectRef:f.config.projectRef,captureKeyId:f.config.retiredControl.id}));
 }
});

test('generic failures and key still accepted are not revocation evidence',async()=>{
 for(const status of [200,204,301,304,404,409,429,500]){
  const f=fixture(),probe=f.create(),baseline=await probe.baseline();f.state.retired=true;f.state.status=status;
  await assert.rejects(probe.verifyRefusal(baseline.body,baseline.sha256),/^Error: Retired control read comparison is unverified$/);
  assert.equal(f.state.requests.filter(v=>v==='secret-object').length,2);
 }
 const f=fixture(),p=f.create(),baseline=await p.baseline();await assert.rejects(p.verifyRefusal(baseline.body,baseline.sha256));
});

test('denied or changed positive controls before or after the refusal discard the comparison',async()=>{
 for(const stage of ['before','after'])for(const fault of ['denied','public','hash']){
  const f=fixture(),probe=f.create(),baseline=await probe.baseline();f.state.retired=true;
  if(stage==='before')f.state.positiveFault=fault;else f.state.afterFault=fault;
  await assert.rejects(probe.verifyRefusal(baseline.body,baseline.sha256));
 }
 const f=fixture();f.state.retired=true;await assert.rejects(f.create().baseline());
});

test('scope, reader mode, credential hash and baseline substitutions refuse without provider calls',async()=>{
 const f=fixture();
 for(const raw of [{...f.config,bucket:'documents'},{...f.config,canary:{...f.config.canary,fileUrl:'charitypilot-recovery-canary/other/test.txt'}},
  {...f.config,canary:{...f.config.canary,fileUrl:'charitypilot-recovery-canary/synthetic/../test.txt'}},
  {...f.config,readRole:{...f.config.readRole,configurationDigest:'0'.repeat(64)}},
  {...f.config,retiredControl:{...f.config.retiredControl,sha256:'0'.repeat(64)}}])assert.throws(()=>f.create(raw));
 const legacy=new SupabaseRecoveryCapture({installationId:f.config.installationId,projectRef:f.config.projectRef,bucket:f.config.bucket,
  credential:{id:f.config.retiredControl.id,sha256:hash(f.secret)}},f.secret,f.transport);
 assert.throws(()=>f.create({...f.config,readRole:{...f.config.readRole,configurationDigest:legacy.configurationDigest()}},legacy));
 assert.equal(f.state.requests.length,0);
 const probe=f.create(),baseline=await probe.baseline();const before=f.state.requests.length;
 for(const key of ['configurationDigest','canarySha256','retiredControlId','bytes','originalBaselineAcknowledgementVerified','capturedAt']){
  const raw=JSON.parse(baseline.body);raw[key]=key==='bytes'?1:key==='originalBaselineAcknowledgementVerified'?true:key==='capturedAt'?'2099-01-01T00:00:00.000Z':'0'.repeat(64);
  const body=JSON.stringify(raw);await assert.rejects(probe.verifyRefusal(body,hash(body)));
 }
 assert.equal(f.state.requests.length,before);
});

test('caller cancellation and the bounded deadline reject a stalled refusal and discard its late response',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 for(const mode of ['caller','deadline']){
  const f=fixture(),probe=f.create(),baseline=await probe.baseline(),controller=new AbortController();f.state.retired=true;f.state.stall=true;
  let enter=()=>{};const entered=new Promise<void>(resolve=>{enter=resolve;});f.state.entered=enter;
  const running=probe.verifyRefusal(baseline.body,baseline.sha256,controller.signal);void running.catch(()=>{});await entered;
  if(mode==='caller')controller.abort();else t.mock.timers.tick(45001);
  await assert.rejects(running);const before=f.state.requests.length;f.state.release!(new Response(null,{status:401}));
  await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(f.state.requests.length,before);
 }
 const f=fixture(),controller=new AbortController();controller.abort();await assert.rejects(f.create().baseline(controller.signal));assert.equal(f.state.requests.length,0);
});

test('an expired configured JWT refuses comparison before any new provider request',async t=>{
 const f=fixture(),probe=f.create(),baseline=await probe.baseline();f.state.retired=true;const before=f.state.requests.length,now=Date.now();
 t.mock.method(Date,'now',()=>now+600000);
 await assert.rejects(probe.verifyRefusal(baseline.body,baseline.sha256));assert.equal(f.state.requests.length,before);
 assert.throws(()=>f.positive.readRoleVerificationEvidence());
});

test('cold public evidence validates after token expiry without credentials, and refuses key/role/hash substitution',async t=>{
 const f=fixture(),probe=f.create(),baseline=await probe.baseline();f.state.retired=true;
 const observation=await probe.verifyRefusal(baseline.body,baseline.sha256),descriptor=JSON.parse(JSON.stringify(probe.configurationDescriptor()));
 const before=f.state.requests.length,now=Date.now();t.mock.method(Date,'now',()=>now+600000);
 assert.throws(()=>f.positive.readRoleVerificationEvidence());
 assert.equal(assertRetiredControlReadBaseline(descriptor,baseline).sha256,baseline.sha256);
 assert.equal(assertRetiredControlReadObservation(descriptor,baseline,observation).observationDigest,observation.observationDigest);
 for(const mode of ['key','role','claim','digest','baseline','time']){
  const v=structuredClone(observation);
  if(mode==='key')v.positiveJwt.verificationKeySha256='0'.repeat(64);
  if(mode==='role')v.positiveJwt.sqlRole.oid='999';
  if(mode==='claim')(v as {credentialRevocationProven:boolean}).credentialRevocationProven=true;
  if(mode==='digest')v.observationDigest='0'.repeat(64);
  if(mode==='baseline')v.baselineSha256='0'.repeat(64);
  if(mode==='time')v.observedAt=new Date(v.positiveJwt.expiresAt*1000).toISOString();
  if(['key','role','time'].includes(mode)){
   const facts={format:v.format,kind:v.kind,configurationDigest:v.configurationDigest,baselineSha256:v.baselineSha256,retiredControlId:v.retiredControlId,
    canarySha256:v.canarySha256,bytes:v.bytes,status:v.status,startedAt:v.startedAt,observedAt:v.observedAt,positiveJwt:v.positiveJwt};v.observationDigest=hash(JSON.stringify(facts));
  }
  assert.throws(()=>assertRetiredControlReadObservation(descriptor,baseline,v));
 }
 const wrong=structuredClone(descriptor);wrong.positiveReader.credential.sha256='0'.repeat(64);
 assert.throws(()=>assertRetiredControlReadBaseline(wrong,baseline));assert.equal(f.state.requests.length,before);
 assert.equal(JSON.stringify(descriptor).includes(f.token),false);assert.equal(JSON.stringify(descriptor).includes(f.secret),false);
});
