import assert from 'node:assert/strict';
import test from 'node:test';
import {generateKeyPairSync,createHash} from 'node:crypto';
import jwt from 'jsonwebtoken';
import {SupabaseRecoveryCapture} from '../services/supabase-recovery-capture.js';
import {SupabaseRetiredControlReadProof} from '../services/supabase-retired-control-read-proof.js';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex'),pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
function fixture(){
 const installationId='synthetic',projectRef='abcdefghijklmnopqrst',bucket='charitypilot-recovery-canaries',subject='11111111-1111-4111-8111-111111111111';
 const authentication={kind:'SUPABASE_CAPTURE_CUSTOM_ROLE_JWT_V1',sqlRole:{name:'storage_capture_reader',oid:'17001'},subject,
  verificationKey:{...pair.publicKey.export({format:'jwk'}),alg:'ES256',kid:'synthetic-key',use:'sig'}};
 const now=Math.floor(Date.now()/1000),token=jwt.sign({iss:`https://${projectRef}.supabase.co/auth/v1`,aud:'authenticated',sub:subject,
  role:authentication.sqlRole.name,iat:now,exp:now+300},pair.privateKey,{algorithm:'ES256',header:{alg:'ES256',typ:'JWT',kid:'synthetic-key'}});
 const secret='sb_secret_'+'x'.repeat(40),body='Synthetic retirement canary. No personal data.\n';
 const canary={fileUrl:'charitypilot-recovery-canary/synthetic/control.txt',bytes:Buffer.byteLength(body),sha256:hash(body)};
 const state={retired:false,status:401,positiveFault:'',afterFault:'',requests:[] as string[],stall:false,entered:()=>{},release:undefined as undefined|((r:Response)=>void)};
 const transport:typeof fetch=async(input,init)=>{
  const u=new URL(String(input)),h=new Headers(init?.headers),positive=h.get('authorization')==='Bearer '+token;
  assert.equal(u.origin,`https://${projectRef}.supabase.co`);assert.equal(init?.method,'GET');assert.equal(init?.redirect,'error');
  assert.equal(h.get('accept-encoding'),'identity');assert.ok(init?.signal);assert.equal(h.get('cache-control'),'no-cache, no-store');
  if(positive)assert.equal(h.get('apikey'),null);else{assert.equal(h.get('apikey'),secret);assert.equal(h.get('authorization'),null);}
  const metadata=u.pathname===`/storage/v1/bucket/${bucket}`;assert.ok(metadata||u.pathname===`/storage/v1/object/${bucket}/${canary.fileUrl}`);
  state.requests.push((positive?'jwt':'secret')+(metadata?'-bucket':'-object'));
  if(positive&&state.positiveFault==='denied')return new Response(null,{status:403});
  if(!positive&&state.retired){
   if(state.afterFault)state.positiveFault=state.afterFault;
   if(state.stall){state.entered();return new Promise<Response>(resolve=>{state.release=resolve;});}
   return new Response([204,304].includes(state.status)?null:'private provider material',{status:state.status});
  }
  if(metadata)return Response.json({id:bucket,public:positive&&state.positiveFault==='public'});
  return new Response(positive&&state.positiveFault==='hash'?body.replace('Synthetic','synthetic'):body,
   {headers:{'content-type':'text/plain','content-length':String(Buffer.byteLength(body))}});
 };
 const captureConfig={installationId,projectRef,bucket,credential:{id:subject,sha256:hash(token)},authentication};
 const positive=new SupabaseRecoveryCapture(captureConfig,token,transport);
 const config={installationId,projectRef,bucket,canary,retiredControl:{id:'22222222-2222-4222-8222-222222222222',sha256:hash(secret)},
  readRole:{subject,sqlRole:authentication.sqlRole,configurationDigest:positive.configurationDigest()}};
 const create=(raw:unknown=config,reader=positive)=>new SupabaseRetiredControlReadProof(raw,secret,reader,transport);
 return{state,create,config,positive,captureConfig,token,secret,transport};
}

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
