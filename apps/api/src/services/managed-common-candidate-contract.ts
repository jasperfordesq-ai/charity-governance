import {canonicalObjectInventorySha256,canonicalObjectKeySha256} from '../../../../packages/shared/runtime/document-recovery-inventory.mjs';
import {z} from 'zod';
import {candidateHash,candidateBindingSchema,candidateRequestSchema,managedCandidateReportSchema,
 candidateRequestArtifact as legacyRequest,candidateReportArtifact as legacyReport,parseCandidateRequest as parseLegacyRequest,parseCandidateReport as parseLegacyReport} from './managed-candidate-capture-contract.js';
import {archivedRecoverySetPinSchema} from './archived-recovery-set.js';
import {managedSnapshotIntervalSchema,managedSnapshotInterval} from './managed-snapshot-interval.js';
import {managedReadRoleConfigurationSchema} from './managed-read-role-configuration.js';
import {readRoleSupabaseCaptureSchema,captureSqlPrivilegeWindowSchema,assertCaptureSqlPrivilegeWindow} from './managed-read-role-capture-contract.js';
import {managedRetirementBundleSchema,assertManagedRetirementBundle} from './managed-retirement-custody.js';
import {managedRetirementRecordSchemas,assertControlRetirementMetadata} from './managed-capture-control-retirement.js';
import {retiredControlReadObservationSchema,assertRetiredControlReadObservation} from './retired-control-read-evidence.js';
import {managedPlanSchema} from './managed-plan-bootstrap.js';
import {candidatePinSchema} from './managed-candidate-capture-contract.js';
const sha=z.string().regex(/^[a-f0-9]{64}$/),no=z.literal(false);
export const commonCandidateRequestSchema=candidateRequestSchema.extend({archiveConfigurationDigest:sha}).strict();
export const commonCandidateBindingSchema=candidateBindingSchema.extend({...commonCandidateRequestSchema.shape,
 format:z.literal(3),kind:z.literal('MANAGED_QUARANTINED_COMMON_CAPTURE_V3')}).strict();
export const readRoleCommonCandidateRequestSchema=commonCandidateRequestSchema.extend({captureAuthorizationDigest:sha,sqlPrivilegeConfigurationDigest:sha}).strict();
export const readRoleCommonCandidateBindingSchema=commonCandidateBindingSchema.extend({...readRoleCommonCandidateRequestSchema.shape,
 format:z.literal(4),kind:z.literal('MANAGED_QUARANTINED_READ_ROLE_COMMON_CAPTURE_V4')}).strict();
export const retiredControlCommonCandidateRequestSchema=readRoleCommonCandidateRequestSchema.extend({retirementConfigurationDigest:sha,readComparisonConfigurationDigest:sha,
 retirementRequestPin:candidatePinSchema.refine(v=>v.kind==='BASELINE'),retirementReadBaselinePin:candidatePinSchema.refine(v=>v.kind==='BASELINE'),retirementReportPin:candidatePinSchema.refine(v=>v.kind==='OBSERVATION')}).strict();
export const retiredControlCommonCandidateBindingSchema=readRoleCommonCandidateBindingSchema.extend({...retiredControlCommonCandidateRequestSchema.shape,
 format:z.literal(5),kind:z.literal('MANAGED_QUARANTINED_RETIRED_CONTROL_COMMON_CAPTURE_V5')}).strict();
export const anyCommonCandidateBindingSchema=z.discriminatedUnion('format',[commonCandidateBindingSchema,readRoleCommonCandidateBindingSchema,retiredControlCommonCandidateBindingSchema]);
export const anyCandidateBindingSchema=z.discriminatedUnion('format',[candidateBindingSchema,commonCandidateBindingSchema,readRoleCommonCandidateBindingSchema,retiredControlCommonCandidateBindingSchema]);
const request=z.object({format:z.literal(2),kind:z.literal('MANAGED_COMMON_CANDIDATE_REQUEST_V1'),binding:commonCandidateBindingSchema,
 executionState:z.literal('REQUESTED_ONLY'),savedObservationAuthorizesExecution:no}).strict();
