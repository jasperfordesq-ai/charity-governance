import {createHash} from 'node:crypto';
import {z} from 'zod';
import {SupabaseRecoveryCapture} from './supabase-recovery-capture.js';
import {supabaseCaptureJwtConfiguration} from './supabase-capture-jwt.js';

const sha=z.string().regex(/^[a-f0-9]{64}$/),uuid=z.string().uuid().refine(v=>v===v.toLowerCase());
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const canarySchema=z.object({fileUrl:z.string().min(1).max(2048),bytes:z.number().int().min(1).max(1024),sha256:sha}).strict();
const configuration=z.object({installationId:z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),projectRef:z.string().regex(/^[a-z0-9]{20}$/),
 bucket:z.literal('charitypilot-recovery-canaries'),canary:canarySchema,retiredControl:z.object({id:uuid,sha256:sha}).strict(),
 readRole:z.object({subject:uuid,sqlRole:supabaseCaptureJwtConfiguration.shape.sqlRole,configurationDigest:sha}).strict()}).strict()
 .refine(v=>v.canary.fileUrl.startsWith('charitypilot-recovery-canary/'+v.installationId+'/')&&v.canary.fileUrl.split('/').length<=32
  &&v.canary.fileUrl.split('/').every(p=>p.length>0&&p.length<=255&&p!=='.'&&p!=='..'&&!/[\x00-\x1f\x7f\\%]/.test(p)));
const baselineSchema=z.object({format:z.literal(1),kind:z.literal('SUPABASE_RETIRED_CONTROL_READ_BASELINE_V1'),configurationDigest:sha,
 capturedAt:z.string().datetime(),canarySha256:sha,bytes:z.number().int().min(1).max(1024),retiredControlId:uuid,
 positiveControl:z.literal('VERIFIED_CUSTOM_ROLE_JWT'),bothConfiguredCredentialsReadCanary:z.literal(true),
 originalBaselineAcknowledgementVerified:z.literal(false),actionAuthorized:z.literal(false)}).strict();
const artifact=(value:unknown)=>{const body=JSON.stringify(value);return{body,sha256:hash(body),byteLength:Buffer.byteLength(body)};};
const failure=()=>new Error('Retired control read comparison is unverified');

/** GET-only synthetic canary comparison. No durable ACK, key deletion, SQL
 * privilege window, provider-current signer or whole-project revocation proof. */
