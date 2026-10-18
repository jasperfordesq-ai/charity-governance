import {commonCandidateRequestSchema,commonCandidateBindingSchema,commonCandidateReportSchema,anyCommonCandidateBindingSchema,readRoleCommonCandidateRequestSchema,readRoleCommonCandidateBindingSchema,readRoleCommonCandidateReportSchema} from './managed-common-candidate-contract.js';
import type {ArchivedRecoverySets} from './archived-recovery-set.js';
import type {ManagedDatabaseSnapshot} from './managed-storage-metadata-window.js';
import {managedSnapshotInterval,type ManagedSnapshotInterval} from './managed-snapshot-interval.js';
import {requireProtocol9ClosedHead} from './managed-maintenance-control.js';
import type {ManagedCandidateCaptureJournal} from './managed-candidate-capture-journal.js';
import {candidateRequestSchema as candidateRequest,candidateBindingSchema,candidatePinSchema,legacySupabaseCaptureSchema,type ManagedLegacySupabaseCapture} from './managed-candidate-capture-contract.js';
import type {SupabaseRecoveryCapture} from './supabase-recovery-capture.js';
import type {ManagedStorageMetadataWindow} from './managed-storage-metadata-window.js';
import type {ManagedS3MaintenanceEvidence} from './managed-s3-maintenance-evidence.js';
import type {ManagedSignedResumableUploadEvidence} from './managed-signed-resumable-upload-evidence.js';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {RenderMaintenanceControl} from './render-maintenance-control.js';
import type {ManagedDatabaseWriterFence} from './managed-database-writer-fence.js';
import type {S3ManagedMaintenanceControl} from './managed-maintenance-control.js';
import type {SupabaseStorageWriterControl} from './supabase-storage-writer-control.js';
import type {SupabaseCredentialReadProof} from './supabase-credential-read-proof.js';
import type {ManagedStorageWriteEvidence} from './managed-storage-write-evidence.js';
import type {ManagedResumableUploadEvidence} from './managed-resumable-upload-evidence.js';
import type {ManagedSignedUploadEvidence} from './managed-signed-upload-evidence.js';
import {signedUploadBaselineSchema,signedUploadObservationSchema} from './signed-upload-evidence-contract.js';
import {credentialWriteObservationSchema} from './credential-write-evidence.js';
import type {ManagedReadRoleCapture} from './managed-read-role-capture.js';
import type {ManagedCaptureControlRetirement} from './managed-capture-control-retirement.js';
import {readRoleSupabaseCaptureSchema,type ManagedReadRoleCapturedFiles} from './managed-read-role-capture-contract.js';

const configuration=z.object({installationId:z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
 sourceSha:z.string().regex(/^[a-f0-9]{40}$/),maintenanceEpoch:z.number().int().positive().max(2147483647)}).strict();
const failure='Managed backend maintenance is unresolved; preserve closed writers and inspect the original attempt without repeating shutdown';

/** Coordinates actual component primitives, never resumes/migrates/reopens.
 * The independent installation guard must already exist for this exact plan.
 * A guarded attempt is NOT tenant authority, provider IAM/credential rotation,
 * protection from an already-dispatched external request or physical host loss. */
