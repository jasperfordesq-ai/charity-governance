import {z} from 'zod';
import {candidateHash,managedStorageWindowSchema} from './managed-candidate-capture-contract.js';
const sha=z.string().regex(/^[a-f0-9]{64}$/),no=z.literal(false);
const snapshot=z.object({format:z.literal(1),kind:z.literal('MANAGED_EXPORTED_DATABASE_SNAPSHOT_V1'),
 database:z.string(),databaseOid:z.string(),observerOid:z.string(),backendPid:z.number().int().positive(),snapshotBindingSha256:sha,
 configurationDigest:sha,windowId:z.string().uuid(),exportedAfterRelationLocks:z.literal(true),exporterHeldDuringCallback:z.literal(true),
 importedByConsumerVerified:no,snapshotStillImportable:no,nonMvccStateCaptured:no,wholeBackendQuiesced:no,actionAuthorized:no}).strict();
export const managedSnapshotIntervalSchema=z.object({metadataWindow:managedStorageWindowSchema,databaseSnapshot:snapshot}).strict();
export type ManagedSnapshotInterval=z.infer<typeof managedSnapshotIntervalSchema>;
const failure=()=>new Error('Managed snapshot interval is unresolved; retain quarantine without admission');
export function managedSnapshotInterval(raw:unknown):ManagedSnapshotInterval{
 try{
  const value=managedSnapshotIntervalSchema.parse(raw),w=value.metadataWindow,s=value.databaseSnapshot;
  const {observationDigest,scope,metadataWindowCompleted,windowStillHeld,objectBytesFenced,allWritersInventoried,wholeBackendQuiesced,actionAuthorized,...facts}=w;
  if(candidateHash(JSON.stringify(facts))!==observationDigest||s.windowId!==w.windowId||s.configurationDigest!==w.configurationDigest
   ||s.database!==w.database||s.databaseOid!==w.databaseOid||s.observerOid!==w.observer.oid||s.backendPid!==w.backendPid)throw failure();
  return value;
 }catch{throw failure();}
}
export function assertImportedSnapshotInterval(raw:unknown,reportBody:string){
 try{
  const interval=managedSnapshotInterval(raw),s=interval.databaseSnapshot;
  const context=z.object({format:z.literal(1),kind:z.literal('GUARDED_IMPORTED_SOURCE_SNAPSHOT_V1'),snapshotBindingSha256:sha,
   database:z.string(),databaseOid:z.string(),observerOid:z.string(),backendPid:z.number().int().positive(),originalViewImported:z.literal(true),
   declaredExporterPresent:z.literal(true),metadataWindowCompletionVerified:no,wholeBackendQuiesced:no,actionAuthorized:no}).strict()
   .parse(JSON.parse(reportBody).importedSnapshot);
  if(context.snapshotBindingSha256!==s.snapshotBindingSha256||context.database!==s.database||context.databaseOid!==s.databaseOid
   ||context.observerOid!==s.observerOid||context.backendPid!==s.backendPid)throw failure();
  return interval;
 }catch{throw failure();}
}
