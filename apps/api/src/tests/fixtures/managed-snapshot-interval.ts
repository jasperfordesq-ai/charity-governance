import {randomUUID} from 'node:crypto';
import {candidateHash} from '../../services/managed-candidate-capture-contract.js';
export function snapshotIntervalFixture(){
 const facts={format:1 as const,kind:'MANAGED_STORAGE_METADATA_WINDOW_V1' as const,windowId:randomUUID(),configurationDigest:'1'.repeat(64),
  database:'synthetic_db',databaseOid:'16384',observer:{name:'maintenance',oid:'10'},relations:[{schema:'storage',name:'objects',oid:'16386'}],
  backendPid:123,lockMode:'SHARE' as const,transactionReadOnly:true as const,transactionIsolation:'ReadCommitted' as const,
  startedAt:'2026-10-17T00:00:00.000Z',finishedAt:'2026-10-17T00:01:00.000Z'};
 return{metadataWindow:{...facts,observationDigest:candidateHash(JSON.stringify(facts)),scope:'CONFIGURED_RELATIONS_DURING_CALLBACK_ONLY' as const,
  metadataWindowCompleted:true as const,windowStillHeld:false as const,objectBytesFenced:false as const,allWritersInventoried:false as const,wholeBackendQuiesced:false as const,actionAuthorized:false as const},
 databaseSnapshot:{format:1 as const,kind:'MANAGED_EXPORTED_DATABASE_SNAPSHOT_V1' as const,database:facts.database,databaseOid:facts.databaseOid,
  observerOid:facts.observer.oid,backendPid:facts.backendPid,snapshotBindingSha256:'2'.repeat(64),configurationDigest:facts.configurationDigest,windowId:facts.windowId,
  exportedAfterRelationLocks:true as const,exporterHeldDuringCallback:true as const,importedByConsumerVerified:false as const,snapshotStillImportable:false as const,
  nonMvccStateCaptured:false as const,wholeBackendQuiesced:false as const,actionAuthorized:false as const}};
}
export function snapshotContext(interval:ReturnType<typeof snapshotIntervalFixture>){
 const s=interval.databaseSnapshot;return{format:1,kind:'GUARDED_IMPORTED_SOURCE_SNAPSHOT_V1',snapshotBindingSha256:s.snapshotBindingSha256,
 database:s.database,databaseOid:s.databaseOid,observerOid:s.observerOid,backendPid:s.backendPid,originalViewImported:true,
 declaredExporterPresent:true,metadataWindowCompletionVerified:false,wholeBackendQuiesced:false,actionAuthorized:false};
}
