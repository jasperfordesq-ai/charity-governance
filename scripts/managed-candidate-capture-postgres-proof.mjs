import {ManagedCandidateCaptureJournal} from '../apps/api/dist/services/managed-candidate-capture-journal.js';
import {candidateBindingSchema} from '../apps/api/dist/services/managed-candidate-capture-contract.js';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {PrismaClient} from '@prisma/client';
import {S3Client,PutObjectCommand,GetObjectCommand} from '@aws-sdk/client-s3';
import {KMSClient,GenerateDataKeyCommand,DecryptCommand} from '@aws-sdk/client-kms';
import {ManagedStorageMetadataWindow} from '../apps/api/dist/services/managed-storage-metadata-window.js';
import {SupabaseRecoveryCapture} from '../apps/api/dist/services/supabase-recovery-capture.js';
import {KmsDocumentBackupKeys} from '../apps/api/dist/services/document-byte-backup-kms.js';
import {sealDocumentByteBackup,openDocumentByteBackup} from '../apps/api/dist/services/document-byte-backup.js';
import {S3DocumentByteBackups} from '../apps/api/dist/services/document-byte-backup-s3.js';
const sha=v=>createHash('sha256').update(v).digest('hex');
export async function proveManagedCandidateCapture({coordinator,control,admin,configuration,operation,scope,url}){
 const holder=new PrismaClient({datasources:{db:{url}}}),credentials={accessKeyId:'synthetic',secretAccessKey:'synthetic'};
 const kms=new KMSClient({region:'eu-west-1',credentials}),s3=new S3Client({region:'eu-west-1',credentials});
 const key=Buffer.alloc(32,9),plaintext=[],objects=new Map(),receipts=[];
 const dataKeyArn='arn:aws:kms:eu-west-1:123456789012:key/22222222-2222-2222-2222-222222222222';
 const storageKeyArn='arn:aws:kms:eu-west-1:123456789012:key/33333333-3333-3333-3333-333333333333';
 let loseAck=false,puts=0,dataPuts=0,journalPuts=0,loseJournal='',stage='initial';
 const journalStorage={installationId:operation.installationId,bucket:'synthetic-candidate-journal',accountId:'123456789012',
  kmsKeyArn:'arn:aws:kms:eu-west-1:123456789012:key/44444444-4444-4444-4444-444444444444'};

 kms.send=async command=>{
  assert.equal(command.input.KeyId,dataKeyArn);assert.ok(command instanceof GenerateDataKeyCommand||command instanceof DecryptCommand);
  const bytes=Buffer.from(key);plaintext.push(bytes);
  return{Plaintext:bytes,KeyId:dataKeyArn,EncryptionAlgorithm:'SYMMETRIC_DEFAULT',CiphertextBlob:Buffer.from('synthetic-wrapped-key')};
 };
 const metadata=row=>({VersionId:row.version,ServerSideEncryption:'aws:kms',SSEKMSKeyId:row.kmsKeyArn,
  ChecksumSHA256:Buffer.from(sha(row.body),'hex').toString('base64'),ChecksumType:'FULL_OBJECT'});
 s3.send=async command=>{
  assert.equal(command.input.ExpectedBucketOwner,'123456789012');
  const journal=command.input.Bucket===journalStorage.bucket;
  assert.ok(journal||command.input.Bucket==='synthetic-candidate-custody');
  const keyName=command.input.Bucket+'/'+command.input.Key;
  if(command instanceof PutObjectCommand){
   assert.equal(command.input.IfNoneMatch,'*');if(objects.has(keyName))throw new Error('synthetic conditional conflict');puts++;
   if(journal)journalPuts++;else dataPuts++;
   const row={body:String(command.input.Body),version:'candidate-version-'+puts,kmsKeyArn:journal?journalStorage.kmsKeyArn:storageKeyArn};objects.set(keyName,row);
   assert.equal(command.input.ChecksumSHA256,metadata(row).ChecksumSHA256);
   assert.equal(command.input.SSEKMSKeyId,row.kmsKeyArn);assert.equal(command.input.ServerSideEncryption,'aws:kms');
   if(!journal&&loseAck)throw new Error('synthetic candidate ACK lost AFTER object storage');
   if(journal&&loseJournal&&command.input.Key.endsWith('/'+loseJournal+'.json'))throw new Error('synthetic journal ACK lost AFTER storage');
   return metadata(row);
  }
  assert.ok(command instanceof GetObjectCommand);const row=objects.get(keyName);assert.ok(row);
  if(command.input.VersionId!==undefined)assert.equal(command.input.VersionId,row.version);else assert.equal(journal,true);
  assert.equal(command.input.ChecksumMode,'ENABLED');
  return{...metadata(row),ContentLength:Buffer.byteLength(row.body),Body:Readable.from([Buffer.from(row.body)])};
 };
 const journal=new ManagedCandidateCaptureJournal(journalStorage,credentials,s3);

 try{
  await admin.$executeRaw`CREATE TABLE public.synthetic_managed_capture_metadata(file_url text PRIMARY KEY)`;
  const fileUrl='record.pdf';
  await admin.$executeRaw`INSERT INTO public.synthetic_managed_capture_metadata VALUES (${fileUrl})`;
  const [relation]=await admin.$queryRaw`SELECT oid::text AS oid FROM pg_class WHERE oid='public.synthetic_managed_capture_metadata'::regclass`;
  const [{pid}]=await holder.$queryRaw`SELECT pg_backend_pid() AS pid`;
  const window=new ManagedStorageMetadataWindow(holder,{database:configuration.database,databaseOid:configuration.databaseOid,
   observer:configuration.maintenance,relations:[{schema:'public',name:'synthetic_managed_capture_metadata',oid:relation.oid}],maxWindowMs:5000});
  const secret='sb_secret_'+'a'.repeat(40),body=Buffer.from('synthetic governed document bytes');
  const storage=new S3DocumentByteBackups({installationId:operation.installationId,bucket:'synthetic-candidate-custody',
   accountId:'123456789012',storageKeyArn,dataKeyArn},credentials,s3),keys=new KmsDocumentBackupKeys(dataKeyArn,credentials,kms);
  const original=await control.observe();
  for(const mode of ['success','changed-bytes','lost-candidate-ack','lost-request-ack','lost-report-ack']){
   const candidateId=randomUUID();let downloads=0;const buffers=[];
   loseAck=mode==='lost-candidate-ack';loseJournal=mode==='lost-request-ack'?'baseline':mode==='lost-report-ack'?'observation':'';
   const capture=new SupabaseRecoveryCapture({installationId:scope.installationId,projectRef:scope.projectRef,bucket:scope.bucket,
    credential:{id:scope.captureKeyId,sha256:sha(secret)}},secret,async(input,init)=>{
    init?.signal?.throwIfAborted();const path=new URL(String(input)).pathname;
    assert.ok(init?.method==='GET'||(init?.method==='POST'&&path.includes('/object/list/')));
    if(path.includes('/bucket/'))return Response.json({id:scope.bucket,public:false});
    if(path.includes('/object/list/'))return Response.json([{name:'record.pdf',id:'11111111-1111-4111-8111-111111111111',
     created_at:'2026-10-17T00:00:00Z',updated_at:'2026-10-17T00:00:00Z',metadata:{size:body.length,mimetype:'application/pdf'}}]);
    downloads++;const bytes=Buffer.from(body);if(mode==='changed-bytes'&&downloads>1)bytes[0]^=1;
    return new Response(bytes,{headers:{'content-type':'application/pdf','content-length':String(bytes.length)}});
   });
   const request={candidateId,attemptId:original.value.attemptId,controlRevision:original.revision,
    captureConfigurationDigest:capture.configurationDigest(),metadataWindowConfigurationDigest:window.configurationDigest(),journalConfigurationDigest:journal.configurationDigest()};
   const visitor=async(file,bytes,digest,signal)=>{
    stage='visitor';
    const requestKey=journalStorage.bucket+'/managed-maintenance/'+operation.installationId+'/'+original.value.attemptId+'/capture-candidate/'+sha(candidateId)+'/baseline.json';
    assert.equal(objects.has(requestKey),true);
    buffers.push(bytes);assert.equal(file.fileUrl,fileUrl);assert.equal(digest,sha(body));
    const [lock]=await admin.$queryRaw`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${pid}
     AND relation=${relation.oid}::oid AND mode='ShareLock' AND granted) AS held`;
    assert.equal(lock.held,true);
    const [metadataRow]=await admin.$queryRaw`SELECT file_url FROM public.synthetic_managed_capture_metadata`;
    assert.equal(metadataRow.file_url,file.fileUrl);
    const context={installationId:operation.installationId,setId:candidateId,organisationId:'synthetic',documentId:'record',
     sourceSha:operation.sourceSha,databaseSha256:sha('synthetic database context, NOT a database dump'),
     sourceBindingSha256:sha(metadataRow.file_url),bytesSha256:digest,byteLength:bytes.length,keyArn:dataKeyArn};
    stage='seal';const sealed=await sealDocumentByteBackup(context,bytes,keys);signal.throwIfAborted();stage='publish';
    const stored=await storage.publish(context,sealed,signal);receipts.push({context,stored});stage='open';
    const reopened=await openDocumentByteBackup(context,stored.body,sealed.sha256,keys);
    try{assert.deepEqual(reopened,body);stage='visitor-done';}finally{reopened.fill(0);}
   };
   const before=objects.size;
   if(mode==='success'){
    const completed=await coordinator.captureQuarantined(request,capture,window,journal,visitor).catch(()=>{throw new Error('Synthetic candidate composition failed at '+stage);});
    const result=completed.candidate;assert.equal(result.capture.objects.length,1);assert.equal(result.metadataWindow.metadataWindowCompleted,true);
    assert.equal(result.binding.candidateId,candidateId);assert.equal(result.binding.controlRevision,original.revision);
    assert.equal(result.restoreMode,'QUARANTINE_ONLY');assert.equal(result.wholeBackendQuiesced,false);
    assert.equal(result.archivedSetAdmitted,false);assert.equal(result.objectBytesFenced,false);
   }else await assert.rejects(()=>coordinator.captureQuarantined(request,capture,window,journal,visitor));
   const expectedWrites=mode==='success'||mode==='lost-report-ack'?3:mode==='lost-request-ack'?1:2;
   assert.equal(objects.size,before+expectedWrites);
   if(mode==='lost-request-ack')assert.equal(buffers.length,0);else assert.ok(buffers.length===1&&buffers[0].every(v=>v===0));
   if(mode==='lost-request-ack'||mode==='lost-report-ack'){
    loseJournal='';const readsBefore=downloads,putsBefore=puts;
    const fresh=new ManagedCandidateCaptureJournal(journalStorage,credentials,s3);
    const binding=candidateBindingSchema.parse({format:2,kind:'MANAGED_QUARANTINED_STORAGE_CAPTURE_V2',...operation,...request,planDigest:coordinator.planDigest()});
    const saved=await fresh.forCandidate(binding).discoverRequest();assert.equal(saved.originalAcknowledgementReconstructed,false);
    assert.equal(saved.savedObservationAuthorizesExecution,false);
    if(mode==='lost-report-ack'){
     const stored=await fresh.forCandidate(binding).discoverReport(saved.pin);
     assert.equal(stored.value.binding.candidateId,candidateId);assert.equal(stored.savedObservationAuthorizesExecution,false);
     assert.equal(stored.originalAcknowledgementReconstructed,false);assert.equal(stored.archivedSetAdmitted,false);
    }
    await assert.rejects(()=>coordinator.captureQuarantined(request,capture,window,fresh,visitor));
    assert.equal(downloads,readsBefore);assert.equal(puts,putsBefore);
   }
   assert.equal((await control.observe()).revision,original.revision);
  }
  assert.equal(dataPuts,4);assert.equal(journalPuts,7);assert.equal(puts,11);assert.equal(receipts.length,3);assert.ok(plaintext.every(p=>p.every(v=>v===0)));
  console.log('PASS native parent candidate composition: actual closed attempt + TLS metadata window + file capture + AES-GCM/KMS and conditional exact-version SDK custody; byte drift and lost data/request/report ACKs preserve quarantine; fresh discovery does not replay or admit');
 }finally{key.fill(0);await holder.$disconnect();kms.destroy();s3.destroy();}
}
