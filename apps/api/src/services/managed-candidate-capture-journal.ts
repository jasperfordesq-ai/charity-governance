import {ManagedProofJobCustody} from './managed-proof-job-custody.js';
import {ManagedPlanBootstrap,managedClosedHead} from './managed-plan-bootstrap.js';
import {requireProtocol9ClosedHead,type S3ManagedMaintenanceControl} from './managed-maintenance-control.js';
import {discoverManagedCandidateCatalogue} from './managed-candidate-catalogue.js';
import {z} from 'zod';
import {S3Client,type S3ClientConfig} from '@aws-sdk/client-s3';
import {S3MaintenanceArtifactStore} from './maintenance-artifact-store.js';
import {candidatePinSchema,candidateHash} from './managed-candidate-capture-contract.js';
import {commonCaptureObjectInventory,anyCandidateBindingSchema as candidateBindingSchema,candidateRequestArtifact,candidateReportArtifact,parseCandidateRequest,parseCandidateReport,assertCandidatePair} from './managed-common-candidate-contract.js';
import type {ArchivedRecoverySets} from './archived-recovery-set.js';
const storageSchema=z.object({installationId:z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
 bucket:z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),accountId:z.string().regex(/^\d{12}$/),
 kmsKeyArn:z.string().regex(/^arn:aws:kms:eu-west-1:\d{12}:key\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)}).strict()
 .refine(s=>s.kmsKeyArn.split(':')[4]===s.accountId);
const failure=()=>new Error('Managed candidate journal is unresolved; inspect original records without replay or admission');
type Binding=z.infer<typeof candidateBindingSchema>;
/** Immutable request/result custody. Inspection never issues an execution lease,
 * retries a write, fills a missing result or makes a live recovery decision. */
