import {z} from 'zod';
import {candidateHash,legacySupabaseCaptureSchema} from './managed-candidate-capture-contract.js';
const sha=z.string().regex(/^[a-f0-9]{64}$/),no=z.literal(false),yes=z.literal(true),name=z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
const oid=z.string().regex(/^[1-9][0-9]{0,9}$/).refine(v=>Number(v)<=4294967295),principal=z.object({name,oid}).strict();
export const readRoleSupabaseCaptureSchema=legacySupabaseCaptureSchema.extend({kind:z.literal('SUPABASE_READ_ROLE_CANDIDATE_CAPTURE_V1'),
 credentialCapability:z.literal('ASYMMETRIC_CUSTOM_ROLE_JWT'),jwtVerification:z.object({format:z.literal(1),kind:z.literal('SUPABASE_CAPTURE_JWT_VERIFICATION_V1'),
  algorithm:z.enum(['ES256','RS256']),keyId:z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),verificationKeySha256:sha,sqlRole:principal,subject:z.string().uuid(),
  issuedAt:z.number().int().safe().nonnegative(),expiresAt:z.number().int().safe().nonnegative(),signatureVerified:yes,configuredClaimsMatched:yes,
  sqlRoleOidDeclared:yes,sqlRoleOidVerified:no,providerKeyCurrentVerified:no,providerSqlRoleVerified:no,privilegeIntervalHeld:no}).strict()
  .refine(v=>v.expiresAt>v.issuedAt&&v.expiresAt-v.issuedAt<=600)}).strict();
export type ManagedReadRoleCapturedFiles=z.infer<typeof readRoleSupabaseCaptureSchema>;
const catalogues=['pg_attribute','pg_proc','pg_class','pg_authid','pg_auth_members','pg_database','pg_namespace','pg_policy'];
export const captureSqlPrivilegeWindowSchema=z.object({format:z.literal(1),kind:z.literal('MANAGED_CAPTURE_SQL_PRIVILEGE_WINDOW_V1'),windowId:z.string().uuid(),
 configurationDigest:sha,database:name,databaseOid:oid,capture:principal,backendPid:z.number().int().positive(),
 catalogues:z.array(z.object({name:z.string(),oid,shared:z.boolean(),held:yes}).strict()).length(8),
 startedAt:z.string().min(1).max(80),finishedAt:z.string().min(1).max(80),maxWindowMs:z.number().int().min(1000).max(30000),observationDigest:sha,
 scope:z.literal('LISTED_SQL_CATALOGUES_DURING_CALLBACK_ONLY'),configuredCaptureSqlReadOnlyObserved:yes,
 preexistingAssignedTransactionsExcludedAtEntry:yes,listedCatalogueChangesExcludedDuringCallback:yes,windowStillHeld:no,
 providerTokenRoleVerified:no,providerManagementActorsExcluded:no,unfilteredBucketVisibilityVerified:no,captureCredentialReadOnlyVerified:no,
 allWritersInventoried:no,wholeBackendQuiesced:no,actionAuthorized:no}).strict();
export function assertCaptureSqlPrivilegeWindow(raw:unknown){
 const v=captureSqlPrivilegeWindowSchema.parse(raw);
 const{observationDigest,scope,configuredCaptureSqlReadOnlyObserved,preexistingAssignedTransactionsExcludedAtEntry,
  listedCatalogueChangesExcludedDuringCallback,windowStillHeld,providerTokenRoleVerified,providerManagementActorsExcluded,
  unfilteredBucketVisibilityVerified,captureCredentialReadOnlyVerified,allWritersInventoried,wholeBackendQuiesced,actionAuthorized,...facts}=v;
 if(candidateHash(JSON.stringify(facts))!==observationDigest||new Set(v.catalogues.map(c=>c.oid)).size!==8
  ||v.catalogues.some((c,i)=>c.name!==catalogues[i]||c.shared!==['pg_authid','pg_auth_members','pg_database'].includes(c.name)))throw new Error('Capture SQL privilege interval is unverified');
 return v;
}
