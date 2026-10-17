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
  private readonly storage:SupabaseStorageWriterControl,private readonly proof:SupabaseCredentialReadProof,private readonly write:ManagedStorageWriteEvidence,private readonly signed:ManagedSignedUploadEvidence,private readonly resumable:ManagedResumableUploadEvidence){
  this.config=configuration.parse(raw);
  this.proof.assertStorageScope(this.storage.readProofScope());
  this.write.assertStorageScope(this.storage.readProofScope());
  this.signed.assertStorageScope(this.storage.readProofScope());
  this.resumable.assertStorageScope(this.storage.readProofScope());
 }
 planDigest(){return createHash('sha256').update(JSON.stringify({format:7,...this.config,
  databaseCredentialPolicy:'PASSWORD_NULL_WHILE_CLOSED',
  storageCredentialPolicy:'REVOKE_REVIEWED_KEYS_KEEP_CAPTURE_V1',
  readProofPolicy:'INDEPENDENT_BASELINE_BEFORE_CREDENTIAL_REVOCATION_V1',
  writeProofPolicy:'EXACT_VERSION_BASELINE_PIN_BEFORE_REVOCATION_V1',signedProofPolicy:'ORIGINAL_ENCRYPTED_TOKEN_AND_BASELINE_PIN_BEFORE_REVOCATION_V1',resumableProofPolicy:'ALL_CONFIGURED_ORIGINAL_TUS_MANIFEST_BEFORE_REVOCATION_V1',
  provider:this.provider.configurationDigest(),database:this.database.configurationDigest(),storage:this.storage.configurationDigest(this.config.installationId),
  readProof:this.proof.configurationDigest(this.config.installationId),writeProof:this.write.configurationDigest(this.config.installationId),signedProof:this.signed.configurationDigest(this.config.installationId),resumableProof:this.resumable.configurationDigest(this.config.installationId)})).digest('hex');}
 private async readback(readProofDigest?:string,writeProofDigest?:string,signedProofDigest?:string,resumableProofDigest?:string){
  const services=await this.provider.observeSuspended(),database=await this.database.observePasswordsInvalidated(),storage=await this.storage.observeClosed(),signing=await this.signed.observeRevoked();
  if(storage.configuredAccessPathsObservedClosed!==true)throw new Error(failure);
  return{servicesDigest:services.observationDigest,databaseDigest:database.observationDigest,storageDigest:storage.observationDigest,signingDigest:signing.observationDigest,
   ...(readProofDigest?{readProofDigest}:{}),...(writeProofDigest?{writeProofDigest}:{}),...(signedProofDigest?{signedProofDigest}:{}),...(resumableProofDigest?{resumableProofDigest}:{}),observedAt:new Date().toISOString()};
 }
 async close(){
  try{
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
   const ready=await this.control.recordResumableBaselinePin(attempt.value.attemptId,signedReady.revision,resumableBaselinePin);
   if(ready.value.phase!=='RESUMABLE_BASELINED'||!ready.value.resumableBaselinePin)throw new Error();
   const savedResumable=await resumable.observeBaseline(ready.value.resumableBaselinePin);
   if(savedResumable.artifact.sha256!==resumableBaselinePin.sha256)throw new Error();
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
   const observations=await this.readback(readObservation.observationDigest,writeObservation.observationDigest,signedObservation.observationDigest,resumableObservation.observationDigest);
   const recorded=await this.control.recordObservedClosed(attempt.value.attemptId,ready.revision,observations,readObservation,writeObservationPin,signedObservationPin,resumableObservation.pin);
   return{phase:recorded.value.phase,attemptId:recorded.value.attemptId,observations,
    credentialReadRefusalsObserved:true as const,readBaselineSha256:retained.sha256,readObservationSha256:recorded.value.readObservation?.sha256,
    resumableCredentialCohortRefusalsObserved:true as const,resumableBaselinePin:recorded.value.resumableBaselinePin,resumableObservationPin:recorded.value.resumableObservationPin,
    testedSignedUploadRefusalObserved:true as const,signedBaselinePin:recorded.value.signedBaselinePin,signedObservationPin:recorded.value.signedObservationPin,
    standardWriteRefusalsObserved:true as const,writeBaselinePin:recorded.value.writeBaselinePin,writeObservationPin:recorded.value.writeObservationPin,
    storageAccessPathsObservedClosed:true as const,databasePasswordCredentialsInvalidated:true as const,wholeBackendQuiesced:false as const,storageTokenIssuerVerified:false as const,providerReleaseAttested:false as const,signedCapabilitiesRevoked:false as const,resumableSessionsRevoked:false as const,inFlightWritesDrained:false as const,credentialRotationVerified:false as const,
    currentTenantAuthorityVerified:false as const,sourceHostFenced:false as const,reopeningAuthorised:false as const,actionAuthorized:false as const};
  }catch{throw new Error(failure);}
 }
 async inspect(){
  try{
   const before=await this.control.observe();
   if(before.value.installationId!==this.config.installationId||before.value.planDigest!==this.planDigest()
    ||before.value.maintenanceEpoch!==this.config.maintenanceEpoch||before.value.phase==='READY')throw new Error();
   if(before.value.phase==='OBSERVED_CLOSED'&&(!before.value.observations?.storageDigest||!before.value.observations.readProofDigest
    ||!before.value.readBaseline||!before.value.readObservation||!before.value.writeBaselinePin||!before.value.writeObservationPin||!before.value.observations.writeProofDigest||!before.value.signedBaselinePin||!before.value.signedObservationPin||!before.value.observations.signedProofDigest||!before.value.observations.signingDigest||!before.value.resumableBaselinePin||!before.value.resumableObservationPin||!before.value.observations.resumableProofDigest))throw new Error();
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
   const metadata=await this.readback();
   const freshReadObservation=retained?await this.proof.verifyReadRefusal(retained.body,retained.sha256):null;
   const observations={...metadata,...(freshReadObservation?{readProofDigest:freshReadObservation.observationDigest}:{})},after=await this.control.observe();
   if(after.revision!==before.revision)throw new Error();
   // Fresh observations never rewrite the original attempt or fabricate a
   // missing command/database completion receipt after an uncertain outcome.
   return{phase:after.value.phase,attemptId:after.value.attemptId,observations,
    credentialReadRefusalsObserved:freshReadObservation!==null,readBaselineSha256:retained?.sha256??null,
    recordedReadObservation:after.value.readObservation??null,freshReadObservation,
    recordedResumableObservation,recordedResumableCredentialCohortRefusalsObserved:recordedResumableObservation!==null,freshResumableCredentialCohortRefusalsObserved:false as const,
    recordedSignedObservation,recordedTestedSignedUploadRefusalObserved:recordedSignedObservation!==null,freshSignedUploadRefusalObserved:false as const,
    recordedWriteObservation,recordedStandardWriteRefusalsObserved:recordedWriteObservation!==null,freshStandardWriteRefusalsObserved:false as const,
    recordedObservations:after.value.observations,storageAccessPathsObservedClosed:true as const,databasePasswordCredentialsInvalidated:true as const,wholeBackendQuiesced:false as const,storageTokenIssuerVerified:false as const,providerReleaseAttested:false as const,signedCapabilitiesRevoked:false as const,resumableSessionsRevoked:false as const,inFlightWritesDrained:false as const,
    credentialRotationVerified:false as const,currentTenantAuthorityVerified:false as const,
    sourceHostFenced:false as const,reopeningAuthorised:false as const,actionAuthorized:false as const};
  }catch{throw new Error(failure);}
 }
}
