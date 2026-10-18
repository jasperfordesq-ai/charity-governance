import {z} from 'zod';
import {randomBytes} from 'node:crypto';
import {ListObjectsV2Command,S3Client,type S3ClientConfig} from '@aws-sdk/client-s3';
import {candidateHash,candidatePinSchema} from './managed-candidate-capture-contract.js';
import {commonCandidateBindingSchema} from './managed-common-candidate-contract.js';
import {localJobArtifact,localJobArtifactSchema,parseJobRequest,parseJobService,assertJobServicePair} from './managed-proof-job-contract.js';
import {S3MaintenanceArtifactStore} from './maintenance-artifact-store.js';
import {managedMaintenanceStorageConfigurationSchema} from './managed-maintenance-control.js';
const sha=z.string().regex(/^[a-f0-9]{64}$/),image=z.string().regex(/^postgres@sha256:[a-f0-9]{64}$/);
const uuid=z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const header=z.object({format:z.literal(2),kind:z.literal('MANAGED_DAEMON_REQUEST_HEADER_V2'),jobId:uuid,inputDigest:sha,image,
 imageVolumeTargets:z.tuple([z.literal('/var/lib/postgresql/data')])}).strict();
const mount=z.union([
 z.object({target:z.literal('/var/lib/postgresql/data'),type:z.literal('tmpfs'),readOnly:z.literal(false),tmpfsOptions:z.enum(['rw,noexec,nosuid,size=1m','rw,noexec,nosuid,size=4g'])}).strict(),
 z.object({target:z.enum(['/proof','/backup','/run/charitypilot/database-ca.pem']),type:z.literal('bind'),readOnly:z.boolean(),sourceDigest:sha}).strict()
  .refine(v=>v.target==='/proof'||v.readOnly),
]);
const plan=z.object({format:z.literal(2),kind:z.literal('MANAGED_PROOF_STORAGE_PLAN_V2'),image,mounts:z.array(mount).min(1).max(4),declaredImageVolumesCovered:z.literal(true)}).strict()
 .refine(v=>new Set(v.mounts.map(m=>m.target)).size===v.mounts.length&&v.mounts.some(m=>m.target==='/var/lib/postgresql/data'));
const intent=z.object({format:z.literal(2),kind:z.literal('MANAGED_DAEMON_REQUEST_INTENT_V2'),jobId:uuid,sequence:z.number().int().min(1).max(64),previousDigest:sha,
 operation:z.enum(['run','exec','rm']),target:z.string().regex(/^(?:[a-f0-9]{64}|charitypilot-(?:source-snapshot|dump-descriptor|isolated-restore|restore-loader|restored-snapshot)-[0-9]+-[0-9]+-[a-f0-9]{8})$/),
 storagePlan:plan.nullable(),argumentsDigest:sha}).strict().refine(v=>v.operation==='run'?v.storagePlan!==null:v.storagePlan===null);
const envelope=z.object({format:z.literal(1),kind:z.enum(['MANAGED_DAEMON_CUSTODY_HEADER_V1','MANAGED_DAEMON_CUSTODY_INTENT_V1']),bindingDigest:sha,
 jobRequestPin:candidatePinSchema,jobServicePin:candidatePinSchema,headerCustodyPin:candidatePinSchema.nullable(),localRecord:localJobArtifactSchema,
 savedEvidenceAuthorizesDispatch:z.literal(false),actionAuthorized:z.literal(false)}).strict();
const failure=()=>new Error('Managed daemon intent custody unresolved; preserve original job without dispatch or replay');
const response=z.object({format:z.literal(1),kind:z.literal('MANAGED_DAEMON_CLIENT_RESPONSE_V1'),jobId:uuid,
 sequence:z.number().int().min(1).max(64),intentPin:z.object({sha256:sha,byteLength:z.number().int().min(1).max(8192)}).strict(),
 status:z.number().int().safe().nullable(),transportError:z.boolean(),signal:z.boolean(),removalAlreadyAbsent:z.boolean()}).strict();
const responseEnvelope=envelope.extend({kind:z.literal('MANAGED_DAEMON_CUSTODY_RESPONSE_V1'),baselineCustodyPin:candidatePinSchema,
 pendingRequestResolved:z.literal(false)}).strict();
const end=z.object({format:z.literal(1),kind:z.literal('MANAGED_DAEMON_REQUEST_END_V1'),jobId:uuid,
 headerPin:response.shape.intentPin,requestCount:z.number().int().min(0).max(64),lastIntentDigest:sha}).strict();
const endEnvelope=responseEnvelope.extend({kind:z.literal('MANAGED_DAEMON_CUSTODY_END_V1')}).strict();
const owner=z.object({format:z.literal(1),kind:z.literal('MANAGED_DAEMON_REQUEST_OWNER_V1'),jobId:uuid,
 sequence:z.number().int().min(1).max(64),intentPin:response.shape.intentPin,
 identity:z.object({ownerId:uuid,unit:z.string().max(100),invocationId:z.string().regex(/^[a-f0-9]{32}$/),
  uid:z.number().int().min(1).max(2147483647),mainPid:z.number().int().min(1).max(2147483647),
  mainStartMonotonic:z.string().regex(/^[1-9][0-9]{0,19}$/),sourceSha:z.string().regex(/^[a-f0-9]{40}$/),inputDigest:sha,
  bootId:z.string().regex(/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/),controlGroup:z.string().max(1024)}).strict()
}).strict();
const ownerEnvelope=envelope.extend({kind:z.literal('MANAGED_DAEMON_OWNER_CUSTODY_V1'),intentCustodyPin:candidatePinSchema,
 independentOwnerDispatchVerified:z.literal(false)}).strict();
const outputDigest=z.object({sha256:sha,byteLength:z.number().int().safe().min(0)}).strict().refine(v=>v.byteLength!==0||v.sha256===candidateHash(''));
const ownerOutcome=response.extend({kind:z.literal('MANAGED_DAEMON_OWNER_OUTCOME_V1'),ownerPin:response.shape.intentPin,
 ownerInputDigest:sha,stdout:outputDigest,stderr:outputDigest}).strict();
const ownerOutcomeEnvelope=ownerEnvelope.extend({kind:z.literal('MANAGED_DAEMON_OWNER_OUTCOME_CUSTODY_V1'),ownerCustodyPin:candidatePinSchema,
 localIntent:localJobArtifactSchema,pendingRequestResolved:z.literal(false)}).strict();