const readRoleRequest=request.extend({format:z.literal(3),kind:z.literal('MANAGED_READ_ROLE_COMMON_CANDIDATE_REQUEST_V1'),binding:readRoleCommonCandidateBindingSchema}).strict();
const retiredRequest=request.extend({format:z.literal(4),kind:z.literal('MANAGED_RETIRED_CONTROL_COMMON_CANDIDATE_REQUEST_V1'),binding:retiredControlCommonCandidateBindingSchema}).strict();
const root=z.object({pin:archivedRecoverySetPinSchema,preparedVersionId:z.string().regex(/^[\x21-\x7e]{1,1024}$/).refine(v=>v!=='null'),
 expectedRootFormat:z.literal(2),state:z.literal('PREPARED_ROOT_REFERENCE_ONLY'),finalPublicationAcknowledgementReconstructed:no}).strict();
export type CommonRootReference=z.infer<typeof root>&{archiveConfigurationDigest:string};
export const commonCandidateReportSchema=managedCandidateReportSchema.extend({kind:z.literal('MANAGED_QUARANTINED_COMMON_CANDIDATE'),
 binding:commonCandidateBindingSchema,databaseSnapshot:managedSnapshotIntervalSchema.shape.databaseSnapshot,rootReference:root}).strict();
export const readRoleCommonCandidateReportSchema=commonCandidateReportSchema.extend({kind:z.literal('MANAGED_QUARANTINED_READ_ROLE_COMMON_CANDIDATE'),
 binding:readRoleCommonCandidateBindingSchema,capture:readRoleSupabaseCaptureSchema,authorization:managedReadRoleConfigurationSchema,sqlPrivilegeWindow:captureSqlPrivilegeWindowSchema,
 configuredJwtSqlRoleMatched:z.literal(true),providerTokenRoleVerified:no,providerProjectDatabaseVerified:no,
 unfilteredBucketVisibilityVerified:no,retainedPrivilegedCredentialsExcluded:no}).strict();
const retirementBoundary=z.object({metadataBefore:managedRetirementRecordSchemas.metadata,metadataAfter:managedRetirementRecordSchemas.metadata,freshReadRefusal:retiredControlReadObservationSchema}).strict();
export const retiredControlCommonCandidateReportSchema=readRoleCommonCandidateReportSchema.extend({kind:z.literal('MANAGED_QUARANTINED_RETIRED_CONTROL_COMMON_CANDIDATE'),binding:retiredControlCommonCandidateBindingSchema,
 retirement:z.object({plan:managedPlanSchema,evidence:managedRetirementBundleSchema,before:retirementBoundary,after:retirementBoundary}).strict(),
 configuredRetiredControlCanaryRefusalObserved:z.literal(true)}).strict();
