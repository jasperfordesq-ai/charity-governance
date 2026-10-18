import {z} from 'zod';
import {type S3Client,type S3ClientConfig} from '@aws-sdk/client-s3';
import {candidateHash,candidatePinSchema} from './managed-candidate-capture-contract.js';
import {managedClosedHead,managedPlanSchema} from './managed-plan-bootstrap.js';
import {S3MaintenanceArtifactStore,type MaintenanceArtifact} from './maintenance-artifact-store.js';
import type {S3ManagedMaintenanceControl} from './managed-maintenance-control.js';
import type {SupabaseStorageWriterControl} from './supabase-storage-writer-control.js';

const sha=z.string().regex(/^[a-f0-9]{64}$/),id=z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const storageSchema=z.object({installationId:id,bucket:z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
 accountId:z.string().regex(/^\d{12}$/),kmsKeyArn:z.string().regex(/^arn:aws:kms:eu-west-1:\d{12}:key\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)}).strict()
 .refine(v=>v.kmsKeyArn.split(':')[4]===v.accountId);
const scopeSchema=z.object({installationId:id,projectRef:z.string().regex(/^[a-z0-9]{20}$/),bucket:z.string().min(1).max(63),
 captureKeyId:z.string().uuid(),storageConfigurationDigest:sha}).strict();
const no=z.literal(false);
const scopeFrom=(v:z.infer<typeof scopeSchema>)=>scopeSchema.parse({installationId:v.installationId,projectRef:v.projectRef,
 bucket:v.bucket,captureKeyId:v.captureKeyId,storageConfigurationDigest:v.storageConfigurationDigest});
const observationSchema=scopeSchema.extend({format:z.literal(1),kind:z.literal('SUPABASE_CAPTURE_CONTROL_RETIRED_V1'),
 observedAt:z.string().datetime(),stateSha256:sha,observationDigest:sha,listedModernKeysAbsent:z.literal(true),
 legacyKeysDisabled:z.literal(true),s3ProtocolDisabled:z.literal(true),retainedCaptureKeys:z.literal(0),
 dataPlaneRejectionVerified:no,controlPlaneWritersExcluded:no,signedCapabilitiesRevoked:no,inFlightWritesDrained:no,
 wholeStorageQuiesced:no,actionAuthorized:no}).strict();
const bindingSchema=z.object({installationId:id,attemptId:z.string().uuid(),planDigest:sha,sourceSha:z.string().regex(/^[a-f0-9]{40}$/),
 maintenanceEpoch:z.number().int().positive().max(2147483647),controlRevision:sha,retirementConfigurationDigest:sha}).strict();
const requestSchema=z.object({format:z.literal(1),kind:z.literal('MANAGED_CAPTURE_CONTROL_RETIREMENT_REQUEST_V1'),
 binding:bindingSchema,scope:scopeSchema,executionState:z.literal('REQUESTED_ONLY'),actionAuthorized:no}).strict();
const reportSchema=z.object({format:z.literal(1),kind:z.literal('MANAGED_CAPTURE_CONTROL_RETIREMENT_REPORT_V1'),
 binding:bindingSchema,requestPin:candidatePinSchema,observation:observationSchema,
 originalDeleteAcknowledgementObserved:z.literal(true),savedObservationAuthorizesExecution:no,actionAuthorized:no}).strict();
const failure=()=>new Error('Capture control retirement is unresolved; preserve original records without retry or ACK reconstruction');
const artifact=(value:unknown):MaintenanceArtifact=>{const body=JSON.stringify(value);return{body,sha256:candidateHash(body)};};
const savedValue=(raw:unknown)=>{const v=z.object({body:z.string().max(16384),sha256:sha}).strict().parse(raw);
 if(candidateHash(v.body)!==v.sha256)throw failure();const value:unknown=JSON.parse(v.body);
 if(JSON.stringify(value)!==v.body)throw failure();return value;};

/** Explicit format-11 component. No route, current coordinator or legacy plan
 * activates this component. It retires one named control key only; management
 * tokens, signing issuers and in-flight/signed capabilities remain unexcluded. */
