import {createHash} from 'node:crypto';
import {z} from 'zod';
import {SupabaseRecoveryCapture} from './supabase-recovery-capture.js';
import {ManagedStorageDatabaseInventory} from './managed-storage-database-inventory.js';
import {ManagedStorageMetadataWindow,type ManagedDatabaseSnapshot} from './managed-storage-metadata-window.js';
import {managedSnapshotInterval} from './managed-snapshot-interval.js';
import {managedReadRoleConfigurationSchema as configuration,managedReadRoleOperationSchema as operation} from './managed-read-role-configuration.js';
const failure=()=>new Error('Managed read-role capture is unresolved; discard the candidate without retry or admission');
/** Explicit configured authority only. No provider grant, caller-selected SQL,
 * application activation, preserved original ACK or whole-backend claim. */
export class ManagedReadRoleCapture {
 readonly #config:z.infer<typeof configuration>;
 readonly #capture:SupabaseRecoveryCapture;
 readonly #catalogue:ManagedStorageDatabaseInventory;
 readonly #metadata:ManagedStorageMetadataWindow;
 private running=false;
 constructor(raw:unknown,capture:SupabaseRecoveryCapture,catalogue:ManagedStorageDatabaseInventory,metadata:ManagedStorageMetadataWindow){
  try{this.#config=configuration.parse(raw);this.#capture=capture;this.#catalogue=catalogue;this.#metadata=metadata;this.assertComponents();}catch{throw failure();}
 }
 private assertComponents(){
  const c=this.#config,relations=[c.storageRelations.buckets,c.storageRelations.objects];
  if(c.captureConfigurationDigest!==this.#capture.configurationDigest()||c.catalogueConfigurationDigest!==this.#catalogue.configurationDigest()
   ||c.metadataWindowConfigurationDigest!==this.#metadata.configurationDigest())throw failure();
  this.#capture.assertConfiguredReadRoleScope({installationId:c.installationId,projectRef:c.projectRef,bucket:c.bucket,subject:c.subject,sqlRole:c.sqlRole});
  this.#catalogue.assertCaptureWindowScope({database:c.database.name,databaseOid:c.database.oid,observer:c.catalogueObserver,capture:c.sqlRole,relations});
  this.#metadata.assertCaptureWindowScope({database:c.database.name,databaseOid:c.database.oid,observer:c.snapshotObserver,relations,maxWindowMs:c.maxWindowMs});
 }
 configurationDescriptor(){return configuration.parse(this.#config);}
 configurationDigest(){return createHash('sha256').update(JSON.stringify(this.#config)).digest('hex');}
 async observeCompatibility(caller?:AbortSignal){this.assertComponents();const result=await this.#catalogue.observeCaptureWindowCompatibility(caller);this.assertComponents();return result;}
 assertMaintenanceScope(raw:unknown){const value=operation.parse(raw);for(const key of ['installationId','sourceSha','maintenanceEpoch'] as const)if(value[key]!==this.#config[key])throw failure();this.assertComponents();}
 assertStorageScope(raw:unknown){
  const value=z.object({installationId:operation.shape.installationId,projectRef:z.string(),bucket:z.string(),captureKeyId:z.string().uuid()}).strict().parse(raw);
  if(value.installationId!==this.#config.installationId||value.projectRef!==this.#config.projectRef||value.bucket!==this.#config.bucket)throw failure();
  this.assertComponents();
 }
 /** The source must import the supplied snapshot while both intervals remain
  * live. Its returned value is opaque; no root publication occurs here. */
 async runWithSnapshot<T>(source:(snapshot:ManagedDatabaseSnapshot,signal:AbortSignal)=>Promise<{visit:Parameters<SupabaseRecoveryCapture['capture']>[0];value:T}>,caller?:AbortSignal){
  if(this.running||typeof source!=='function')throw failure();this.running=true;
  const controller=new AbortController(),signal=caller?AbortSignal.any([caller,controller.signal]):controller.signal;
  let timeout:ReturnType<typeof setTimeout>|undefined;
  let metadataCompletion:Promise<unknown>|undefined;
  try{
   this.assertComponents();signal.throwIfAborted();const c=this.#config;
   timeout=setTimeout(()=>controller.abort(),Math.min(c.maxWindowMs,this.#capture.readRoleRemainingMs()));
   const privileged=await this.#catalogue.runCaptureRoleWindow(async(boundary,privilegeSignal)=>{
    if(boundary.capture.name!==c.sqlRole.name||boundary.capture.oid!==c.sqlRole.oid)throw failure();this.assertComponents();
    const completed=this.#metadata.runWithSnapshot(async(snapshot,metadataSignal)=>{
     const signal=AbortSignal.any([privilegeSignal,metadataSignal]);signal.throwIfAborted();
     if(snapshot.database!==c.database.name||snapshot.databaseOid!==c.database.oid||snapshot.observerOid!==c.snapshotObserver.oid)throw failure();
     const prepared=await source(snapshot,signal);signal.throwIfAborted();this.assertComponents();
     if(typeof prepared?.visit!=='function')throw failure();
     const captured=await this.#capture.capture(prepared.visit,signal);signal.throwIfAborted();this.assertComponents();
     if(captured.kind!=='SUPABASE_READ_ROLE_CANDIDATE_CAPTURE_V1'||captured.credentialCapability!=='ASYMMETRIC_CUSTOM_ROLE_JWT'
      ||captured.configurationDigest!==c.captureConfigurationDigest||captured.jwtVerification?.signatureVerified!==true)throw failure();
     return{captured,value:prepared.value};
    },privilegeSignal);metadataCompletion=completed;return completed;
   },{maxWindowMs:c.maxWindowMs},signal);
   signal.throwIfAborted();this.#capture.readRoleRemainingMs();this.assertComponents();
   const interval=managedSnapshotInterval({metadataWindow:privileged.value.evidence,databaseSnapshot:privileged.value.databaseSnapshot});
   if(privileged.evidence.database!==interval.metadataWindow.database||privileged.evidence.databaseOid!==interval.metadataWindow.databaseOid
    ||privileged.evidence.configurationDigest!==c.catalogueConfigurationDigest||interval.metadataWindow.configurationDigest!==c.metadataWindowConfigurationDigest)throw failure();
   return{kind:'MANAGED_READ_ROLE_CAPTURE_INTERVAL_V1' as const,configurationDigest:this.configurationDigest(),captured:privileged.value.value.captured,
    sourceValue:privileged.value.value.value,snapshotInterval:interval,sqlPrivilegeWindow:privileged.evidence,configuredJwtSqlRoleMatched:true as const,
    providerTokenRoleVerified:false as const,providerProjectDatabaseVerified:false as const,unfilteredBucketVisibilityVerified:false as const,
    retainedPrivilegedCredentialsExcluded:false as const,wholeBackendQuiesced:false as const,actionAuthorized:false as const};
  }catch{throw failure();}finally{
   clearTimeout(timeout);controller.abort();
   // Await the bounded inner transaction's rollback, never the arbitrary source
   // callback. Outer cancellation can win its race before inner cleanup ends.
   await metadataCompletion?.catch(()=>{});this.running=false;
  }
 }
}
