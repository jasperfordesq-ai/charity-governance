import {createHash} from 'node:crypto';
import {z} from 'zod';
import {supabaseCaptureJwtConfiguration} from './supabase-capture-jwt.js';
import {supabaseReadRoleCaptureConfigurationSchema} from './supabase-recovery-capture.js';
import {readRoleSupabaseCaptureSchema} from './managed-read-role-capture-contract.js';
const sha=z.string().regex(/^[a-f0-9]{64}$/),uuid=z.string().uuid().refine(v=>v===v.toLowerCase());
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const canarySchema=z.object({fileUrl:z.string().min(1).max(2048),bytes:z.number().int().min(1).max(1024),sha256:sha}).strict();
export const retiredControlReadConfigurationSchema=z.object({installationId:z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),projectRef:z.string().regex(/^[a-z0-9]{20}$/),
 bucket:z.literal('charitypilot-recovery-canaries'),canary:canarySchema,retiredControl:z.object({id:uuid,sha256:sha}).strict(),
 readRole:z.object({subject:uuid,sqlRole:supabaseCaptureJwtConfiguration.shape.sqlRole,configurationDigest:sha}).strict()}).strict()
 .refine(v=>v.canary.fileUrl.startsWith('charitypilot-recovery-canary/'+v.installationId+'/')&&v.canary.fileUrl.split('/').length<=32
  &&v.canary.fileUrl.split('/').every(p=>p.length>0&&p.length<=255&&p!=='.'&&p!=='..'&&!/[\x00-\x1f\x7f\\%]/.test(p)));
export const retiredControlReadBaselineSchema=z.object({format:z.literal(1),kind:z.literal('SUPABASE_RETIRED_CONTROL_READ_BASELINE_V1'),configurationDigest:sha,
 capturedAt:z.string().datetime(),canarySha256:sha,bytes:z.number().int().min(1).max(1024),retiredControlId:uuid,
 positiveControl:z.literal('VERIFIED_CUSTOM_ROLE_JWT'),bothConfiguredCredentialsReadCanary:z.literal(true),
 originalBaselineAcknowledgementVerified:z.literal(false),actionAuthorized:z.literal(false)}).strict();
const failure=()=>new Error('Retired control read evidence is unverified');
export const retiredControlReadConfigurationDigest=(raw:unknown)=>hash(JSON.stringify({format:1,policy:'RETIRED_CONTROL_CANARY_GET_WITH_CUSTOM_JWT_POSITIVE_V1',...retiredControlReadConfigurationSchema.parse(raw)}));
export const retiredControlReadDescriptorSchema=z.object({format:z.literal(1),kind:z.literal('RETIRED_CONTROL_READ_DESCRIPTOR_V1'),
 configuration:retiredControlReadConfigurationSchema,positiveReader:supabaseReadRoleCaptureConfigurationSchema}).strict().superRefine((v,ctx)=>{
 const c=v.configuration,p=v.positiveReader;
 if(c.installationId!==p.installationId||c.projectRef!==p.projectRef||c.bucket!==p.bucket||c.readRole.subject!==p.authentication.subject
  ||JSON.stringify(c.readRole.sqlRole)!==JSON.stringify(p.authentication.sqlRole)
  ||c.readRole.configurationDigest!==hash(JSON.stringify({format:3,provider:'SUPABASE_PRIVATE_CAPTURE_CUSTOM_ROLE_JWT_V3',...p})))
  ctx.addIssue({code:'custom',message:'Read comparison descriptor scope mismatch'});
});
const no=z.literal(false),yes=z.literal(true);
export const retiredControlReadObservationSchema=z.object({format:z.literal(1),kind:z.literal('SUPABASE_RETIRED_CONTROL_CANARY_READ_REFUSAL_V1'),
 configurationDigest:sha,baselineSha256:sha,retiredControlId:uuid,canarySha256:sha,bytes:z.number().int().min(1).max(1024),
 status:z.union([z.literal(401),z.literal(403)]),startedAt:z.string().datetime(),observedAt:z.string().datetime(),positiveJwt:readRoleSupabaseCaptureSchema.shape.jwtVerification,
 observationDigest:sha,coverage:z.literal('EXACT_SYNTHETIC_CANARY_GET_ONLY'),positiveReadRoleCanaryReadsMatched:yes,retiredControlCanaryGetRefusalObserved:yes,
 originalBaselineAcknowledgementVerified:no,credentialRevocationProven:no,writeRejectionVerified:no,providerKeyCurrentVerified:no,
 sqlPrivilegeWindowHeld:no,unfilteredVisibilityVerified:no,wholeStorageQuiesced:no,actionAuthorized:no}).strict();
