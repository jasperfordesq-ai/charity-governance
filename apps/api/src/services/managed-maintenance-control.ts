import {createHash,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {GetObjectCommand,PutObjectCommand,S3Client,type S3ClientConfig} from '@aws-sdk/client-s3';
import {z} from 'zod';
import {parseCredentialReadBaselineArtifact,parseCredentialReadObservationArtifact,credentialReadObservationArtifact,assertCredentialReadEvidencePair,credentialReadObservationSchema,credentialReadBaselineSchema} from './credential-read-evidence.js';
import {managedWriteEvidencePinSchema} from './managed-write-evidence.js';
import {signedUploadEvidencePinSchema} from './signed-upload-evidence.js';

const identity=z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),digest=z.string().regex(/^[a-f0-9]{64}$/);
const configuration=z.object({installationId:identity,bucket:z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
 accountId:z.string().regex(/^\d{12}$/),
 kmsKeyArn:z.string().regex(/^arn:aws:kms:eu-west-1:\d{12}:key\/[a-f0-9-]{36}$/)}).strict()
 .refine(c=>c.kmsKeyArn.split(':')[4]===c.accountId);
const observations=z.object({servicesDigest:digest,databaseDigest:digest,storageDigest:digest.optional(),readProofDigest:digest.optional(),writeProofDigest:digest.optional(),signedProofDigest:digest.optional(),signingDigest:digest.optional(),observedAt:z.string().datetime()}).strict();
const control=z.object({format:z.literal(1),installationId:identity,maintenanceEpoch:z.number().int().positive().max(2147483647),
 planDigest:digest,phase:z.enum(['READY','ATTEMPTED','BASELINED','WRITE_BASELINED','SIGNED_BASELINED','OBSERVED_CLOSED']),attemptId:z.string().uuid().nullable(),
 observations:observations.nullable(),readBaseline:z.unknown().transform(parseCredentialReadBaselineArtifact).optional(),
 readObservation:z.unknown().transform(parseCredentialReadObservationArtifact).optional(),
 writeBaselinePin:managedWriteEvidencePinSchema.refine(v=>v.kind==='BASELINE').optional(),
 writeObservationPin:managedWriteEvidencePinSchema.refine(v=>v.kind==='OBSERVATION').optional(),
 signedBaselinePin:signedUploadEvidencePinSchema.refine(v=>v.kind==='BASELINE').optional(),
 signedObservationPin:signedUploadEvidencePinSchema.refine(v=>v.kind==='OBSERVATION').optional(),
 publicationId:z.string().uuid()}).strict().superRefine((v,ctx)=>{
 if((v.phase==='READY')!==(v.attemptId===null)||(v.phase==='OBSERVED_CLOSED')!==(v.observations!==null))
  ctx.addIssue({code:'custom',message:'Invalid maintenance transition state'});
 if(v.readBaseline){
  const binding=credentialReadBaselineSchema.parse(JSON.parse(v.readBaseline.body)).maintenance;
  if(!binding||binding.attemptId!==v.attemptId||binding.planDigest!==v.planDigest||binding.maintenanceEpoch!==v.maintenanceEpoch)
   ctx.addIssue({code:'custom',message:'Credential baseline belongs to another maintenance attempt'});
 }
 if((v.phase==='READY'||v.phase==='ATTEMPTED')&&(v.readBaseline||v.readObservation)
  ||v.phase==='BASELINED'&&(!v.readBaseline||v.readObservation)
  ||v.phase!=='OBSERVED_CLOSED'&&v.readObservation)
  ctx.addIssue({code:'custom',message:'Invalid credential baseline phase'});
 if(['READY','ATTEMPTED','BASELINED'].includes(v.phase)&&(v.writeBaselinePin||v.writeObservationPin)
  ||['WRITE_BASELINED','SIGNED_BASELINED'].includes(v.phase)&&(!v.readBaseline||!v.writeBaselinePin||v.readObservation||v.writeObservationPin)
  ||v.phase!=='OBSERVED_CLOSED'&&v.writeObservationPin
  ||v.phase==='OBSERVED_CLOSED'&&(v.writeBaselinePin||v.writeObservationPin)&&(!v.writeBaselinePin||!v.writeObservationPin||!v.observations?.writeProofDigest))
  ctx.addIssue({code:'custom',message:'Invalid standard-write evidence phase'});
 if(!['SIGNED_BASELINED','OBSERVED_CLOSED'].includes(v.phase)&&(v.signedBaselinePin||v.signedObservationPin)
  ||v.phase==='SIGNED_BASELINED'&&(!v.signedBaselinePin||v.signedObservationPin)
  ||v.phase==='OBSERVED_CLOSED'&&(v.signedBaselinePin||v.signedObservationPin||v.observations?.signedProofDigest)
   &&(!v.signedBaselinePin||!v.signedObservationPin||!v.readBaseline||!v.readObservation||!v.writeBaselinePin||!v.writeObservationPin||!v.observations?.signedProofDigest||!v.observations?.signingDigest))
  ctx.addIssue({code:'custom',message:'Invalid signed-upload evidence phase'});
 if(v.phase==='OBSERVED_CLOSED'&&(v.readBaseline||v.readObservation)){
  try{
   if(!v.readBaseline||!v.readObservation||!v.observations?.storageDigest)throw new Error();
   assertCredentialReadEvidencePair(v.readBaseline,v.readObservation);
   const report=credentialReadObservationSchema.parse(JSON.parse(v.readObservation.body));
   if(v.observations.readProofDigest!==report.observationDigest)throw new Error();
  }catch{ctx.addIssue({code:'custom',message:'Incomplete credential read evidence'});}
 }
});
const tag=z.string().min(3).max(256).regex(/^"[\x21\x23-\x7e]+"$/);
type Control=z.infer<typeof control>;
const failure='Independent managed maintenance control is unresolved; inspect without retrying shutdown or reopening';