type Pin=z.infer<typeof candidatePinSchema>;
type Artifact={body:string;sha256:string};
const transferArtifact=z.object({body:z.string().min(1).max(16384),sha256:sha}).strict();
const transferCredential=z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/);
const ownerTransfer=z.object({format:z.literal(1),kind:z.literal('ORIGINAL_DAEMON_OUTCOME_TRANSFER_V1'),nonce:sha,
 issuedMonotonicNs:z.string().regex(/^[0-9]{1,24}$/),expiresMonotonicNs:z.string().regex(/^[0-9]{1,24}$/),
 storage:managedMaintenanceStorageConfigurationSchema,binding:commonCandidateBindingSchema,
 requestArtifact:transferArtifact,requestPin:candidatePinSchema,serviceArtifact:transferArtifact,servicePin:candidatePinSchema,
 headerPin:candidatePinSchema,intentPin:candidatePinSchema,ownerPin:candidatePinSchema,localIntent:localJobArtifactSchema,
 credentials:z.object({accessKeyId:transferCredential.max(128),secretAccessKey:transferCredential.max(256),sessionToken:transferCredential.optional()}).strict(),
}).strict();
const transferActive=(value:z.infer<typeof ownerTransfer>)=>{
 const now=process.hrtime.bigint(),issued=BigInt(value.issuedMonotonicNs),expires=BigInt(value.expiresMonotonicNs);
 return issued<=now&&expires-issued===120000000000n&&now<expires;
};
async function boundedTransfer<T>(work:Promise<T>,signal:AbortSignal){
 let stop=()=>{};
 const cancelled=new Promise<never>((_,reject)=>{stop=()=>reject(failure());signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();});
 try{return await Promise.race([work,cancelled]);}finally{signal.removeEventListener('abort',stop);}
}
export const daemonCustodyScope=(candidateId:string,sequence:number)=>{
 z.string().uuid().parse(candidateId);z.number().int().min(0).max(64).parse(sequence);
 return candidateHash('CHARITYPILOT_DAEMON_INTENT_CUSTODY_V1\n'+candidateId+'\n'+sequence);
};
export const daemonOwnerCustodyScope=(candidateId:string,sequence:number)=>{
 z.string().uuid().parse(candidateId);z.number().int().min(1).max(64).parse(sequence);
 return candidateHash('CHARITYPILOT_DAEMON_OWNER_CUSTODY_V1\n'+candidateId+'\n'+sequence);
};

/** Original write-ACK component only. Saved evidence is not a dispatch lease,
 * daemon response, resource inventory, cancellation fence or recovery grant. */
