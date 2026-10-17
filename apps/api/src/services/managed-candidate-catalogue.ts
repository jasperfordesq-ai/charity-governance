import {parseCandidateRequest,type CommonRootReference} from './managed-common-candidate-contract.js';
import {Readable} from 'node:stream';
import {GetObjectCommand,ListObjectsV2Command,type GetObjectCommandOutput,type ListObjectsV2CommandOutput,type S3Client} from '@aws-sdk/client-s3';
import {z} from 'zod';
import {credentialReadMaintenanceBindingSchema} from './credential-read-evidence.js';
import {candidateHash,candidatePinSchema} from './managed-candidate-capture-contract.js';
import type {ManagedCandidateCaptureJournal} from './managed-candidate-capture-journal.js';
const bootstrap=credentialReadMaintenanceBindingSchema.extend({controlRevision:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const entry=z.object({Key:z.string().min(1).max(1024),ETag:z.string().min(1).max(1024),Size:z.number().int().min(1).max(128*1024*1024)});
type Entry=z.infer<typeof entry>;
type Context={storage:{installationId:string;bucket:string;accountId:string;kmsKeyArn:string},configurationDigest:string,client:S3Client,
 forCandidate:(raw:unknown)=>Pick<ReturnType<ManagedCandidateCaptureJournal['forCandidate']>,'inspectRequest'|'inspectReport'>};
const failure=()=>new Error('Managed candidate catalogue is unresolved; do not infer history, execution or admission');
/** Read-only current-namespace bootstrap. Original IDs are learned from stored
 * requests, never guessed or supplied by the lost source host. Not a complete
 * history, atomic cross-page snapshot, current authority or execution lease. */
export async function discoverManagedCandidateCatalogue(context:Context,raw:unknown,caller?:AbortSignal){
 const parsed=bootstrap.safeParse(raw);if(!parsed.success||(caller!==undefined&&!(caller instanceof AbortSignal)))throw failure();
 const trusted=parsed.data,controller=new AbortController(),signal=caller?AbortSignal.any([caller,controller.signal]):controller.signal;
 const timer=setTimeout(()=>controller.abort(),300000),s=context.storage;
 const prefix=`managed-maintenance/${s.installationId}/${trusted.attemptId}/capture-candidate/`;
 async function send(command:GetObjectCommand):Promise<GetObjectCommandOutput>;
 async function send(command:ListObjectsV2Command):Promise<ListObjectsV2CommandOutput>;
 async function send(command:GetObjectCommand|ListObjectsV2Command){
  const bounded=new AbortController(),requestSignal=AbortSignal.any([signal,bounded.signal]),deadline=setTimeout(()=>bounded.abort(),15000);
  let stop:()=>void=()=>{};const cancelled=new Promise<never>((_,reject)=>{stop=()=>reject(failure());requestSignal.addEventListener('abort',stop,{once:true});});
  let returned=false;
  try{
   requestSignal.throwIfAborted();const pending=(command instanceof GetObjectCommand?context.client.send(command,{abortSignal:requestSignal})
    :context.client.send(command,{abortSignal:requestSignal})).then(result=>{
     if(requestSignal.aborted){if('Body' in result&&result.Body instanceof Readable)result.Body.destroy();throw failure();}return result;
    });const result=await Promise.race([pending,cancelled]);returned=true;return result;
  }finally{clearTimeout(deadline);requestSignal.removeEventListener('abort',stop);if(!returned)bounded.abort();}
 }
 async function list(){
  const rows:Entry[]=[],seen=new Set<string>(),tokens=new Set<string>();let token:string|undefined;
  for(let page=0;page<20;page++){
   const value=await send(new ListObjectsV2Command({Bucket:s.bucket,ExpectedBucketOwner:s.accountId,Prefix:prefix,MaxKeys:1000,
    ...(token?{ContinuationToken:token}:{})}));
   if(value.Name!==s.bucket||value.Prefix!==prefix||value.MaxKeys!==1000||typeof value.IsTruncated!=='boolean'
    ||value.ContinuationToken!==token||(value.CommonPrefixes!==undefined&&(!Array.isArray(value.CommonPrefixes)||value.CommonPrefixes.length!==0))
    ||value.EncodingType!==undefined||value.Delimiter!==undefined||value.StartAfter!==undefined)throw failure();
   const contents=z.array(entry).max(1000).parse(value.Contents===undefined?[]:value.Contents);
   if(value.KeyCount!==contents.length||(value.IsTruncated&&contents.length===0))throw failure();
   for(const row of contents){
    if(!row.Key.startsWith(prefix)||!/^([a-f0-9]{64})\/(baseline|observation)\.json$/.test(row.Key.slice(prefix.length))
     ||seen.has(row.Key)||rows.length>=2000)throw failure();
    seen.add(row.Key);rows.push(row);
   }
   if(!value.IsTruncated){if(value.NextContinuationToken!==undefined)throw failure();return rows.sort((a,b)=>a.Key<b.Key?-1:a.Key>b.Key?1:0);}
   const next=z.string().min(1).max(8192).parse(value.NextContinuationToken);
   if(tokens.has(next))throw failure();tokens.add(next);token=next;
  }throw failure();
 }
 async function current(row:Entry,kind:'BASELINE'|'OBSERVATION'){
  if(kind==='BASELINE'&&row.Size>8192)throw failure();
  const value=await send(new GetObjectCommand({Bucket:s.bucket,ExpectedBucketOwner:s.accountId,Key:row.Key,ChecksumMode:'ENABLED'}));
  const body=value.Body instanceof Readable?value.Body:undefined,bodyController=new AbortController();
  const bodySignal=AbortSignal.any([signal,bodyController.signal]),bodyTimer=setTimeout(()=>bodyController.abort(),15000);
  const abortBody=()=>body?.destroy(failure());bodySignal.addEventListener('abort',abortBody,{once:true});
  try{
   bodySignal.throwIfAborted();
   if(!body||value.DeleteMarker||value.ETag!==row.ETag||value.ContentLength!==row.Size||value.ServerSideEncryption!=='aws:kms'
    ||value.SSEKMSKeyId!==s.kmsKeyArn||!value.ChecksumSHA256||(value.ChecksumType&&value.ChecksumType!=='FULL_OBJECT'))throw failure();
   const digest=Buffer.from(value.ChecksumSHA256,'base64');if(digest.length!==32||digest.toString('base64')!==value.ChecksumSHA256)throw failure();
   const pin=candidatePinSchema.parse({kind,versionId:value.VersionId,sha256:digest.toString('hex'),byteLength:row.Size});
   if(kind==='OBSERVATION')return{pin,artifact:undefined};
   if(row.Size>8192)throw failure();const chunks:Buffer[]=[];let size=0;
   for await(const chunk of body){bodySignal.throwIfAborted();if(!(chunk instanceof Uint8Array))throw failure();size+=chunk.byteLength;
    if(size>8192||size>row.Size)throw failure();chunks.push(Buffer.from(chunk));}
   if(size!==row.Size)throw failure();const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
   const artifact={body:text,sha256:pin.sha256};parseCandidateRequest(artifact);return{pin,artifact};
  }finally{clearTimeout(bodyTimer);bodySignal.removeEventListener('abort',abortBody);bodyController.abort();body?.destroy();}
 }
 try{
  signal.throwIfAborted();if(s.bucket.endsWith('--x-s3'))throw failure();
  const before=await list(),groups=new Map<string,{request?:Entry;report?:Entry}>();
  for(const row of before){const [id,kind]=row.Key.slice(prefix.length).split('/');const group=groups.get(id!)??{};
   if(kind==='baseline.json')group.request=row;else group.report=row;groups.set(id!,group);}
  if(groups.size>1000||[...groups.values()].some(g=>!g.request))throw failure();
  const records=[];
  for(const [pathDigest,group] of groups){
   signal.throwIfAborted();const original=await current(group.request!,'BASELINE');if(!original.artifact)throw failure();
   const request=parseCandidateRequest(original.artifact).value,b=request.binding;
   if(candidateHash(b.candidateId)!==pathDigest||b.installationId!==s.installationId||b.attemptId!==trusted.attemptId
    ||b.planDigest!==trusted.planDigest||b.sourceSha!==trusted.sourceSha||b.maintenanceEpoch!==trusted.maintenanceEpoch
    ||b.controlRevision!==trusted.controlRevision||b.journalConfigurationDigest!==context.configurationDigest)throw failure();
   const session=context.forCandidate(b);await session.inspectRequest(original.pin,signal);
   let commonRoot:CommonRootReference|undefined;
   let reportPin:z.infer<typeof candidatePinSchema>|null=null,reportObservationDigest:string|null=null,objectCount:number|null=null;
   if(group.report){const saved=await current(group.report,'OBSERVATION');const inspected=await session.inspectReport(saved.pin,original.pin,signal);
    reportPin=saved.pin;reportObservationDigest=inspected.value.observationDigest;objectCount=inspected.value.capture.objects.length;
    if(inspected.value.kind==='MANAGED_QUARANTINED_COMMON_CANDIDATE')commonRoot={...inspected.value.rootReference,archiveConfigurationDigest:inspected.value.binding.archiveConfigurationDigest};}
   records.push({binding:b,requestPin:original.pin,reportPin,reportObservationDigest,objectCount,...(commonRoot?{commonRoot}:{}),
    reportStatus:reportPin?'SAVED_REPORT_OBSERVED' as const:'NOT_LISTED_AT_BOUNDARY' as const,
    originalAcknowledgementReconstructed:false as const,savedObservationAuthorizesExecution:false as const,archivedSetAdmitted:false as const});
  }
  const after=await list();if(JSON.stringify(before)!==JSON.stringify(after))throw failure();signal.throwIfAborted();
  const facts={format:1,kind:'MANAGED_CANDIDATE_CATALOGUE_OBSERVATION_V1',installationId:s.installationId,
   journalConfigurationDigest:context.configurationDigest,bootstrap:trusted,listingDigest:candidateHash(JSON.stringify(before)),
   observedAt:new Date().toISOString(),records};
  return{...facts,observationDigest:candidateHash(JSON.stringify(facts)),listingStableAtBoundaries:true as const,
   historyCompletenessVerified:false as const,crossPageSnapshotVerified:false as const,sourceHostLossProven:false as const,
   originalAcknowledgementReconstructed:false as const,savedObservationAuthorizesExecution:false as const,
   archivedSetAdmitted:false as const,actionAuthorized:false as const};
 }catch{throw failure();}finally{clearTimeout(timer);controller.abort();}
}
