import {requireProtocol9ClosedHead} from './managed-maintenance-control.js';
import {Readable} from 'node:stream';
import {z} from 'zod';
import {GetObjectCommand,PutObjectCommand,type S3Client} from '@aws-sdk/client-s3';
import {candidateHash,candidatePinSchema} from './managed-candidate-capture-contract.js';
const sha=z.string().regex(/^[a-f0-9]{64}$/),identity=z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const legacyManagedPlanSchema=z.object({format:z.literal(9),installationId:identity,sourceSha:z.string().regex(/^[a-f0-9]{40}$/),
 maintenanceEpoch:z.number().int().positive().max(2147483647),databaseCredentialPolicy:z.literal('PASSWORD_NULL_WHILE_CLOSED'),
 storageCredentialPolicy:z.literal('REVOKE_REVIEWED_KEYS_KEEP_CAPTURE_V1'),readProofPolicy:z.literal('INDEPENDENT_BASELINE_BEFORE_CREDENTIAL_REVOCATION_V1'),
 writeProofPolicy:z.literal('EXACT_VERSION_BASELINE_PIN_BEFORE_REVOCATION_V1'),signedProofPolicy:z.literal('ORIGINAL_ENCRYPTED_TOKEN_AND_BASELINE_PIN_BEFORE_REVOCATION_V1'),
 resumableProofPolicy:z.literal('ALL_CONFIGURED_ORIGINAL_TUS_MANIFEST_BEFORE_REVOCATION_V1'),signedResumableProofPolicy:z.literal('ORIGINAL_SIGNED_TUS_BASELINE_PIN_BEFORE_REVOCATION_V1'),
 s3ProofPolicy:z.literal('EXPLICIT_MODE_ORIGINAL_S3_BASELINE_BEFORE_CLOSURE_V1'),provider:sha,database:sha,storage:sha,readProof:sha,writeProof:sha,
 signedProof:sha,resumableProof:sha,signedResumableProof:sha,s3Proof:sha}).strict();
const readRolePlan=legacyManagedPlanSchema.extend({format:z.literal(10),
 capturePolicy:z.literal('EXPLICIT_JWT_SQL_PRIVILEGE_AND_METADATA_WINDOW_V1'),captureAuthorization:sha}).strict();
export const managedPlanSchema=z.discriminatedUnion('format',[legacyManagedPlanSchema,readRolePlan,
 readRolePlan.extend({format:z.literal(11),storageCredentialPolicy:z.literal('REVOKE_REVIEWED_KEYS_THEN_RETIRE_CAPTURE_CONTROL_V1'),
 captureControlRetirement:sha}).strict(),
 readRolePlan.extend({format:z.literal(12),storageCredentialPolicy:z.literal('REVOKE_KEYS_RETIRE_CONTROL_WITH_CANARY_READ_COMPARISON_V2'),
 captureControlRetirement:sha,captureControlReadComparison:sha}).strict()]);
const closed=z.object({revision:sha,value:z.object({installationId:identity,maintenanceEpoch:z.number().int().positive().max(2147483647),
 planDigest:sha,phase:z.literal('OBSERVED_CLOSED'),attemptId:z.string().uuid()})});
export type ManagedClosedHead=z.infer<typeof closed>;
export function managedClosedHead(raw:unknown,installationId:string){
 const head=closed.parse(requireProtocol9ClosedHead(raw));if(head.value.installationId!==installationId)throw failure();return head;
}
const failure=()=>new Error('Managed plan bootstrap is unresolved; preserve original records without execution or ACK reconstruction');
type Storage={installationId:string;bucket:string;accountId:string;kmsKeyArn:string};
/** Declarative plan preimage, cryptographically matched to a separately trusted
 * live head. No policy decision, head write, epoch transition or execution lease. */