export class ManagedBackendMaintenance {
 private readonly config:z.infer<typeof configuration>;
 constructor(raw:unknown,private readonly provider:RenderMaintenanceControl,
  private readonly database:ManagedDatabaseWriterFence,private readonly control:S3ManagedMaintenanceControl,
  private readonly storage:SupabaseStorageWriterControl,private readonly proof:SupabaseCredentialReadProof,private readonly write:ManagedStorageWriteEvidence,private readonly signed:ManagedSignedUploadEvidence,private readonly resumable:ManagedResumableUploadEvidence,private readonly signedResumable:ManagedSignedResumableUploadEvidence,private readonly s3:ManagedS3MaintenanceEvidence,private readonly readRole?:ManagedReadRoleCapture,private readonly retirement?:ManagedCaptureControlRetirement){
  this.config=configuration.parse(raw);
  this.s3.assertStorageScope(this.storage.s3FeatureProofScope(),this.storage.configurationDigest(this.config.installationId));
  this.proof.assertStorageScope(this.storage.readProofScope());
  this.write.assertStorageScope(this.storage.readProofScope());
  this.signed.assertStorageScope(this.storage.readProofScope());
  this.resumable.assertStorageScope(this.storage.readProofScope());
  this.signedResumable.assertStorageScope(this.storage.readProofScope());
  this.signedResumable.assertSignedScope(this.signed.configurationDigest(this.config.installationId));
  this.readRole?.assertMaintenanceScope(this.config);this.readRole?.assertStorageScope(this.storage.candidateCaptureScope());
  if(this.retirement){if(!this.readRole)throw new Error(failure);this.retirement.assertCoordinatorScope(this.config.installationId,this.storage,this.control);}
 }
 planDescriptor(){const descriptor={format:9,...this.config,
  databaseCredentialPolicy:'PASSWORD_NULL_WHILE_CLOSED',
  storageCredentialPolicy:'REVOKE_REVIEWED_KEYS_KEEP_CAPTURE_V1',
  readProofPolicy:'INDEPENDENT_BASELINE_BEFORE_CREDENTIAL_REVOCATION_V1',
  writeProofPolicy:'EXACT_VERSION_BASELINE_PIN_BEFORE_REVOCATION_V1',signedProofPolicy:'ORIGINAL_ENCRYPTED_TOKEN_AND_BASELINE_PIN_BEFORE_REVOCATION_V1',resumableProofPolicy:'ALL_CONFIGURED_ORIGINAL_TUS_MANIFEST_BEFORE_REVOCATION_V1',signedResumableProofPolicy:'ORIGINAL_SIGNED_TUS_BASELINE_PIN_BEFORE_REVOCATION_V1',s3ProofPolicy:'EXPLICIT_MODE_ORIGINAL_S3_BASELINE_BEFORE_CLOSURE_V1',
  provider:this.provider.configurationDigest(),database:this.database.configurationDigest(),storage:this.storage.configurationDigest(this.config.installationId),
  readProof:this.proof.configurationDigest(this.config.installationId),writeProof:this.write.configurationDigest(this.config.installationId),signedProof:this.signed.configurationDigest(this.config.installationId),resumableProof:this.resumable.configurationDigest(this.config.installationId),signedResumableProof:this.signedResumable.configurationDigest(this.config.installationId),s3Proof:this.s3.configurationDigest(this.config.installationId)};
  if(!this.readRole)return descriptor;this.readRole.assertMaintenanceScope(this.config);this.readRole.assertStorageScope(this.storage.candidateCaptureScope());
  const readRolePlan={...descriptor,format:10,capturePolicy:'EXPLICIT_JWT_SQL_PRIVILEGE_AND_METADATA_WINDOW_V1',captureAuthorization:this.readRole.configurationDigest()};
  if(!this.retirement)return readRolePlan;this.retirement.assertCoordinatorScope(this.config.installationId,this.storage,this.control);
  return{...readRolePlan,format:11,storageCredentialPolicy:'REVOKE_REVIEWED_KEYS_THEN_RETIRE_CAPTURE_CONTROL_V1',captureControlRetirement:this.retirement.configurationDigest()};}
 planDigest(){return createHash('sha256').update(JSON.stringify(this.planDescriptor())).digest('hex');}
 private async readback(readProofDigest?:string,writeProofDigest?:string,signedProofDigest?:string,resumableProofDigest?:string,signedResumableProofDigest?:string,s3ProofDigest?:string,retiredStorageDigest?:string){
  const services=await this.provider.observeSuspended(),database=await this.database.observePasswordsInvalidated();
  let storageDigest=retiredStorageDigest;
  if(!storageDigest){const storage=await this.storage.observeClosed();if(storage.configuredAccessPathsObservedClosed!==true)throw new Error(failure);storageDigest=storage.observationDigest;}
  const signing=await this.signed.observeRevoked();
  return{servicesDigest:services.observationDigest,databaseDigest:database.observationDigest,storageDigest,signingDigest:signing.observationDigest,
   ...(readProofDigest?{readProofDigest}:{}),...(writeProofDigest?{writeProofDigest}:{}),...(signedProofDigest?{signedProofDigest}:{}),...(resumableProofDigest?{resumableProofDigest}:{}),...(signedResumableProofDigest?{signedResumableProofDigest}:{}),...(s3ProofDigest?{s3ProofDigest}:{}),observedAt:new Date().toISOString()};
 }
 async close(){
  try{
   if(this.readRole&&(await this.readRole.observeCompatibility()).catalogueLockAclPredicatesObserved!==true)throw new Error();
   const attempt=await this.control.acquire(this.config.installationId,this.planDigest(),this.config.maintenanceEpoch);
   if(attempt.value.installationId!==this.config.installationId||attempt.value.phase!=='ATTEMPTED'||!attempt.value.attemptId)throw new Error();
   const binding={attemptId:attempt.value.attemptId,planDigest:this.planDigest(),sourceSha:this.config.sourceSha,maintenanceEpoch:this.config.maintenanceEpoch};
   const baseline=this.proof.assertBaseline(await this.proof.baseline(undefined,binding),binding);
   const pinned=await this.control.recordReadBaseline(attempt.value.attemptId,attempt.revision,baseline);
   if(pinned.value.phase!=='BASELINED'||!pinned.value.readBaseline)throw new Error();
   const retained=this.proof.assertBaseline(pinned.value.readBaseline,binding);
   const writer=this.write.forAttempt(binding),writeBaseline=writer.probe.assertBaseline(await writer.probe.baseline());
   const writeBaselinePin=await writer.evidence.publishBaseline(writeBaseline);
   const writeReady=await this.control.recordWriteBaselinePin(attempt.value.attemptId,pinned.revision,writeBaselinePin);
   if(writeReady.value.phase!=='WRITE_BASELINED'||!writeReady.value.writeBaselinePin)throw new Error();
   const savedWriteBaseline=writer.probe.assertBaseline(await writer.evidence.observeBaseline(writeReady.value.writeBaselinePin));
   if(savedWriteBaseline.sha256!==writeBaseline.sha256)throw new Error();
   const signer=this.signed.forAttempt(binding),signedBaseline=signer.probe.assertBaseline(await signer.probe.baseline((input,signal)=>signer.vault.retain(input,signal)),signer.vault.configurationDigest());
   const signedBaselinePin=await signer.evidence.publishBaseline(signedBaseline);
   const signedReady=await this.control.recordSignedBaselinePin(attempt.value.attemptId,writeReady.revision,signedBaselinePin);
   if(signedReady.value.phase!=='SIGNED_BASELINED'||!signedReady.value.signedBaselinePin)throw new Error();
   const savedSignedBaseline=signer.probe.assertBaseline(await signer.evidence.observeBaseline(signedReady.value.signedBaselinePin),signer.vault.configurationDigest());
   if(savedSignedBaseline.sha256!==signedBaseline.sha256)throw new Error();
   const resumable=this.resumable.forAttempt(binding),resumableBaselinePin=await resumable.baseline();
   const resumableReady=await this.control.recordResumableBaselinePin(attempt.value.attemptId,signedReady.revision,resumableBaselinePin);
   if(resumableReady.value.phase!=='RESUMABLE_BASELINED'||!resumableReady.value.resumableBaselinePin)throw new Error();
   const savedResumable=await resumable.observeBaseline(resumableReady.value.resumableBaselinePin);
   if(savedResumable.artifact.sha256!==resumableBaselinePin.sha256)throw new Error();
   const signedTus=this.signedResumable.forAttempt(binding),signedResumableBaselinePin=await signedTus.baseline();
   const signedTusReady=await this.control.recordSignedResumableBaselinePin(attempt.value.attemptId,resumableReady.revision,signedResumableBaselinePin);
   if(signedTusReady.value.phase!=='SIGNED_RESUMABLE_BASELINED'||!signedTusReady.value.signedResumableBaselinePin)throw new Error();
   const savedSignedTus=await signedTus.observeBaseline(signedTusReady.value.signedResumableBaselinePin);
   if(savedSignedTus.artifact.sha256!==signedResumableBaselinePin.sha256)throw new Error();
   const s3=this.s3.forAttempt(binding),s3BaselinePin=await s3.baseline();
   const ready=await this.control.recordS3BaselinePin(attempt.value.attemptId,signedTusReady.revision,s3BaselinePin);
   if(ready.value.phase!=='S3_BASELINED'||!ready.value.s3BaselinePin)throw new Error();
   const savedS3=await s3.observeBaseline(ready.value.s3BaselinePin);
   if(savedS3.artifact.sha256!==s3BaselinePin.sha256)throw new Error();
   await this.provider.suspend();
   await this.database.close();
   await this.database.invalidatePasswords();
   await this.storage.close();
   await this.signed.revokeReviewed();
   const readObservation=await this.proof.verifyReadRefusal(retained.body,retained.sha256);
   const writeObservation=await writer.probe.verifyWriteRefusal(savedWriteBaseline.body,savedWriteBaseline.sha256);
   const writeObservationPin=await writer.evidence.publishObservation(writeObservation,ready.value.writeBaselinePin);
   const original=signedUploadBaselineSchema.parse(JSON.parse(savedSignedBaseline.body));
   const signedObservation=await signer.vault.withCredential(original.credentialPin,original.credentialReference,(secret,signal)=>signer.probe.verifyRefusal(savedSignedBaseline.body,savedSignedBaseline.sha256,secret,signal));
   const signedObservationPin=await signer.evidence.publishObservation(signedObservation,ready.value.signedBaselinePin);
   const resumableObservation=await resumable.verifyRefusal(ready.value.resumableBaselinePin);
   const signedTusObservation=await signedTus.verifyRefusal(ready.value.signedResumableBaselinePin);
   const s3Observation=await s3.verifyRefusal(ready.value.s3BaselinePin);
   const observations=await this.readback(readObservation.observationDigest,writeObservation.observationDigest,signedObservation.observationDigest,resumableObservation.observationDigest,signedTusObservation.observationDigest,s3Observation.observationDigest);
   const checkedS3=await s3.observeObservation(s3Observation.pin,ready.value.s3BaselinePin);
   if(checkedS3.observationDigest!==s3Observation.observationDigest||Math.abs(Date.now()-Date.parse(checkedS3.observedAt))>180000)throw new Error();
   const recorded=await this.control.recordObservedClosed(attempt.value.attemptId,ready.revision,observations,readObservation,writeObservationPin,signedObservationPin,resumableObservation.pin,signedTusObservation.pin,s3Observation.pin);
   return{phase:recorded.value.phase,attemptId:recorded.value.attemptId,observations,
    ...(this.retirement?{captureControlRetirementRequired:true as const,captureControlRetirementAcknowledged:false as const}:{}),
    configuredS3CoverageObserved:true as const,s3Mode:s3Observation.mode,s3Coverage:s3Observation.coverage,s3BaselinePin:recorded.value.s3BaselinePin,s3ObservationPin:recorded.value.s3ObservationPin,
    credentialReadRefusalsObserved:true as const,readBaselineSha256:retained.sha256,readObservationSha256:recorded.value.readObservation?.sha256,
    testedSignedResumablePatchRefusalObserved:true as const,signedResumableBaselinePin:recorded.value.signedResumableBaselinePin,signedResumableObservationPin:recorded.value.signedResumableObservationPin,
    resumableCredentialCohortRefusalsObserved:true as const,resumableBaselinePin:recorded.value.resumableBaselinePin,resumableObservationPin:recorded.value.resumableObservationPin,
    testedSignedUploadRefusalObserved:true as const,signedBaselinePin:recorded.value.signedBaselinePin,signedObservationPin:recorded.value.signedObservationPin,
    standardWriteRefusalsObserved:true as const,writeBaselinePin:recorded.value.writeBaselinePin,writeObservationPin:recorded.value.writeObservationPin,
    storageAccessPathsObservedClosed:true as const,databasePasswordCredentialsInvalidated:true as const,wholeBackendQuiesced:false as const,storageTokenIssuerVerified:false as const,providerReleaseAttested:false as const,signedCapabilitiesRevoked:false as const,resumableSessionsRevoked:false as const,inFlightWritesDrained:false as const,credentialRotationVerified:false as const,
    currentTenantAuthorityVerified:false as const,sourceHostFenced:false as const,reopeningAuthorised:false as const,actionAuthorized:false as const};
  }catch{throw new Error(failure);}
 }
 /** Explicit declarative bootstrap publication, never an execution receipt. */
 async publishCaptureBootstrap(journal:ManagedCandidateCaptureJournal,caller?:AbortSignal){
  try{
   caller?.throwIfAborted();const before=requireProtocol9ClosedHead(await this.control.observe(caller));
   if(before.value.installationId!==this.config.installationId||before.value.maintenanceEpoch!==this.config.maintenanceEpoch
    ||before.value.planDigest!==this.planDigest())throw new Error();
   await this.inspect();if((await this.control.observe(caller)).revision!==before.revision)throw new Error();
   const published=await journal.publishPlanBootstrap(this.planDescriptor(),before,caller);
   if((await this.control.observe(caller)).revision!==before.revision)throw new Error();return published;
  }catch{throw new Error('Managed capture bootstrap publication is unresolved; inspect original configuration without repeating publication');}
 }
 /** Candidate-only composition. Partial visitor archives stay quarantined after
  * any unresolved outcome. Never advances control, retries, admits or reopens. */
 async captureQuarantined(raw:unknown,capture:SupabaseRecoveryCapture,window:ManagedStorageMetadataWindow,journal:ManagedCandidateCaptureJournal,
  visit:Parameters<SupabaseRecoveryCapture['capture']>[0],caller?:AbortSignal){
  let session:ReturnType<ManagedCandidateCaptureJournal['forCandidate']>|undefined,liveAcknowledged=false;
  try{
   if(this.readRole)throw new Error(); // Protocol10 must never use the legacy key path.
   const request=candidateRequest.parse(raw);caller?.throwIfAborted();
   capture.assertStorageScope(this.storage.candidateCaptureScope());
   if(request.captureConfigurationDigest!==capture.configurationDigest()
    ||request.metadataWindowConfigurationDigest!==window.configurationDigest()||request.journalConfigurationDigest!==journal.configurationDigest())throw new Error();
   const checkHead=async()=>{
    caller?.throwIfAborted();const head=await this.control.observe();caller?.throwIfAborted();
    if(head.revision!==request.controlRevision||head.value.attemptId!==request.attemptId
     ||head.value.phase!=='OBSERVED_CLOSED'||head.value.planDigest!==this.planDigest()
     ||head.value.installationId!==this.config.installationId||head.value.maintenanceEpoch!==this.config.maintenanceEpoch)throw new Error();
    return head;
   };
   await checkHead();await this.inspect();const preparedHead=await checkHead();
   await journal.observePlanBootstrap(preparedHead,caller);await checkHead();
   const binding=candidateBindingSchema.parse({format:2,kind:'MANAGED_QUARANTINED_STORAGE_CAPTURE_V2',...this.config,...request,planDigest:this.planDigest()});
   session=journal.forCandidate(binding);const requestPin=await session.reserve(caller);liveAcknowledged=true;await checkHead();
   const guarded=await window.run(signal=>capture.capture(visit,signal),caller);
   await checkHead();await this.inspect();await checkHead();
   if(guarded.value.configurationDigest!==request.captureConfigurationDigest
    ||guarded.evidence.configurationDigest!==request.metadataWindowConfigurationDigest)throw new Error();
   const report={kind:'MANAGED_QUARANTINED_STORAGE_CANDIDATE' as const,binding,
    bindingDigest:createHash('sha256').update(JSON.stringify(binding)).digest('hex'),
    requestPin,capture:guarded.value,metadataWindow:guarded.evidence,restoreMode:'QUARANTINE_ONLY' as const,
    controlRevisionVerifiedAtBoundaries:true as const,wholeBackendQuiesced:false as const,
    objectBytesFenced:false as const,currentTenantAuthorityVerified:false as const,
    archivedSetAdmitted:false as const,actionAuthorized:false as const};
   const candidate={...report,observationDigest:createHash('sha256').update(JSON.stringify(report)).digest('hex')};
   const stored=await session.publishReport(candidate,requestPin,caller);await checkHead();
   return{candidate:stored.report,requestPin,reportPin:stored.pin,savedObservationAuthorizesExecution:false as const,restoreMode:'QUARANTINE_ONLY' as const,archivedSetAdmitted:false as const,actionAuthorized:false as const};
  }catch{throw new Error('Managed storage candidate capture is unresolved; preserve quarantined artifacts without admission or automatic retry');}
  finally{if(liveAcknowledged)session?.closeExecution();}
 }
 /** Common candidate execution. The saved root reference precedes the final
  * root write, so an unknown final ACK remains discoverable without replay. */
 async captureCommonQuarantined(raw:unknown,capture:SupabaseRecoveryCapture,window:ManagedStorageMetadataWindow,
  journal:ManagedCandidateCaptureJournal,archive:ArchivedRecoverySets,
  source:(snapshot:ManagedDatabaseSnapshot,signal:AbortSignal,context:Readonly<{kind:'COMMON_CANDIDATE';bindingDigest:string;requestPinDigest:string;sourceSha:string;jobCustody:Readonly<{reserve:(artifact:unknown)=>Promise<unknown>;observe:(artifact:unknown)=>Promise<unknown>;bindService:(artifact:unknown)=>Promise<unknown>;reserveDaemonHeader:(artifact:unknown)=>Promise<unknown>;reserveDaemonIntent:(artifact:unknown)=>Promise<unknown>;bindDaemonOwner:(artifact:unknown)=>Promise<unknown>;createDaemonOwnerOutcomeWriter:()=>Promise<Readonly<{publish:(artifact:unknown,signal?:AbortSignal)=>Promise<unknown>;revoke:()=>void}>>;createDaemonOwnerOutcomeTransfer:()=>Promise<Readonly<{take:()=>Promise<unknown>;claim:(nonce:string,digest:string)=>Promise<boolean>;observeReceipt:(artifact:unknown,receipt:unknown)=>Promise<unknown>;confirmReady:()=>Promise<boolean>;abandon:()=>void}>>;observeDaemonResponse:(artifact:unknown)=>Promise<unknown>;finishDaemonRequests:(artifact:unknown)=>Promise<unknown>}>}>)=>Promise<{
   visit:Parameters<SupabaseRecoveryCapture['capture']>[0];
   prepareArchiveInput:(captured:ManagedLegacySupabaseCapture,interval:ManagedSnapshotInterval,signal?:AbortSignal)=>Promise<unknown>;
  }>,caller?:AbortSignal){
  let session:ReturnType<ManagedCandidateCaptureJournal['forCandidate']>|undefined,acknowledged=false;
  try{
   if(this.readRole)throw new Error(); // No silent downgrade of the pinned capture policy.
   const request=commonCandidateRequestSchema.parse(raw);caller?.throwIfAborted();
   capture.assertStorageScope(this.storage.candidateCaptureScope());
   if(typeof source!=='function'||request.captureConfigurationDigest!==capture.configurationDigest()
    ||request.metadataWindowConfigurationDigest!==window.configurationDigest()||request.journalConfigurationDigest!==journal.configurationDigest()
    ||request.archiveConfigurationDigest!==archive.configurationDigest())throw new Error();
   const check=async()=>{caller?.throwIfAborted();const head=requireProtocol9ClosedHead(await this.control.observe(caller));
    if(head.revision!==request.controlRevision||head.value.attemptId!==request.attemptId||head.value.planDigest!==this.planDigest()
     ||head.value.installationId!==this.config.installationId||head.value.maintenanceEpoch!==this.config.maintenanceEpoch)throw new Error();return head;};
   await check();await this.inspect();await journal.observePlanBootstrap(await check(),caller);await check();
   const binding=commonCandidateBindingSchema.parse({format:3,kind:'MANAGED_QUARANTINED_COMMON_CAPTURE_V3',...this.config,...request,planDigest:this.planDigest()});
   session=journal.forCandidate(binding);const requestPin=await session.reserve(caller);acknowledged=true;await check();
   const guarded=await window.runWithSnapshot(async(snapshot,signal)=>{
    const context=this.commonSourceContext(binding,session!,requestPin,signal,check);
    const prepared=await source(snapshot,signal,context);signal.throwIfAborted();
    if(typeof prepared.visit!=='function'||typeof prepared.prepareArchiveInput!=='function')throw new Error();
    const visit=prepared.visit,prepareArchiveInput=prepared.prepareArchiveInput;
    const captured=legacySupabaseCaptureSchema.parse(await capture.capture(visit,signal));return{captured,prepareArchiveInput};
   },caller);
   await check();await this.inspect();await check();
   const interval=managedSnapshotInterval({metadataWindow:guarded.evidence,databaseSnapshot:guarded.databaseSnapshot});
   const input=await guarded.value.prepareArchiveInput(guarded.value.captured,interval,caller);await check();
   const prepared=await archive.prepareImported(input,interval,caller);await check();
   const staged=await archive.stagePrepared(prepared.pin,prepared.artifact,caller);await check();
   const parsed=commonCandidateReportSchema.parse({kind:'MANAGED_QUARANTINED_COMMON_CANDIDATE',binding,
    bindingDigest:createHash('sha256').update(JSON.stringify(binding)).digest('hex'),requestPin,capture:guarded.value.captured,
    metadataWindow:guarded.evidence,databaseSnapshot:guarded.databaseSnapshot,rootReference:{pin:prepared.pin,preparedVersionId:staged.versionId,
     expectedRootFormat:2,state:'PREPARED_ROOT_REFERENCE_ONLY',finalPublicationAcknowledgementReconstructed:false},
    restoreMode:'QUARANTINE_ONLY',controlRevisionVerifiedAtBoundaries:true,wholeBackendQuiesced:false,objectBytesFenced:false,
    currentTenantAuthorityVerified:false,archivedSetAdmitted:false,actionAuthorized:false,observationDigest:'0'.repeat(64)});
   const {observationDigest,...core}=parsed,report={...core,observationDigest:createHash('sha256').update(JSON.stringify(core)).digest('hex')};
   const stored=await session.publishReport(report,requestPin,caller);await check();
   await archive.publishPrepared(prepared.pin,staged.versionId,caller);await check();
   const verified=await journal.verifyDiscoveredCommonRoot(binding,archive,caller);await check();
   return{candidate:stored.report,requestPin,reportPin:stored.pin,root:verified.root,savedObservationAuthorizesExecution:false as const,
    restoreMode:'QUARANTINE_ONLY' as const,archivedSetAdmitted:false as const,actionAuthorized:false as const};
  }catch{throw new Error('Managed common candidate capture is unresolved; inspect original root reference without retry or admission');}
  finally{if(acknowledged)session?.closeExecution();}
 }
 /** Explicit format4 path. The original request ACK always precedes source
  * execution; uncertain request/report/root outcomes have no replay path. */
 async captureReadRoleCommonQuarantined(raw:unknown,journal:ManagedCandidateCaptureJournal,archive:ArchivedRecoverySets,
  source:(snapshot:ManagedDatabaseSnapshot,signal:AbortSignal,context:ReturnType<ManagedBackendMaintenance['commonSourceContext']>)=>Promise<{
   visit:Parameters<SupabaseRecoveryCapture['capture']>[0];prepareArchiveInput:(captured:ManagedReadRoleCapturedFiles,interval:ManagedSnapshotInterval,signal?:AbortSignal)=>Promise<unknown>;
  }>,caller?:AbortSignal){
  let session:ReturnType<ManagedCandidateCaptureJournal['forCandidate']>|undefined,acknowledged=false;
  try{
   if(!this.readRole||typeof source!=='function')throw new Error();caller?.throwIfAborted();
   this.readRole.assertMaintenanceScope(this.config);this.readRole.assertStorageScope(this.storage.candidateCaptureScope());
   const request=readRoleCommonCandidateRequestSchema.parse(raw),authorization=this.readRole.configurationDescriptor();
   if(request.captureAuthorizationDigest!==this.readRole.configurationDigest()||request.captureConfigurationDigest!==authorization.captureConfigurationDigest
    ||request.sqlPrivilegeConfigurationDigest!==authorization.catalogueConfigurationDigest||request.metadataWindowConfigurationDigest!==authorization.metadataWindowConfigurationDigest
    ||request.journalConfigurationDigest!==journal.configurationDigest()||request.archiveConfigurationDigest!==archive.configurationDigest())throw new Error();
   const check=async()=>{caller?.throwIfAborted();const head=requireProtocol9ClosedHead(await this.control.observe(caller));
    if(head.revision!==request.controlRevision||head.value.attemptId!==request.attemptId||head.value.planDigest!==this.planDigest()
     ||head.value.installationId!==this.config.installationId||head.value.maintenanceEpoch!==this.config.maintenanceEpoch)throw new Error();return head;};
   await check();if((await this.readRole.observeCompatibility(caller)).catalogueLockAclPredicatesObserved!==true)throw new Error();
   await check();await this.inspect();const bootstrap=await journal.observePlanBootstrap(await check(),caller);await check();
   if(bootstrap.plan.format!==10||bootstrap.plan.captureAuthorization!==request.captureAuthorizationDigest)throw new Error();
   const binding=readRoleCommonCandidateBindingSchema.parse({format:4,kind:'MANAGED_QUARANTINED_READ_ROLE_COMMON_CAPTURE_V4',...this.config,...request,planDigest:this.planDigest()});
   session=journal.forCandidate(binding);const requestPin=await session.reserve(caller);acknowledged=true;await check();
   const guarded=await this.readRole.runWithSnapshot(async(snapshot,signal)=>{
    const context=this.commonSourceContext(binding,session!,requestPin,signal,check),prepared=await source(snapshot,signal,context);
    signal.throwIfAborted();await check();if(typeof prepared.visit!=='function'||typeof prepared.prepareArchiveInput!=='function')throw new Error();
    return{visit:prepared.visit,value:prepared.prepareArchiveInput};
   },caller);
   await check();await this.inspect();await check();
   if(guarded.configurationDigest!==request.captureAuthorizationDigest)throw new Error();
   const captured=readRoleSupabaseCaptureSchema.parse(guarded.captured),interval=managedSnapshotInterval(guarded.snapshotInterval);
   const input=await guarded.sourceValue(captured,interval,caller);await check();
   const prepared=await archive.prepareImported(input,interval,caller);await check();
   const staged=await archive.stagePrepared(prepared.pin,prepared.artifact,caller);await check();
   const parsed=readRoleCommonCandidateReportSchema.parse({kind:'MANAGED_QUARANTINED_READ_ROLE_COMMON_CANDIDATE',binding,
    bindingDigest:createHash('sha256').update(JSON.stringify(binding)).digest('hex'),requestPin,capture:captured,
    metadataWindow:interval.metadataWindow,databaseSnapshot:interval.databaseSnapshot,authorization,sqlPrivilegeWindow:guarded.sqlPrivilegeWindow,
    configuredJwtSqlRoleMatched:true,providerTokenRoleVerified:false,providerProjectDatabaseVerified:false,unfilteredBucketVisibilityVerified:false,retainedPrivilegedCredentialsExcluded:false,
    rootReference:{pin:prepared.pin,preparedVersionId:staged.versionId,expectedRootFormat:2,state:'PREPARED_ROOT_REFERENCE_ONLY',finalPublicationAcknowledgementReconstructed:false},
    restoreMode:'QUARANTINE_ONLY',controlRevisionVerifiedAtBoundaries:true,wholeBackendQuiesced:false,objectBytesFenced:false,
    currentTenantAuthorityVerified:false,archivedSetAdmitted:false,actionAuthorized:false,observationDigest:'0'.repeat(64)});
   const{observationDigest,...core}=parsed,report={...core,observationDigest:createHash('sha256').update(JSON.stringify(core)).digest('hex')};
   const stored=await session.publishReport(report,requestPin,caller);await check();
   await archive.publishPrepared(prepared.pin,staged.versionId,caller);await check();
   const verified=await journal.verifyDiscoveredCommonRoot(binding,archive,caller);await check();
   return{candidate:stored.report,requestPin,reportPin:stored.pin,root:verified.root,savedObservationAuthorizesExecution:false as const,
    restoreMode:'QUARANTINE_ONLY' as const,archivedSetAdmitted:false as const,actionAuthorized:false as const};
  }catch{throw new Error('Managed read-role common candidate is unresolved; inspect original evidence without retry or admission');}
  finally{if(acknowledged)session?.closeExecution();}
 }
 private commonSourceContext(binding:z.infer<typeof anyCommonCandidateBindingSchema>,session:ReturnType<ManagedCandidateCaptureJournal['forCandidate']>,requestPin:z.infer<typeof candidatePinSchema>,signal:AbortSignal,check:()=>Promise<unknown>){
  return Object.freeze({kind:'COMMON_CANDIDATE' as const,sourceSha:binding.sourceSha,bindingDigest:createHash('sha256').update(JSON.stringify(binding)).digest('hex'),
     requestPinDigest:createHash('sha256').update(JSON.stringify(requestPin)).digest('hex'),jobCustody:Object.freeze({
      reserve:async(artifact:unknown)=>{await check();signal.throwIfAborted();const saved=await session.reserveSourceJob(artifact,requestPin,signal);await check();return saved;},
      bindService:async(artifact:unknown)=>{await check();signal.throwIfAborted();const saved=await session.bindSourceJobService(artifact,requestPin,signal);await check();return saved;},
      reserveDaemonHeader:async(artifact:unknown)=>{await check();signal.throwIfAborted();const saved=await session.reserveSourceDaemonHeader(artifact,requestPin,signal);await check();return saved;},
      reserveDaemonIntent:async(artifact:unknown)=>{await check();signal.throwIfAborted();const saved=await session.reserveSourceDaemonIntent(artifact,requestPin,signal);await check();return saved;},
      bindDaemonOwner:async(artifact:unknown)=>{await check();signal.throwIfAborted();const saved=await session.bindSourceDaemonOwner(artifact,requestPin,signal);await check();return saved;},
      createDaemonOwnerOutcomeWriter:async()=>{await check();signal.throwIfAborted();const writer=session.createSourceDaemonOwnerOutcomeWriter(requestPin);try{await check();return writer;}catch(error){writer.revoke();throw error;}},
      createDaemonOwnerOutcomeTransfer:async()=>{await check();signal.throwIfAborted();const transfer=await session.createSourceDaemonOwnerOutcomeTransfer(requestPin,signal);
       const checked=async<T>(run:()=>T|Promise<T>)=>{try{await check();signal.throwIfAborted();const value=await run();await check();signal.throwIfAborted();return value;}catch(error){transfer.abandon();throw error;}};
       try{await check();return Object.freeze({take:()=>checked(()=>transfer.take()),claim:(nonce:string,digest:string)=>checked(()=>transfer.claim(nonce,digest)),observeReceipt:(artifact:unknown,receipt:unknown)=>checked(()=>transfer.observeReceipt(artifact,receipt,signal)),confirmReady:()=>checked(()=>transfer.confirmReady()),abandon:()=>transfer.abandon()});}
       catch(error){transfer.abandon();throw error;}
      },
      observeDaemonResponse:async(artifact:unknown)=>{await check();signal.throwIfAborted();const saved=await session.observeSourceDaemonResponse(artifact,requestPin,signal);await check();return saved;},
      finishDaemonRequests:async(artifact:unknown)=>{await check();signal.throwIfAborted();const saved=await session.finishSourceDaemonRequests(artifact,requestPin,signal);await check();return saved;},
      observe:async(artifact:unknown)=>{await check();signal.throwIfAborted();const saved=await session.observeSourceJob(artifact,requestPin,signal);await check();return saved;}
     })});
 }
 /** Explicit second step, after all original positive-control evidence is saved.
  * An uncertain retirement is never resumed through this method. */
 async retireCaptureControl(caller?:AbortSignal){
  try{
   if(!this.retirement||!this.readRole)throw new Error();caller?.throwIfAborted();
   await this.inspectEvidence('RETIREMENT_PREFLIGHT');caller?.throwIfAborted();
   return await this.retirement.retire(this.planDescriptor(),caller);
  }catch{throw new Error(failure);}
 }
 async inspect(){return this.inspectEvidence(this.retirement?'RETIRED_CONTROL':'LIVE_CONTROL');}
 private async inspectEvidence(mode:'LIVE_CONTROL'|'RETIREMENT_PREFLIGHT'|'RETIRED_CONTROL'){
  try{
   const before=await this.control.observe();
   if(before.value.installationId!==this.config.installationId||before.value.planDigest!==this.planDigest()
    ||before.value.maintenanceEpoch!==this.config.maintenanceEpoch||before.value.phase==='READY')throw new Error();
   if(before.value.phase==='OBSERVED_CLOSED')requireProtocol9ClosedHead(before);
   const binding={attemptId:before.value.attemptId,planDigest:before.value.planDigest,sourceSha:this.config.sourceSha,maintenanceEpoch:this.config.maintenanceEpoch};
   const retained=before.value.readBaseline?this.proof.assertBaseline(before.value.readBaseline,binding):null;
   if(before.value.readObservation){if(!retained)throw new Error();this.proof.assertObservation(before.value.readObservation,retained.sha256);}
   const writer=this.write.forAttempt(binding);
   if(before.value.writeBaselinePin)writer.probe.assertBaseline(await writer.evidence.observeBaseline(before.value.writeBaselinePin));
   const recordedWriteObservation=before.value.writeObservationPin?await writer.evidence.observeObservation(before.value.writeObservationPin,before.value.writeBaselinePin):null;
   if(recordedWriteObservation)writer.probe.assertObservation(recordedWriteObservation,before.value.writeBaselinePin!.sha256);
   if(recordedWriteObservation&&credentialWriteObservationSchema.parse(JSON.parse(recordedWriteObservation.body)).observationDigest!==before.value.observations?.writeProofDigest)throw new Error();
   const signer=this.signed.forAttempt(binding);
   if(before.value.signedBaselinePin)signer.probe.assertBaseline(await signer.evidence.observeBaseline(before.value.signedBaselinePin),signer.vault.configurationDigest());
   const recordedSignedObservation=before.value.signedObservationPin?await signer.evidence.observeObservation(before.value.signedObservationPin,before.value.signedBaselinePin):null;
   if(recordedSignedObservation&&signedUploadObservationSchema.parse(JSON.parse(recordedSignedObservation.body)).observationDigest!==before.value.observations?.signedProofDigest)throw new Error();
   const resumable=this.resumable.forAttempt(binding);
   if(before.value.resumableBaselinePin)await resumable.observeBaseline(before.value.resumableBaselinePin);
   const recordedResumableObservation=before.value.resumableObservationPin?await resumable.observeObservation(before.value.resumableObservationPin,before.value.resumableBaselinePin):null;
   if(recordedResumableObservation&&recordedResumableObservation.artifact.sha256!==before.value.observations?.resumableProofDigest)throw new Error();
   const signedTus=this.signedResumable.forAttempt(binding);
   if(before.value.signedResumableBaselinePin)await signedTus.observeBaseline(before.value.signedResumableBaselinePin);
   const recordedSignedResumableObservation=before.value.signedResumableObservationPin?await signedTus.observeObservation(before.value.signedResumableObservationPin,before.value.signedResumableBaselinePin):null;
   if(recordedSignedResumableObservation&&recordedSignedResumableObservation.value.observationDigest!==before.value.observations?.signedResumableProofDigest)throw new Error();
   const s3=this.s3.forAttempt(binding);
   if(before.value.s3BaselinePin)await s3.observeBaseline(before.value.s3BaselinePin);
   const recordedS3Observation=before.value.s3ObservationPin?await s3.observeObservation(before.value.s3ObservationPin,before.value.s3BaselinePin):null;
   if(recordedS3Observation&&recordedS3Observation.observationDigest!==before.value.observations?.s3ProofDigest)throw new Error();
   const retirement=mode==='RETIRED_CONTROL'?await this.retirement!.inspect(this.planDescriptor()):null;
   const metadata=await this.readback(undefined,undefined,undefined,undefined,undefined,undefined,retirement?.current.observationDigest);
   // The original privileged control is deliberately unusable after retirement.
   // Its saved proof stays historical; never replay the old positive-control GET.
   const freshReadObservation=mode==='LIVE_CONTROL'&&retained?await this.proof.verifyReadRefusal(retained.body,retained.sha256):null;
   const observations={...metadata,...(freshReadObservation?{readProofDigest:freshReadObservation.observationDigest}:{})},after=await this.control.observe();
   if(after.revision!==before.revision)throw new Error();
   // Fresh observations never rewrite the original attempt or fabricate a
   // missing command/database completion receipt after an uncertain outcome.
   return{phase:after.value.phase,attemptId:after.value.attemptId,observations,
    ...(retirement?{captureControlRetirement:retirement,captureControlRetirementRequired:true as const,originalCaptureControlRetirementAcknowledgementReconstructed:false as const,
     recordedCaptureControlRetirementReportVerified:true as const,currentListedControlKeyAbsenceObserved:true as const,freshRetiredControlDataPlaneRefusalVerified:false as const}:{}),
    credentialReadRefusalsObserved:freshReadObservation!==null,readBaselineSha256:retained?.sha256??null,
    recordedReadObservation:after.value.readObservation??null,freshReadObservation,
    recordedS3Observation,recordedS3CoverageObserved:recordedS3Observation!==null,freshS3CoverageObserved:false as const,s3Mode:s3.mode,
    recordedSignedResumableObservation,recordedSignedResumablePatchRefusalObserved:recordedSignedResumableObservation!==null,freshSignedResumablePatchRefusalObserved:false as const,
    recordedResumableObservation,recordedResumableCredentialCohortRefusalsObserved:recordedResumableObservation!==null,freshResumableCredentialCohortRefusalsObserved:false as const,
    recordedSignedObservation,recordedTestedSignedUploadRefusalObserved:recordedSignedObservation!==null,freshSignedUploadRefusalObserved:false as const,
    recordedWriteObservation,recordedStandardWriteRefusalsObserved:recordedWriteObservation!==null,freshStandardWriteRefusalsObserved:false as const,
    recordedObservations:after.value.observations,storageAccessPathsObservedClosed:true as const,databasePasswordCredentialsInvalidated:true as const,wholeBackendQuiesced:false as const,storageTokenIssuerVerified:false as const,providerReleaseAttested:false as const,signedCapabilitiesRevoked:false as const,resumableSessionsRevoked:false as const,inFlightWritesDrained:false as const,
    credentialRotationVerified:false as const,currentTenantAuthorityVerified:false as const,
    sourceHostFenced:false as const,reopeningAuthorised:false as const,actionAuthorized:false as const};
  }catch{throw new Error(failure);}
 }
}
