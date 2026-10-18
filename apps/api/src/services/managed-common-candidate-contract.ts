import {canonicalObjectInventorySha256,canonicalObjectKeySha256} from '../../../../packages/shared/runtime/document-recovery-inventory.mjs';
import {z} from 'zod';
import {candidateHash,candidateBindingSchema,candidateRequestSchema,managedCandidateReportSchema,
 candidateRequestArtifact as legacyRequest,candidateReportArtifact as legacyReport,parseCandidateRequest as parseLegacyRequest,parseCandidateReport as parseLegacyReport} from './managed-candidate-capture-contract.js';
import {archivedRecoverySetPinSchema} from './archived-recovery-set.js';
import {managedSnapshotIntervalSchema,managedSnapshotInterval} from './managed-snapshot-interval.js';
import {managedReadRoleConfigurationSchema} from './managed-read-role-configuration.js';
import {readRoleSupabaseCaptureSchema,captureSqlPrivilegeWindowSchema,assertCaptureSqlPrivilegeWindow} from './managed-read-role-capture-contract.js';
const sha=z.string().regex(/^[a-f0-9]{64}$/),no=z.literal(false);
export const commonCandidateRequestSchema=candidateRequestSchema.extend({archiveConfigurationDigest:sha}).strict();
export const commonCandidateBindingSchema=candidateBindingSchema.extend({...commonCandidateRequestSchema.shape,
 format:z.literal(3),kind:z.literal('MANAGED_QUARANTINED_COMMON_CAPTURE_V3')}).strict();
export const readRoleCommonCandidateRequestSchema=commonCandidateRequestSchema.extend({captureAuthorizationDigest:sha,sqlPrivilegeConfigurationDigest:sha}).strict();
export const readRoleCommonCandidateBindingSchema=commonCandidateBindingSchema.extend({...readRoleCommonCandidateRequestSchema.shape,
 format:z.literal(4),kind:z.literal('MANAGED_QUARANTINED_READ_ROLE_COMMON_CAPTURE_V4')}).strict();
export const anyCommonCandidateBindingSchema=z.discriminatedUnion('format',[commonCandidateBindingSchema,readRoleCommonCandidateBindingSchema]);
export const anyCandidateBindingSchema=z.discriminatedUnion('format',[candidateBindingSchema,commonCandidateBindingSchema,readRoleCommonCandidateBindingSchema]);
const request=z.object({format:z.literal(2),kind:z.literal('MANAGED_COMMON_CANDIDATE_REQUEST_V1'),binding:commonCandidateBindingSchema,
 executionState:z.literal('REQUESTED_ONLY'),savedObservationAuthorizesExecution:no}).strict();
const readRoleRequest=request.extend({format:z.literal(3),kind:z.literal('MANAGED_READ_ROLE_COMMON_CANDIDATE_REQUEST_V1'),binding:readRoleCommonCandidateBindingSchema}).strict();
const root=z.object({pin:archivedRecoverySetPinSchema,preparedVersionId:z.string().regex(/^[\x21-\x7e]{1,1024}$/).refine(v=>v!=='null'),
 expectedRootFormat:z.literal(2),state:z.literal('PREPARED_ROOT_REFERENCE_ONLY'),finalPublicationAcknowledgementReconstructed:no}).strict();
export type CommonRootReference=z.infer<typeof root>&{archiveConfigurationDigest:string};
export const commonCandidateReportSchema=managedCandidateReportSchema.extend({kind:z.literal('MANAGED_QUARANTINED_COMMON_CANDIDATE'),
 binding:commonCandidateBindingSchema,databaseSnapshot:managedSnapshotIntervalSchema.shape.databaseSnapshot,rootReference:root}).strict();
export const readRoleCommonCandidateReportSchema=commonCandidateReportSchema.extend({kind:z.literal('MANAGED_QUARANTINED_READ_ROLE_COMMON_CANDIDATE'),
 binding:readRoleCommonCandidateBindingSchema,capture:readRoleSupabaseCaptureSchema,authorization:managedReadRoleConfigurationSchema,sqlPrivilegeWindow:captureSqlPrivilegeWindowSchema,
 configuredJwtSqlRoleMatched:z.literal(true),providerTokenRoleVerified:no,providerProjectDatabaseVerified:no,
 unfilteredBucketVisibilityVerified:no,retainedPrivilegedCredentialsExcluded:no}).strict();
