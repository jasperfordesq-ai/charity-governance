import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {S3Client,GetObjectCommand,PutObjectCommand,ListObjectsV2Command,type S3ClientConfig,type GetObjectCommandOutput,type PutObjectCommandOutput,type ListObjectsV2CommandOutput} from '@aws-sdk/client-s3';
import {managedMaintenanceStorageConfigurationSchema} from './managed-maintenance-control.js';
import {managedClosedHead} from './managed-plan-bootstrap.js';
import {candidateHash} from './managed-candidate-capture-contract.js';
import {managedRecoveryEpochSchemas as schemas,type ManagedRecoveryEpochReader,type ManagedRecoveryEpochWriter} from './managed-recovery-epoch-catalogue.js';
const tag=z.string().regex(/^"[\x21\x23-\x7e]{1,254}"$/);
type Artifact=z.infer<typeof schemas.artifact>;type Pin=z.infer<typeof schemas.pin>;
const failure=()=>new Error('S3 recovery epoch custody is unresolved; preserve original slots without retry, repair or ACK reconstruction');
function canonical(raw:unknown){const a=schemas.artifact.parse(raw);if(Buffer.byteLength(a.body)>65536||candidateHash(a.body)!==a.sha256||JSON.stringify(JSON.parse(a.body))!==a.body)throw failure();return a;}
function sequence(raw:number,genesis=false){if(!Number.isInteger(raw)||raw<(genesis?0:1)||raw>10000)throw failure();return String(raw).padStart(5,'0');}
/** Private transport shared by two distinct public capabilities. Logical head
 * CAS is create-if-absent of the next immutable slot, never ETag/version aliasing.
 * Independent IAM/no-delete/no-copy/lifecycle/rollback policy is a live gate. */
