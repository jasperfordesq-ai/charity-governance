import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {candidateHash,candidatePinSchema} from './managed-candidate-capture-contract.js';
import {managedPlanSchema,managedClosedHead} from './managed-plan-bootstrap.js';
import {requireProtocol9ClosedHead,type S3ManagedMaintenanceControl} from './managed-maintenance-control.js';
import type {ManagedCandidateCaptureJournal} from './managed-candidate-capture-journal.js';
const sha=z.string().regex(/^[a-f0-9]{64}$/),identity=z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const artifactSchema=z.object({body:z.string().min(1).max(65536),sha256:sha}).strict();
const pinSchema=candidatePinSchema.refine(p=>p.kind==='BASELINE'&&p.byteLength<=65536);
const headSchema=z.object({format:z.literal(1),kind:z.literal('MANAGED_RECOVERY_EPOCH_HEAD_V1'),installationId:identity,
 sequence:z.number().int().min(0).max(10000),entryPin:pinSchema.nullable(),publicationId:z.string().uuid()}).strict()
 .refine(v=>(v.sequence===0)===(v.entryPin===null));
const recordSchema=z.object({revision:z.string().regex(/^[\x21-\x7e]{1,1024}$/),artifact:artifactSchema}).strict();
const configurationSchema=z.object({installationId:identity,storeConfigurationDigest:sha,genesisHeadSha256:sha,
 trustedCheckpoint:z.object({sequence:z.number().int().min(0).max(10000),sha256:sha}).strict()}).strict()
 .refine(v=>v.trustedCheckpoint.sequence!==0||v.trustedCheckpoint.sha256===v.genesisHeadSha256);
const entrySchema=z.object({format:z.literal(1),kind:z.literal('MANAGED_CLOSED_RECOVERY_EPOCH_V1'),installationId:identity,
 sequence:z.number().int().min(1).max(10000),registryConfigurationDigest:sha,previousHead:artifactSchema,
 closedControl:z.unknown(),controlConfigurationDigest:sha,journalConfigurationDigest:sha,archiveConfigurationDigest:sha,plan:managedPlanSchema}).strict();
type Artifact=z.infer<typeof artifactSchema>;type Pin=z.infer<typeof pinSchema>;
/** Trusted adapter boundary: authenticated current, uncached head reads with a
 * non-reused provider revision, and exact-version immutable entry reads. No
 * backup/local fallback. Durability, independent IAM and anti-rollback are NOT
 * established by implementing this interface. */
export interface ManagedRecoveryEpochReader {
 configurationDigest():string;
 readHead(signal:AbortSignal):Promise<unknown>;
 readEntry(sequence:number,pin:Pin,signal:AbortSignal):Promise<unknown>;
}
/** Separate explicit write capability. Entry creation must be provider-atomic
 * create-if-absent at the sequence's fixed location. Head replacement must be
 * provider-atomic CAS against expectedRevision; conflicts/unknown ACKs throw.
 * Provisioning the pinned genesis is a separate authorised operation. */
export interface ManagedRecoveryEpochWriter {
 configurationDigest():string;
 createEntry(sequence:number,artifact:Artifact,signal:AbortSignal):Promise<unknown>;
 replaceHead(expectedRevision:string,artifact:Artifact,signal:AbortSignal):Promise<unknown>;
}
const fail=()=>new Error('Managed recovery epoch catalogue is unresolved; preserve original records without replay, admission or recovered ACKs');
const artifact=(value:unknown):Artifact=>{const body=JSON.stringify(value);return canonical({body,sha256:candidateHash(body)});};
function canonical(raw:unknown){const v=artifactSchema.parse(raw);if(Buffer.byteLength(v.body)>65536||candidateHash(v.body)!==v.sha256||JSON.stringify(JSON.parse(v.body))!==v.body)throw fail();return v;}
function headRecord(raw:unknown){const r=recordSchema.parse(raw),a=canonical(r.artifact),head=headSchema.parse(JSON.parse(a.body));if(JSON.stringify(head)!==a.body)throw fail();return{...r,artifact:a,head};}
async function bounded<T>(run:(signal:AbortSignal)=>Promise<T>,caller?:AbortSignal){
 const controller=new AbortController(),signal=caller?AbortSignal.any([caller,controller.signal]):controller.signal;
 const timer=setTimeout(()=>controller.abort(),300000);let stop=()=>{};
 try{signal.throwIfAborted();const cancelled=new Promise<never>((_,reject)=>{stop=()=>reject(fail());signal.addEventListener('abort',stop,{once:true});});
  const result=await Promise.race([run(signal),cancelled]);signal.throwIfAborted();return result;
 }catch{throw fail();}finally{clearTimeout(timer);signal.removeEventListener('abort',stop);controller.abort();}
}
export const managedRecoveryEpochSchemas={configuration:configurationSchema,head:headSchema,entry:entrySchema,artifact:artifactSchema,record:recordSchema,pin:pinSchema};
/** Read-only closed-epoch lineage. The independently retained genesis digest
 * must not be learned from the same backup/namespace being inspected. */
