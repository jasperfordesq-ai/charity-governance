import {z} from 'zod';
import {candidateHash,candidatePinSchema} from './managed-candidate-capture-contract.js';
import {commonCandidateBindingSchema} from './managed-common-candidate-contract.js';
const sha=z.string().regex(/^[a-f0-9]{64}$/),no=z.literal(false);
const release=z.string().regex(/^[a-f0-9]{40}$/);
export const localJobPinSchema=z.object({sha256:sha,byteLength:z.number().int().min(1).max(8192)}).strict();
const scope=z.object({kind:z.literal('COMMON_CANDIDATE'),bindingDigest:sha,requestPinDigest:sha,sourceSha:release}).strict();
const localRequest=z.object({format:z.literal(1),kind:z.literal('MANAGED_IMPORTED_PROOF_JOB_V1'),jobId:z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
 scope,sourceSha:release,workspaceDigest:sha,snapshotDigest:sha,argumentsDigest:sha,createdAt:z.string().datetime(),state:z.literal('REQUESTED_ONLY'),executionAuthorized:no,publicationAuthorized:no,actionAuthorized:no}).strict();
const localObservation=z.object({format:z.literal(1),kind:z.literal('MANAGED_IMPORTED_PROOF_JOB_OBSERVATION_V1'),jobId:z.string().uuid(),requestPin:localJobPinSchema,
 state:z.enum(['WORKER_EXIT_ACK_OBSERVED','UNRESOLVED']),jobContainersObservedAbsent:z.boolean(),executionAuthorized:no,publicationAuthorized:no,actionAuthorized:no}).strict()
 .refine(v=>v.state!=='WORKER_EXIT_ACK_OBSERVED'||v.jobContainersObservedAbsent);
export const localJobArtifactSchema=localJobPinSchema.extend({body:z.string().min(1).max(8192)}).strict();
const requestEnvelope=z.object({format:z.literal(1),kind:z.literal('MANAGED_SOURCE_JOB_REQUEST_V1'),bindingDigest:sha,candidateRequestPin:candidatePinSchema,
 localRequest:localJobArtifactSchema,executionState:z.literal('REQUESTED_ONLY'),savedObservationAuthorizesExecution:no}).strict();
const resultEnvelope=z.object({format:z.literal(1),kind:z.literal('MANAGED_SOURCE_JOB_OBSERVATION_V1'),bindingDigest:sha,jobRequestPin:candidatePinSchema,
 localObservation:localJobArtifactSchema,savedObservationAuthorizesExecution:no,actionAuthorized:no}).strict();
const identityFields={jobId:localRequest.shape.jobId,
 unit:z.string().max(100),invocationId:z.string().regex(/^[a-f0-9]{32}$/),uid:z.number().int().min(1).max(2147483647),mainPid:z.number().int().min(1).max(2147483647),
 mainStartMonotonic:z.string().regex(/^[1-9][0-9]{0,19}$/),sourceSha:release,inputDigest:sha,executionAuthorized:no,actionAuthorized:no};
const identity=z.union([
 z.object({format:z.literal(1),kind:z.literal('MANAGED_GUARDIAN_LIVE_BINDING_V1'),...identityFields}).strict(),
 z.object({format:z.literal(2),kind:z.literal('MANAGED_GUARDIAN_LIVE_BINDING_V2'),...identityFields,
  bootId:z.string().regex(/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/),controlGroup:z.string().max(1024)}).strict()
  .refine(v=>v.controlGroup.startsWith(`/user.slice/user-${v.uid}.slice/user@${v.uid}.service/`)
   &&v.controlGroup.endsWith('/'+v.unit)&&v.controlGroup.slice(1).split('/').every(p=>p!=='.'&&p!=='..'&&/^[A-Za-z0-9_.@:-]+$/.test(p))),
]).refine(v=>v.unit===`charitypilot-containment-${v.jobId}.service`);
const localService=z.object({format:z.literal(1),kind:z.literal('MANAGED_IMPORTED_PROOF_SERVICE_V1'),jobId:localRequest.shape.jobId,requestPin:localJobPinSchema,
 identity,executionAuthorized:no,publicationAuthorized:no,actionAuthorized:no}).strict().refine(v=>v.jobId===v.identity.jobId);
const serviceEnvelope=z.object({format:z.literal(1),kind:z.literal('MANAGED_SOURCE_JOB_SERVICE_V1'),bindingDigest:sha,jobRequestPin:candidatePinSchema,
 localService:localJobArtifactSchema,savedObservationAuthorizesExecution:no,actionAuthorized:no}).strict();
const failure=()=>new Error('Managed source job custody unresolved; inspect original records without replay');
export function localJobArtifact(raw:unknown){const v=localJobArtifactSchema.parse(raw);
 if(Buffer.byteLength(v.body)!==v.byteLength||candidateHash(v.body)!==v.sha256)throw failure();return v;}
function artifact(value:unknown){const body=JSON.stringify(value);if(Buffer.byteLength(body)>16384)throw failure();return{body,sha256:candidateHash(body)};}
function parse(raw:unknown){const v=z.object({body:z.string().min(1).max(16384),sha256:sha}).strict().parse(raw);
 if(Buffer.byteLength(v.body)>16384||candidateHash(v.body)!==v.sha256)throw failure();return JSON.parse(v.body) as unknown;}
