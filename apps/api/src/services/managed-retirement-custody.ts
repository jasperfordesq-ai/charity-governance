import {z} from 'zod';
import type {S3Client,S3ClientConfig} from '@aws-sdk/client-s3';
import {candidateHash,candidatePinSchema} from './managed-candidate-capture-contract.js';
import {managedPlanSchema,managedClosedHead} from './managed-plan-bootstrap.js';
import {managedRetirementRecordSchemas as schemas,controlRetirementPolicyDigest,assertControlRetirementMetadata} from './managed-capture-control-retirement.js';
import {assertRetiredControlReadBaseline,assertRetiredControlReadObservation} from './retired-control-read-evidence.js';
import {S3MaintenanceArtifactStore} from './maintenance-artifact-store.js';
const sha=z.string().regex(/^[a-f0-9]{64}$/),artifactSchema=z.object({body:z.string().min(1).max(16384),sha256:sha}).strict();
const saved=z.object({pin:candidatePinSchema,artifact:artifactSchema}).strict();
export const managedRetirementBundleSchema=z.object({storage:schemas.storage,request:saved,readBaseline:saved,report:saved}).strict();
const failure=()=>new Error('Saved retirement custody is unverified; no original ACK or execution authority can be reconstructed');
function canonical(raw:unknown){const a=artifactSchema.parse(raw);if(Buffer.byteLength(a.body)>16384||candidateHash(a.body)!==a.sha256||JSON.stringify(JSON.parse(a.body))!==a.body)throw failure();return a;}
export function assertManagedRetirementBundle(raw:unknown,rawPlan:unknown,rawBinding:unknown){
 try{
  const b=managedRetirementBundleSchema.parse(raw),plan=managedPlanSchema.parse(rawPlan),binding=schemas.binding.parse(rawBinding);
  if(plan.format!==12||candidateHash(JSON.stringify(plan))!==binding.planDigest||plan.captureControlRetirement!==binding.retirementConfigurationDigest
   ||plan.installationId!==binding.installationId||plan.sourceSha!==binding.sourceSha||plan.maintenanceEpoch!==binding.maintenanceEpoch)throw failure();
  for(const [key,kind] of [['request','BASELINE'],['readBaseline','BASELINE'],['report','OBSERVATION']] as const){
   const row=b[key],a=canonical(row.artifact);if(row.pin.kind!==kind||row.pin.sha256!==a.sha256||row.pin.byteLength!==Buffer.byteLength(a.body))throw failure();
  }
  const request=schemas.request.parse(JSON.parse(b.request.artifact.body)),read=schemas.readBaseline.parse(JSON.parse(b.readBaseline.artifact.body)),report=schemas.report.parse(JSON.parse(b.report.artifact.body));
  if(request.format!==2||report.format!==2)throw failure();
  for(const row of [request,read,report])if(JSON.stringify(row.binding)!==JSON.stringify(binding))throw failure();
  if(JSON.stringify(request)!==b.request.artifact.body||JSON.stringify(read)!==b.readBaseline.artifact.body||JSON.stringify(report)!==b.report.artifact.body
   ||JSON.stringify(read.requestPin)!==JSON.stringify(b.request.pin)||JSON.stringify(report.requestPin)!==JSON.stringify(b.request.pin)
   ||JSON.stringify(report.readBaselinePin)!==JSON.stringify(b.readBaseline.pin)||request.scope.storageConfigurationDigest!==plan.storage
   ||controlRetirementPolicyDigest(b.storage,request.scope,request.readComparison)!==plan.captureControlRetirement
   ||candidateHash(JSON.stringify(request.readComparison))!==plan.captureControlReadComparison)throw failure();
  const baseline=assertRetiredControlReadBaseline(request.readComparison,read.readBaseline),refusal=assertRetiredControlReadObservation(request.readComparison,read.readBaseline,report.readRefusal);
  const metadata=assertControlRetirementMetadata(report.observation,request.scope);
  if(Date.parse(metadata.observedAt)<Date.parse(baseline.value.capturedAt)||Date.parse(refusal.startedAt)<Date.parse(metadata.observedAt))throw failure();
  return{bundle:b,plan,binding,request,readBaseline:read,report};
 }catch{throw failure();}
}
/** Read-only current fixed-record discovery. No provider token, capture JWT,
 * candidate ID, supplied original pin or mutable publication API is accepted. */
export class ManagedSavedRetirementCustody {
 readonly #storage:z.infer<typeof schemas.storage>;
 readonly #credentials:NonNullable<S3ClientConfig['credentials']>;
 readonly #client:S3Client;
 constructor(raw:unknown,credentials:NonNullable<S3ClientConfig['credentials']>,client:S3Client){this.#storage=schemas.storage.parse(raw);if(!credentials)throw failure();this.#credentials=credentials;this.#client=client;}
 async inspect(rawHead:unknown,rawPlan:unknown,caller?:AbortSignal){
  try{
   const head=managedClosedHead(rawHead,this.#storage.installationId),plan=managedPlanSchema.parse(rawPlan);
   if(plan.format!==12||head.value.planDigest!==candidateHash(JSON.stringify(plan)))throw failure();
   const binding=schemas.binding.parse({installationId:this.#storage.installationId,attemptId:head.value.attemptId,planDigest:head.value.planDigest,sourceSha:plan.sourceSha,
    maintenanceEpoch:head.value.maintenanceEpoch,controlRevision:head.revision,retirementConfigurationDigest:plan.captureControlRetirement});
   return await this.inspectBoundRecords(binding,plan,caller);
  }catch{throw failure();}
 }
 /** Historical binding only: this does not assert that the supplied revision is
  * the current control head. The caller must establish current authority. */
 async inspectBoundRecords(rawBinding:unknown,rawPlan:unknown,caller?:AbortSignal){
  try{
   const binding=schemas.binding.parse(rawBinding),plan=managedPlanSchema.parse(rawPlan);
   if(binding.installationId!==this.#storage.installationId||plan.format!==12||binding.planDigest!==candidateHash(JSON.stringify(plan)))throw failure();
   const store=(namespace:'capture-control'|'capture-control-read')=>new S3MaintenanceArtifactStore({...this.#storage,maintenance:{attemptId:binding.attemptId,planDigest:binding.planDigest,sourceSha:binding.sourceSha,maintenanceEpoch:binding.maintenanceEpoch}},this.#credentials,{
    namespace,pinSchema:candidatePinSchema,limits:{BASELINE:8192,OBSERVATION:16384},baseline:canonical,parseObservation:canonical,
    observationFromValue:()=>{throw failure();},assertPair:()=>{throw failure();},failure},this.#client);
   const control=store('capture-control'),canary=store('capture-control-read');
   const request=await control.inspectCandidateArtifact('BASELINE',caller),read=await canary.inspectCandidateArtifact('BASELINE',caller),report=await control.inspectCandidateArtifact('OBSERVATION',caller);
   const bundle={storage:this.#storage,request:{pin:request.pin,artifact:request.artifact},readBaseline:{pin:read.pin,artifact:read.artifact},report:{pin:report.pin,artifact:report.artifact}};
   return{...assertManagedRetirementBundle(bundle,plan,binding),originalAcknowledgementReconstructed:false as const,savedObservationAuthorizesExecution:false as const,
    atomicSnapshotVerified:false as const,currentProviderFencingVerified:false as const,currentTenantAuthorityVerified:false as const,actionAuthorized:false as const};
  }catch{throw failure();}
 }
}
