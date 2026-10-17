import {pathToFileURL} from 'node:url';
import {S3Client} from '@aws-sdk/client-s3';
import {KMSClient} from '@aws-sdk/client-kms';
import {z} from 'zod';
import {ArchivedRecoverySets,archivedRecoveryConfigurationSchema} from '../services/archived-recovery-set.js';
import {S3ManagedMaintenanceControl,managedMaintenanceStorageConfigurationSchema} from '../services/managed-maintenance-control.js';
import {ManagedCandidateCaptureJournal} from '../services/managed-candidate-capture-journal.js';

const credential=z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/);
const input=z.object({archive:archivedRecoveryConfigurationSchema,control:managedMaintenanceStorageConfigurationSchema,
 minimumEpoch:z.number().int().min(1).max(2147483647),
 credentials:z.object({accessKeyId:credential.max(128),secretAccessKey:credential.max(256),sessionToken:credential.optional()}).strict(),
}).strict().refine(v=>v.archive.installationId===v.control.installationId);
type Inspection=Awaited<ReturnType<ManagedCandidateCaptureJournal['inspectCurrentRecovery']>>;
const failure=()=>new Error('Managed recovery inspection refused; retain quarantine');

/** Explicit output allowlist: never print configuration, credentials, file
 * inventories, document metadata, service PIDs or provider error bodies. */
export function summariseManagedRecoveryInspection(value:Inspection){
 if(value.kind!=='MANAGED_CURRENT_RECOVERY_INSPECTION_V1'||value.restoreMode!=='QUARANTINE_ONLY'
  ||value.actionAuthorized!==false||value.executionAuthorized!==false||value.archivedSetAdmitted!==false)throw failure();
 const common=value.records.filter(r=>r.kind==='COMMON_CAPTURE_RECOVERY_OBSERVATION');
 if(value.unresolvedCommonCandidates!==common.filter(r=>r.unresolved).length)throw failure();
 const verifiedRoots=common.filter(r=>r.rootStatus==='ARCHIVE_VERIFIED_QUARANTINE_ONLY').length;
 return{format:1,kind:'MANAGED_RECOVERY_DIAGNOSTIC_V1',installationId:value.bootstrap.plan.installationId,
  recordedSourceSha:value.bootstrap.plan.sourceSha,maintenanceEpoch:value.bootstrap.plan.maintenanceEpoch,
  controlRevision:value.bootstrap.head.revision,planDigest:value.bootstrap.head.value.planDigest,
  candidateCount:value.records.length,commonCandidateCount:common.length,verifiedRoots,
  unresolvedCommonCandidates:value.unresolvedCommonCandidates,
  diagnosticStatus:verifiedRoots>0&&value.unresolvedCommonCandidates===0?'AVAILABLE_EVIDENCE_VERIFIED' as const:'QUARANTINED_UNRESOLVED' as const,
  records:common.map(r=>({candidateId:r.candidateId,jobStatus:r.jobStatus,rootStatus:r.rootStatus,unresolved:r.unresolved})),
  restoreMode:'QUARANTINE_ONLY' as const,runningToolReleaseVerified:false as const,currentTenantAuthorityVerified:false as const,sourceHostLossProven:false as const,
  historyCompletenessVerified:false as const,writerFencingVerified:false as const,daemonRequestsAccountedFor:false as const,
  archivedSetAdmitted:false as const,cleanupAuthorized:false as const,executionAuthorized:false as const,actionAuthorized:false as const};
}

/** Dependencies are an internal test seam, never selectable by the CLI input. */
export async function inspectManagedRecovery(raw:unknown,inspect?:((configuration:z.infer<typeof input>)=>Promise<Inspection>)){
 const c=input.parse(raw);
 if(inspect)return summariseManagedRecoveryInspection(await inspect(c));
 const s3=new S3Client({region:'eu-west-1',endpoint:'https://s3.eu-west-1.amazonaws.com',credentials:c.credentials,
  maxAttempts:1,followRegionRedirects:false,requestHandler:{connectionTimeout:5000,requestTimeout:15000,throwOnRequestTimeout:true}});
 const kms=new KMSClient({region:'eu-west-1',endpoint:'https://kms.eu-west-1.amazonaws.com',credentials:c.credentials,
  maxAttempts:1,requestHandler:{connectionTimeout:5000,requestTimeout:15000,throwOnRequestTimeout:true}});
 try{
  const storage={installationId:c.archive.installationId,bucket:c.archive.bucket,accountId:c.archive.accountId,kmsKeyArn:c.archive.storageKeyArn};
  const journal=new ManagedCandidateCaptureJournal(storage,c.credentials,s3);
  return summariseManagedRecoveryInspection(await journal.inspectCurrentRecovery(new S3ManagedMaintenanceControl(c.control,c.credentials,s3),c.minimumEpoch,
   new ArchivedRecoverySets(c.archive,c.credentials,{s3,kms})));
 }finally{s3.destroy();kms.destroy();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  if(process.argv.length!==3||process.argv[2]!=='--stdin')throw failure();
  const chunks:Buffer[]=[];let size=0;
  try{
   for await(const value of process.stdin){size+=value.length;if(size>16384)throw failure();chunks.push(Buffer.from(value));}
   const result=await inspectManagedRecovery(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));
   process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=result.diagnosticStatus==='QUARANTINED_UNRESOLVED'?2:0;
  }finally{for(const chunk of chunks)chunk.fill(0);}
 }catch{process.stderr.write('Managed recovery inspection refused; retain quarantine\n');process.exitCode=1;}
}
