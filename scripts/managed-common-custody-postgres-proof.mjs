import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {backend,config as defaults,credentials,hash,source,sink} from '../apps/api/dist/tests/fixtures/archived-custody.js';
import {sealDatabaseByteBackup} from '../apps/api/dist/services/database-byte-backup.js';
import {sealDocumentByteBackup} from '../apps/api/dist/services/document-byte-backup.js';
import {KmsDatabaseBackupKeys} from '../apps/api/dist/services/database-byte-backup-kms.js';
import {KmsDocumentBackupKeys} from '../apps/api/dist/services/document-byte-backup-kms.js';
import {S3DatabaseByteBackups} from '../apps/api/dist/services/database-byte-backup-s3.js';
import {S3DocumentByteBackups} from '../apps/api/dist/services/document-byte-backup-s3.js';
import {sealDocumentBackupIndex} from '../apps/api/dist/services/document-backup-index.js';
import {KmsDocumentBackupIndexMac} from '../apps/api/dist/services/document-backup-index-kms.js';
import {canonicalMetadataBindingSha256} from '../packages/shared/runtime/document-recovery-inventory.mjs';
import {S3BackupManifests} from '../apps/api/dist/services/backup-manifests-s3.js';
import {ArchivedRecoverySets} from '../apps/api/dist/services/archived-recovery-set.js';
const hex=v=>hash(v).toString('hex');
/** In-process signed SDK synthetic cloud transport, actual crypto/archive classes.
 * Input report and dump come from the genuine native source/isolated-restore proof. */
export async function startManagedCommonCustody({reportBody,dump,metadata,captureConfigurationDigest},signal){
 const config={...defaults,installationId:'synthetic-snapshot-proof'},b=backend(config),clients={s3:b.s3(),kms:b.kms()},readers=[];
 const report=JSON.parse(reportBody),setId=randomUUID(),sourceSha=report.helperImplementation.commitSha,reportSha=hex(reportBody);
 const storage={installationId:config.installationId,bucket:config.bucket,accountId:config.accountId,storageKeyArn:config.storageKeyArn};
 const context={installationId:config.installationId,setId,sourceSha,databaseIdentitySha256:report.sourceDatabaseIdentitySha256,
  sourceCaptureReportSha256:reportSha,databaseSha256:report.dump.sha256,byteLength:Number(report.dump.bytes),keyArn:config.dataKeyArn};
 const close=()=>{clients.s3.destroy();clients.kms.destroy();for(const v of readers){v.s3.destroy();v.kms.destroy();}b.close();};
 try{
  assert.equal(dump.length,context.byteLength);assert.equal(hex(dump),context.databaseSha256);
  const encrypted=sink(),sealed=await sealDatabaseByteBackup(context,source(dump),encrypted.stream,
   new KmsDatabaseBackupKeys(config.dataKeyArn,credentials,clients.kms),signal);
  const ciphertext=Buffer.concat(encrypted.chunks);
  const database=await new S3DatabaseByteBackups({...storage,dataKeyArn:config.dataKeyArn},credentials,clients.s3)
   .publish(context,sealed,source(ciphertext),signal);ciphertext.fill(0);for(const chunk of encrypted.chunks)chunk.fill(0);
  const meta=new S3BackupManifests(storage,credentials,clients.s3),target={installationId:config.installationId,setId,sourceSha};
  const sourceReport=await meta.publish({...target,kind:'SOURCE_REPORT_V2'},{body:reportBody,sha256:reportSha},signal);
  const receipts=[];
  return{
   close,
   visit:async(file,bytes,digest,caller)=>{
    const row=metadata.rows.find(r=>r.fileUrl===file.fileUrl);assert.ok(row);assert.equal(row.fileSize,bytes.length);
    const docContext={installationId:config.installationId,setId,sourceSha,databaseSha256:context.databaseSha256,
     organisationId:row.organisationId,documentId:row.id,sourceBindingSha256:canonicalMetadataBindingSha256(row),
     bytesSha256:digest,byteLength:bytes.length,keyArn:config.dataKeyArn};
    const encrypted=await sealDocumentByteBackup(docContext,bytes,new KmsDocumentBackupKeys(config.dataKeyArn,credentials,clients.kms));
    const stored=await new S3DocumentByteBackups({...storage,dataKeyArn:config.dataKeyArn},credentials,clients.s3).publish(docContext,encrypted,caller);
    receipts.push({context:docContext,sha256:stored.sha256,objectKey:stored.objectKey,versionId:stored.versionId});
   },
   finish:async(interval,capture)=>{
    const indexScope={installationId:config.installationId,setId,sourceSha,databaseSha256:context.databaseSha256,
     sourceCaptureReportSha256:reportSha,databaseIdentitySha256:context.databaseIdentitySha256,objectStoreIdentitySha256:captureConfigurationDigest,
     dataKeyArn:config.dataKeyArn,macKeyArn:config.indexMacKeyArn,metadataCapturedAt:metadata.capturedAt,
     metadataCaptureTransactionId:metadata.transactionId,objectCapturedAt:capture.observedAt};
    const index=await sealDocumentBackupIndex({scope:indexScope,metadataRows:metadata.rows,objectRows:capture.objects,receipts},
     new KmsDocumentBackupIndexMac(config.indexMacKeyArn,credentials,clients.kms));
    const storedIndex=await meta.publish({...target,kind:'DOCUMENT_INDEX_V1'},index);
    const input={indexScope,databaseContext:context,database:{artifact:database.artifact,versionId:database.versionId},
     index:{sha256:index.sha256,versionId:storedIndex.versionId},sourceReport:{sha256:reportSha,versionId:sourceReport.versionId}};
    const archive=new ArchivedRecoverySets(config,credentials,clients),bad=structuredClone(interval),before=b.writes;
    bad.databaseSnapshot.snapshotBindingSha256='f'.repeat(64);
    await assert.rejects(archive.prepareImported(input,bad));assert.equal(b.writes,before);
    const prepared=await archive.prepareImported(input,interval);assert.equal(JSON.parse(prepared.artifact.body).manifest.format,2);
    const staged=await archive.stagePrepared(prepared.pin,prepared.artifact);b.loseRoot=true;
    await assert.rejects(archive.publishPrepared(prepared.pin,staged.versionId));const writes=b.writes,generates=b.generates;
    const fresh={s3:b.s3(),kms:b.kms()};readers.push(fresh);
    const verified=await new ArchivedRecoverySets(config,credentials,fresh).verifySet(prepared.pin);
    assert.equal(verified.completedIntervalBindingVerified,true);assert.deepEqual(verified.snapshotInterval,interval);
    assert.equal(verified.documentCount,metadata.rows.length);assert.equal(verified.objectCount,capture.objects.length);
    assert.equal(verified.restoreMode,'QUARANTINE_ONLY');assert.equal(verified.wholeBackendQuiesced,false);assert.equal(verified.actionAuthorized,false);
    assert.equal(b.writes,writes);assert.equal(b.generates,generates);
    console.log('PASS common encrypted custody: genuine full report/dump + actual captured file + SQL metadata transaction -> AES-GCM/KMS, exact-version multipart/database/document custody, authenticated index and interval-bound V2 root; lost root ACK verifies fresh read-only without new writes/data keys');
    return{rootSha256:verified.sha256,reportSha256:reportSha,databaseSha256:context.databaseSha256,completedIntervalBindingVerified:true,
     wholeBackendQuiesced:false,currentTenantAuthorityVerified:false,sourceHostLossProven:false,actionAuthorized:false};
   }
  };
 }catch(e){close();throw e;}
}