export class ManagedDaemonIntentCustody{
 private readonly binding;private readonly request;private readonly service;
 private headerAttempted=false;private failed=false;private busy=false;private savedHeader:Pin|undefined;
 private previous:string|undefined;private sequence=0;
 private latestIntent:Pin|undefined;private readonly responseAttempts=new Set<number>();
 private responseCount=0;private endAttempted=false;private uncertainResponse=false;
 private readonly ownerAttempts=new Set<number>();
 private readonly acknowledgedOwners=new Map<number,{pin:Pin;localIntent:z.infer<typeof localJobArtifactSchema>}>();
 private readonly outcomeGrantAttempts=new Set<number>();
 constructor(private readonly storage:{installationId:string;bucket:string;accountId:string;kmsKeyArn:string},binding:unknown,
  private readonly credentials:NonNullable<S3ClientConfig['credentials']>,private readonly client:S3Client,
  private readonly requestArtifact:Artifact,private readonly requestPin:Pin,private readonly serviceArtifact:Artifact,private readonly servicePin:Pin,
  private readonly live:()=>boolean){
  this.binding=commonCandidateBindingSchema.parse(binding);this.request=parseJobRequest(this.binding,requestArtifact);this.service=parseJobService(this.binding,serviceArtifact);
  assertJobServicePair(this.binding,requestArtifact,serviceArtifact);
  if(this.binding.installationId!==storage.installationId||this.service.local.identity.format!==2)throw failure();
  for(const [pin,artifact] of [[requestPin,requestArtifact],[servicePin,serviceArtifact]] as const){
   candidatePinSchema.parse(pin);if(pin.kind!=='BASELINE'||pin.sha256!==candidateHash(artifact.body)||pin.byteLength!==Buffer.byteLength(artifact.body))throw failure();
  }
  if(JSON.stringify(this.service.value.jobRequestPin)!==JSON.stringify(requestPin))throw failure();
  this.storage={...storage};this.requestPin=candidatePinSchema.parse(requestPin);this.servicePin=candidatePinSchema.parse(servicePin);
  this.requestArtifact={body:requestArtifact.body,sha256:requestArtifact.sha256};this.serviceArtifact={body:serviceArtifact.body,sha256:serviceArtifact.sha256};
 }
 private checked(raw:unknown,sequence:number){
  const record=localJobArtifact(raw),value=sequence===0?header.parse(JSON.parse(record.body)):intent.parse(JSON.parse(record.body));
  if(value.jobId!==this.request.local.jobId)throw failure();
  if(sequence===0){if((value as z.infer<typeof header>).inputDigest!==this.service.local.identity.inputDigest)throw failure();}
  else if((value as z.infer<typeof intent>).sequence!==sequence)throw failure();
  return{record,value};
 }
 private parse(raw:unknown,sequence:number){
  const artifact=z.object({body:z.string().min(1).max(16384),sha256:sha}).strict().parse(raw);
  if(candidateHash(artifact.body)!==artifact.sha256||Buffer.byteLength(artifact.body)>16384)throw failure();
  const value=envelope.parse(JSON.parse(artifact.body));
  if(value.kind!==(sequence===0?'MANAGED_DAEMON_CUSTODY_HEADER_V1':'MANAGED_DAEMON_CUSTODY_INTENT_V1')
   ||value.bindingDigest!==candidateHash(JSON.stringify(this.binding))||JSON.stringify(value.jobRequestPin)!==JSON.stringify(this.requestPin)
   ||JSON.stringify(value.jobServicePin)!==JSON.stringify(this.servicePin)||(sequence===0)!==(value.headerCustodyPin===null))throw failure();
  this.checked(value.localRecord,sequence);return{artifact,value};
 }
 private store(sequence:number){return new S3MaintenanceArtifactStore({...this.storage,maintenance:{attemptId:this.binding.attemptId,planDigest:this.binding.planDigest,
  sourceSha:this.binding.sourceSha,maintenanceEpoch:this.binding.maintenanceEpoch}},this.credentials,
  {namespace:'capture-job',scopeDigest:daemonCustodyScope(this.binding.candidateId,sequence),pinSchema:candidatePinSchema,limits:{BASELINE:16384,OBSERVATION:16384},failure,
   baseline:raw=>this.parse(raw,sequence).artifact,parseObservation:raw=>sequence===0?this.parseEnd(raw).artifact:this.parseResponse(raw,sequence).artifact,
   observationFromValue:raw=>sequence===0?this.parseEnd(raw).artifact:this.parseResponse(raw,sequence).artifact,
   assertPair:(baseline,observation)=>sequence===0?this.assertEndPair(baseline,observation):this.assertResponsePair(baseline,observation,sequence)},this.client);}
 private checkedOwner(raw:unknown,sequence:number){
  const record=localJobArtifact(raw),value=owner.parse(JSON.parse(record.body)),v=value.identity,s=this.service.local.identity;
  if(s.format!==2||value.jobId!==this.request.local.jobId||value.sequence!==sequence||v.sourceSha!==this.binding.sourceSha
   ||v.uid!==s.uid||v.bootId!==s.bootId||v.ownerId===s.jobId||v.mainPid===s.mainPid||v.invocationId===s.invocationId
   ||v.unit!==`charitypilot-containment-${v.ownerId}.service`||v.controlGroup===s.controlGroup||v.controlGroup.startsWith(s.controlGroup+'/')||s.controlGroup.startsWith(v.controlGroup+'/')
   ||!v.controlGroup.startsWith(`/user.slice/user-${v.uid}.slice/user@${v.uid}.service/`)||!v.controlGroup.endsWith('/'+v.unit)
   ||!v.controlGroup.slice(1).split('/').every(p=>p!=='.'&&p!=='..'&&/^[A-Za-z0-9_.@:-]+$/.test(p)))throw failure();
  return{record,value};
 }
 private parseOwner(raw:unknown,sequence:number){
  const artifact=z.object({body:z.string().min(1).max(16384),sha256:sha}).strict().parse(raw);
  if(candidateHash(artifact.body)!==artifact.sha256||Buffer.byteLength(artifact.body)>16384)throw failure();
  const value=ownerEnvelope.parse(JSON.parse(artifact.body));
  if(value.bindingDigest!==candidateHash(JSON.stringify(this.binding))||JSON.stringify(value.jobRequestPin)!==JSON.stringify(this.requestPin)
   ||JSON.stringify(value.jobServicePin)!==JSON.stringify(this.servicePin)||value.headerCustodyPin?.kind!=='BASELINE'||value.intentCustodyPin.kind!=='BASELINE')throw failure();
  const local=this.checkedOwner(value.localRecord,sequence);return{artifact,value,local:local.value};
 }
 private ownerStore(sequence:number){return new S3MaintenanceArtifactStore({...this.storage,maintenance:{attemptId:this.binding.attemptId,planDigest:this.binding.planDigest,
  sourceSha:this.binding.sourceSha,maintenanceEpoch:this.binding.maintenanceEpoch}},this.credentials,
  {namespace:'capture-job',scopeDigest:daemonOwnerCustodyScope(this.binding.candidateId,sequence),pinSchema:candidatePinSchema,limits:{BASELINE:16384,OBSERVATION:16384},failure,
   baseline:raw=>this.parseOwner(raw,sequence).artifact,parseObservation:raw=>this.parseOwnerOutcome(raw,sequence).artifact,
   observationFromValue:raw=>this.parseOwnerOutcome(raw,sequence).artifact,assertPair:(a,b)=>this.assertOwnerOutcomePair(a,b,sequence)},this.client);}
 private parseOwnerOutcome(raw:unknown,sequence:number){
  const artifact=z.object({body:z.string().min(1).max(16384),sha256:sha}).strict().parse(raw);
  if(candidateHash(artifact.body)!==artifact.sha256||Buffer.byteLength(artifact.body)>16384)throw failure();
  const value=ownerOutcomeEnvelope.parse(JSON.parse(artifact.body)),record=localJobArtifact(value.localRecord),local=ownerOutcome.parse(JSON.parse(record.body));
  const original=this.checked(value.localIntent,sequence);
  if(value.bindingDigest!==candidateHash(JSON.stringify(this.binding))||JSON.stringify(value.jobRequestPin)!==JSON.stringify(this.requestPin)
   ||JSON.stringify(value.jobServicePin)!==JSON.stringify(this.servicePin)||value.headerCustodyPin?.kind!=='BASELINE'||value.intentCustodyPin.kind!=='BASELINE'
   ||value.ownerCustodyPin.kind!=='BASELINE'||local.jobId!==this.request.local.jobId||local.sequence!==sequence
   ||local.intentPin.sha256!==original.record.sha256||local.intentPin.byteLength!==original.record.byteLength
   ||local.removalAlreadyAbsent&&(intent.parse(original.value).operation!=='rm'||local.status!==1||local.transportError||local.signal))throw failure();
  return{artifact,value,local};
 }
 private assertOwnerOutcomePair(baseline:Artifact,observation:Artifact,sequence:number){
  const bound=this.parseOwner(baseline,sequence),observed=this.parseOwnerOutcome(observation,sequence);
  if(observed.value.ownerCustodyPin.sha256!==baseline.sha256||observed.value.ownerCustodyPin.byteLength!==Buffer.byteLength(baseline.body)
   ||JSON.stringify(observed.value.headerCustodyPin)!==JSON.stringify(bound.value.headerCustodyPin)
   ||JSON.stringify(observed.value.intentCustodyPin)!==JSON.stringify(bound.value.intentCustodyPin)
   ||observed.local.ownerPin.sha256!==bound.value.localRecord.sha256||observed.local.ownerPin.byteLength!==bound.value.localRecord.byteLength
   ||JSON.stringify(observed.local.intentPin)!==JSON.stringify(bound.local.intentPin)||observed.local.ownerInputDigest!==bound.local.identity.inputDigest)throw failure();
 }
 /** Process-local, one-shot evidence capability. Only original ACK state may
  * create it; saved reads cannot. It is not scoped provider IAM or dispatch. */
 createOwnerOutcomeWriter(){
  const sequence=this.sequence,ack=this.acknowledgedOwners.get(sequence);
  if(this.failed||this.busy||!this.live()||this.endAttempted||!ack||this.responseAttempts.has(sequence)||this.outcomeGrantAttempts.has(sequence))throw failure();
  this.outcomeGrantAttempts.add(sequence);const pin=candidatePinSchema.parse(ack.pin),localIntent=localJobArtifact(ack.localIntent),store=this.ownerStore(sequence);
  const expires=performance.now()+120000,controller=new AbortController();let attempted=false,revoked=false;
  return Object.freeze({revoke:()=>{revoked=true;controller.abort();this.failed=true;},publish:async(raw:unknown,caller?:AbortSignal)=>{
   if(attempted||revoked){this.failed=true;throw failure();}if(performance.now()>=expires){revoked=true;this.failed=true;throw failure();}attempted=true;
   const signal=caller?AbortSignal.any([caller,controller.signal]):controller.signal;
   try{
    const record=localJobArtifact(raw),local=ownerOutcome.parse(JSON.parse(record.body));
    if(local.sequence!==sequence)throw failure();
    const baseline=await store.observeBaseline(pin,signal),bound=this.parseOwner(baseline,sequence);
    const body=JSON.stringify(ownerOutcomeEnvelope.parse({...bound.value,kind:'MANAGED_DAEMON_OWNER_OUTCOME_CUSTODY_V1',
     ownerCustodyPin:pin,localIntent,localRecord:record,pendingRequestResolved:false}));
    if(revoked||performance.now()>=expires)throw failure();
    const saved=await store.publishObservation({body,sha256:candidateHash(body)},pin,signal);
    if(revoked||performance.now()>=expires)throw failure();
    return{pin:saved,originalAcknowledgementReconstructed:false as const,savedEvidenceAuthorizesDispatch:false as const,pendingRequestResolved:false as const,independentOwnerDispatchVerified:false as const,actionAuthorized:false as const};
   }catch{this.failed=true;throw failure();}
  }});
 }
 /** Private live-authority transfer, never a saved recovery artifact. The
  * future process adapter must authenticate its original child before claim.
  * Credentials stay on protected stdin/IPC and must never be logged or stored. */
 async createOwnerOutcomeTransfer(signal?:AbortSignal){
  const sequence=this.sequence,ack=this.acknowledgedOwners.get(sequence),issued=process.hrtime.bigint();
  try{
   if(this.failed||this.busy||!this.live()||this.endAttempted||!ack||!this.savedHeader||!this.latestIntent
    ||this.responseAttempts.has(sequence)||this.outcomeGrantAttempts.has(sequence))throw failure();
   this.outcomeGrantAttempts.add(sequence);this.busy=true;
   const expiry=AbortSignal.timeout(120000),bounded=signal?AbortSignal.any([signal,expiry]):expiry;
   const owner=await this.ownerStore(sequence).inspectCandidateArtifact('BASELINE',bounded),header=await this.inspectHeader(bounded),intent=await this.store(sequence).inspectCandidateArtifact('BASELINE',bounded);
   if(JSON.stringify(owner.pin)!==JSON.stringify(ack.pin)||JSON.stringify(header.pin)!==JSON.stringify(this.savedHeader)
    ||JSON.stringify(intent.pin)!==JSON.stringify(this.latestIntent)||!this.live()||this.failed)throw failure();
   bounded.throwIfAborted();const credential=await boundedTransfer(Promise.resolve(typeof this.credentials==='function'?this.credentials():this.credentials),bounded);
   const value=ownerTransfer.parse({format:1,kind:'ORIGINAL_DAEMON_OUTCOME_TRANSFER_V1',nonce:randomBytes(32).toString('hex'),
    issuedMonotonicNs:issued.toString(),expiresMonotonicNs:(issued+120000000000n).toString(),storage:this.storage,binding:this.binding,
    requestArtifact:this.requestArtifact,requestPin:this.requestPin,serviceArtifact:this.serviceArtifact,servicePin:this.servicePin,
    headerPin:this.savedHeader,intentPin:this.latestIntent,ownerPin:ack.pin,localIntent:ack.localIntent,
    credentials:{accessKeyId:credential.accessKeyId,secretAccessKey:credential.secretAccessKey,...(credential.sessionToken?{sessionToken:credential.sessionToken}:{})}});
   if(this.failed||!this.live()||!transferActive(value)||Buffer.byteLength(JSON.stringify(value))>65536)throw failure();this.busy=false;
   const digest=candidateHash(JSON.stringify(value));let taken=false,claimed=false,receiptAttempted=false;
   return Object.freeze({abandon:()=>{taken=true;claimed=true;this.failed=true;},take:()=>{
    if(taken||this.failed||!this.live()||!transferActive(value)){this.failed=true;throw failure();}taken=true;return structuredClone(value);
   },claim:(nonce:string,bodyDigest:string)=>{
    if(claimed)return false;claimed=true;
    if(!taken||this.failed||!this.live()||!transferActive(value)||nonce!==value.nonce||bodyDigest!==digest){this.failed=true;return false;}return true;
   },observeReceipt:async(raw:unknown,receipt:unknown,caller?:AbortSignal)=>{
    try{
     if(receiptAttempted||!claimed||!taken||this.failed||this.busy||!this.live()||!transferActive(value)
      ||this.sequence!==sequence||this.endAttempted||this.responseAttempts.has(sequence))throw failure();
     receiptAttempted=true;this.busy=true;
     const observed=z.object({pin:candidatePinSchema,originalAcknowledgementReconstructed:z.literal(false),pendingRequestResolved:z.literal(false),actionAuthorized:z.literal(false)}).strict().parse(receipt);
     if(observed.pin.kind!=='OBSERVATION')throw failure();
     const record=localJobArtifact(raw),local=ownerOutcome.parse(JSON.parse(record.body));if(local.sequence!==sequence)throw failure();
     const remaining=Math.max(1,Number((BigInt(value.expiresMonotonicNs)-process.hrtime.bigint())/1000000n));
     const expiry=AbortSignal.timeout(remaining),bounded=caller?AbortSignal.any([caller,expiry]):expiry;
     const saved=await this.inspectOwnerOutcome(sequence,JSON.parse(value.localIntent.body).previousDigest,bounded);
     if(JSON.stringify(saved.pin)!==JSON.stringify(observed.pin)||JSON.stringify(saved.localRecord)!==JSON.stringify(record)
      ||this.failed||!this.live()||!transferActive(value))throw failure();
     bounded.throwIfAborted();this.busy=false;
     return{pin:saved.pin,originalAcknowledgementReconstructed:false as const,savedEvidenceAuthorizesDispatch:false as const,
      independentOwnerDispatchVerified:false as const,pendingRequestResolved:false as const,actionAuthorized:false as const};
    }catch{receiptAttempted=true;this.failed=true;throw failure();}
   }});
  }catch{this.failed=true;throw failure();}
 }
 /** Internal receiving half. The required claim callback must contact the
  * still-live original issuer over authenticated private IPC. Reads alone,
  * stored pins or a caller-selected CLI flag cannot supply that authority. */
 static async acceptOwnerOutcomeTransfer(raw:unknown,claim:(nonce:string,bodyDigest:string,signal:AbortSignal)=>Promise<boolean>,client?:S3Client){
  let ownedClient:S3Client|undefined;
  try{
   const value=ownerTransfer.parse(raw);if(Buffer.byteLength(JSON.stringify(value))>65536||typeof claim!=='function'||!transferActive(value))throw failure();
   const remaining=()=>Math.max(1,Number((BigInt(value.expiresMonotonicNs)-process.hrtime.bigint())/1000000n));
   const expiry=AbortSignal.timeout(remaining());
   const activeClient=client??(ownedClient=new S3Client({region:'eu-west-1',endpoint:'https://s3.eu-west-1.amazonaws.com',
    credentials:value.credentials,maxAttempts:1,followRegionRedirects:false,requestHandler:{connectionTimeout:5000,requestTimeout:15000,throwOnRequestTimeout:true}}));
   const writer=new ManagedDaemonIntentCustody(value.storage,value.binding,value.credentials,activeClient,
    value.requestArtifact,value.requestPin,value.serviceArtifact,value.servicePin,()=>true);
   const local=localJobArtifact(value.localIntent),sequence=intent.parse(JSON.parse(local.body)).sequence;
   // Consume the original live claim before any provider read or write.
   if(await boundedTransfer(claim(value.nonce,candidateHash(JSON.stringify(value)),expiry),expiry)!==true||!transferActive(value))throw failure();
   const h=await writer.inspectHeader(expiry),i=await writer.inspectIntent(sequence,JSON.parse(local.body).previousDigest,expiry),o=await writer.inspectOwner(sequence,JSON.parse(local.body).previousDigest,expiry);
   if(JSON.stringify(h.pin)!==JSON.stringify(value.headerPin)||JSON.stringify(i.pin)!==JSON.stringify(value.intentPin)||JSON.stringify(o.pin)!==JSON.stringify(value.ownerPin)
    ||JSON.stringify(i.localRecord)!==JSON.stringify(local)||!transferActive(value))throw failure();
   writer.sequence=sequence;writer.acknowledgedOwners.set(sequence,{pin:value.ownerPin,localIntent:local});
   const original=writer.createOwnerOutcomeWriter();let attempted=false;
   const revoke=()=>{attempted=true;original.revoke();ownedClient?.destroy();};
   const deadline=setTimeout(revoke,remaining());deadline.unref();
   return Object.freeze({revoke:()=>{clearTimeout(deadline);revoke();},publish:async(outcome:unknown,caller?:AbortSignal)=>{
    if(attempted||!transferActive(value))throw failure();attempted=true;
    try{const result=await original.publish(outcome,caller?AbortSignal.any([caller,expiry]):expiry);
     if(!transferActive(value))throw failure();return result;
    }finally{clearTimeout(deadline);ownedClient?.destroy();}
   }});
  }catch{ownedClient?.destroy();throw failure();}
 }
 private assertOwnerIntent(local:z.infer<typeof owner>,original:ReturnType<ManagedDaemonIntentCustody['parse']>){
  if(local.intentPin.sha256!==original.value.localRecord.sha256||local.intentPin.byteLength!==original.value.localRecord.byteLength)throw failure();
 }
 /** Original owner readiness custody only; the live kernel/dispatch adapter must
  * independently verify the identity before invoking this method. */
 async bindOwner(raw:unknown,signal?:AbortSignal){
  try{
   if(this.failed||this.busy||this.endAttempted||!this.latestIntent||!this.savedHeader||!this.live()
    ||this.responseAttempts.has(this.sequence)||this.ownerAttempts.has(this.sequence))throw failure();
   this.busy=true;this.ownerAttempts.add(this.sequence);const checked=this.checkedOwner(raw,this.sequence);
   const current=await this.store(this.sequence).inspectCandidateArtifact('BASELINE',signal),h=await this.inspectHeader(signal);
   if(JSON.stringify(current.pin)!==JSON.stringify(this.latestIntent)||JSON.stringify(h.pin)!==JSON.stringify(this.savedHeader))throw failure();
   const original=this.parse(current.artifact,this.sequence);
   this.assertOwnerIntent(checked.value,original);
   if(JSON.stringify(original.value.headerCustodyPin)!==JSON.stringify(this.savedHeader)||this.failed||!this.live())throw failure();
   const body=JSON.stringify(ownerEnvelope.parse({format:1,kind:'MANAGED_DAEMON_OWNER_CUSTODY_V1',bindingDigest:candidateHash(JSON.stringify(this.binding)),
    jobRequestPin:this.requestPin,jobServicePin:this.servicePin,headerCustodyPin:this.savedHeader,intentCustodyPin:this.latestIntent,localRecord:checked.record,
    savedEvidenceAuthorizesDispatch:false,independentOwnerDispatchVerified:false,actionAuthorized:false}));
   const pin=await this.ownerStore(this.sequence).publishBaseline({body,sha256:candidateHash(body)},signal);
   if(this.failed||!this.live())throw failure();this.busy=false;this.acknowledgedOwners.set(this.sequence,{pin:candidatePinSchema.parse(pin),localIntent:localJobArtifact(original.value.localRecord)});
   return{pin,savedEvidenceAuthorizesDispatch:false as const,independentOwnerDispatchVerified:false as const,actionAuthorized:false as const};
  }catch{this.failed=true;throw failure();}
 }
 async inspectOwner(sequence:number,previousLocalDigest:string,signal?:AbortSignal){
  const original=await this.inspectIntent(sequence,previousLocalDigest,signal),h=await this.inspectHeader(signal);
  const saved=await this.ownerStore(sequence).inspectCandidateArtifact('BASELINE',signal),parsed=this.parseOwner(saved.artifact,sequence);
  if(JSON.stringify(parsed.value.intentCustodyPin)!==JSON.stringify(original.pin)||JSON.stringify(parsed.value.headerCustodyPin)!==JSON.stringify(h.pin)
   ||parsed.local.intentPin.sha256!==original.localRecord.sha256||parsed.local.intentPin.byteLength!==original.localRecord.byteLength)throw failure();
  return{pin:saved.pin,localRecord:parsed.value.localRecord,originalAcknowledgementReconstructed:false as const,savedEvidenceAuthorizesDispatch:false as const,
   independentOwnerDispatchVerified:false as const,pendingRequestResolved:false as const,actionAuthorized:false as const};
 }
 async inspectOwnerOutcome(sequence:number,previousLocalDigest:string,signal?:AbortSignal){
  const bound=await this.inspectOwner(sequence,previousLocalDigest,signal),saved=await this.ownerStore(sequence).inspectCandidateArtifact('OBSERVATION',signal);
  const parsed=this.parseOwnerOutcome(saved.artifact,sequence);
  if(JSON.stringify(parsed.value.ownerCustodyPin)!==JSON.stringify(bound.pin))throw failure();
  await this.ownerStore(sequence).observeObservation(saved.pin,bound.pin,signal);
  return{pin:saved.pin,localRecord:parsed.value.localRecord,originalAcknowledgementReconstructed:false as const,pendingRequestResolved:false as const,
   independentOwnerDispatchVerified:false as const,executionAuthorized:false as const,actionAuthorized:false as const};
 }
 private parseEnd(raw:unknown){
  const artifact=z.object({body:z.string().min(1).max(16384),sha256:sha}).strict().parse(raw);
  if(candidateHash(artifact.body)!==artifact.sha256||Buffer.byteLength(artifact.body)>16384)throw failure();
  const value=endEnvelope.parse(JSON.parse(artifact.body)),record=localJobArtifact(value.localRecord),local=end.parse(JSON.parse(record.body));
  if(value.bindingDigest!==candidateHash(JSON.stringify(this.binding))||JSON.stringify(value.jobRequestPin)!==JSON.stringify(this.requestPin)
   ||JSON.stringify(value.jobServicePin)!==JSON.stringify(this.servicePin)||!value.headerCustodyPin||value.baselineCustodyPin.kind!=='BASELINE'
   ||JSON.stringify(value.headerCustodyPin)!==JSON.stringify(value.baselineCustodyPin)||local.jobId!==this.request.local.jobId)throw failure();
  return{artifact,value,local};
 }
 private assertEndPair(baseline:Artifact,observation:Artifact){
  const original=this.parse(baseline,0).value,observed=this.parseEnd(observation);
  if(observed.local.headerPin.sha256!==original.localRecord.sha256||observed.local.headerPin.byteLength!==original.localRecord.byteLength
   ||observed.value.baselineCustodyPin.sha256!==baseline.sha256||observed.value.baselineCustodyPin.byteLength!==Buffer.byteLength(baseline.body))throw failure();
 }
 private parseResponse(raw:unknown,sequence:number){
  if(sequence===0)throw failure();
  const artifact=z.object({body:z.string().min(1).max(16384),sha256:sha}).strict().parse(raw);
  if(candidateHash(artifact.body)!==artifact.sha256||Buffer.byteLength(artifact.body)>16384)throw failure();
  const value=responseEnvelope.parse(JSON.parse(artifact.body)),local=localJobArtifact(value.localRecord),v=response.parse(JSON.parse(local.body));
  if(value.bindingDigest!==candidateHash(JSON.stringify(this.binding))||JSON.stringify(value.jobRequestPin)!==JSON.stringify(this.requestPin)
   ||JSON.stringify(value.jobServicePin)!==JSON.stringify(this.servicePin)||!value.headerCustodyPin||value.baselineCustodyPin.kind!=='BASELINE'
   ||v.jobId!==this.request.local.jobId||v.sequence!==sequence)throw failure();
  return{artifact,value,local:v};
 }
 private assertResponsePair(baseline:Artifact,observation:Artifact,sequence:number){
  const original=this.parse(baseline,sequence).value,observed=this.parseResponse(observation,sequence),v=intent.parse(JSON.parse(original.localRecord.body));
  if(JSON.stringify(original.headerCustodyPin)!==JSON.stringify(observed.value.headerCustodyPin)
   ||observed.local.intentPin.sha256!==original.localRecord.sha256||observed.local.intentPin.byteLength!==original.localRecord.byteLength
   ||observed.value.baselineCustodyPin.sha256!==baseline.sha256||observed.value.baselineCustodyPin.byteLength!==Buffer.byteLength(baseline.body)
   ||observed.local.removalAlreadyAbsent&&(v.operation!=='rm'||observed.local.status!==1||observed.local.transportError||observed.local.signal))throw failure();
 }
 /** Retain an original client response; this does not settle the daemon queue. */
 async observeResponse(raw:unknown,signal?:AbortSignal){
  try{
   if(this.failed||this.busy||this.endAttempted||!this.latestIntent||!this.savedHeader||!this.live()||this.responseAttempts.has(this.sequence))throw failure();
   this.busy=true;this.responseAttempts.add(this.sequence);
   const record=localJobArtifact(raw),v=response.parse(JSON.parse(record.body));
   if(v.sequence!==this.sequence||v.jobId!==this.request.local.jobId)throw failure();
   const body=JSON.stringify(responseEnvelope.parse({format:1,kind:'MANAGED_DAEMON_CUSTODY_RESPONSE_V1',
    bindingDigest:candidateHash(JSON.stringify(this.binding)),jobRequestPin:this.requestPin,jobServicePin:this.servicePin,
    headerCustodyPin:this.savedHeader,baselineCustodyPin:this.latestIntent,localRecord:record,
    savedEvidenceAuthorizesDispatch:false,pendingRequestResolved:false,actionAuthorized:false}));
   const pin=await this.store(this.sequence).publishObservation({body,sha256:candidateHash(body)},this.latestIntent,signal);
   if(this.failed||!this.live())throw failure();this.busy=false;this.responseCount=this.sequence;this.uncertainResponse=v.status===null||v.transportError||v.signal;
   return{pin,savedEvidenceAuthorizesDispatch:false as const,pendingRequestResolved:false as const,actionAuthorized:false as const};
  }catch{this.failed=true;throw failure();}
 }
 async inspectResponse(sequence:number,previousLocalDigest:string,signal?:AbortSignal){
  const original=await this.inspectIntent(sequence,previousLocalDigest,signal),store=this.store(sequence);
  const saved=await store.inspectCandidateArtifact('OBSERVATION',signal),value=this.parseResponse(saved.artifact,sequence).value;
  if(JSON.stringify(value.baselineCustodyPin)!==JSON.stringify(original.pin))throw failure();
  await store.observeObservation(saved.pin,original.pin,signal);
  return{pin:saved.pin,localRecord:value.localRecord,originalAcknowledgementReconstructed:false as const,
   savedEvidenceAuthorizesDispatch:false as const,pendingRequestResolved:false as const,actionAuthorized:false as const};
 }
 async finishRequests(raw:unknown,signal?:AbortSignal){
  try{
   if(this.failed||this.busy||this.endAttempted||!this.savedHeader||!this.live()||this.responseCount!==this.sequence)throw failure();
   this.endAttempted=true;this.busy=true;
   const record=localJobArtifact(raw),v=end.parse(JSON.parse(record.body));
   if(v.requestCount!==this.sequence||v.lastIntentDigest!==this.previous)throw failure();
   const body=JSON.stringify(endEnvelope.parse({format:1,kind:'MANAGED_DAEMON_CUSTODY_END_V1',bindingDigest:candidateHash(JSON.stringify(this.binding)),
    jobRequestPin:this.requestPin,jobServicePin:this.servicePin,headerCustodyPin:this.savedHeader,baselineCustodyPin:this.savedHeader,
    localRecord:record,savedEvidenceAuthorizesDispatch:false,pendingRequestResolved:false,actionAuthorized:false}));
   const pin=await this.store(0).publishObservation({body,sha256:candidateHash(body)},this.savedHeader,signal);
   if(this.failed||!this.live())throw failure();this.busy=false;
   return{pin,savedEvidenceAuthorizesDispatch:false as const,pendingRequestResolved:false as const,actionAuthorized:false as const};
  }catch{this.failed=true;throw failure();}
 }
 async inspectEnd(signal?:AbortSignal){
  const original=await this.inspectHeader(signal),store=this.store(0),saved=await store.inspectCandidateArtifact('OBSERVATION',signal),value=this.parseEnd(saved.artifact);
  if(JSON.stringify(value.value.baselineCustodyPin)!==JSON.stringify(original.pin))throw failure();
  await store.observeObservation(saved.pin,original.pin,signal);
  let previous=original.localRecord.sha256;
  for(let sequence=1;sequence<=value.local.requestCount;sequence++){
   const intent=await this.inspectIntent(sequence,previous,signal);await this.inspectResponse(sequence,previous,signal);previous=intent.localRecord.sha256;
  }
  if(previous!==value.local.lastIntentDigest)throw failure();
  return{pin:saved.pin,localRecord:value.value.localRecord,originalAcknowledgementReconstructed:false as const,
   savedEvidenceAuthorizesDispatch:false as const,pendingRequestResolved:false as const,completeResourceInventory:false as const,actionAuthorized:false as const};
 }
 private artifact(raw:unknown,sequence:number){
  const {record}=this.checked(raw,sequence);
  const body=JSON.stringify(envelope.parse({format:1,kind:sequence===0?'MANAGED_DAEMON_CUSTODY_HEADER_V1':'MANAGED_DAEMON_CUSTODY_INTENT_V1',
   bindingDigest:candidateHash(JSON.stringify(this.binding)),jobRequestPin:this.requestPin,jobServicePin:this.servicePin,headerCustodyPin:sequence===0?null:this.savedHeader,
   localRecord:record,savedEvidenceAuthorizesDispatch:false,actionAuthorized:false}));return{body,sha256:candidateHash(body)};
 }
 async reserveHeader(raw:unknown,signal?:AbortSignal){
  try{
   if(this.failed||this.headerAttempted||!this.live())throw failure();this.headerAttempted=true;
   const checked=this.checked(raw,0),artifact=this.artifact(checked.record,0),saved=await this.store(0).publishBaseline(artifact,signal);if(this.failed||!this.live())throw failure();
   this.savedHeader=candidatePinSchema.parse(saved);this.previous=checked.record.sha256;
   return{pin:saved,savedEvidenceAuthorizesDispatch:false as const,actionAuthorized:false as const};
  }catch{this.failed=true;throw failure();}
 }
 async reserveIntent(raw:unknown,signal?:AbortSignal){
  try{
   if(this.failed||this.busy||this.endAttempted||this.uncertainResponse||!this.savedHeader||!this.live()||this.sequence>=64||this.responseCount!==this.sequence)throw failure();this.busy=true;
   const sequence=this.sequence+1,checked=this.checked(raw,sequence),v=intent.parse(checked.value);
   const savedHeader=await this.inspectHeader(signal),h=header.parse(JSON.parse(savedHeader.localRecord.body));
   if(this.failed||!this.live()||JSON.stringify(savedHeader.pin)!==JSON.stringify(this.savedHeader)||v.previousDigest!==this.previous||v.storagePlan&&v.storagePlan.image!==h.image)throw failure();
   const artifact=this.artifact(checked.record,sequence),saved=await this.store(sequence).publishBaseline(artifact,signal);if(this.failed||!this.live())throw failure();
   this.sequence=sequence;this.previous=checked.record.sha256;this.latestIntent=candidatePinSchema.parse(saved);this.busy=false;
   return{pin:saved,savedEvidenceAuthorizesDispatch:false as const,actionAuthorized:false as const};
  }catch{this.failed=true;throw failure();}
 }
 async inspectHeader(signal?:AbortSignal){
  const saved=await this.store(0).inspectCandidateArtifact('BASELINE',signal),value=this.parse(saved.artifact,0).value;
  return{pin:saved.pin,localRecord:value.localRecord,originalAcknowledgementReconstructed:false as const,savedEvidenceAuthorizesDispatch:false as const,actionAuthorized:false as const};
 }
 async inspectIntent(sequence:number,previousLocalDigest:string,signal?:AbortSignal){
  z.number().int().min(1).max(64).parse(sequence);sha.parse(previousLocalDigest);
  const h=await this.inspectHeader(signal),saved=await this.store(sequence).inspectCandidateArtifact('BASELINE',signal),value=this.parse(saved.artifact,sequence).value;
  const v=intent.parse(JSON.parse(value.localRecord.body));
  if(JSON.stringify(value.headerCustodyPin)!==JSON.stringify(h.pin)||v.previousDigest!==previousLocalDigest
   ||v.storagePlan&&v.storagePlan.image!==header.parse(JSON.parse(h.localRecord.body)).image)throw failure();
  return{pin:saved.pin,localRecord:value.localRecord,originalAcknowledgementReconstructed:false as const,savedEvidenceAuthorizesDispatch:false as const,
   daemonResponseObserved:false as const,pendingRequestResolved:false as const,actionAuthorized:false as const};
 }
 /** Discover all protocol ordinals from independently stored original context.
  * Stable current listings are not historical completeness or daemon finality. */
 async discover(caller?:AbortSignal){
  const controller=new AbortController(),signal=caller?AbortSignal.any([caller,controller.signal]):controller.signal;
  const timer=setTimeout(()=>controller.abort(),60000);
  const row=z.object({Key:z.string().min(1).max(1024),ETag:z.string().min(1).max(1024),Size:z.number().int().min(1).max(16384)});
  const list=async(sequence:number,ownerRecord=false)=>{
   const scope=ownerRecord?daemonOwnerCustodyScope(this.binding.candidateId,sequence):daemonCustodyScope(this.binding.candidateId,sequence),maximum=2;
   const prefix=`managed-maintenance/${this.storage.installationId}/${this.binding.attemptId}/capture-job/${scope}/`;
   signal.throwIfAborted();let stop=()=>{};
   const aborted=new Promise<never>((_,reject)=>{stop=()=>reject(failure());signal.addEventListener('abort',stop,{once:true});});
   try{
    const value=await Promise.race([this.client.send(new ListObjectsV2Command({Bucket:this.storage.bucket,ExpectedBucketOwner:this.storage.accountId,
     Prefix:prefix,MaxKeys:maximum+1}),{abortSignal:signal}),aborted]);signal.throwIfAborted();
    if(value.Name!==this.storage.bucket||value.Prefix!==prefix||value.MaxKeys!==maximum+1||value.IsTruncated!==false||value.NextContinuationToken!==undefined
     ||value.ContinuationToken!==undefined||value.EncodingType!==undefined||value.Delimiter!==undefined||value.StartAfter!==undefined
     ||value.CommonPrefixes&&value.CommonPrefixes.length)throw failure();
    const rows=z.array(row).max(maximum).parse(value.Contents??[]).sort((a,b)=>a.Key.localeCompare(b.Key));
    if(value.KeyCount!==rows.length||new Set(rows.map(v=>v.Key)).size!==rows.length
     ||rows.some(v=>v.Key!==prefix+'baseline.json'&&v.Key!==prefix+'observation.json'))throw failure();
    return rows;
   }finally{signal.removeEventListener('abort',stop);}
  };
  const catalogue=async()=>{const rows=[];for(let sequence=0;sequence<=64;sequence++)rows.push(await list(sequence));
   for(let sequence=1;sequence<=64;sequence++)rows.push(await list(sequence,true));return rows;};
  try{
   const before=await catalogue(),read=async(sequence:number,kind:'BASELINE'|'OBSERVATION',ownerRecord=false)=>{
    const listed=before[ownerRecord?64+sequence:sequence].find(v=>v.Key.endsWith(kind==='BASELINE'?'/baseline.json':'/observation.json'));
    if(!listed)return null;
    const saved=await(ownerRecord?this.ownerStore(sequence):this.store(sequence)).inspectCandidateArtifact(kind,signal);
    if(saved.currentETag!==listed.ETag||saved.pin.byteLength!==listed.Size)throw failure();return saved;
   };
   const savedHeader=await read(0,'BASELINE'),savedEnd=await read(0,'OBSERVATION');
   if(!savedHeader&&before.some(rows=>rows.length))throw failure();
   const h=savedHeader?this.parse(savedHeader.artifact,0).value:null;
   let previous=h?.localRecord.sha256,missingIntent=false,uncertain=false,responseCount=0,ownerBindingCount=0,ownerOutcomeCount=0;
   const records=[];
   for(let sequence=1;sequence<=64;sequence++){
    const saved=await read(sequence,'BASELINE'),observed=await read(sequence,'OBSERVATION'),boundOwner=await read(sequence,'BASELINE',true),ownerResult=await read(sequence,'OBSERVATION',true);
    if(!saved){if(observed||boundOwner||ownerResult)throw failure();missingIntent=true;continue;}
    if(ownerResult&&!boundOwner)throw failure();
    if(missingIntent||!h||!savedHeader)throw failure();
    const original=this.parse(saved.artifact,sequence).value,v=intent.parse(JSON.parse(original.localRecord.body));
    if(v.previousDigest!==previous||JSON.stringify(original.headerCustodyPin)!==JSON.stringify(savedHeader.pin)
     ||v.storagePlan&&v.storagePlan.image!==header.parse(JSON.parse(h.localRecord.body)).image)throw failure();
    if(boundOwner){const bound=this.parseOwner(boundOwner.artifact,sequence);this.assertOwnerIntent(bound.local,this.parse(saved.artifact,sequence));
     if(JSON.stringify(bound.value.intentCustodyPin)!==JSON.stringify(saved.pin)||JSON.stringify(bound.value.headerCustodyPin)!==JSON.stringify(savedHeader.pin))throw failure();ownerBindingCount++;}
    let ownerResultLocal:z.infer<typeof ownerOutcome>|undefined;
    if(ownerResult&&boundOwner){const result=this.parseOwnerOutcome(ownerResult.artifact,sequence);this.assertOwnerOutcomePair(boundOwner.artifact,ownerResult.artifact,sequence);
     if(JSON.stringify(result.value.ownerCustodyPin)!==JSON.stringify(boundOwner.pin)||JSON.stringify(result.value.intentCustodyPin)!==JSON.stringify(saved.pin)
      ||result.value.localIntent.sha256!==original.localRecord.sha256||result.value.localIntent.byteLength!==original.localRecord.byteLength)throw failure();ownerOutcomeCount++;ownerResultLocal=result.local;}
    previous=original.localRecord.sha256;
    let outcome:'RECORDED_CLIENT_SUCCESS'|'RECORDED_CLIENT_UNCERTAINTY'|'NOT_LISTED_AT_BOUNDARY'='NOT_LISTED_AT_BOUNDARY';
    if(observed){
     const r=this.parseResponse(observed.artifact,sequence);
     if(JSON.stringify(r.value.baselineCustodyPin)!==JSON.stringify(saved.pin))throw failure();
     this.assertResponsePair(saved.artifact,observed.artifact,sequence);responseCount++;
     // Independently retained pairs must agree even when no original process
     // or wire ACK survives. Matching bytes still grant no request finality.
     if(ownerResultLocal){
      for(const field of ['status','transportError','signal','removalAlreadyAbsent'] as const)if(r.local[field]!==ownerResultLocal[field])throw failure();
      if(JSON.stringify(r.local.intentPin)!==JSON.stringify(ownerResultLocal.intentPin))throw failure();
     }
     outcome=(r.local.status===0||r.local.removalAlreadyAbsent)&&!r.local.transportError&&!r.local.signal?'RECORDED_CLIENT_SUCCESS':'RECORDED_CLIENT_UNCERTAINTY';
    }
    if(outcome!=='RECORDED_CLIENT_SUCCESS')uncertain=true;
    records.push({sequence,intentPin:saved.pin,responsePin:observed?.pin??null,ownerPin:boundOwner?.pin??null,ownerOutcomePin:ownerResult?.pin??null,
     localIntentPin:{sha256:original.localRecord.sha256,byteLength:original.localRecord.byteLength},outcome});
   }
   if(savedEnd){
    if(!savedHeader)throw failure();const e=this.parseEnd(savedEnd.artifact);
    this.assertEndPair(savedHeader.artifact,savedEnd.artifact);
    if(JSON.stringify(e.value.baselineCustodyPin)!==JSON.stringify(savedHeader.pin)||e.local.requestCount!==records.length
     ||e.local.lastIntentDigest!==previous||responseCount!==records.length)throw failure();
   }
   if(JSON.stringify(await catalogue())!==JSON.stringify(before))throw failure();signal.throwIfAborted();
   return{kind:'MANAGED_DAEMON_CUSTODY_DISCOVERY_V1' as const,
    state:!savedHeader?'NOT_LISTED_AT_BOUNDARY' as const:savedEnd&&!uncertain?'RECORDED_CLIENT_RESPONSES' as const:'UNRESOLVED_REQUESTS' as const,
    headerPin:savedHeader?.pin??null,endPin:savedEnd?.pin??null,records,responseCount,ownerBindingCount,ownerOutcomeCount,listingDigest:candidateHash(JSON.stringify(before)),
    protocolOrdinalRange:{first:0,last:64},ownerOrdinalRange:{first:1,last:64},independentOwnerDispatchVerified:false as const,
    listingStableAtBoundaries:true as const,historyCompletenessVerified:false as const,
    pendingRequestResolved:false as const,completeResourceInventory:false as const,sourceHostLossProven:false as const,
    originalAcknowledgementReconstructed:false as const,savedEvidenceAuthorizesDispatch:false as const,cleanupAuthorized:false as const,actionAuthorized:false as const};
  }catch{throw failure();}finally{clearTimeout(timer);controller.abort();}
 }
}
