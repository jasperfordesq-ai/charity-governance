import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {RenderMaintenanceControl} from './render-maintenance-control.js';
import type {ManagedDatabaseWriterFence} from './managed-database-writer-fence.js';
import type {S3ManagedMaintenanceControl} from './managed-maintenance-control.js';

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
  private readonly database:ManagedDatabaseWriterFence,private readonly control:S3ManagedMaintenanceControl){
  this.config=configuration.parse(raw);
 }
 planDigest(){return createHash('sha256').update(JSON.stringify({format:2,...this.config,
  databaseCredentialPolicy:'PASSWORD_NULL_WHILE_CLOSED',
  provider:this.provider.configurationDigest(),database:this.database.configurationDigest()})).digest('hex');}
 private async readback(){
  const services=await this.provider.observeSuspended(),database=await this.database.observePasswordsInvalidated();
  return{servicesDigest:services.observationDigest,databaseDigest:database.observationDigest,observedAt:new Date().toISOString()};
 }
 async close(){
  try{
   const attempt=await this.control.acquire(this.config.installationId,this.planDigest(),this.config.maintenanceEpoch);
   if(attempt.value.installationId!==this.config.installationId||attempt.value.phase!=='ATTEMPTED'||!attempt.value.attemptId)throw new Error();
   await this.provider.suspend();
   await this.database.close();
   await this.database.invalidatePasswords();
   const observations=await this.readback();
   const recorded=await this.control.recordObservedClosed(attempt.value.attemptId,attempt.revision,observations);
   return{phase:recorded.value.phase,attemptId:recorded.value.attemptId,observations,
    databasePasswordCredentialsInvalidated:true as const,wholeBackendQuiesced:false as const,credentialRotationVerified:false as const,
    currentTenantAuthorityVerified:false as const,sourceHostFenced:false as const,reopeningAuthorised:false as const,actionAuthorized:false as const};
  }catch{throw new Error(failure);}
 }
 async inspect(){
  try{
   const before=await this.control.observe();
   if(before.value.installationId!==this.config.installationId||before.value.planDigest!==this.planDigest()
    ||before.value.maintenanceEpoch!==this.config.maintenanceEpoch||before.value.phase==='READY')throw new Error();
   const observations=await this.readback(),after=await this.control.observe();
   if(after.revision!==before.revision)throw new Error();
   // Fresh observations never rewrite the original attempt or fabricate a
   // missing command/database completion receipt after an uncertain outcome.
   return{phase:after.value.phase,attemptId:after.value.attemptId,observations,
    recordedObservations:after.value.observations,databasePasswordCredentialsInvalidated:true as const,wholeBackendQuiesced:false as const,
    credentialRotationVerified:false as const,currentTenantAuthorityVerified:false as const,
    sourceHostFenced:false as const,reopeningAuthorised:false as const,actionAuthorized:false as const};
  }catch{throw new Error(failure);}
 }
}