export class ManagedCandidateCaptureJournal {
 private readonly storage:z.infer<typeof storageSchema>;
 private readonly client:S3Client;
 private readonly bootstrap:ManagedPlanBootstrap;
 private readonly sessions=new Map<string,{bindingDigest:string,session:CandidateSession}>();
 constructor(raw:unknown,private readonly credentials:NonNullable<S3ClientConfig['credentials']>,client?:S3Client){
  this.storage=storageSchema.parse(raw);if(!credentials)throw failure();
  this.client=client??new S3Client({region:'eu-west-1',endpoint:'https://s3.eu-west-1.amazonaws.com',credentials,
   maxAttempts:1,followRegionRedirects:false,requestHandler:{connectionTimeout:5000,requestTimeout:15000,throwOnRequestTimeout:true}});
  this.bootstrap=new ManagedPlanBootstrap(this.storage,this.client);
 }
 configurationDigest(){return candidateHash(JSON.stringify({format:1,policy:'IMMUTABLE_CANDIDATE_REQUEST_REPORT_V1',...this.storage}));}
 publishPlanBootstrap(plan:unknown,head:unknown,signal?:AbortSignal){return this.bootstrap.publish(plan,head,signal);}
 observePlanBootstrap(head:unknown,signal?:AbortSignal){return this.bootstrap.observe(head,signal);}
 /** Current live head supplies plan identity; descriptor supplies its verified
  * preimage. No local candidate IDs, source SHA, plan or epoch inference. */
 async discoverCurrentCandidates(control:S3ManagedMaintenanceControl,minimumEpoch:number,caller?:AbortSignal){
  if(!Number.isInteger(minimumEpoch)||minimumEpoch<1||minimumEpoch>2147483647)throw failure();
  const controller=new AbortController(),signal=caller?AbortSignal.any([caller,controller.signal]):controller.signal;
  const timer=setTimeout(()=>controller.abort(),300000);let stop:()=>void=()=>{};
  const cancelled=new Promise<never>((_,reject)=>{stop=()=>reject(failure());signal.addEventListener('abort',stop,{once:true});});
  try{
   const head=async()=>{signal.throwIfAborted();const value=requireProtocol9ClosedHead(await Promise.race([control.observe(signal),cancelled]));
    signal.throwIfAborted();if(value.value.installationId!==this.storage.installationId||value.value.maintenanceEpoch<minimumEpoch)throw failure();return value;};
   const before=await head(),saved=await this.bootstrap.observe(before,signal);
   const catalogue=await this.discoverCandidates({attemptId:before.value.attemptId,planDigest:before.value.planDigest,
    sourceSha:saved.plan.sourceSha,maintenanceEpoch:before.value.maintenanceEpoch,controlRevision:before.revision},signal);
   for(const row of catalogue.records){
    if(saved.plan.format===10){if(row.binding.format!==4||row.binding.captureAuthorizationDigest!==saved.plan.captureAuthorization)throw failure();}
    else if(row.binding.format===4)throw failure();
   }
   const after=await head();if(after.revision!==before.revision)throw failure();
   return{kind:'MANAGED_CURRENT_CANDIDATE_BOOTSTRAP_V1' as const,head:managedClosedHead(before,this.storage.installationId),bootstrapPin:saved.pin,plan:saved.plan,catalogue,
    minimumEpoch,descriptorPlanDigestMatched:true as const,liveHeadStableAtBoundaries:true as const,
    monotonicHistoryVerified:false as const,currentTenantAuthorityVerified:false as const,sourceHostLossProven:false as const,
    originalAcknowledgementReconstructed:false as const,savedObservationAuthorizesExecution:false as const,
    archivedSetAdmitted:false as const,actionAuthorized:false as const};
  }catch{throw failure();}finally{clearTimeout(timer);signal.removeEventListener('abort',stop);controller.abort();}
 }
 discoverCandidates(raw:unknown,signal?:AbortSignal){
  return discoverManagedCandidateCatalogue({storage:this.storage,configurationDigest:this.configurationDigest(),client:this.client,
   forCandidate:binding=>this.forCandidate(binding)},raw,signal);
 }
 /** Cold read-only composition. No supplied candidate IDs/pins, original ACK
  * reconstruction, cleanup, current tenant authority or archive admission. */
 async inspectCurrentRecovery(control:S3ManagedMaintenanceControl,minimumEpoch:number,
  archive:Pick<ArchivedRecoverySets,'configurationDigest'|'verifySet'>,caller?:AbortSignal){
  const controller=new AbortController(),signal=caller?AbortSignal.any([caller,controller.signal]):controller.signal;
  const timer=setTimeout(()=>controller.abort(),300000);
  try{
   signal.throwIfAborted();const before=await this.discoverCurrentCandidates(control,minimumEpoch,signal);
   const records=[];let unresolvedCommonCandidates=0;
   for(const row of before.catalogue.records){
    signal.throwIfAborted();
    if(row.binding.format===2){records.push({candidateId:row.binding.candidateId,kind:'LEGACY_CAPTURE_NOT_COMMON' as const});continue;}
    let job:Awaited<ReturnType<ManagedCandidateCaptureJournal['discoverSourceJob']>>|null=null;
    let root:Awaited<ReturnType<ManagedCandidateCaptureJournal['verifyDiscoveredCommonRoot']>>|null=null;
    try{job=await this.discoverSourceJob(row.binding,signal);}catch{signal.throwIfAborted();}
    if(row.commonRoot){try{root=await this.verifyDiscoveredCommonRoot(row.binding,archive,signal);}catch{signal.throwIfAborted();}}
    const unresolved=!job||job.state!=='WORKER_EXIT_ACK_OBSERVED'||job.serviceIdentity?.format!==2
     ||job.daemon?.state!=='RECORDED_CLIENT_RESPONSES'||job.daemon.records.length<1||!root;
    if(unresolved)unresolvedCommonCandidates++;
    records.push({candidateId:row.binding.candidateId,kind:'COMMON_CAPTURE_RECOVERY_OBSERVATION' as const,
     jobStatus:job?'SAVED_RECORDS_VERIFIED' as const:'UNRESOLVED' as const,job,
     rootStatus:root?'ARCHIVE_VERIFIED_QUARANTINE_ONLY' as const:row.commonRoot?'UNRESOLVED' as const:'NOT_LISTED_AT_BOUNDARY' as const,root,
     unresolved,executionAuthorized:false as const,actionAuthorized:false as const});
   }
   // An original closed head is not a lease. Check it and the full catalogue
   // again after all potentially long archive reads, without cached fallback.
   const after=await this.discoverCurrentCandidates(control,minimumEpoch,signal);
   if(after.head.revision!==before.head.revision||JSON.stringify(after.bootstrapPin)!==JSON.stringify(before.bootstrapPin)
    ||after.catalogue.listingDigest!==before.catalogue.listingDigest
    ||JSON.stringify(after.catalogue.records)!==JSON.stringify(before.catalogue.records))throw failure();
   for(const record of records){
    if(record.kind!=='COMMON_CAPTURE_RECOVERY_OBSERVATION'||!record.job)continue;
    const row=before.catalogue.records.find(v=>v.binding.candidateId===record.candidateId)!;
    if(JSON.stringify(await this.discoverSourceJob(row.binding,signal))!==JSON.stringify(record.job))throw failure();
   }
   const finalHead=managedClosedHead(await control.observe(signal),this.storage.installationId);
   if(JSON.stringify(finalHead)!==JSON.stringify(before.head))throw failure();
   signal.throwIfAborted();
   return{kind:'MANAGED_CURRENT_RECOVERY_INSPECTION_V1' as const,bootstrap:before,records,unresolvedCommonCandidates,
    headAndCatalogueStableAtObservationBoundaries:true as const,atomicSnapshotVerified:false as const,restoreMode:'QUARANTINE_ONLY' as const,
    historyCompletenessVerified:false as const,monotonicHistoryVerified:false as const,currentTenantAuthorityVerified:false as const,
    sourceHostLossProven:false as const,daemonRequestsAccountedFor:false as const,writerFencingVerified:false as const,
    originalAcknowledgementReconstructed:false as const,archivedSetAdmitted:false as const,
    cleanupAuthorized:false as const,executionAuthorized:false as const,publicationAuthorized:false as const,actionAuthorized:false as const};
  }catch{throw failure();}finally{clearTimeout(timer);controller.abort();}
 }
 async verifyDiscoveredCommonRoot(raw:unknown,archive:Pick<ArchivedRecoverySets,'configurationDigest'|'verifySet'>,signal?:AbortSignal){
  const binding=candidateBindingSchema.parse(raw);
  if(binding.format===2||binding.archiveConfigurationDigest!==archive.configurationDigest())throw failure();
  const session=this.forCandidate(binding),request=await session.discoverRequest(signal),saved=await session.discoverReport(request.pin,signal);
  if(saved.value.kind==='MANAGED_QUARANTINED_STORAGE_CANDIDATE')throw failure();
  const result=await archive.verifySet(saved.value.rootReference.pin,undefined,signal),interval=result.snapshotInterval;
  if(result.completedIntervalBindingVerified!==true||!interval||interval.metadataWindow.observationDigest!==saved.value.metadataWindow.observationDigest
   ||JSON.stringify(interval.databaseSnapshot)!==JSON.stringify(saved.value.databaseSnapshot)||result.objectCount!==saved.value.capture.objects.length
   ||result.objectInventorySha256!==commonCaptureObjectInventory(saved.value))throw failure();
  return{root:result,requestPin:request.pin,reportPin:saved.pin,originalAcknowledgementReconstructed:false as const,
   savedObservationAuthorizesExecution:false as const,archivedSetAdmitted:false as const,actionAuthorized:false as const};
 }
 async discoverSourceJob(raw:unknown,signal?:AbortSignal){
  const session=this.forCandidate(raw),original=await session.discoverRequest(signal);return session.discoverSourceJob(original.pin,signal);
 }
 forCandidate(raw:unknown){
  const binding=candidateBindingSchema.parse(raw),bindingDigest=candidateHash(JSON.stringify(binding));
  if(binding.installationId!==this.storage.installationId||binding.journalConfigurationDigest!==this.configurationDigest())throw failure();
  const old=this.sessions.get(binding.candidateId);
  if(old){if(old.bindingDigest!==bindingDigest)throw failure();return old.session;}
  const session=new CandidateSession(this.storage,binding,this.credentials,this.client);
  this.sessions.set(binding.candidateId,{bindingDigest,session});return session;
 }
}
class CandidateSession {
 private readonly evidence:S3MaintenanceArtifactStore<z.infer<typeof candidatePinSchema>>;
 private readonly original:ReturnType<typeof candidateRequestArtifact>;
 private acknowledgedRequest:z.infer<typeof candidatePinSchema>|undefined;
 private reportAttempted=false;private jobs:ManagedProofJobCustody|undefined;
 constructor(private readonly storage:z.infer<typeof storageSchema>,private readonly binding:Binding,private readonly credentials:NonNullable<S3ClientConfig['credentials']>,private readonly client:S3Client){
  this.original=candidateRequestArtifact(binding);
  const match=(artifact:{body:string;sha256:string})=>{
   const parsed=parseCandidateRequest(artifact);if(parsed.artifact.body!==this.original.body)throw failure();return parsed.artifact;
  };
  const result=(artifact:{body:string;sha256:string})=>{
   const parsed=parseCandidateReport(artifact);if(JSON.stringify(parsed.value.binding)!==JSON.stringify(this.binding))throw failure();return parsed.artifact;
  };
  this.evidence=new S3MaintenanceArtifactStore({...storage,maintenance:{attemptId:binding.attemptId,planDigest:binding.planDigest,
   sourceSha:binding.sourceSha,maintenanceEpoch:binding.maintenanceEpoch}},credentials,
   {namespace:'capture-candidate',scopeDigest:candidateHash(binding.candidateId),pinSchema:candidatePinSchema,
    limits:{BASELINE:8192,OBSERVATION:128*1024*1024},baseline:raw=>match(parseCandidateRequest(raw).artifact),
    parseObservation:raw=>result(parseCandidateReport(raw).artifact),observationFromValue:raw=>result(candidateReportArtifact(raw)),
    assertPair:assertCandidatePair,failure},client);
 }
 /** Only this original conditional write + exact readback may precede live capture. */
 async reserve(signal?:AbortSignal){
  const pin=await this.evidence.publishBaseline(this.original,signal);this.acknowledgedRequest=candidatePinSchema.parse(pin);return pin;
 }
 closeExecution(){this.acknowledgedRequest=undefined;this.jobs?.closeExecution();}
 private jobCustody(){
  if(this.binding.format===2)throw failure();
  return this.jobs??=new ManagedProofJobCustody(this.storage,this.binding,this.credentials,this.client,pin=>!!this.acknowledgedRequest&&JSON.stringify(pin)===JSON.stringify(this.acknowledgedRequest));
 }
 reserveSourceJob(local:unknown,pin:unknown,signal?:AbortSignal){return this.jobCustody().reserve(local,pin,signal);}
 bindSourceJobService(local:unknown,pin:unknown,signal?:AbortSignal){return this.jobCustody().bindService(local,pin,signal);}
 reserveSourceDaemonHeader(local:unknown,pin:unknown,signal?:AbortSignal){return this.jobCustody().reserveDaemonHeader(local,pin,signal);}
 reserveSourceDaemonIntent(local:unknown,pin:unknown,signal?:AbortSignal){return this.jobCustody().reserveDaemonIntent(local,pin,signal);}
 bindSourceDaemonOwner(local:unknown,pin:unknown,signal?:AbortSignal){return this.jobCustody().bindDaemonOwner(local,pin,signal);}
 createSourceDaemonOwnerOutcomeWriter(pin:unknown){return this.jobCustody().createDaemonOwnerOutcomeWriter(pin);}
 createSourceDaemonOwnerOutcomeTransfer(pin:unknown,signal?:AbortSignal){return this.jobCustody().createDaemonOwnerOutcomeTransfer(pin,signal);}
 observeSourceDaemonResponse(local:unknown,pin:unknown,signal?:AbortSignal){return this.jobCustody().observeDaemonResponse(local,pin,signal);}
 finishSourceDaemonRequests(local:unknown,pin:unknown,signal?:AbortSignal){return this.jobCustody().finishDaemonRequests(local,pin,signal);}
 observeSourceJob(local:unknown,pin:unknown,signal?:AbortSignal){return this.jobCustody().observe(local,pin,signal);}
 async discoverSourceJob(pin:unknown,signal?:AbortSignal){await this.inspectRequest(pin,signal);return this.jobCustody().discover(pin,signal);}
 async inspectRequest(pin:unknown,signal?:AbortSignal){
  const artifact=await this.evidence.observeBaseline(pin,signal);
  return{artifact,value:parseCandidateRequest(artifact).value,savedObservationAuthorizesExecution:false as const};
 }
 async discoverRequest(signal?:AbortSignal){
  const saved=await this.evidence.inspectCandidateArtifact('BASELINE',signal);
  return{...saved,value:parseCandidateRequest(saved.artifact).value};
 }
 async publishReport(raw:unknown,requestPin:unknown,signal?:AbortSignal){
  const pin=candidatePinSchema.parse(requestPin);
  if(!this.acknowledgedRequest||JSON.stringify(this.acknowledgedRequest)!==JSON.stringify(pin)||this.reportAttempted)throw failure();
  this.reportAttempted=true;
  const snapshot=candidateReportArtifact(raw),report=parseCandidateReport(snapshot).value;
  if(JSON.stringify(report.requestPin)!==JSON.stringify(pin))throw failure();
  const value=JSON.parse(snapshot.body) as typeof report;
  const result=await this.evidence.publishObservation(value,pin,signal);
  return{pin:result,report:JSON.parse(snapshot.body) as typeof report};
 }
 async inspectReport(reportPin:unknown,requestPin:unknown,signal?:AbortSignal){
  const artifact=await this.evidence.observeObservation(reportPin,requestPin,signal),value=parseCandidateReport(artifact).value;
  if(JSON.stringify(value.requestPin)!==JSON.stringify(candidatePinSchema.parse(requestPin)))throw failure();
  return{artifact,value,originalAcknowledgementReconstructed:false as const,savedObservationAuthorizesExecution:false as const,
   archivedSetAdmitted:false as const,actionAuthorized:false as const};
 }
 async discoverReport(requestPin:unknown,signal?:AbortSignal){
  await this.inspectRequest(requestPin,signal);
  const saved=await this.evidence.inspectCandidateArtifact('OBSERVATION',signal);
  const checked=await this.inspectReport(saved.pin,requestPin,signal);return{...checked,pin:saved.pin};
 }
}