export class SupabaseRetiredControlReadProof {
 readonly #config:z.infer<typeof configuration>;
 readonly #secret:string;
 readonly #positive:SupabaseRecoveryCapture;
 readonly #legacy:SupabaseRecoveryCapture;
 readonly #transport:typeof fetch;
 constructor(raw:unknown,secret:string,positive:SupabaseRecoveryCapture,transport:typeof fetch=fetch){
  try{
   this.#config=configuration.parse(raw);this.#secret=secret;this.#positive=positive;this.#transport=transport;
   if(typeof secret!=='string'||!/^sb_secret_[A-Za-z0-9_-]{16,512}$/.test(secret)||hash(secret)!==this.#config.retiredControl.sha256)throw failure();
   this.#legacy=new SupabaseRecoveryCapture({installationId:this.#config.installationId,projectRef:this.#config.projectRef,
    bucket:this.#config.bucket,credential:this.#config.retiredControl},secret,transport);this.assertComponents();
  }catch{throw failure();}
 }
 private assertComponents(){const c=this.#config;
  if(this.#positive.configurationDigest()!==c.readRole.configurationDigest)throw failure();
  this.#positive.assertConfiguredReadRoleScope({installationId:c.installationId,projectRef:c.projectRef,bucket:c.bucket,
   subject:c.readRole.subject,sqlRole:c.readRole.sqlRole});
 }
 configurationDigest(){this.assertComponents();return hash(JSON.stringify({format:1,policy:'RETIRED_CONTROL_CANARY_GET_WITH_CUSTOM_JWT_POSITIVE_V1',...this.#config}));}
 assertRetirementKeyScope(raw:unknown){const v=z.object({installationId:z.string(),projectRef:z.string(),captureKeyId:uuid}).strict().parse(raw);
  if(v.installationId!==this.#config.installationId||v.projectRef!==this.#config.projectRef||v.captureKeyId!==this.#config.retiredControl.id)throw failure();this.assertComponents();}
 private async work<T>(run:(signal:AbortSignal)=>Promise<T>,caller?:AbortSignal){
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,stop=()=>{};
  try{
   if(caller!==undefined&&!(caller instanceof AbortSignal))throw failure();this.assertComponents();
   const signal=caller?AbortSignal.any([controller.signal,caller]):controller.signal;signal.throwIfAborted();
   timer=setTimeout(()=>controller.abort(),Math.min(45000,this.#positive.readRoleRemainingMs()));
   const cancelled=new Promise<never>((_,reject)=>{stop=()=>reject(failure());signal.addEventListener('abort',stop,{once:true});});
   try{const result=await Promise.race([run(signal),cancelled]);signal.throwIfAborted();this.assertComponents();this.#positive.readRoleRemainingMs();return result;}
   finally{signal.removeEventListener('abort',stop);}
  }catch{throw failure();}finally{if(timer)clearTimeout(timer);controller.abort();}
 }
 private async positive(signal:AbortSignal){
  await this.#positive.readRecoveryCanary(this.#config.canary,signal);
  return this.#positive.readRoleVerificationEvidence();
 }
 async baseline(caller?:AbortSignal){return this.work(async signal=>{
  await this.positive(signal);await this.#legacy.readRecoveryCanary(this.#config.canary,signal);await this.positive(signal);
  return artifact(baselineSchema.parse({format:1,kind:'SUPABASE_RETIRED_CONTROL_READ_BASELINE_V1',configurationDigest:this.configurationDigest(),
   capturedAt:new Date().toISOString(),canarySha256:this.#config.canary.sha256,bytes:this.#config.canary.bytes,retiredControlId:this.#config.retiredControl.id,
   positiveControl:'VERIFIED_CUSTOM_ROLE_JWT',bothConfiguredCredentialsReadCanary:true,originalBaselineAcknowledgementVerified:false,actionAuthorized:false}));
 },caller);}
 assertBaseline(body:string,expectedSha256:string){
  try{
   if(typeof body!=='string'||Buffer.byteLength(body)>4096||!sha.safeParse(expectedSha256).success||hash(body)!==expectedSha256)throw failure();
   const v=baselineSchema.parse(JSON.parse(body)),c=this.#config;
   if(JSON.stringify(v)!==body||v.configurationDigest!==this.configurationDigest()||v.canarySha256!==c.canary.sha256
    ||v.bytes!==c.canary.bytes||v.retiredControlId!==c.retiredControl.id||Date.parse(v.capturedAt)>Date.now()+60000)throw failure();return v;
  }catch{throw failure();}
 }
 private async denied(signal:AbortSignal){
  const c=this.#config,path=c.canary.fileUrl.split('/').map(encodeURIComponent).join('/');signal.throwIfAborted();
  const response=await this.#transport(`https://${c.projectRef}.supabase.co/storage/v1/object/${c.bucket}/${path}`,{
   method:'GET',redirect:'error',credentials:'omit',signal,headers:{apikey:this.#secret,Accept:'text/plain','Accept-Encoding':'identity','Cache-Control':'no-cache, no-store'}});
  // Never inspect private provider error bodies. Abort/caller expiry also
  // cancels the underlying request; a late response cannot count as refusal.
  void response.body?.cancel().catch(()=>{});signal.throwIfAborted();
  if(response.status!==401&&response.status!==403)throw failure();return response.status as 401|403;
 }
 async verifyRefusal(body:string,expectedSha256:string,caller?:AbortSignal){return this.work(async signal=>{
  this.assertBaseline(body,expectedSha256);const startedAt=new Date().toISOString(),before=await this.positive(signal);
  const status=await this.denied(signal),after=await this.positive(signal);
  if(JSON.stringify(before)!==JSON.stringify(after))throw failure();
  const facts={format:1,kind:'SUPABASE_RETIRED_CONTROL_CANARY_READ_REFUSAL_V1',configurationDigest:this.configurationDigest(),
   baselineSha256:expectedSha256,retiredControlId:this.#config.retiredControl.id,canarySha256:this.#config.canary.sha256,
   bytes:this.#config.canary.bytes,status,startedAt,observedAt:new Date().toISOString(),positiveJwt:after};
  return{...facts,observationDigest:hash(JSON.stringify(facts)),coverage:'EXACT_SYNTHETIC_CANARY_GET_ONLY' as const,
   positiveReadRoleCanaryReadsMatched:true as const,retiredControlCanaryGetRefusalObserved:true as const,
   originalBaselineAcknowledgementVerified:false as const,credentialRevocationProven:false as const,writeRejectionVerified:false as const,
   providerKeyCurrentVerified:false as const,sqlPrivilegeWindowHeld:false as const,unfilteredVisibilityVerified:false as const,
   wholeStorageQuiesced:false as const,actionAuthorized:false as const};
 },caller);}
}
