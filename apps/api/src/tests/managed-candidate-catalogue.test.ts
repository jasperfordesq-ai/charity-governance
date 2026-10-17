import assert from 'node:assert/strict';
import test from 'node:test';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {S3Client,GetObjectCommand,PutObjectCommand,ListObjectsV2Command} from '@aws-sdk/client-s3';
import {ManagedCandidateCaptureJournal} from '../services/managed-candidate-capture-journal.js';
import {candidateHash as hash} from '../services/managed-candidate-capture-contract.js';
const storage={installationId:'synthetic',bucket:'synthetic-catalogue',accountId:'123456789012',
 kmsKeyArn:'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-1111-1111-111111111111'};
const credentials={accessKeyId:'synthetic',secretAccessKey:'synthetic'},trusted={attemptId:'11111111-1111-4111-8111-111111111111',
 sourceSha:'1'.repeat(40),maintenanceEpoch:1,planDigest:hash('plan'),controlRevision:hash('head')};
const unresolved=/^Error: Managed candidate catalogue is unresolved; do not infer history, execution or admission$/;
async function fixture(){
 const client=new S3Client({region:'eu-west-1',credentials}),objects=new Map<string,{body:string;version:string}>();
 let puts=0,lists=0,gets=0;
 let mutate:(page:Record<string,unknown>,call:number)=>Record<string,unknown>=p=>p;
 let getFault:(command:GetObjectCommand)=>void=()=>{};
 client.send=(async(command:PutObjectCommand|GetObjectCommand|ListObjectsV2Command,options:{abortSignal?:AbortSignal}={})=>{
  options.abortSignal?.throwIfAborted();assert.equal(command.input.ExpectedBucketOwner,storage.accountId);assert.equal(command.input.Bucket,storage.bucket);
  if(command instanceof ListObjectsV2Command){
   lists++;assert.equal(command.input.MaxKeys,1000);assert.equal(command.input.Delimiter,undefined);
   const rows=[...objects].filter(([k])=>k.startsWith(command.input.Prefix!)).sort(([a],[b])=>a<b?-1:1);
   const offset=command.input.ContinuationToken?Number(command.input.ContinuationToken):0,row=rows.slice(offset,offset+1);
   return mutate({Name:storage.bucket,Prefix:command.input.Prefix,MaxKeys:1000,KeyCount:row.length,
    ContinuationToken:command.input.ContinuationToken,IsTruncated:offset+1<rows.length,
    ...(offset+1<rows.length?{NextContinuationToken:String(offset+1)}:{}),
    Contents:row.map(([Key,v])=>({Key,Size:Buffer.byteLength(v.body),ETag:'"'+v.version+'"'}))},lists);
  }
  if(command instanceof PutObjectCommand){
   assert.equal(command.input.IfNoneMatch,'*');assert.equal(objects.has(command.input.Key!),false);puts++;
   objects.set(command.input.Key!,{body:String(command.input.Body),version:'version-'+puts});
   return{VersionId:'version-'+puts,ServerSideEncryption:'aws:kms',SSEKMSKeyId:storage.kmsKeyArn};
  }
  gets++;getFault(command);const row=objects.get(command.input.Key!)!;assert.ok(row);
  if(command.input.VersionId!==undefined)assert.equal(command.input.VersionId,row.version);
  const body=Readable.from([Buffer.from(row.body)]);
  // Model SDK transport ownership: aborting at headers would kill the body.
  options.abortSignal?.addEventListener('abort',()=>body.destroy(),{once:true});
  return{VersionId:row.version,ETag:'"'+row.version+'"',ServerSideEncryption:'aws:kms',SSEKMSKeyId:storage.kmsKeyArn,
   ChecksumSHA256:Buffer.from(hash(row.body),'hex').toString('base64'),ChecksumType:'FULL_OBJECT',
   ContentLength:Buffer.byteLength(row.body),Body:body};
 }) as typeof client.send;
 const producer=new ManagedCandidateCaptureJournal(storage,credentials,client);
 for(let i=0;i<2;i++){
  const binding={format:2,kind:'MANAGED_QUARANTINED_STORAGE_CAPTURE_V2',installationId:storage.installationId,
   ...trusted,candidateId:randomUUID(),captureConfigurationDigest:hash('capture'),metadataWindowConfigurationDigest:hash('window'),
   journalConfigurationDigest:producer.configurationDigest()};
  const session=producer.forCandidate(binding);await session.reserve();session.closeExecution();
 }
 return{client,objects,get puts(){return puts;},get lists(){return lists;},get gets(){return gets;},
  setListMutation:(fn:typeof mutate)=>{mutate=fn;},setGetFault:(fn:typeof getFault)=>{getFault=fn;},
  fresh:()=>new ManagedCandidateCaptureJournal(storage,credentials,client)};
}
test('candidate catalogue bootstraps unknown IDs through bounded pages and version-pinned read-only records',async()=>{
 const f=await fixture(),puts=f.puts;try{
  const result=await f.fresh().discoverCandidates(trusted);
  assert.equal(result.records.length,2);assert.equal(f.lists,4);assert.equal(f.puts,puts);assert.equal(result.listingStableAtBoundaries,true);
  for(const r of result.records){assert.equal(r.reportStatus,'NOT_LISTED_AT_BOUNDARY');assert.equal(r.reportPin,null);
   assert.equal(r.binding.attemptId,trusted.attemptId);assert.equal(r.savedObservationAuthorizesExecution,false);}
  for(const flag of ['historyCompletenessVerified','crossPageSnapshotVerified','sourceHostLossProven','originalAcknowledgementReconstructed',
   'savedObservationAuthorizesExecution','archivedSetAdmitted','actionAuthorized'])assert.equal(result[flag as keyof typeof result],false);
 }finally{f.client.destroy();}
});
test('catalogue refuses malformed/repeated pages, orphan reports, listing drift and wrong bootstrap without partial success',async()=>{
 for(const mode of ['malformed','null-contents','repeat-token','duplicate','drift','outside','orphan','wrong-bootstrap']){
  const f=await fixture();try{
   if(mode==='orphan'){
    const key=[...f.objects.keys()][0]!,row=f.objects.get(key)!;f.objects.delete(key);f.objects.set(key.replace('baseline','observation'),row);
   }
   f.setListMutation((p,call)=>{
    if(mode==='malformed')return{...p,IsTruncated:undefined};
    if(mode==='null-contents')return{...p,Contents:null,KeyCount:0,IsTruncated:false,NextContinuationToken:undefined};
    if(mode==='repeat-token')return{...p,IsTruncated:true,NextContinuationToken:'1'};
    if(mode==='duplicate'&&call===2)return{...p,Contents:[{Key:[...f.objects.keys()].sort()[0],Size:1,ETag:'"bad"'}]};
    if(mode==='drift'&&call===3)return{...p,Contents:(p.Contents as {Key:string;ETag:string}[]).map(r=>({...r,ETag:'"changed"'}))};
    if(mode==='outside')return{...p,Contents:[{Key:'another-scope/baseline.json',Size:1,ETag:'"bad"'}]};return p;
   });
   await assert.rejects(()=>f.fresh().discoverCandidates(mode==='wrong-bootstrap'?{...trusted,sourceSha:'2'.repeat(40)}:trusted),unresolved);
   assert.equal(f.puts,2);
  }finally{f.client.destroy();}
 }
});
test('catalogue rejects invalid bootstrap and cancellation before requests; candidate path/body substitution cannot bootstrap',async()=>{
 const f=await fixture();try{
  await assert.rejects(()=>f.fresh().discoverCandidates({...trusted,unknown:'synthetic'}),unresolved);assert.equal(f.lists,0);
  const cancelled=new AbortController();cancelled.abort();await assert.rejects(()=>f.fresh().discoverCandidates(trusted,cancelled.signal),unresolved);
  assert.equal(f.lists,0);
  const key=[...f.objects.keys()][0]!,row=f.objects.get(key)!;const value=JSON.parse(row.body);value.binding.candidateId=randomUUID();
  f.objects.set(key,{...row,body:JSON.stringify(value)});await assert.rejects(()=>f.fresh().discoverCandidates(trusted),unresolved);
  assert.equal(f.puts,2);
 }finally{f.client.destroy();}
});

test('catalogue cancellation stops an uncooperative listing transport without writes or request-body reads',async()=>{
 const f=await fixture(),controller=new AbortController(),before=f.gets;try{
  const original=f.client.send.bind(f.client);
  f.client.send=((command:ListObjectsV2Command|GetObjectCommand,options?:unknown)=>{
   if(command instanceof ListObjectsV2Command){controller.abort();return new Promise(()=>{});}
   return original(command,options as never);
  }) as typeof f.client.send;
  await assert.rejects(()=>f.fresh().discoverCandidates(trusted,controller.signal),unresolved);
  assert.equal(f.gets,before);assert.equal(f.puts,2);
 }finally{f.client.destroy();}
});
