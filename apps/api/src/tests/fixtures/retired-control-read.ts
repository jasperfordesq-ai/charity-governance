import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash} from 'node:crypto';
import jwt from 'jsonwebtoken';
import {SupabaseRecoveryCapture} from '../../services/supabase-recovery-capture.js';
import {SupabaseRetiredControlReadProof} from '../../services/supabase-retired-control-read-proof.js';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex'),pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
export function retiredControlReadFixture(options:{installationId?:string;controlId?:string}={}){
 const installationId=options.installationId??'synthetic',projectRef='abcdefghijklmnopqrst',bucket='charitypilot-recovery-canaries',subject='11111111-1111-4111-8111-111111111111';
 const authentication={kind:'SUPABASE_CAPTURE_CUSTOM_ROLE_JWT_V1',sqlRole:{name:'storage_capture_reader',oid:'17001'},subject,
  verificationKey:{...pair.publicKey.export({format:'jwk'}),alg:'ES256',kid:'synthetic-key',use:'sig'}};
 const now=Math.floor(Date.now()/1000),token=jwt.sign({iss:`https://${projectRef}.supabase.co/auth/v1`,aud:'authenticated',sub:subject,
  role:authentication.sqlRole.name,iat:now,exp:now+300},pair.privateKey,{algorithm:'ES256',header:{alg:'ES256',typ:'JWT',kid:'synthetic-key'}});
 const secret='sb_secret_'+'x'.repeat(40),body='Synthetic retirement canary. No personal data.\n';
 const canary={fileUrl:'charitypilot-recovery-canary/'+installationId+'/control.txt',bytes:Buffer.byteLength(body),sha256:hash(body)};
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
 const config={installationId,projectRef,bucket,canary,retiredControl:{id:options.controlId??'22222222-2222-4222-8222-222222222222',sha256:hash(secret)},
  readRole:{subject,sqlRole:authentication.sqlRole,configurationDigest:positive.configurationDigest()}};
 const create=(raw:unknown=config,reader=positive)=>new SupabaseRetiredControlReadProof(raw,secret,reader,transport);
 return{state,create,config,positive,captureConfig,token,secret,transport};
}