export class ManagedPlanBootstrap {
 private readonly attempted=new Set<string>();
 constructor(private readonly storage:Storage,private readonly client:S3Client){}
 private request(head:ManagedClosedHead){return{Bucket:this.storage.bucket,ExpectedBucketOwner:this.storage.accountId,
  Key:`managed-maintenance/${this.storage.installationId}/${head.value.attemptId}/plan-bootstrap.json`};}
 private plan(body:string,head:ManagedClosedHead){
  if(Buffer.byteLength(body)>8192||candidateHash(body)!==head.value.planDigest)throw failure();
  const raw=JSON.parse(body),plan=managedPlanSchema.parse(raw);
  if(JSON.stringify(raw)!==body||plan.installationId!==this.storage.installationId||plan.maintenanceEpoch!==head.value.maintenanceEpoch)throw failure();
  return plan;
 }
 private async read(head:ManagedClosedHead,version:string|undefined,caller?:AbortSignal){
  const controller=new AbortController(),signal=caller?AbortSignal.any([caller,controller.signal]):controller.signal;
  const timer=setTimeout(()=>controller.abort(),15000);let stream:Readable|undefined;
  const stop=()=>stream?.destroy(failure());signal.addEventListener('abort',stop,{once:true});
  try{
   signal.throwIfAborted();let reject:()=>void=()=>{};
   const cancelled=new Promise<never>((_,r)=>{reject=()=>r(failure());signal.addEventListener('abort',reject,{once:true});});
   try{
    const pending=this.client.send(new GetObjectCommand({...this.request(head),ChecksumMode:'ENABLED',...(version?{VersionId:version}:{})}),{abortSignal:signal}).then(value=>{
     if(signal.aborted){if(value.Body instanceof Readable)value.Body.destroy();throw failure();}return value;});
    const value=await Promise.race([pending,cancelled]);if(value.Body instanceof Readable)stream=value.Body;
    if(!stream||value.DeleteMarker||value.ServerSideEncryption!=='aws:kms'||value.SSEKMSKeyId!==this.storage.kmsKeyArn
     ||value.ChecksumSHA256!==Buffer.from(head.value.planDigest,'hex').toString('base64')||(value.ChecksumType&&value.ChecksumType!=='FULL_OBJECT')
     ||!Number.isInteger(value.ContentLength)||value.ContentLength!<1||value.ContentLength!>8192)throw failure();
    const pin=candidatePinSchema.parse({kind:'BASELINE',versionId:value.VersionId,sha256:head.value.planDigest,byteLength:value.ContentLength});
    if(version!==undefined&&pin.versionId!==version)throw failure();
    const chunks:Buffer[]=[];let count=0;
    for await(const chunk of stream){signal.throwIfAborted();if(!(chunk instanceof Uint8Array))throw failure();count+=chunk.byteLength;
     if(count>8192||count>pin.byteLength)throw failure();chunks.push(Buffer.from(chunk));}
    if(count!==pin.byteLength)throw failure();const body=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
    return{pin,body,plan:this.plan(body,head)};
   }finally{signal.removeEventListener('abort',reject);}
  }catch{throw failure();}finally{clearTimeout(timer);signal.removeEventListener('abort',stop);stream?.destroy();controller.abort();}
 }
 async observe(rawHead:unknown,caller?:AbortSignal){
  try{
   const head=managedClosedHead(rawHead,this.storage.installationId),first=await this.read(head,undefined,caller);
   const exact=await this.read(head,first.pin.versionId,caller);if(exact.body!==first.body)throw failure();
   return{pin:exact.pin,plan:exact.plan,descriptorPlanDigestMatched:true as const,originalAcknowledgementReconstructed:false as const,
    savedObservationAuthorizesExecution:false as const,actionAuthorized:false as const};
  }catch{throw failure();}
 }
 async publish(rawPlan:unknown,rawHead:unknown,caller?:AbortSignal){
  const head=managedClosedHead(rawHead,this.storage.installationId);if(this.attempted.has(head.value.attemptId))throw failure();
  this.attempted.add(head.value.attemptId);const body=JSON.stringify(managedPlanSchema.parse(rawPlan));this.plan(body,head);
  const controller=new AbortController(),signal=caller?AbortSignal.any([caller,controller.signal]):controller.signal;
  const timer=setTimeout(()=>controller.abort(),15000);let stop:()=>void=()=>{};
  try{
   signal.throwIfAborted();const cancelled=new Promise<never>((_,reject)=>{stop=()=>reject(failure());signal.addEventListener('abort',stop,{once:true});});
   const value=await Promise.race([this.client.send(new PutObjectCommand({...this.request(head),IfNoneMatch:'*',Body:body,ContentType:'application/json',
    ServerSideEncryption:'aws:kms',SSEKMSKeyId:this.storage.kmsKeyArn,ChecksumSHA256:Buffer.from(head.value.planDigest,'hex').toString('base64')}),{abortSignal:signal}),cancelled]);
   if(signal.aborted||value.ServerSideEncryption!=='aws:kms'||value.SSEKMSKeyId!==this.storage.kmsKeyArn)throw failure();
   const pin=candidatePinSchema.parse({kind:'BASELINE',versionId:value.VersionId,sha256:head.value.planDigest,byteLength:Buffer.byteLength(body)});
   const exact=await this.read(head,pin.versionId,signal);if(exact.body!==body)throw failure();
   return{pin,publicationAcknowledged:true as const,originalAcknowledgementReconstructed:false as const,actionAuthorized:false as const};
  }catch{throw failure();}finally{clearTimeout(timer);signal.removeEventListener('abort',stop);controller.abort();}
 }
}
