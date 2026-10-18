import assert from 'node:assert/strict';
import test from 'node:test';
import {generateKeyPairSync,createHash,sign as cryptoSign,type KeyObject} from 'node:crypto';
import jwt from 'jsonwebtoken';
import {SupabaseCaptureJwt} from '../services/supabase-capture-jwt.js';
import {SupabaseRecoveryCapture} from '../services/supabase-recovery-capture.js';
const ec=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),other=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),rsa=generateKeyPairSync('rsa',{modulusLength:2048});
const project='abcdefghijklmnopqrst',subject='11111111-1111-4111-8111-111111111111';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
function fixture(algorithm:'ES256'|'RS256'='ES256',change:Record<string,unknown>={}){
 const pair=algorithm==='ES256'?ec:rsa,now=Math.floor(Date.now()/1000),kid='synthetic-capture-key';
 const authentication={kind:'SUPABASE_CAPTURE_CUSTOM_ROLE_JWT_V1',sqlRole:{name:'storage_capture_reader',oid:'17001'},subject,
  verificationKey:{...pair.publicKey.export({format:'jwk'}),alg:algorithm,kid,use:'sig'}};
 const claims={iss:`https://${project}.supabase.co/auth/v1`,aud:'authenticated',sub:subject,role:authentication.sqlRole.name,iat:now,exp:now+300,...change};
 const token=jwt.sign(claims,pair.privateKey,{algorithm,header:{alg:algorithm,typ:'JWT',kid}});
 const configuration={installationId:'synthetic',projectRef:project,bucket:'documents',credential:{id:subject,sha256:hash(token)},authentication};
 return{pair,authentication,claims,token,configuration};
}
function rawToken(header:string,claims:string,key:KeyObject){
 const input=Buffer.from(header).toString('base64url')+'.'+Buffer.from(claims).toString('base64url');
 return input+'.'+cryptoSign('sha256',Buffer.from(input),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
}
function transportFor(token:string){let requests=0,bodyReads=0;
 const transport:typeof fetch=async(input,init)=>{
  requests++;const u=new URL(String(input));assert.equal(u.origin,`https://${project}.supabase.co`);assert.equal(init?.redirect,'error');
  const h=new Headers(init?.headers);assert.equal(h.get('authorization'),'Bearer '+token);assert.equal(h.get('apikey'),null);
  if(u.pathname.includes('/bucket/'))return Response.json({id:'documents',public:false});
  if(u.pathname.includes('/object/list/')){assert.equal(init?.method,'POST');return Response.json([{name:'synthetic.txt',id:subject,created_at:'2026-10-18T00:00:00Z',updated_at:'2026-10-18T00:00:00Z',metadata:{size:3,mimetype:'text/plain'}}]);}
  assert.equal(init?.method,'GET');bodyReads++;return new Response('abc',{headers:{'content-type':'text/plain','content-length':'3'}});
 };return{transport,requests:()=>requests,bodyReads:()=>bodyReads};
}

test('asymmetric capture JWT verifies signature and exact configured claims without exposing token or granting provider privilege',()=>{
 for(const algorithm of ['ES256','RS256'] as const){const f=fixture(algorithm),auth=new SupabaseCaptureJwt(f.authentication,f.token,project),e=auth.evidence();
  assert.equal(e.signatureVerified,true);assert.equal(e.configuredClaimsMatched,true);assert.deepEqual(e.sqlRole,f.authentication.sqlRole);
  for(const flag of ['sqlRoleOidVerified','providerKeyCurrentVerified','providerSqlRoleVerified','privilegeIntervalHeld'] as const)assert.equal(e[flag],false);
  assert.equal(JSON.stringify(auth),'{}');assert.equal(JSON.stringify(e).includes(f.token),false);
  assert.equal(auth.headers().Authorization,'Bearer '+f.token);assert.ok(auth.remainingMs()>0&&auth.remainingMs()<=300000);
 }
});

test('forged/wrong key, claims, future/expired or overlong tokens and symmetric/URL/private-key substitutions refuse before HTTP',()=>{
 for(const claims of [{iss:'https://other.supabase.co/auth/v1'},{aud:'other'},{aud:['authenticated','other']},{sub:'22222222-2222-4222-8222-222222222222'},
  {role:'other_reader'},{role:'service_role'},{iat:Math.floor(Date.now()/1000)+100},{nbf:Math.floor(Date.now()/1000)+100},{exp:Math.floor(Date.now()/1000)-1},
  {exp:Math.floor(Date.now()/1000)+601},{email:'synthetic-private@example.invalid'}]){
  const f=fixture('ES256',claims);assert.throws(()=>new SupabaseCaptureJwt(f.authentication,f.token,project),/JWT is unresolved/);
 }
 const f=fixture(),wrongKey={...f.authentication,verificationKey:{...other.publicKey.export({format:'jwk'}),alg:'ES256',kid:'synthetic-capture-key',use:'sig'}};
 assert.throws(()=>new SupabaseCaptureJwt(wrongKey,f.token,project));
 for(const keyChange of [{d:'synthetic-private-key'},{jku:'https://untrusted.invalid/key'},{alg:'HS256'},{kid:'other-key'}])assert.throws(()=>new SupabaseCaptureJwt({...f.authentication,verificationKey:{...f.authentication.verificationKey,...keyChange}},f.token,project));
 for(const token of [f.token+'=',f.token.slice(0,-12)+'a'.repeat(12),'a'.repeat(8193),jwt.sign(f.claims,'synthetic-hmac-only',{algorithm:'HS256',header:{alg:'HS256',typ:'JWT',kid:'synthetic-capture-key'}})])assert.throws(()=>new SupabaseCaptureJwt(f.authentication,token,project));
 let calls=0;assert.throws(()=>new SupabaseRecoveryCapture({...f.configuration,credential:{...f.configuration.credential,sha256:'0'.repeat(64)}},f.token,async()=>{calls++;return Response.json([]);}));assert.equal(calls,0);
});

test('valid signatures with duplicate JSON fields, non-canonical encoding or key discovery headers are refused',()=>{
 const f=fixture(),header=JSON.stringify({alg:'ES256',typ:'JWT',kid:'synthetic-capture-key'});
 for(const [h,p] of [[header,JSON.stringify(f.claims).replace('"role":', '"role":"service_role","role":')],
  [header,' '+JSON.stringify(f.claims)],[JSON.stringify({alg:'ES256',typ:'JWT',kid:'synthetic-capture-key',jku:'https://untrusted.invalid'}),JSON.stringify(f.claims)]]){
  assert.throws(()=>new SupabaseCaptureJwt(f.authentication,rawToken(h,p,f.pair.privateKey),project));
 }
});

test('JWT capture uses authenticated read transport, distinct provenance and refuses the legacy key registry',async()=>{
 const f=fixture(),t=transportFor(f.token),capture=new SupabaseRecoveryCapture(f.configuration,f.token,t.transport),digest=capture.configurationDigest();
 const {authentication,...legacyConfig}=f.configuration;const originalKey='sb_secret_'+'a'.repeat(40),legacy=new SupabaseRecoveryCapture({...legacyConfig,credential:{id:subject,sha256:hash(originalKey)}},originalKey,t.transport);
 assert.notEqual(digest,legacy.configurationDigest());assert.equal(JSON.stringify(capture).includes(f.token),false);assert.equal(JSON.stringify(legacy).includes(originalKey),false);
 assert.throws(()=>capture.assertStorageScope({installationId:'synthetic',projectRef:project,bucket:'documents',captureKeyId:subject}));
 f.configuration.authentication.sqlRole.oid='17002';assert.equal(capture.configurationDigest(),digest);
 const result=await capture.capture(async(_file,bytes)=>{assert.equal(bytes.toString(),'abc');});
 assert.equal(result.kind,'SUPABASE_READ_ROLE_CANDIDATE_CAPTURE_V1');assert.equal(result.credentialCapability,'ASYMMETRIC_CUSTOM_ROLE_JWT');
 assert.equal(result.jwtVerification?.signatureVerified,true);assert.equal(result.credentialPrivilegeVerified,false);assert.equal(result.credentialWriteAuthorityExcluded,false);
 assert.equal(JSON.stringify(result).includes(f.token),false);assert.equal(t.bodyReads(),2);assert.ok(t.requests()>2);
});

test('token expiry cancels a stalled visitor despite a frozen wall clock and zeros exposed bytes',{timeout:4000},async(t)=>{
 const now=Date.now();t.mock.method(Date,'now',()=>now);const f=fixture('ES256',{exp:Math.floor(now/1000)+1}),io=transportFor(f.token);
 const capture=new SupabaseRecoveryCapture(f.configuration,f.token,io.transport);let held:Buffer|undefined;
 await assert.rejects(capture.capture(async(_file,bytes)=>{held=bytes;await new Promise(()=>{});}));
 assert.ok(held);assert.ok(held.every(v=>v===0));assert.equal(io.bodyReads(),1);
});

test('monotonic lifetime cannot be extended by a wall clock that stops moving',{timeout:4000},async(t)=>{
 const now=Date.now();t.mock.method(Date,'now',()=>now);const f=fixture('ES256',{exp:Math.floor(now/1000)+1}),auth=new SupabaseCaptureJwt(f.authentication,f.token,project);
 await new Promise(r=>setTimeout(r,1100));assert.throws(()=>auth.headers());assert.throws(()=>auth.evidence());
});
