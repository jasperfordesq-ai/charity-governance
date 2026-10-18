import {z} from 'zod';
const sha=z.string().regex(/^[a-f0-9]{64}$/),name=z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
const oid=z.string().regex(/^[1-9][0-9]{0,9}$/).refine(v=>Number(v)<=4294967295);
const principal=z.object({name,oid}).strict();
export const managedReadRoleOperationSchema=z.object({installationId:z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),sourceSha:z.string().regex(/^[a-f0-9]{40}$/),maintenanceEpoch:z.number().int().positive().max(2147483647)}).strict();
export const managedReadRoleConfigurationSchema=managedReadRoleOperationSchema.extend({kind:z.literal('MANAGED_READ_ROLE_CAPTURE_CONFIGURATION_V1'),
 projectRef:z.string().regex(/^[a-z0-9]{20}$/),bucket:z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),subject:z.string().uuid(),sqlRole:principal,
 database:z.object({name,oid}).strict(),catalogueObserver:principal,snapshotObserver:principal,
 storageRelations:z.object({buckets:z.object({schema:z.literal('storage'),name:z.literal('buckets'),oid}).strict(),
  objects:z.object({schema:z.literal('storage'),name:z.literal('objects'),oid}).strict()}).strict(),
 captureConfigurationDigest:sha,catalogueConfigurationDigest:sha,metadataWindowConfigurationDigest:sha,
 maxWindowMs:z.number().int().min(1000).max(30000)}).strict().refine(v=>v.storageRelations.buckets.oid!==v.storageRelations.objects.oid);
