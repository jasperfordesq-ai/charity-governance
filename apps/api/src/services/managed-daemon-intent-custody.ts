import {z} from 'zod';
import type {S3Client,S3ClientConfig} from '@aws-sdk/client-s3';
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
   baseline:raw=>this.parse(raw,sequence).artifact,parseObservation:()=>{throw failure();},observationFromValue:()=>{throw failure();},assertPair:()=>{throw failure();}},this.client);}
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
   if(this.failed||this.busy||!this.savedHeader||!this.live()||this.sequence>=64)throw failure();this.busy=true;
   const sequence=this.sequence+1,checked=this.checked(raw,sequence),v=intent.parse(checked.value);
   const savedHeader=await this.inspectHeader(signal),h=header.parse(JSON.parse(savedHeader.localRecord.body));
   if(this.failed||!this.live()||JSON.stringify(savedHeader.pin)!==JSON.stringify(this.savedHeader)||v.previousDigest!==this.previous||v.storagePlan&&v.storagePlan.image!==h.image)throw failure();
   const artifact=this.artifact(checked.record,sequence),saved=await this.store(sequence).publishBaseline(artifact,signal);if(this.failed||!this.live())throw failure();
   this.sequence=sequence;this.previous=checked.record.sha256;this.busy=false;
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
}
