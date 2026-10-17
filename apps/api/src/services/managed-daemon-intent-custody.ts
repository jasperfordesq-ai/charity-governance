import {z} from 'zod';
import {ListObjectsV2Command,type S3Client,type S3ClientConfig} from '@aws-sdk/client-s3';
import {candidateHash,candidatePinSchema} from './managed-candidate-capture-contract.js';
import {commonCandidateBindingSchema} from './managed-common-candidate-contract.js';
import {localJobArtifact,localJobArtifactSchema,parseJobRequest,parseJobService,assertJobServicePair} from './managed-proof-job-contract.js';
import {S3MaintenanceArtifactStore} from './maintenance-artifact-store.js';
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
type Pin=z.infer<typeof candidatePinSchema>;
type Artifact={body:string;sha256:string};
export const daemonCustodyScope=(candidateId:string,sequence:number)=>{
 z.string().uuid().parse(candidateId);z.number().int().min(0).max(64).parse(sequence);
 return candidateHash('CHARITYPILOT_DAEMON_INTENT_CUSTODY_V1\n'+candidateId+'\n'+sequence);
};

/** Original write-ACK component only. Saved evidence is not a dispatch lease,
 * daemon response, resource inventory, cancellation fence or recovery grant. */
export class ManagedDaemonIntentCustody{
 private readonly binding;private readonly request;private readonly service;
 private headerAttempted=false;private failed=false;private busy=false;private savedHeader:Pin|undefined;
 private previous:string|undefined;private sequence=0;
 private latestIntent:Pin|undefined;private readonly responseAttempts=new Set<number>();
 private responseCount=0;private endAttempted=false;private uncertainResponse=false;
 constructor(private readonly storage:{installationId:string;bucket:string;accountId:string;kmsKeyArn:string},binding:unknown,
  private readonly credentials:NonNullable<S3ClientConfig['credentials']>,private readonly client:S3Client,
  requestArtifact:Artifact,private readonly requestPin:Pin,serviceArtifact:Artifact,private readonly servicePin:Pin,
  private readonly live:()=>boolean){
  this.binding=commonCandidateBindingSchema.parse(binding);this.request=parseJobRequest(this.binding,requestArtifact);this.service=parseJobService(this.binding,serviceArtifact);
  assertJobServicePair(this.binding,requestArtifact,serviceArtifact);
  if(this.binding.installationId!==storage.installationId||this.service.local.identity.format!==2)throw failure();
  for(const [pin,artifact] of [[requestPin,requestArtifact],[servicePin,serviceArtifact]] as const){
   candidatePinSchema.parse(pin);if(pin.kind!=='BASELINE'||pin.sha256!==candidateHash(artifact.body)||pin.byteLength!==Buffer.byteLength(artifact.body))throw failure();
  }
  if(JSON.stringify(this.service.value.jobRequestPin)!==JSON.stringify(requestPin))throw failure();
  this.storage={...storage};this.requestPin=candidatePinSchema.parse(requestPin);this.servicePin=candidatePinSchema.parse(servicePin);
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
  const list=async(sequence:number)=>{
   const prefix=`managed-maintenance/${this.storage.installationId}/${this.binding.attemptId}/capture-job/${daemonCustodyScope(this.binding.candidateId,sequence)}/`;
   signal.throwIfAborted();let stop=()=>{};
   const aborted=new Promise<never>((_,reject)=>{stop=()=>reject(failure());signal.addEventListener('abort',stop,{once:true});});
   try{
    const value=await Promise.race([this.client.send(new ListObjectsV2Command({Bucket:this.storage.bucket,ExpectedBucketOwner:this.storage.accountId,
     Prefix:prefix,MaxKeys:3}),{abortSignal:signal}),aborted]);signal.throwIfAborted();
    if(value.Name!==this.storage.bucket||value.Prefix!==prefix||value.MaxKeys!==3||value.IsTruncated!==false||value.NextContinuationToken!==undefined
     ||value.ContinuationToken!==undefined||value.EncodingType!==undefined||value.Delimiter!==undefined||value.StartAfter!==undefined
     ||value.CommonPrefixes&&value.CommonPrefixes.length)throw failure();
    const rows=z.array(row).max(2).parse(value.Contents??[]).sort((a,b)=>a.Key.localeCompare(b.Key));
    if(value.KeyCount!==rows.length||new Set(rows.map(v=>v.Key)).size!==rows.length
     ||rows.some(v=>v.Key!==prefix+'baseline.json'&&v.Key!==prefix+'observation.json'))throw failure();
    return rows;
   }finally{signal.removeEventListener('abort',stop);}
  };
  const catalogue=async()=>{const rows=[];for(let sequence=0;sequence<=64;sequence++)rows.push(await list(sequence));return rows;};
  try{
   const before=await catalogue(),read=async(sequence:number,kind:'BASELINE'|'OBSERVATION')=>{
    const listed=before[sequence].find(v=>v.Key.endsWith(kind==='BASELINE'?'/baseline.json':'/observation.json'));
    if(!listed)return null;
    const saved=await this.store(sequence).inspectCandidateArtifact(kind,signal);
    if(saved.currentETag!==listed.ETag||saved.pin.byteLength!==listed.Size)throw failure();return saved;
   };
   const savedHeader=await read(0,'BASELINE'),savedEnd=await read(0,'OBSERVATION');
   if(!savedHeader&&before.some(rows=>rows.length))throw failure();
   const h=savedHeader?this.parse(savedHeader.artifact,0).value:null;
   let previous=h?.localRecord.sha256,missingIntent=false,uncertain=false,responseCount=0;
   const records=[];
   for(let sequence=1;sequence<=64;sequence++){
    const saved=await read(sequence,'BASELINE'),observed=await read(sequence,'OBSERVATION');
    if(!saved){if(observed)throw failure();missingIntent=true;continue;}
    if(missingIntent||!h||!savedHeader)throw failure();
    const original=this.parse(saved.artifact,sequence).value,v=intent.parse(JSON.parse(original.localRecord.body));
    if(v.previousDigest!==previous||JSON.stringify(original.headerCustodyPin)!==JSON.stringify(savedHeader.pin)
     ||v.storagePlan&&v.storagePlan.image!==header.parse(JSON.parse(h.localRecord.body)).image)throw failure();
    previous=original.localRecord.sha256;
    let outcome:'RECORDED_CLIENT_SUCCESS'|'RECORDED_CLIENT_UNCERTAINTY'|'NOT_LISTED_AT_BOUNDARY'='NOT_LISTED_AT_BOUNDARY';
    if(observed){
     const r=this.parseResponse(observed.artifact,sequence);
     if(JSON.stringify(r.value.baselineCustodyPin)!==JSON.stringify(saved.pin))throw failure();
     this.assertResponsePair(saved.artifact,observed.artifact,sequence);responseCount++;
     outcome=(r.local.status===0||r.local.removalAlreadyAbsent)&&!r.local.transportError&&!r.local.signal?'RECORDED_CLIENT_SUCCESS':'RECORDED_CLIENT_UNCERTAINTY';
    }
    if(outcome!=='RECORDED_CLIENT_SUCCESS')uncertain=true;
    records.push({sequence,intentPin:saved.pin,responsePin:observed?.pin??null,localIntentPin:{sha256:original.localRecord.sha256,byteLength:original.localRecord.byteLength},outcome});
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
    headerPin:savedHeader?.pin??null,endPin:savedEnd?.pin??null,records,responseCount,listingDigest:candidateHash(JSON.stringify(before)),
    protocolOrdinalRange:{first:0,last:64},listingStableAtBoundaries:true as const,historyCompletenessVerified:false as const,
    pendingRequestResolved:false as const,completeResourceInventory:false as const,sourceHostLossProven:false as const,
    originalAcknowledgementReconstructed:false as const,savedEvidenceAuthorizesDispatch:false as const,cleanupAuthorized:false as const,actionAuthorized:false as const};
  }catch{throw failure();}finally{clearTimeout(timer);controller.abort();}
 }
}
