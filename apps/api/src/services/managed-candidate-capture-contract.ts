import {createHash} from 'node:crypto';
import {z} from 'zod';
const sha=z.string().regex(/^[a-f0-9]{64}$/),uuid=z.string().uuid(),id=z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const name=z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/),oid=z.string().regex(/^[1-9][0-9]{0,9}$/).refine(v=>Number(v)<=4294967295);
export const candidateHash=(value:string)=>createHash('sha256').update(value).digest('hex');
export const candidateRequestSchema=z.object({candidateId:uuid.refine(v=>v===v.toLowerCase()),attemptId:uuid,
 controlRevision:sha,captureConfigurationDigest:sha,metadataWindowConfigurationDigest:sha,journalConfigurationDigest:sha}).strict();
export const candidateBindingSchema=z.object({format:z.literal(2),kind:z.literal('MANAGED_QUARANTINED_STORAGE_CAPTURE_V2'),
 installationId:id,sourceSha:z.string().regex(/^[a-f0-9]{40}$/),maintenanceEpoch:z.number().int().positive().max(2147483647),
 ...candidateRequestSchema.shape,planDigest:sha}).strict();
export const candidatePinSchema=z.object({kind:z.enum(['BASELINE','OBSERVATION']),versionId:z.string().min(1).max(1024).refine(v=>v!=='null'),
 sha256:sha,byteLength:z.number().int().min(1).max(128*1024*1024)}).strict();
const request=z.object({format:z.literal(1),kind:z.literal('MANAGED_CANDIDATE_REQUEST_V1'),binding:candidateBindingSchema,
 executionState:z.literal('REQUESTED_ONLY'),savedObservationAuthorizesExecution:z.literal(false)}).strict();
const no=z.literal(false),size=z.number().int().min(0).max(10*1024*1024),path=z.string().min(1).max(2048);
const file=z.object({fileUrl:path,id:uuid,bytes:size,mimeType:z.string().min(1).max(255),
 createdAt:z.string().max(64).datetime({offset:true}),updatedAt:z.string().max(64).datetime({offset:true})}).strict();
const capture=z.object({kind:z.literal('SUPABASE_CANDIDATE_CAPTURE'),restoreMode:z.literal('QUARANTINE_ONLY'),
 captureConsistency:z.literal('EXTERNAL_VERIFICATION_REQUIRED'),visibility:z.literal('SUPPLIED_CREDENTIAL_VIEW_ONLY'),
 credentialId:uuid,credentialSha256:sha,captureRequestMode:z.literal('READ_OPERATIONS_ONLY'),
 credentialCapability:z.literal('PRIVILEGED_MODERN_SERVER_KEY'),credentialHashMatched:z.literal(true),credentialIdentityVerified:no,
 credentialPrivilegeVerified:no,credentialWriteAuthorityExcluded:no,wholeStorageQuiesced:no,actionAuthorized:no,
 configurationDigest:sha,inventoryDigest:sha,startedAt:z.string().datetime(),observedAt:z.string().datetime(),
 objects:z.array(z.object({fileUrl:path,bytes:size,sha256:sha}).strict()).max(5000),files:z.array(file).max(5000)}).strict();
export const managedStorageWindowSchema=z.object({format:z.literal(1),kind:z.literal('MANAGED_STORAGE_METADATA_WINDOW_V1'),windowId:uuid,
 configurationDigest:sha,database:name,databaseOid:oid,observer:z.object({name,oid}).strict(),
 relations:z.array(z.object({schema:name,name,oid}).strict()).min(1).max(16),backendPid:z.number().int().positive(),
 lockMode:z.literal('SHARE'),transactionReadOnly:z.literal(true),transactionIsolation:z.literal('ReadCommitted'),
 startedAt:z.string().min(1).max(80),finishedAt:z.string().min(1).max(80),observationDigest:sha,
 scope:z.literal('CONFIGURED_RELATIONS_DURING_CALLBACK_ONLY'),metadataWindowCompleted:z.literal(true),windowStillHeld:no,
 objectBytesFenced:no,allWritersInventoried:no,wholeBackendQuiesced:no,actionAuthorized:no}).strict();