/** Installation-wide one-attempt guard, separate from tenant authority heads.
 * Requires an explicitly provisioned READY record for the exact plan/epoch.
 * No initialization, expiry, takeover, release, writer replacement or reopening.
 * Authentic provider reads/CAS do not prove independent custody, IAM exclusion,
 * tenant preservation/disposal freshness or protection against privileged replay. */
export class S3ManagedMaintenanceControl {
 private readonly config:z.infer<typeof configuration>;
 private readonly client:S3Client;
 constructor(raw:unknown,credentials:NonNullable<S3ClientConfig['credentials']>,client?:S3Client){
  this.config=configuration.parse(raw);if(!credentials)throw new Error('Explicit maintenance storage credentials required');
  this.client=client??new S3Client({region:'eu-west-1',credentials,endpoint:'https://s3.eu-west-1.amazonaws.com',
   maxAttempts:1,followRegionRedirects:false,requestHandler:{connectionTimeout:5000,requestTimeout:15000,throwOnRequestTimeout:true}});
 }
 private request(){return{Bucket:this.config.bucket,ExpectedBucketOwner:this.config.accountId,
  Key:`managed-maintenance/${this.config.installationId}/control.json`};}
 private validMetadata(value:{VersionId?:string;ServerSideEncryption?:string;SSEKMSKeyId?:string}){
  return Boolean(value.VersionId&&value.VersionId!=='null'&&value.ServerSideEncryption==='aws:kms'&&value.SSEKMSKeyId===this.config.kmsKeyArn);
 }
 private async read(callerSignal?:AbortSignal){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);let body:Readable|undefined;
  const signal=callerSignal?AbortSignal.any([controller.signal,callerSignal]):controller.signal;
  const abort=()=>body?.destroy(new Error('Maintenance storage read deadline'));signal.addEventListener('abort',abort,{once:true});
  try{
   signal.throwIfAborted();
   const response=await this.client.send(new GetObjectCommand({...this.request(),ChecksumMode:'ENABLED'}),{abortSignal:signal});
   if(response.Body instanceof Readable)body=response.Body;
   if(signal.aborted||!body||response.DeleteMarker||!this.validMetadata(response)
    ||!Number.isInteger(response.ContentLength)||response.ContentLength!<1||response.ContentLength!>8192)throw new Error();
   const chunks:Buffer[]=[];let length=0;
   for await(const chunk of body){
    if(!(chunk instanceof Uint8Array))throw new Error();length+=chunk.byteLength;if(length>8192)throw new Error();chunks.push(Buffer.from(chunk));
   }
   if(signal.aborted||length!==response.ContentLength)throw new Error();
   const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)),value=control.parse(JSON.parse(text));
   if(value.installationId!==this.config.installationId||JSON.stringify(value)!==text)throw new Error();
   const etag=tag.parse(response.ETag),versionId=z.string().min(1).max(1024).parse(response.VersionId);
   return{value,etag,versionId,revision:createHash('sha256').update(JSON.stringify({request:this.request(),etag,versionId,text})).digest('hex')};
  }catch{throw new Error(failure);}
  finally{clearTimeout(timer);signal.removeEventListener('abort',abort);body?.destroy();}
 }
 private async replace(previous:Awaited<ReturnType<S3ManagedMaintenanceControl['read']>>,next:Control){
  const value=control.parse(next),text=JSON.stringify(value);
  if(Buffer.byteLength(text)>8192)throw new Error(failure);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{
   const response=await this.client.send(new PutObjectCommand({...this.request(),IfMatch:previous.etag,Body:text,
    ContentType:'application/json',ServerSideEncryption:'aws:kms',SSEKMSKeyId:this.config.kmsKeyArn,
    ChecksumSHA256:createHash('sha256').update(text).digest('base64')}),{abortSignal:controller.signal});
   if(controller.signal.aborted||!this.validMetadata(response))throw new Error();
   const current=await this.read(controller.signal);
   if(current.revision===previous.revision||current.versionId!==response.VersionId||current.etag!==tag.parse(response.ETag)
    ||JSON.stringify(current.value)!==text)throw new Error();
   return current;
  }catch{throw new Error(failure);}
  finally{clearTimeout(timer);}
 }
 async observe(){return this.read();}
 async acquire(installationId:string,planDigest:string,maintenanceEpoch:number){
  if(identity.parse(installationId)!==this.config.installationId)throw new Error(failure);
  const expected=digest.parse(planDigest),epoch=z.number().int().positive().max(2147483647).parse(maintenanceEpoch);
  const current=await this.read();
  if(current.value.phase!=='READY'||current.value.planDigest!==expected||current.value.maintenanceEpoch!==epoch)throw new Error(failure);
  // Only this successful fresh CAS caller may dispatch. A lost acknowledgement
  // never becomes executable merely because a later read finds ATTEMPTED.
  return this.replace(current,{...current.value,phase:'ATTEMPTED',attemptId:randomUUID(),publicationId:randomUUID()});
 }
 async recordReadBaseline(attemptId:string,revision:string,raw:unknown){
  z.string().uuid().parse(attemptId);digest.parse(revision);const artifact=parseCredentialReadBaselineArtifact(raw),current=await this.read();
  if(current.value.phase!=='ATTEMPTED'||current.value.attemptId!==attemptId||current.revision!==revision)throw new Error(failure);
  return this.replace(current,{...current.value,phase:'BASELINED',readBaseline:artifact,publicationId:randomUUID()});
 }
 async recordWriteBaselinePin(attemptId:string,revision:string,raw:unknown){
  z.string().uuid().parse(attemptId);digest.parse(revision);const pin=managedWriteEvidencePinSchema.parse(raw),current=await this.read();
  if(pin.kind!=='BASELINE'||current.value.phase!=='BASELINED'||current.value.attemptId!==attemptId||current.revision!==revision)throw new Error(failure);
  return this.replace(current,{...current.value,phase:'WRITE_BASELINED',writeBaselinePin:pin,publicationId:randomUUID()});
 }
 async recordSignedBaselinePin(attemptId:string,revision:string,raw:unknown){
  z.string().uuid().parse(attemptId);digest.parse(revision);const pin=signedUploadEvidencePinSchema.parse(raw),current=await this.read();
  if(pin.kind!=='BASELINE'||current.value.phase!=='WRITE_BASELINED'||current.value.attemptId!==attemptId||current.revision!==revision)throw new Error(failure);
  return this.replace(current,{...current.value,phase:'SIGNED_BASELINED',signedBaselinePin:pin,publicationId:randomUUID()});
 }
 async recordObservedClosed(attemptId:string,revision:string,raw:unknown,rawReadObservation?:unknown,rawWriteObservationPin?:unknown,rawSignedObservationPin?:unknown){
  z.string().uuid().parse(attemptId);digest.parse(revision);const facts=observations.parse(raw),current=await this.read();
  if(!['ATTEMPTED','BASELINED','WRITE_BASELINED','SIGNED_BASELINED'].includes(current.value.phase)||current.value.attemptId!==attemptId||current.revision!==revision)throw new Error(failure);
  const readObservation=rawReadObservation===undefined?undefined:credentialReadObservationArtifact(rawReadObservation);
  if(['BASELINED','WRITE_BASELINED','SIGNED_BASELINED'].includes(current.value.phase)&&!readObservation)throw new Error(failure);
  const writeObservationPin=rawWriteObservationPin===undefined?undefined:managedWriteEvidencePinSchema.parse(rawWriteObservationPin);
  if(['WRITE_BASELINED','SIGNED_BASELINED'].includes(current.value.phase)&&(!writeObservationPin||!facts.writeProofDigest))throw new Error(failure);
  const signedObservationPin=rawSignedObservationPin===undefined?undefined:signedUploadEvidencePinSchema.parse(rawSignedObservationPin);
  if(current.value.phase==='SIGNED_BASELINED'&&(!signedObservationPin||!facts.signedProofDigest))throw new Error(failure);
  if(current.value.phase!=='SIGNED_BASELINED'&&(signedObservationPin||facts.signedProofDigest))throw new Error(failure);
  return this.replace(current,{...current.value,phase:'OBSERVED_CLOSED',observations:facts,
   ...(readObservation?{readObservation}:{}),...(writeObservationPin?{writeObservationPin}:{}),...(signedObservationPin?{signedObservationPin}:{}),publicationId:randomUUID()});
 }
}