export const anyCommonCandidateReportSchema=z.discriminatedUnion('kind',[commonCandidateReportSchema,readRoleCommonCandidateReportSchema]);
const failure=()=>new Error('Managed common candidate is unresolved; preserve original evidence without replay or admission');
function artifact(raw:unknown,limit:number){
 const a=z.object({body:z.string().min(1),sha256:sha}).strict().parse(raw);
 if(Buffer.byteLength(a.body)>limit||candidateHash(a.body)!==a.sha256)throw failure();const value=JSON.parse(a.body);
 if(JSON.stringify(value)!==a.body)throw failure();return{artifact:a,value};
}
export function candidateRequestArtifact(raw:unknown){
 const b=anyCandidateBindingSchema.parse(raw);if(b.format===2)return legacyRequest(b);
 const body=JSON.stringify(b.format===4?readRoleRequest.parse({format:3,kind:'MANAGED_READ_ROLE_COMMON_CANDIDATE_REQUEST_V1',binding:b,executionState:'REQUESTED_ONLY',savedObservationAuthorizesExecution:false}):request.parse({format:2,kind:'MANAGED_COMMON_CANDIDATE_REQUEST_V1',binding:b,executionState:'REQUESTED_ONLY',savedObservationAuthorizesExecution:false}));
 if(Buffer.byteLength(body)>8192)throw failure();return{body,sha256:candidateHash(body)};
}
export function parseCandidateRequest(raw:unknown){
 const v=artifact(raw,8192);if(v.value.format===1)return parseLegacyRequest(raw);return{artifact:v.artifact,value:v.value.format===3?readRoleRequest.parse(v.value):request.parse(v.value)};
}
export function candidateReportArtifact(raw:unknown){
 if((raw as {kind?:unknown})?.kind==='MANAGED_QUARANTINED_STORAGE_CANDIDATE')return legacyReport(raw);
 const v=anyCommonCandidateReportSchema.parse(raw),{observationDigest,...core}=v,b=v.binding,p=v.rootReference.pin.scope;
 if(candidateHash(JSON.stringify(core))!==observationDigest||candidateHash(JSON.stringify(b))!==v.bindingDigest
  ||v.capture.configurationDigest!==b.captureConfigurationDigest||v.metadataWindow.configurationDigest!==b.metadataWindowConfigurationDigest
  ||p.index.objectCapturedAt!==v.capture.observedAt
  ||p.index.installationId!==b.installationId||p.index.sourceSha!==b.sourceSha||p.index.objectStoreIdentitySha256!==b.captureConfigurationDigest)throw failure();
 managedSnapshotInterval({metadataWindow:v.metadataWindow,databaseSnapshot:v.databaseSnapshot});
 if(v.kind==='MANAGED_QUARANTINED_READ_ROLE_COMMON_CANDIDATE'){
  const a=v.authorization,w=assertCaptureSqlPrivilegeWindow(v.sqlPrivilegeWindow),jwt=v.capture.jwtVerification,b=v.binding;
  if(candidateHash(JSON.stringify(a))!==b.captureAuthorizationDigest||a.installationId!==b.installationId||a.sourceSha!==b.sourceSha||a.maintenanceEpoch!==b.maintenanceEpoch
   ||a.captureConfigurationDigest!==b.captureConfigurationDigest||a.metadataWindowConfigurationDigest!==b.metadataWindowConfigurationDigest
   ||a.catalogueConfigurationDigest!==b.sqlPrivilegeConfigurationDigest||w.configurationDigest!==b.sqlPrivilegeConfigurationDigest
   ||w.database!==a.database.name||w.databaseOid!==a.database.oid||v.metadataWindow.database!==a.database.name||v.metadataWindow.databaseOid!==a.database.oid
   ||v.metadataWindow.observer.name!==a.snapshotObserver.name||v.metadataWindow.observer.oid!==a.snapshotObserver.oid
   ||w.capture.name!==a.sqlRole.name||w.capture.oid!==a.sqlRole.oid||jwt.sqlRole.name!==a.sqlRole.name||jwt.sqlRole.oid!==a.sqlRole.oid
   ||jwt.subject!==a.subject||w.maxWindowMs!==a.maxWindowMs
   ||JSON.stringify(v.metadataWindow.relations)!==JSON.stringify([a.storageRelations.buckets,a.storageRelations.objects].sort((x,y)=>Number(x.oid)-Number(y.oid))))throw failure();
 }
 if(v.capture.files.length!==v.capture.objects.length||new Set(v.capture.files.map(f=>f.fileUrl)).size!==v.capture.files.length
  ||v.capture.files.some((f,i)=>f.fileUrl!==v.capture.objects[i]?.fileUrl||f.bytes!==v.capture.objects[i]?.bytes))throw failure();
 const body=JSON.stringify(v);if(Buffer.byteLength(body)>128*1024*1024)throw failure();return{body,sha256:candidateHash(body)};
}
export function parseCandidateReport(raw:unknown){
 const v=artifact(raw,128*1024*1024);if(v.value.kind==='MANAGED_QUARANTINED_STORAGE_CANDIDATE')return parseLegacyReport(raw);
 candidateReportArtifact(v.value);return{artifact:v.artifact,value:anyCommonCandidateReportSchema.parse(v.value)};
}
export function assertCandidatePair(baseline:unknown,observation:unknown){
 const a=parseCandidateRequest(baseline),b=parseCandidateReport(observation);
 if(JSON.stringify(a.value.binding)!==JSON.stringify(b.value.binding)||b.value.requestPin.sha256!==a.artifact.sha256
  ||b.value.requestPin.byteLength!==Buffer.byteLength(a.artifact.body))throw failure();
}

export function commonCaptureObjectInventory(value:z.infer<typeof anyCommonCandidateReportSchema>){
 return canonicalObjectInventorySha256(value.capture.objects.map(o=>({objectKeySha256:canonicalObjectKeySha256(o.fileUrl),bytes:o.bytes,sha256:o.sha256})),value.capture.observedAt);
}