const report=z.object({kind:z.literal('MANAGED_QUARANTINED_STORAGE_CANDIDATE'),binding:candidateBindingSchema,bindingDigest:sha,
 requestPin:candidatePinSchema.refine(p=>p.kind==='BASELINE'&&p.byteLength<=8192),capture,metadataWindow:managedStorageWindowSchema,
 restoreMode:z.literal('QUARANTINE_ONLY'),controlRevisionVerifiedAtBoundaries:z.literal(true),wholeBackendQuiesced:no,
 objectBytesFenced:no,currentTenantAuthorityVerified:no,archivedSetAdmitted:no,actionAuthorized:no,observationDigest:sha}).strict();
export const managedCandidateReportSchema=report;
const failure=()=>new Error('Managed candidate custody artifact is unverified');
export function candidateRequestArtifact(raw:unknown){
 const value=request.parse({format:1,kind:'MANAGED_CANDIDATE_REQUEST_V1',binding:candidateBindingSchema.parse(raw),
  executionState:'REQUESTED_ONLY',savedObservationAuthorizesExecution:false});
 const body=JSON.stringify(value);return{body,sha256:candidateHash(body)};
}
function parse(raw:unknown,limit:number){
 const artifact=z.object({body:z.string().min(1),sha256:sha}).strict().parse(raw);
 if(Buffer.byteLength(artifact.body)>limit||candidateHash(artifact.body)!==artifact.sha256)throw failure();
 const value=JSON.parse(artifact.body);if(JSON.stringify(value)!==artifact.body)throw failure();return{artifact,value};
}
export function parseCandidateRequest(raw:unknown){const {artifact,value}=parse(raw,8192);request.parse(value);return{artifact,value:request.parse(value)};}
export function candidateReportArtifact(raw:unknown){
 report.parse(raw);const value=raw as z.infer<typeof report>,{observationDigest,...core}=value;
 if(candidateHash(JSON.stringify(core))!==observationDigest||candidateHash(JSON.stringify(value.binding))!==value.bindingDigest
  ||value.capture.configurationDigest!==value.binding.captureConfigurationDigest
  ||value.metadataWindow.configurationDigest!==value.binding.metadataWindowConfigurationDigest)throw failure();
 const w=value.metadataWindow,{observationDigest:windowHash,scope,metadataWindowCompleted,windowStillHeld,
  objectBytesFenced,allWritersInventoried,wholeBackendQuiesced,actionAuthorized,...facts}=w;
 if(candidateHash(JSON.stringify(facts))!==windowHash)throw failure();
 if(value.capture.files.length!==value.capture.objects.length||new Set(value.capture.files.map(f=>f.fileUrl)).size!==value.capture.files.length
  ||value.capture.files.some((f,i)=>f.fileUrl!==value.capture.objects[i]?.fileUrl||f.bytes!==value.capture.objects[i]?.bytes))throw failure();
 const body=JSON.stringify(value);if(Buffer.byteLength(body)>128*1024*1024)throw failure();
 return{body,sha256:candidateHash(body)};
}
export function parseCandidateReport(raw:unknown){const {artifact,value}=parse(raw,128*1024*1024);
 candidateReportArtifact(value);return{artifact,value:report.parse(value)};}
export function assertCandidatePair(baseline:unknown,observation:unknown){
 const a=parseCandidateRequest(baseline),b=parseCandidateReport(observation);
 if(JSON.stringify(a.value.binding)!==JSON.stringify(b.value.binding)||b.value.requestPin.sha256!==a.artifact.sha256
  ||b.value.requestPin.byteLength!==Buffer.byteLength(a.artifact.body))throw failure();
}