export const anyCommonCandidateReportSchema=z.discriminatedUnion('kind',[commonCandidateReportSchema,readRoleCommonCandidateReportSchema,retiredControlCommonCandidateReportSchema]);
const failure=()=>new Error('Managed common candidate is unresolved; preserve original evidence without replay or admission');
function artifact(raw:unknown,limit:number){
 const a=z.object({body:z.string().min(1),sha256:sha}).strict().parse(raw);
 if(Buffer.byteLength(a.body)>limit||candidateHash(a.body)!==a.sha256)throw failure();const value=JSON.parse(a.body);
 if(JSON.stringify(value)!==a.body)throw failure();return{artifact:a,value};
}
export function candidateRequestArtifact(raw:unknown){
 const b=anyCandidateBindingSchema.parse(raw);if(b.format===2)return legacyRequest(b);
 const body=JSON.stringify(b.format===5?retiredRequest.parse({format:4,kind:'MANAGED_RETIRED_CONTROL_COMMON_CANDIDATE_REQUEST_V1',binding:b,executionState:'REQUESTED_ONLY',savedObservationAuthorizesExecution:false}):b.format===4?readRoleRequest.parse({format:3,kind:'MANAGED_READ_ROLE_COMMON_CANDIDATE_REQUEST_V1',binding:b,executionState:'REQUESTED_ONLY',savedObservationAuthorizesExecution:false}):request.parse({format:2,kind:'MANAGED_COMMON_CANDIDATE_REQUEST_V1',binding:b,executionState:'REQUESTED_ONLY',savedObservationAuthorizesExecution:false}));
 if(Buffer.byteLength(body)>8192)throw failure();return{body,sha256:candidateHash(body)};
}
export function parseCandidateRequest(raw:unknown){
 const v=artifact(raw,8192);if(v.value.format===1)return parseLegacyRequest(raw);return{artifact:v.artifact,value:v.value.format===4?retiredRequest.parse(v.value):v.value.format===3?readRoleRequest.parse(v.value):request.parse(v.value)};
}
export function candidateReportArtifact(raw:unknown){
 if((raw as {kind?:unknown})?.kind==='MANAGED_QUARANTINED_STORAGE_CANDIDATE')return legacyReport(raw);
 const v=anyCommonCandidateReportSchema.parse(raw),{observationDigest,...core}=v,b=v.binding,p=v.rootReference.pin.scope;
 if(candidateHash(JSON.stringify(core))!==observationDigest||candidateHash(JSON.stringify(b))!==v.bindingDigest
  ||v.capture.configurationDigest!==b.captureConfigurationDigest||v.metadataWindow.configurationDigest!==b.metadataWindowConfigurationDigest
  ||p.index.objectCapturedAt!==v.capture.observedAt
  ||p.index.installationId!==b.installationId||p.index.sourceSha!==b.sourceSha||p.index.objectStoreIdentitySha256!==b.captureConfigurationDigest)throw failure();
 managedSnapshotInterval({metadataWindow:v.metadataWindow,databaseSnapshot:v.databaseSnapshot});
 if(v.kind==='MANAGED_QUARANTINED_READ_ROLE_COMMON_CANDIDATE'||v.kind==='MANAGED_QUARANTINED_RETIRED_CONTROL_COMMON_CANDIDATE'){
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
 if(v.kind==='MANAGED_QUARANTINED_RETIRED_CONTROL_COMMON_CANDIDATE'){
  const r=v.retirement,b=v.binding,p=r.plan;
  const checked=assertManagedRetirementBundle(r.evidence,p,{installationId:b.installationId,sourceSha:b.sourceSha,attemptId:b.attemptId,planDigest:b.planDigest,
   maintenanceEpoch:b.maintenanceEpoch,controlRevision:b.controlRevision,retirementConfigurationDigest:b.retirementConfigurationDigest});
  if(p.format!==12||p.captureAuthorization!==b.captureAuthorizationDigest||p.captureControlReadComparison!==b.readComparisonConfigurationDigest
   ||candidateHash(JSON.stringify({format:1,policy:'IMMUTABLE_CANDIDATE_REQUEST_REPORT_V1',...r.evidence.storage}))!==b.journalConfigurationDigest
   ||JSON.stringify(b.retirementRequestPin)!==JSON.stringify(r.evidence.request.pin)||JSON.stringify(b.retirementReadBaselinePin)!==JSON.stringify(r.evidence.readBaseline.pin)
   ||JSON.stringify(b.retirementReportPin)!==JSON.stringify(r.evidence.report.pin)||checked.request.scope.projectRef!==v.authorization.projectRef||checked.request.scope.bucket!==v.authorization.bucket)throw failure();
  const principal=checked.request.readComparison.configuration.readRole,j=v.capture.jwtVerification;
  if(principal.subject!==v.authorization.subject||JSON.stringify(principal.sqlRole)!==JSON.stringify(v.authorization.sqlRole)
   ||Date.parse(v.capture.startedAt)<j.issuedAt*1000||Date.parse(v.capture.observedAt)>=j.expiresAt*1000)throw failure();
  for(const boundary of [r.before,r.after]){
   const first=assertControlRetirementMetadata(boundary.metadataBefore,checked.request.scope),last=assertControlRetirementMetadata(boundary.metadataAfter,checked.request.scope);
   const comparison=assertRetiredControlReadObservation(checked.request.readComparison,checked.readBaseline.readBaseline,boundary.freshReadRefusal);
   if(first.stateSha256!==last.stateSha256||Date.parse(first.observedAt)>Date.parse(comparison.startedAt)||Date.parse(last.observedAt)<Date.parse(comparison.observedAt)
    ||comparison.positiveJwt.verificationKeySha256!==j.verificationKeySha256||comparison.positiveJwt.keyId!==j.keyId||comparison.positiveJwt.algorithm!==j.algorithm)throw failure();
  }
  if(JSON.stringify(r.before.metadataAfter.stateSha256)!==JSON.stringify(r.after.metadataBefore.stateSha256)
   ||Date.parse(r.before.freshReadRefusal.observedAt)>Date.parse(v.capture.startedAt)||Date.parse(r.after.freshReadRefusal.startedAt)<Date.parse(v.capture.observedAt))throw failure();
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