export class ManagedRecoveryEpochCatalogue {
 readonly #config:z.infer<typeof configurationSchema>;
 readonly #reader:ManagedRecoveryEpochReader;
 constructor(raw:unknown,reader:ManagedRecoveryEpochReader){this.#config=configurationSchema.parse(raw);this.#reader=reader;if(reader.configurationDigest()!==this.#config.storeConfigurationDigest)throw fail();}
 configurationDescriptor(){return configurationSchema.parse(this.#config);}
 configurationDigest(){const{trustedCheckpoint,...identity}=this.#config;return candidateHash(JSON.stringify({format:1,policy:'PINNED_GENESIS_CLOSED_EPOCH_CHAIN_V1',...identity}));}
 async observe(caller?:AbortSignal){return bounded(async signal=>{
  if(this.#reader.configurationDigest()!==this.#config.storeConfigurationDigest)throw fail();
  const before=headRecord(await this.#reader.readHead(signal));signal.throwIfAborted();
  if(before.head.installationId!==this.#config.installationId||before.head.sequence<this.#config.trustedCheckpoint.sequence)throw fail();
  let current=before.head,latest:z.infer<typeof entrySchema>|null=null,previousEpoch=2147483648,entryCount=0;
  while(current.sequence>0){
   signal.throwIfAborted();const saved=z.object({pin:pinSchema,artifact:artifactSchema}).strict().parse(await this.#reader.readEntry(current.sequence,current.entryPin!,signal));signal.throwIfAborted();
   const a=canonical(saved.artifact),entry=entrySchema.parse(JSON.parse(a.body));
   if(JSON.stringify(saved.pin)!==JSON.stringify(current.entryPin)||saved.pin.sha256!==a.sha256||saved.pin.byteLength!==Buffer.byteLength(a.body)
    ||JSON.stringify(entry)!==a.body||entry.installationId!==this.#config.installationId||entry.sequence!==current.sequence||entry.registryConfigurationDigest!==this.configurationDigest())throw fail();
   if(entry.sequence===this.#config.trustedCheckpoint.sequence&&a.sha256!==this.#config.trustedCheckpoint.sha256)throw fail();
   const closed=managedClosedHead(entry.closedControl,this.#config.installationId),plan=entry.plan;
   if(closed.value.planDigest!==candidateHash(JSON.stringify(plan))||plan.installationId!==this.#config.installationId||plan.maintenanceEpoch!==closed.value.maintenanceEpoch
    ||plan.maintenanceEpoch>=previousEpoch)throw fail();
   const prior=headRecord({revision:'historical-preimage-only',artifact:entry.previousHead});
   if(prior.head.installationId!==this.#config.installationId||prior.head.sequence!==entry.sequence-1)throw fail();
   latest??=entry;previousEpoch=plan.maintenanceEpoch;entryCount++;current=prior.head;
   if(current.sequence===0&&prior.artifact.sha256!==this.#config.genesisHeadSha256)throw fail();
  }
  if(!latest&&before.artifact.sha256!==this.#config.genesisHeadSha256)throw fail();
  const after=headRecord(await this.#reader.readHead(signal));signal.throwIfAborted();
  if(after.revision!==before.revision||after.artifact.body!==before.artifact.body||this.#reader.configurationDigest()!==this.#config.storeConfigurationDigest)throw fail();
  return{kind:'MANAGED_RECOVERY_EPOCH_CATALOGUE_OBSERVATION_V1' as const,configurationDigest:this.configurationDigest(),head:before,
   latest,entryCount,recordedClosedEpochChainVerified:true as const,externalCheckpointEnforced:true as const,headStableAtBoundaries:true as const,
   allMaintenanceEpochsAccountedFor:false as const,providerRollbackExclusionVerified:false as const,independentCustodyVerified:false as const,
   currentTenantAuthorityVerified:false as const,completeHistoryVerified:false as const,sourceHostLossProven:false as const,
   savedObservationAuthorizesExecution:false as const,executionAuthorized:false as const,reopeningAuthorized:false as const,
   originalAcknowledgementReconstructed:false as const,archivedSetAdmitted:false as const,actionAuthorized:false as const};
 },caller);}
}
/** Original publisher only. A cold reader cannot obtain this write capability
 * from an observation. The original immutable entry ACK always precedes CAS. */
export class ManagedRecoveryEpochPublisher {
 readonly #catalogue:ManagedRecoveryEpochCatalogue;readonly #writer:ManagedRecoveryEpochWriter;readonly #reader:ManagedRecoveryEpochReader;
 readonly #attempted=new Set<number>();
 constructor(catalogue:ManagedRecoveryEpochCatalogue,reader:ManagedRecoveryEpochReader,writer:ManagedRecoveryEpochWriter){
  this.#catalogue=catalogue;this.#reader=reader;this.#writer=writer;
  const expected=catalogue.configurationDescriptor().storeConfigurationDigest;if(reader.configurationDigest()!==expected||writer.configurationDigest()!==expected)throw fail();
 }
 async publishClosedEpoch(control:S3ManagedMaintenanceControl,journal:Pick<ManagedCandidateCaptureJournal,'configurationDigest'|'discoverCurrentCandidates'>,
  archiveConfigurationDigest:string,expectedHeadRevision:string,caller?:AbortSignal){return bounded(async signal=>{
   const config=this.#catalogue.configurationDescriptor(),before=await this.#catalogue.observe(signal);signal.throwIfAborted();
   if(before.head.revision!==expectedHeadRevision)throw fail();
   const sequence=before.head.head.sequence+1;if(sequence>10000||this.#attempted.has(sequence))throw fail();this.#attempted.add(sequence);
   const closed=await control.observe(signal);signal.throwIfAborted();managedClosedHead(closed,config.installationId);
   const bootstrap=await journal.discoverCurrentCandidates(control,closed.value.maintenanceEpoch,signal);signal.throwIfAborted();
   if(bootstrap.head.revision!==closed.revision||bootstrap.plan.maintenanceEpoch<=(before.latest?.plan.maintenanceEpoch??0))throw fail();
   const value=entrySchema.parse({format:1,kind:'MANAGED_CLOSED_RECOVERY_EPOCH_V1',installationId:config.installationId,sequence,
    registryConfigurationDigest:this.#catalogue.configurationDigest(),previousHead:before.head.artifact,
    closedControl:{revision:closed.revision,value:requireProtocol9ClosedHead(closed).value},controlConfigurationDigest:control.configurationDigest(),
    journalConfigurationDigest:journal.configurationDigest(),archiveConfigurationDigest:sha.parse(archiveConfigurationDigest),plan:bootstrap.plan});
   const original=artifact(value);
   const check=async()=>{
    signal.throwIfAborted();if(this.#writer.configurationDigest()!==config.storeConfigurationDigest||this.#reader.configurationDigest()!==config.storeConfigurationDigest)throw fail();
    const current=await control.observe(signal);signal.throwIfAborted();
    if(current.revision!==closed.revision||JSON.stringify(current.value)!==JSON.stringify(closed.value)||control.configurationDigest()!==value.controlConfigurationDigest)throw fail();
    const h=headRecord(await this.#reader.readHead(signal));signal.throwIfAborted();if(h.revision!==before.head.revision||h.artifact.body!==before.head.artifact.body)throw fail();
   };
   await check();const pin=pinSchema.parse(await this.#writer.createEntry(sequence,original,signal));signal.throwIfAborted();
   if(pin.sha256!==original.sha256||pin.byteLength!==Buffer.byteLength(original.body))throw fail();
   const saved=z.object({pin:pinSchema,artifact:artifactSchema}).strict().parse(await this.#reader.readEntry(sequence,pin,signal));signal.throwIfAborted();
   if(JSON.stringify(saved.pin)!==JSON.stringify(pin)||canonical(saved.artifact).body!==original.body)throw fail();await check();
   const next=artifact(headSchema.parse({format:1,kind:'MANAGED_RECOVERY_EPOCH_HEAD_V1',installationId:config.installationId,sequence,entryPin:pin,publicationId:randomUUID()}));
   const ack=headRecord(await this.#writer.replaceHead(before.head.revision,next,signal));signal.throwIfAborted();
   if(ack.artifact.body!==next.body||ack.revision===before.head.revision)throw fail();
   const after=await this.#catalogue.observe(signal);signal.throwIfAborted();
   if(after.head.revision!==ack.revision||after.head.artifact.body!==next.body)throw fail();
   const last=await control.observe(signal);signal.throwIfAborted();if(last.revision!==closed.revision||JSON.stringify(last.value)!==JSON.stringify(closed.value))throw fail();
   return{...after,originalEntryAcknowledgementObserved:true as const,originalHeadAcknowledgementObserved:true as const};
  },caller);}
}
