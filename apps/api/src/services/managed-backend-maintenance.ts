import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {RenderMaintenanceControl} from './render-maintenance-control.js';
import type {ManagedDatabaseWriterFence} from './managed-database-writer-fence.js';
import type {S3ManagedMaintenanceControl} from './managed-maintenance-control.js';
import type {SupabaseStorageWriterControl} from './supabase-storage-writer-control.js';
import type {SupabaseCredentialReadProof} from './supabase-credential-read-proof.js';

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
  private readonly storage:SupabaseStorageWriterControl,private readonly proof:SupabaseCredentialReadProof){
  this.config=configuration.parse(raw);
  this.proof.assertStorageScope(this.storage.readProofScope());
 }
 planDigest(){return createHash('sha256').update(JSON.stringify({format:4,...this.config,
  databaseCredentialPolicy:'PASSWORD_NULL_WHILE_CLOSED',
  storageCredentialPolicy:'REVOKE_REVIEWED_KEYS_KEEP_CAPTURE_V1',
  readProofPolicy:'INDEPENDENT_BASELINE_BEFORE_CREDENTIAL_REVOCATION_V1',
  provider:this.provider.configurationDigest(),database:this.database.configurationDigest(),storage:this.storage.configurationDigest(this.config.installationId),
  readProof:this.proof.configurationDigest(this.config.installationId)})).digest('hex');}
 private async readback(readProofDigest?:string){
  const services=await this.provider.observeSuspended(),database=await this.database.observePasswordsInvalidated(),storage=await this.storage.observeClosed();
  if(storage.configuredAccessPathsObservedClosed!==true)throw new Error(failure);
  return{servicesDigest:services.observationDigest,databaseDigest:database.observationDigest,storageDigest:storage.observationDigest,
   ...(readProofDigest?{readProofDigest}:{}),observedAt:new Date().toISOString()};
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
   await this.provider.suspend();
   await this.database.close();
   await this.database.invalidatePasswords();
   await this.storage.close();
   const readObservation=await this.proof.verifyReadRefusal(retained.body,retained.sha256);
   const observations=await this.readback(readObservation.observationDigest);
   const recorded=await this.control.recordObservedClosed(attempt.value.attemptId,pinned.revision,observations,readObservation);
   return{phase:recorded.value.phase,attemptId:recorded.value.attemptId,observations,
    credentialReadRefusalsObserved:true as const,readBaselineSha256:retained.sha256,readObservationSha256:recorded.value.readObservation?.sha256,
    storageAccessPathsObservedClosed:true as const,databasePasswordCredentialsInvalidated:true as const,wholeBackendQuiesced:false as const,credentialRotationVerified:false as const,
    currentTenantAuthorityVerified:false as const,sourceHostFenced:false as const,reopeningAuthorised:false as const,actionAuthorized:false as const};
  }catch{throw new Error(failure);}
 }
 async inspect(){
  try{
   const before=await this.control.observe();
   if(before.value.installationId!==this.config.installationId||before.value.planDigest!==this.planDigest()
    ||before.value.maintenanceEpoch!==this.config.maintenanceEpoch||before.value.phase==='READY')throw new Error();
   if(before.value.phase==='OBSERVED_CLOSED'&&(!before.value.observations?.storageDigest||!before.value.observations.readProofDigest
    ||!before.value.readBaseline||!before.value.readObservation))throw new Error();
   const binding={attemptId:before.value.attemptId,planDigest:before.value.planDigest,sourceSha:this.config.sourceSha,maintenanceEpoch:this.config.maintenanceEpoch};
   const retained=before.value.readBaseline?this.proof.assertBaseline(before.value.readBaseline,binding):null;
   if(before.value.readObservation){if(!retained)throw new Error();this.proof.assertObservation(before.value.readObservation,retained.sha256);}
   const metadata=await this.readback();
   const freshReadObservation=retained?await this.proof.verifyReadRefusal(retained.body,retained.sha256):null;
   const observations={...metadata,...(freshReadObservation?{readProofDigest:freshReadObservation.observationDigest}:{})},after=await this.control.observe();
   if(after.revision!==before.revision)throw new Error();
   // Fresh observations never rewrite the original attempt or fabricate a
   // missing command/database completion receipt after an uncertain outcome.
   return{phase:after.value.phase,attemptId:after.value.attemptId,observations,
    credentialReadRefusalsObserved:freshReadObservation!==null,readBaselineSha256:retained?.sha256??null,
    recordedReadObservation:after.value.readObservation??null,freshReadObservation,
    recordedObservations:after.value.observations,storageAccessPathsObservedClosed:true as const,databasePasswordCredentialsInvalidated:true as const,wholeBackendQuiesced:false as const,
    credentialRotationVerified:false as const,currentTenantAuthorityVerified:false as const,
    sourceHostFenced:false as const,reopeningAuthorised:false as const,actionAuthorized:false as const};
  }catch{throw new Error(failure);}
 }
}