export class ManagedCaptureControlRetirement {
 private readonly storage:z.infer<typeof storageSchema>;
 private readonly scope:z.infer<typeof scopeSchema>;
 private attempted=false;
 constructor(rawStorage:unknown,private readonly provider:SupabaseStorageWriterControl,
  private readonly control:S3ManagedMaintenanceControl,private readonly credentials:NonNullable<S3ClientConfig['credentials']>,
  private readonly client?:S3Client){
  this.storage=storageSchema.parse(rawStorage);this.scope=scopeSchema.parse(provider.captureControlRetirementScope());
  if(!credentials||this.scope.installationId!==this.storage.installationId)throw failure();
 }
 configurationDigest(){return candidateHash(JSON.stringify({format:1,policy:'ORIGINAL_REQUEST_ACK_BEFORE_CAPTURE_CONTROL_RETIREMENT_V1',
  storage:this.storage,scope:this.scope}));}
 assertCoordinatorScope(installationId:string,provider:SupabaseStorageWriterControl,control:S3ManagedMaintenanceControl){
  if(installationId!==this.storage.installationId||provider!==this.provider||control!==this.control
   ||JSON.stringify(scopeSchema.parse(provider.captureControlRetirementScope()))!==JSON.stringify(this.scope))throw failure();
 }
 private async context(rawPlan:unknown,signal?:AbortSignal){
  signal?.throwIfAborted();const plan=managedPlanSchema.parse(rawPlan);
  if(plan.format!==11||plan.captureControlRetirement!==this.configurationDigest()||plan.storage!==this.scope.storageConfigurationDigest
   ||plan.installationId!==this.storage.installationId)throw failure();
  const head=managedClosedHead(await this.control.observe(signal),this.storage.installationId);
  if(head.value.planDigest!==candidateHash(JSON.stringify(plan))||head.value.maintenanceEpoch!==plan.maintenanceEpoch)throw failure();
  const binding=bindingSchema.parse({installationId:plan.installationId,attemptId:head.value.attemptId,planDigest:head.value.planDigest,
   sourceSha:plan.sourceSha,maintenanceEpoch:plan.maintenanceEpoch,controlRevision:head.revision,retirementConfigurationDigest:this.configurationDigest()});
  const check=async()=>{signal?.throwIfAborted();const current=managedClosedHead(await this.control.observe(signal),this.storage.installationId);
   if(JSON.stringify(current)!==JSON.stringify(head)||JSON.stringify(scopeSchema.parse(this.provider.captureControlRetirementScope()))!==JSON.stringify(this.scope))throw failure();};
  const sameBinding=(raw:unknown)=>{if(JSON.stringify(bindingSchema.parse(raw))!==JSON.stringify(binding))throw failure();};
  const request=(raw:unknown)=>{const v=requestSchema.parse(raw);sameBinding(v.binding);
   if(JSON.stringify(v.scope)!==JSON.stringify(this.scope))throw failure();return artifact(v);};
  const observe=(raw:unknown)=>{const v=observationSchema.parse(raw),{observationDigest,...observation}=v;
   const facts={format:observation.format,kind:observation.kind,...scopeFrom(observation),observedAt:observation.observedAt,stateSha256:observation.stateSha256};
   if(observationDigest!==candidateHash(JSON.stringify(facts))||JSON.stringify(scopeFrom(v))!==JSON.stringify(this.scope))throw failure();return v;};
  const report=(raw:unknown)=>{const v=reportSchema.parse(raw);sameBinding(v.binding);observe(v.observation);
   return artifact(v);};
  const parseSaved=(raw:unknown,parse:(raw:unknown)=>MaintenanceArtifact)=>{const checked=parse(savedValue(raw));
   const original=raw as MaintenanceArtifact;if(checked.body!==original.body||checked.sha256!==original.sha256)throw failure();return checked;};
  const evidence=new S3MaintenanceArtifactStore({...this.storage,maintenance:{attemptId:binding.attemptId,planDigest:binding.planDigest,
   sourceSha:binding.sourceSha,maintenanceEpoch:binding.maintenanceEpoch}},this.credentials,{
   namespace:'capture-control',pinSchema:candidatePinSchema,limits:{BASELINE:8192,OBSERVATION:16384},
   baseline:raw=>raw&&typeof raw==='object'&&'body' in raw?parseSaved(raw,request):request(raw),
   parseObservation:raw=>parseSaved(raw,report),observationFromValue:report,
   assertPair:(a,b)=>{const before=requestSchema.parse(JSON.parse(a.body)),after=reportSchema.parse(JSON.parse(b.body));
    request(before);report(after);if(after.requestPin.kind!=='BASELINE'||after.requestPin.sha256!==a.sha256||after.requestPin.byteLength!==Buffer.byteLength(a.body))throw failure();},failure},this.client);
  return{binding,check,evidence,observe};
 }
 async retire(rawPlan:unknown,caller?:AbortSignal){
  if(this.attempted)throw failure();this.attempted=true;
  try{
   const c=await this.context(rawPlan,caller);await c.check();
   // Original conditional PUT + exact version readback must return before any
   // provider mutation. Cold discovery below never supplies this live ACK.
   const requestPin=await c.evidence.publishBaseline({format:1,kind:'MANAGED_CAPTURE_CONTROL_RETIREMENT_REQUEST_V1',binding:c.binding,
    scope:this.scope,executionState:'REQUESTED_ONLY',actionAuthorized:false},caller);
   await c.check();const observation=await this.provider.retireCaptureControl(caller);await c.check();
   const report={format:1,kind:'MANAGED_CAPTURE_CONTROL_RETIREMENT_REPORT_V1',binding:c.binding,requestPin,observation,
    originalDeleteAcknowledgementObserved:true,savedObservationAuthorizesExecution:false,actionAuthorized:false};
   const reportPin=await c.evidence.publishObservation(report,requestPin,caller);await c.check();
   return{requestPin,reportPin,report:reportSchema.parse(report),wholeBackendQuiesced:false as const,actionAuthorized:false as const};
  }catch{throw failure();}
 }
 /** Saved report and current metadata are distinct observations. No DELETE, PUT,
  * replay, admission or original acknowledgement recovery is available here. */
 async inspect(rawPlan:unknown,caller?:AbortSignal){
  try{
   const c=await this.context(rawPlan,caller),request=await c.evidence.inspectCandidateArtifact('BASELINE',caller);
   const saved=await c.evidence.inspectCandidateArtifact('OBSERVATION',caller);
   const pair=await c.evidence.observeObservation(saved.pin,request.pin,caller),report=reportSchema.parse(JSON.parse(pair.body));
   if(JSON.stringify(report.requestPin)!==JSON.stringify(request.pin))throw failure();
   const current=c.observe(await this.provider.observeCaptureControlRetired(caller));await c.check();
   return{requestPin:request.pin,reportPin:saved.pin,report,current,originalAcknowledgementReconstructed:false as const,
    savedObservationAuthorizesExecution:false as const,wholeBackendQuiesced:false as const,actionAuthorized:false as const};
  }catch{throw failure();}
 }
}
