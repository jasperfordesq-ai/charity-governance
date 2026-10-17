import {ListObjectsV2Command,type S3Client,type S3ClientConfig} from '@aws-sdk/client-s3';
import {z} from 'zod';
import {S3MaintenanceArtifactStore} from './maintenance-artifact-store.js';
import {candidateHash,candidatePinSchema} from './managed-candidate-capture-contract.js';
import {commonCandidateBindingSchema} from './managed-common-candidate-contract.js';
import {jobScope,jobRequestArtifact,jobObservationArtifact,parseJobRequest,parseJobObservation,assertJobPair} from './managed-proof-job-contract.js';
const failure=()=>new Error('Managed proof job custody unresolved; saved records do not authorise execution');
const entry=z.object({Key:z.string().min(1).max(1024),ETag:z.string().min(1).max(1024),Size:z.number().int().min(1).max(16384)});
type Pin=z.infer<typeof candidatePinSchema>;
export class ManagedProofJobCustody{
 private readonly evidence:S3MaintenanceArtifactStore<Pin>;
 private readonly binding:z.infer<typeof commonCandidateBindingSchema>;
 private acknowledged:Pin|undefined;private attempted=false;private observationAttempted=false;
 constructor(private readonly storage:{installationId:string;bucket:string;accountId:string;kmsKeyArn:string},binding:unknown,
  credentials:NonNullable<S3ClientConfig['credentials']>,private readonly client:S3Client,private readonly live:(pin:Pin)=>boolean){
  this.binding=commonCandidateBindingSchema.parse(binding);if(this.binding.installationId!==storage.installationId)throw failure();
  this.evidence=new S3MaintenanceArtifactStore({...storage,maintenance:{attemptId:this.binding.attemptId,planDigest:this.binding.planDigest,sourceSha:this.binding.sourceSha,maintenanceEpoch:this.binding.maintenanceEpoch}},credentials,
   {namespace:'capture-job',scopeDigest:candidateHash(this.binding.candidateId),pinSchema:candidatePinSchema,limits:{BASELINE:16384,OBSERVATION:16384},failure,
    baseline:raw=>parseJobRequest(this.binding,raw).artifact,parseObservation:raw=>parseJobObservation(this.binding,raw).artifact,
    observationFromValue:raw=>parseJobObservation(this.binding,raw).artifact,assertPair:(a,b)=>assertJobPair(this.binding,a,b)},client);
 }
 closeExecution(){this.acknowledged=undefined;}
 async reserve(local:unknown,original:unknown,signal?:AbortSignal){
  const pin=candidatePinSchema.parse(original);if(!this.live(pin)||this.attempted)throw failure();this.attempted=true;
  const artifact=jobRequestArtifact(this.binding,pin,local),saved=await this.evidence.publishBaseline(artifact,signal);
  if(!this.live(pin))throw failure();this.acknowledged=saved;return{pin:saved,originalAcknowledgementReconstructed:false as const};
 }
 async observe(local:unknown,original:unknown,signal?:AbortSignal){
  const pin=candidatePinSchema.parse(original);if(!this.live(pin)||!this.acknowledged||this.observationAttempted)throw failure();this.observationAttempted=true;
  const saved=await this.evidence.publishObservation(jobObservationArtifact(this.binding,this.acknowledged,local),this.acknowledged,signal);
  if(!this.live(pin))throw failure();return{pin:saved,savedObservationAuthorizesExecution:false as const};
 }
 async discover(original:unknown,caller?:AbortSignal){
  const originalPin=candidatePinSchema.parse(original),scope=jobScope(this.binding,originalPin),controller=new AbortController();
  const signal=caller?AbortSignal.any([caller,controller.signal]):controller.signal,timer=setTimeout(()=>controller.abort(),60000);
  const prefix=`managed-maintenance/${this.binding.installationId}/${this.binding.attemptId}/capture-job/${candidateHash(this.binding.candidateId)}/`;
  const list=async()=>{
   signal.throwIfAborted();let stop:()=>void=()=>{};
   const aborted=new Promise<never>((_,reject)=>{stop=()=>reject(failure());signal.addEventListener('abort',stop,{once:true});});
   try{
    const v=await Promise.race([this.client.send(new ListObjectsV2Command({Bucket:this.storage.bucket,ExpectedBucketOwner:this.storage.accountId,Prefix:prefix,MaxKeys:3}),{abortSignal:signal}),aborted]);
    signal.throwIfAborted();
    if(v.Name!==this.storage.bucket||v.Prefix!==prefix||v.MaxKeys!==3||v.IsTruncated!==false||v.NextContinuationToken!==undefined||v.ContinuationToken!==undefined
     ||v.EncodingType!==undefined||v.Delimiter!==undefined||v.StartAfter!==undefined||(v.CommonPrefixes!==undefined&&v.CommonPrefixes.length!==0))throw failure();
    const rows=z.array(entry).max(2).parse(v.Contents??[]);if(v.KeyCount!==rows.length||new Set(rows.map(r=>r.Key)).size!==rows.length
     ||rows.some(r=>r.Key!==prefix+'baseline.json'&&r.Key!==prefix+'observation.json'))throw failure();return rows.sort((a,b)=>a.Key<b.Key?-1:a.Key>b.Key?1:0);
   }finally{signal.removeEventListener('abort',stop);}
  };
  try{
   const before=await list(),baseline=before.find(r=>r.Key===prefix+'baseline.json'),result=before.find(r=>r.Key===prefix+'observation.json');if(!baseline)throw failure();
   const saved=await this.evidence.inspectCandidateArtifact('BASELINE',signal),a=parseJobRequest(this.binding,saved.artifact);
   if(saved.currentETag!==baseline.ETag||saved.pin.byteLength!==baseline.Size||JSON.stringify(a.value.candidateRequestPin)!==JSON.stringify(originalPin))throw failure();
   let observation:ReturnType<typeof parseJobObservation>|undefined,observationPin:Pin|null=null;
   if(result){
    const b=await this.evidence.inspectCandidateArtifact('OBSERVATION',signal);
    if(b.currentETag!==result.ETag||b.pin.byteLength!==result.Size)throw failure();
    observation=parseJobObservation(this.binding,await this.evidence.observeObservation(b.pin,saved.pin,signal));observationPin=b.pin;
    if(JSON.stringify(observation.value.jobRequestPin)!==JSON.stringify(saved.pin))throw failure();
   }
   if(JSON.stringify(before)!==JSON.stringify(await list()))throw failure();signal.throwIfAborted();
   return{jobId:a.local.jobId,scope,sourceSha:a.local.sourceSha,requestPin:{sha256:a.value.localRequest.sha256,byteLength:a.value.localRequest.byteLength},
    observationPin:observation?{sha256:observation.value.localObservation.sha256,byteLength:observation.value.localObservation.byteLength}:null,
    jobRequestPin:saved.pin,jobObservationPin:observationPin,state:observation?.local.state??'REQUESTED_ONLY',
    reportStatus:observation?'SAVED_OBSERVATION':'NOT_LISTED_AT_BOUNDARY',listingStableAtBoundaries:true as const,
    historyCompletenessVerified:false as const,sourceHostLossProven:false as const,originalAcknowledgementReconstructed:false as const,
    savedObservationAuthorizesExecution:false as const,executionAuthorized:false as const,publicationAuthorized:false as const,actionAuthorized:false as const};
  }catch{throw failure();}finally{clearTimeout(timer);controller.abort();}
 }
}