const artifactSchema=z.object({body:z.string().max(4096),sha256:sha,byteLength:z.number().int().positive().optional()}).strict();
/** Historical public-data validation only. No JWT construction, clock-active
 * credential check, HTTP, original ACK recovery or current authority exists. */
export function assertRetiredControlReadBaseline(rawDescriptor:unknown,raw:unknown){
 try{
  const d=retiredControlReadDescriptorSchema.parse(rawDescriptor),a=artifactSchema.parse(raw),v=retiredControlReadBaselineSchema.parse(JSON.parse(a.body)),c=d.configuration;
  if(Buffer.byteLength(a.body)>4096||hash(a.body)!==a.sha256||JSON.stringify(v)!==a.body||a.byteLength!==undefined&&a.byteLength!==Buffer.byteLength(a.body)
   ||v.configurationDigest!==retiredControlReadConfigurationDigest(c)||v.canarySha256!==c.canary.sha256||v.bytes!==c.canary.bytes
   ||v.retiredControlId!==c.retiredControl.id||Date.parse(v.capturedAt)>Date.now()+60000)throw failure();
  return{body:a.body,sha256:a.sha256,byteLength:Buffer.byteLength(a.body),value:v};
 }catch{throw failure();}
}
export function assertRetiredControlReadObservation(rawDescriptor:unknown,baseline:unknown,raw:unknown){
 try{
  const d=retiredControlReadDescriptorSchema.parse(rawDescriptor),b=assertRetiredControlReadBaseline(d,baseline),v=retiredControlReadObservationSchema.parse(raw),c=d.configuration;
  const j=v.positiveJwt,key=d.positiveReader.authentication.verificationKey;
  const facts={format:v.format,kind:v.kind,configurationDigest:v.configurationDigest,baselineSha256:v.baselineSha256,retiredControlId:v.retiredControlId,
   canarySha256:v.canarySha256,bytes:v.bytes,status:v.status,startedAt:v.startedAt,observedAt:v.observedAt,positiveJwt:j};
  if(v.observationDigest!==hash(JSON.stringify(facts))||v.configurationDigest!==retiredControlReadConfigurationDigest(c)||v.baselineSha256!==b.sha256
   ||v.retiredControlId!==c.retiredControl.id||v.canarySha256!==c.canary.sha256||v.bytes!==c.canary.bytes||j.subject!==c.readRole.subject
   ||JSON.stringify(j.sqlRole)!==JSON.stringify(c.readRole.sqlRole)||j.keyId!==key.kid||j.algorithm!==key.alg||j.verificationKeySha256!==hash(JSON.stringify(key))
   ||Date.parse(v.startedAt)<Date.parse(b.value.capturedAt)||Date.parse(v.observedAt)<Date.parse(v.startedAt)
   ||Date.parse(b.value.capturedAt)<j.issuedAt*1000||Date.parse(b.value.capturedAt)>=j.expiresAt*1000
   ||Date.parse(v.startedAt)<j.issuedAt*1000||Date.parse(v.observedAt)>=j.expiresAt*1000)throw failure();return v;
 }catch{throw failure();}
}
