import {discoverManagedCandidateCatalogue} from './managed-candidate-catalogue.js';
import {z} from 'zod';
import {S3Client,type S3ClientConfig} from '@aws-sdk/client-s3';
import {S3MaintenanceArtifactStore} from './maintenance-artifact-store.js';
import {candidateBindingSchema,candidatePinSchema,candidateHash,candidateRequestArtifact,parseCandidateRequest,
 candidateReportArtifact,parseCandidateReport,assertCandidatePair} from './managed-candidate-capture-contract.js';
const storageSchema=z.object({installationId:z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
 bucket:z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),accountId:z.string().regex(/^\d{12}$/),
 kmsKeyArn:z.string().regex(/^arn:aws:kms:eu-west-1:\d{12}:key\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)}).strict()
 .refine(s=>s.kmsKeyArn.split(':')[4]===s.accountId);
const failure=()=>new Error('Managed candidate journal is unresolved; inspect original records without replay or admission');
type Binding=z.infer<typeof candidateBindingSchema>;
/** Immutable request/result custody. Inspection never issues an execution lease,
 * retries a write, fills a missing result or makes a live recovery decision. */
export class ManagedCandidateCaptureJournal {
 private readonly storage:z.infer<typeof storageSchema>;
 private readonly client:S3Client;
 private readonly sessions=new Map<string,{bindingDigest:string,session:CandidateSession}>();
 constructor(raw:unknown,private readonly credentials:NonNullable<S3ClientConfig['credentials']>,client?:S3Client){
  this.storage=storageSchema.parse(raw);if(!credentials)throw failure();
  this.client=client??new S3Client({region:'eu-west-1',endpoint:'https://s3.eu-west-1.amazonaws.com',credentials,
   maxAttempts:1,followRegionRedirects:false,requestHandler:{connectionTimeout:5000,requestTimeout:15000,throwOnRequestTimeout:true}});
 }
 configurationDigest(){return candidateHash(JSON.stringify({format:1,policy:'IMMUTABLE_CANDIDATE_REQUEST_REPORT_V1',...this.storage}));}
 discoverCandidates(raw:unknown,signal?:AbortSignal){
  return discoverManagedCandidateCatalogue({storage:this.storage,configurationDigest:this.configurationDigest(),client:this.client,
   forCandidate:binding=>this.forCandidate(binding)},raw,signal);
 }
 forCandidate(raw:unknown){
  const binding=candidateBindingSchema.parse(raw),bindingDigest=candidateHash(JSON.stringify(binding));
  if(binding.installationId!==this.storage.installationId||binding.journalConfigurationDigest!==this.configurationDigest())throw failure();
  const old=this.sessions.get(binding.candidateId);
  if(old){if(old.bindingDigest!==bindingDigest)throw failure();return old.session;}
  const session=new CandidateSession(this.storage,binding,this.credentials,this.client);
  this.sessions.set(binding.candidateId,{bindingDigest,session});return session;
 }
}
class CandidateSession {
 private readonly evidence:S3MaintenanceArtifactStore<z.infer<typeof candidatePinSchema>>;
 private readonly original:ReturnType<typeof candidateRequestArtifact>;
 private acknowledgedRequest:z.infer<typeof candidatePinSchema>|undefined;
 private reportAttempted=false;
 constructor(storage:z.infer<typeof storageSchema>,private readonly binding:Binding,credentials:NonNullable<S3ClientConfig['credentials']>,client?:S3Client){
  this.original=candidateRequestArtifact(binding);
  const match=(artifact:{body:string;sha256:string})=>{
   const parsed=parseCandidateRequest(artifact);if(parsed.artifact.body!==this.original.body)throw failure();return parsed.artifact;
  };
  const result=(artifact:{body:string;sha256:string})=>{
   const parsed=parseCandidateReport(artifact);if(JSON.stringify(parsed.value.binding)!==JSON.stringify(this.binding))throw failure();return parsed.artifact;
  };
  this.evidence=new S3MaintenanceArtifactStore({...storage,maintenance:{attemptId:binding.attemptId,planDigest:binding.planDigest,
   sourceSha:binding.sourceSha,maintenanceEpoch:binding.maintenanceEpoch}},credentials,
   {namespace:'capture-candidate',scopeDigest:candidateHash(binding.candidateId),pinSchema:candidatePinSchema,
    limits:{BASELINE:8192,OBSERVATION:128*1024*1024},baseline:raw=>match(parseCandidateRequest(raw).artifact),
    parseObservation:raw=>result(parseCandidateReport(raw).artifact),observationFromValue:raw=>result(candidateReportArtifact(raw)),
    assertPair:assertCandidatePair,failure},client);
 }
 /** Only this original conditional write + exact readback may precede live capture. */
 async reserve(signal?:AbortSignal){
  const pin=await this.evidence.publishBaseline(this.original,signal);this.acknowledgedRequest=candidatePinSchema.parse(pin);return pin;
 }
 closeExecution(){this.acknowledgedRequest=undefined;}
 async inspectRequest(pin:unknown,signal?:AbortSignal){
  const artifact=await this.evidence.observeBaseline(pin,signal);
  return{artifact,value:parseCandidateRequest(artifact).value,savedObservationAuthorizesExecution:false as const};
 }
 async discoverRequest(signal?:AbortSignal){
  const saved=await this.evidence.inspectCandidateArtifact('BASELINE',signal);
  return{...saved,value:parseCandidateRequest(saved.artifact).value};
 }
 async publishReport(raw:unknown,requestPin:unknown,signal?:AbortSignal){
  const pin=candidatePinSchema.parse(requestPin);
  if(!this.acknowledgedRequest||JSON.stringify(this.acknowledgedRequest)!==JSON.stringify(pin)||this.reportAttempted)throw failure();
  this.reportAttempted=true;
  const snapshot=candidateReportArtifact(raw),report=parseCandidateReport(snapshot).value;
  if(JSON.stringify(report.requestPin)!==JSON.stringify(pin))throw failure();
  const value=JSON.parse(snapshot.body) as typeof report;
  const result=await this.evidence.publishObservation(value,pin,signal);
  return{pin:result,report:JSON.parse(snapshot.body) as typeof report};
 }
 async inspectReport(reportPin:unknown,requestPin:unknown,signal?:AbortSignal){
  const artifact=await this.evidence.observeObservation(reportPin,requestPin,signal),value=parseCandidateReport(artifact).value;
  if(JSON.stringify(value.requestPin)!==JSON.stringify(candidatePinSchema.parse(requestPin)))throw failure();
  return{artifact,value,originalAcknowledgementReconstructed:false as const,savedObservationAuthorizesExecution:false as const,
   archivedSetAdmitted:false as const,actionAuthorized:false as const};
 }
 async discoverReport(requestPin:unknown,signal?:AbortSignal){
  await this.inspectRequest(requestPin,signal);
  const saved=await this.evidence.inspectCandidateArtifact('OBSERVATION',signal);
  const checked=await this.inspectReport(saved.pin,requestPin,signal);return{...checked,pin:saved.pin};
 }
}