export function jobScope(raw:unknown,pin:unknown){const b=commonCandidateBindingSchema.parse(raw),p=candidatePinSchema.parse(pin);if(p.kind!=='BASELINE'||p.byteLength>8192)throw failure();
 return{kind:'COMMON_CANDIDATE' as const,bindingDigest:candidateHash(JSON.stringify(b)),requestPinDigest:candidateHash(JSON.stringify(p)),sourceSha:b.sourceSha};}
export function jobRequestArtifact(binding:unknown,candidateRequestPin:unknown,raw:unknown){const s=jobScope(binding,candidateRequestPin),local=localJobArtifact(raw),v=localRequest.parse(JSON.parse(local.body));
 if(JSON.stringify(v.scope)!==JSON.stringify(s)||v.sourceSha!==s.sourceSha||new Date(v.createdAt).toISOString()!==v.createdAt)throw failure();
 return artifact(requestEnvelope.parse({format:1,kind:'MANAGED_SOURCE_JOB_REQUEST_V1',bindingDigest:s.bindingDigest,candidateRequestPin,localRequest:local,
  executionState:'REQUESTED_ONLY',savedObservationAuthorizesExecution:false}));}
export function parseJobRequest(binding:unknown,raw:unknown){const value=requestEnvelope.parse(parse(raw)),checked=jobRequestArtifact(binding,value.candidateRequestPin,value.localRequest);
 const local=localRequest.parse(JSON.parse(value.localRequest.body));if(checked.body!==JSON.stringify(value))throw failure();return{artifact:checked,value,local};}
export function jobObservationArtifact(binding:unknown,jobRequestPin:unknown,raw:unknown){const b=commonCandidateBindingSchema.parse(binding),local=localJobArtifact(raw);localObservation.parse(JSON.parse(local.body));
 const pin=candidatePinSchema.parse(jobRequestPin);if(pin.kind!=='BASELINE'||pin.byteLength>16384)throw failure();
 return artifact(resultEnvelope.parse({format:1,kind:'MANAGED_SOURCE_JOB_OBSERVATION_V1',bindingDigest:candidateHash(JSON.stringify(b)),jobRequestPin:pin,
  localObservation:local,savedObservationAuthorizesExecution:false,actionAuthorized:false}));}
export function parseJobObservation(binding:unknown,raw:unknown){const value=resultEnvelope.parse(parse(raw)),checked=jobObservationArtifact(binding,value.jobRequestPin,value.localObservation);
 if(checked.body!==JSON.stringify(value))throw failure();return{artifact:checked,value,local:localObservation.parse(JSON.parse(value.localObservation.body))};}
export function assertJobPair(binding:unknown,baseline:unknown,result:unknown){const a=parseJobRequest(binding,baseline),b=parseJobObservation(binding,result);
 const p=localJobPinSchema.parse({sha256:a.value.localRequest.sha256,byteLength:a.value.localRequest.byteLength});
 if(b.value.jobRequestPin.sha256!==a.artifact.sha256||b.value.jobRequestPin.byteLength!==Buffer.byteLength(a.artifact.body)||a.local.jobId!==b.local.jobId||JSON.stringify(p)!==JSON.stringify(b.local.requestPin))throw failure();}
/** Separate immutable baseline; the existing request/result namespace stays unchanged. */
export function jobServiceScope(candidateId:string){return candidateHash('CHARITYPILOT_SOURCE_JOB_SERVICE_V1\n'+z.string().uuid().parse(candidateId));}
export function jobServiceArtifact(binding:unknown,jobRequestPin:unknown,raw:unknown){
 const b=commonCandidateBindingSchema.parse(binding),local=localJobArtifact(raw),v=localService.parse(JSON.parse(local.body)),pin=candidatePinSchema.parse(jobRequestPin);
 if(pin.kind!=='BASELINE'||pin.byteLength>16384||v.identity.sourceSha!==b.sourceSha)throw failure();
 return artifact(serviceEnvelope.parse({format:1,kind:'MANAGED_SOURCE_JOB_SERVICE_V1',bindingDigest:candidateHash(JSON.stringify(b)),jobRequestPin:pin,
  localService:local,savedObservationAuthorizesExecution:false,actionAuthorized:false}));
}
export function parseJobService(binding:unknown,raw:unknown){
 const value=serviceEnvelope.parse(parse(raw)),checked=jobServiceArtifact(binding,value.jobRequestPin,value.localService);
 if(checked.body!==JSON.stringify(value))throw failure();return{artifact:checked,value,local:localService.parse(JSON.parse(value.localService.body))};
}
export function assertJobServicePair(binding:unknown,baseline:unknown,service:unknown){
 const a=parseJobRequest(binding,baseline),b=parseJobService(binding,service),p=localJobPinSchema.parse({sha256:a.value.localRequest.sha256,byteLength:a.value.localRequest.byteLength});
 if(b.value.jobRequestPin.sha256!==a.artifact.sha256||b.value.jobRequestPin.byteLength!==Buffer.byteLength(a.artifact.body)||a.local.jobId!==b.local.jobId
  ||JSON.stringify(p)!==JSON.stringify(b.local.requestPin)||a.local.sourceSha!==b.local.identity.sourceSha)throw failure();
}