class EpochObjects {
 readonly #config:z.infer<typeof managedMaintenanceStorageConfigurationSchema>;readonly #client:S3Client;readonly #attempted=new Set<string>();
 readonly #acknowledgedEntries=new Map<number,{pin:Pin;artifact:Artifact}>();
 constructor(raw:unknown,credentials:NonNullable<S3ClientConfig['credentials']>,client?:S3Client){
  this.#config=managedMaintenanceStorageConfigurationSchema.parse(raw);if(!credentials||['--x-s3','--ol-s3','-s3alias','--table-s3'].some(s=>this.#config.bucket.endsWith(s)))throw failure();
  z.string().regex(/key\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/).parse(this.#config.kmsKeyArn);
  this.#client=client??new S3Client({region:'eu-west-1',endpoint:'https://s3.eu-west-1.amazonaws.com',credentials,maxAttempts:1,followRegionRedirects:false,
   requestHandler:{connectionTimeout:5000,requestTimeout:15000,throwOnRequestTimeout:true}});
 }
 configurationDigest(){return candidateHash(JSON.stringify({format:1,policy:'S3_APPEND_ONLY_RECOVERY_EPOCH_SLOTS_V1',...this.#config}));}
 prefix(kind:'heads'|'entries'){return`managed-maintenance/${this.#config.installationId}/recovery-epochs/${kind}/`;}
 key(kind:'heads'|'entries',n:number){return this.prefix(kind)+sequence(n,kind==='heads')+'.json';}
 request(key:string){return{Bucket:this.#config.bucket,ExpectedBucketOwner:this.#config.accountId,Key:key};}
 async work<T>(fn:(signal:AbortSignal)=>Promise<T>,caller:AbortSignal){
  const controller=new AbortController(),signal=AbortSignal.any([controller.signal,caller]);const timer=setTimeout(()=>controller.abort(),300000);let stop=()=>{};
  try{signal.throwIfAborted();const cancelled=new Promise<never>((_,reject)=>{stop=()=>reject(failure());signal.addEventListener('abort',stop,{once:true});});
   const result=await Promise.race([fn(signal),cancelled]);signal.throwIfAborted();return result;
  }catch{throw failure();}finally{clearTimeout(timer);signal.removeEventListener('abort',stop);controller.abort();}
 }
 send(command:GetObjectCommand,caller:AbortSignal):Promise<GetObjectCommandOutput>;
 send(command:PutObjectCommand,caller:AbortSignal):Promise<PutObjectCommandOutput>;
 send(command:ListObjectsV2Command,caller:AbortSignal):Promise<ListObjectsV2CommandOutput>;
 async send(command:GetObjectCommand|PutObjectCommand|ListObjectsV2Command,caller:AbortSignal){
  const controller=new AbortController(),signal=AbortSignal.any([controller.signal,caller]);const timer=setTimeout(()=>controller.abort(),15000);let stop=()=>{},handedOff=false;
  try{signal.throwIfAborted();const cancelled=new Promise<never>((_,reject)=>{stop=()=>reject(failure());signal.addEventListener('abort',stop,{once:true});});
   const pending=(command instanceof GetObjectCommand?this.#client.send(command,{abortSignal:signal}):command instanceof PutObjectCommand?this.#client.send(command,{abortSignal:signal}):this.#client.send(command,{abortSignal:signal}))
    .then(value=>{
     if(signal.aborted){if('Body'in value&&value.Body instanceof Readable)value.Body.destroy();throw failure();}
     if('Body'in value&&value.Body instanceof Readable){
      const body=value.Body,abort=()=>body.destroy(failure());handedOff=true;
      body.once('error',()=>{});signal.addEventListener('abort',abort,{once:true});
      body.once('close',()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);controller.abort();});
     }
     return value;
    });
   return await Promise.race([pending,cancelled]);
  }finally{signal.removeEventListener('abort',stop);if(!handedOff){clearTimeout(timer);controller.abort();}}
 }
 metadata(v:{VersionId?:string;ServerSideEncryption?:string;SSEKMSKeyId?:string;BucketKeyEnabled?:boolean;DeleteMarker?:boolean;ChecksumType?:string}){
  if(!v.VersionId||v.VersionId==='null'||v.ServerSideEncryption!=='aws:kms'||v.SSEKMSKeyId!==this.#config.kmsKeyArn||v.BucketKeyEnabled===true||v.DeleteMarker||v.ChecksumType!==undefined&&v.ChecksumType!=='FULL_OBJECT')throw failure();
 }
 async get(key:string,signal:AbortSignal,version?:string){
  const r=await this.send(new GetObjectCommand({...this.request(key),ChecksumMode:'ENABLED',...(version?{VersionId:version}:{})}),signal) as GetObjectCommandOutput;
  const body=r.Body;let abort=()=>{};
  try{
   signal.throwIfAborted();this.metadata(r);
   if(!(body instanceof Readable)||r.ContentType!=='application/json'||r.ContentEncoding||!Number.isInteger(r.ContentLength)||r.ContentLength!<1||r.ContentLength!>65536||version&&r.VersionId!==version)throw failure();
   abort=()=>body.destroy(failure());signal.addEventListener('abort',abort,{once:true});signal.throwIfAborted();
   const chunks:Buffer[]=[];let bytes=0;for await(const chunk of body){signal.throwIfAborted();if(!(chunk instanceof Uint8Array))throw failure();bytes+=chunk.byteLength;if(bytes>65536)throw failure();chunks.push(Buffer.from(chunk));}
   signal.throwIfAborted();if(bytes!==r.ContentLength)throw failure();const buffer=Buffer.concat(chunks),sha256=createHash('sha256').update(buffer).digest('hex');
   if(r.ChecksumSHA256!==Buffer.from(sha256,'hex').toString('base64'))throw failure();
   const artifact=canonical({body:new TextDecoder('utf-8',{fatal:true}).decode(buffer),sha256}),etag=tag.parse(r.ETag);
   const pin=schemas.pin.parse({kind:'BASELINE',versionId:r.VersionId,sha256,byteLength:bytes});
   return{artifact,pin,etag,revision:candidateHash(JSON.stringify({configurationDigest:this.configurationDigest(),key,versionId:pin.versionId,etag,sha256}))};
  }finally{signal.removeEventListener('abort',abort);if(body instanceof Readable)body.destroy();}
 }
 async listHeads(signal:AbortSignal){
  const prefix=this.prefix('heads'),rows:{Key:string;Size:number;ETag:string}[]=[],seen=new Set<string>();let token:string|undefined;
  for(let page=0;page<11;page++){
   signal.throwIfAborted();const v=await this.send(new ListObjectsV2Command({Bucket:this.#config.bucket,ExpectedBucketOwner:this.#config.accountId,Prefix:prefix,MaxKeys:1000,...(token?{ContinuationToken:token}:{})}),signal);
   if(!('Contents'in v)||v.Name!==this.#config.bucket||v.Prefix!==prefix||v.MaxKeys!==1000||v.KeyCount!==(v.Contents??[]).length||typeof v.IsTruncated!=='boolean'
    ||v.Delimiter||v.StartAfter||v.EncodingType||v.CommonPrefixes?.length||v.ContinuationToken!==token||!Array.isArray(v.Contents)||v.Contents.length>1000)throw failure();
   for(const raw of v.Contents){const row={Key:z.string().parse(raw.Key),Size:z.number().int().min(1).max(65536).parse(raw.Size),ETag:tag.parse(raw.ETag)};
    const n=rows.length;if(n>10000||row.Key!==this.key('heads',n))throw failure();rows.push(row);}
   if(!v.IsTruncated){if(v.NextContinuationToken!==undefined||!rows.length)throw failure();return rows;}
   const next=z.string().min(1).max(8192).parse(v.NextContinuationToken);if(seen.has(next)||next===token||v.Contents.length===0)throw failure();seen.add(next);token=next;
  }throw failure();
 }
 head(value:{artifact:Artifact},n:number){const head=schemas.head.parse(JSON.parse(value.artifact.body));if(head.installationId!==this.#config.installationId||head.sequence!==n||JSON.stringify(head)!==value.artifact.body)throw failure();return head;}
 entry(value:{artifact:Artifact},n:number){const entry=schemas.entry.parse(JSON.parse(value.artifact.body)),closed=managedClosedHead(entry.closedControl,this.#config.installationId);
  if(entry.installationId!==this.#config.installationId||entry.sequence!==n||JSON.stringify(entry)!==value.artifact.body
   ||entry.plan.installationId!==this.#config.installationId||entry.plan.maintenanceEpoch!==closed.value.maintenanceEpoch||candidateHash(JSON.stringify(entry.plan))!==closed.value.planDigest)throw failure();return entry;}
 async readHead(signal:AbortSignal){
  const rows=await this.listHeads(signal),n=rows.length-1,key=this.key('heads',n),first=await this.get(key,signal);this.head(first,n);
  if(first.etag!==rows[n]!.ETag||first.pin.byteLength!==rows[n]!.Size)throw failure();
  const exact=await this.get(key,signal,first.pin.versionId);if(exact.artifact.body!==first.artifact.body||exact.etag!==first.etag)throw failure();
  if(JSON.stringify(await this.listHeads(signal))!==JSON.stringify(rows))throw failure();
  const last=await this.get(key,signal);if(last.revision!==first.revision||last.artifact.body!==first.artifact.body)throw failure();
  return{revision:first.revision,artifact:first.artifact};
 }
 async readEntry(n:number,rawPin:Pin,signal:AbortSignal){
  const pin=schemas.pin.parse(rawPin),saved=await this.get(this.key('entries',n),signal,pin.versionId);this.entry(saved,n);
  if(JSON.stringify(saved.pin)!==JSON.stringify(pin))throw failure();return{pin:saved.pin,artifact:saved.artifact};
 }
 async put(key:string,raw:Artifact,signal:AbortSignal){
  const artifact=canonical(raw);if(this.#attempted.has(key))throw failure();this.#attempted.add(key);signal.throwIfAborted();
  const checksum=Buffer.from(artifact.sha256,'hex').toString('base64');
  const r=await this.send(new PutObjectCommand({...this.request(key),IfNoneMatch:'*',Body:artifact.body,ContentType:'application/json',
   ServerSideEncryption:'aws:kms',SSEKMSKeyId:this.#config.kmsKeyArn,BucketKeyEnabled:false,ChecksumSHA256:checksum}),signal);
  if(!('VersionId'in r))throw failure();this.metadata(r);const etag=tag.parse(r.ETag);if(r.ChecksumSHA256!==checksum)throw failure();signal.throwIfAborted();
  const saved=await this.get(key,signal,r.VersionId);if(saved.artifact.body!==artifact.body||saved.etag!==etag)throw failure();return saved;
 }
 async createEntry(n:number,raw:Artifact,signal:AbortSignal){const artifact=canonical(raw);this.entry({artifact},n);const saved=await this.put(this.key('entries',n),artifact,signal);
  this.#acknowledgedEntries.set(n,{pin:{...saved.pin},artifact:{...artifact}});return saved.pin;}
 async replaceHead(expected:string,raw:Artifact,signal:AbortSignal){
  const artifact=canonical(raw),proposed=schemas.head.parse(JSON.parse(artifact.body)),acknowledged=this.#acknowledgedEntries.get(proposed.sequence);
  if(!acknowledged||JSON.stringify(acknowledged.pin)!==JSON.stringify(proposed.entryPin))throw failure();
  this.#acknowledgedEntries.delete(proposed.sequence);
  const before=await this.readHead(signal);if(before.revision!==expected)throw failure();const previous=schemas.head.parse(JSON.parse(before.artifact.body)),next=this.head({artifact},previous.sequence+1);
  if(next.publicationId===previous.publicationId||!next.entryPin)throw failure();
  const saved=await this.readEntry(next.sequence,next.entryPin,signal),entry=this.entry(saved,next.sequence);
  if(saved.artifact.body!==acknowledged.artifact.body||entry.previousHead.sha256!==before.artifact.sha256||entry.previousHead.body!==before.artifact.body)throw failure();
  const rechecked=await this.readHead(signal);if(rechecked.revision!==expected||rechecked.artifact.body!==before.artifact.body)throw failure();
  // The fixed next slot is the atomic single-winner location. Old slots are
  // never overwritten. A lost PUT/readback ACK cannot be repaired or replayed.
  const written=await this.put(this.key('heads',next.sequence),artifact,signal);
  const original=await this.get(this.key('heads',previous.sequence),signal);if(original.revision!==expected)throw failure();
  const after=await this.readHead(signal);if(after.revision!==written.revision||after.artifact.body!==written.artifact.body)throw failure();return after;
 }
}
export class S3ManagedRecoveryEpochReader implements ManagedRecoveryEpochReader {
 readonly #objects:EpochObjects;
 constructor(raw:unknown,credentials:NonNullable<S3ClientConfig['credentials']>,client?:S3Client){this.#objects=new EpochObjects(raw,credentials,client);}
 configurationDigest(){return this.#objects.configurationDigest();}
 readHead(signal:AbortSignal){return this.#objects.work(s=>this.#objects.readHead(s),signal);}
 readEntry(n:number,pin:Pin,signal:AbortSignal){return this.#objects.work(s=>this.#objects.readEntry(n,pin,s),signal);}
}
export class S3ManagedRecoveryEpochWriter implements ManagedRecoveryEpochWriter {
 readonly #objects:EpochObjects;
 constructor(raw:unknown,credentials:NonNullable<S3ClientConfig['credentials']>,client?:S3Client){this.#objects=new EpochObjects(raw,credentials,client);}
 configurationDigest(){return this.#objects.configurationDigest();}
 createEntry(n:number,artifact:Artifact,signal:AbortSignal){return this.#objects.work(s=>this.#objects.createEntry(n,artifact,s),signal);}
 replaceHead(revision:string,artifact:Artifact,signal:AbortSignal){return this.#objects.work(s=>this.#objects.replaceHead(revision,artifact,s),signal);}
}
