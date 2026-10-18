import {createHash} from 'node:crypto';
import {z} from 'zod';

const identifier=z.string().regex(/^[a-z][a-z0-9-]{1,99}$/);
const serviceId=z.string().regex(/^srv-[a-z0-9]{20}$/);
const imagePath=z.string().max(512).regex(/^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?\/[A-Za-z0-9._/-]+@sha256:[a-f0-9]{64}$/);
const component=z.enum(['gateway','web','api','scheduler']);
const configuration=z.object({ownerId:identifier,environmentId:identifier,
 services:z.array(z.object({component,id:serviceId,imagePath}).strict()).length(4)}).strict().superRefine((value,ctx)=>{
 if(new Set(value.services.map(s=>s.id)).size!==4||new Set(value.services.map(s=>s.component)).size!==4)
  ctx.addIssue({code:'custom',message:'Exact distinct gateway, private web, API and scheduler services required'});
});
export {configuration as renderMaintenanceConfigurationSchema};
const service=z.object({id:serviceId,ownerId:identifier,environmentId:identifier,
 type:z.enum(['web_service','private_service','background_worker']),imagePath,
 autoDeploy:z.literal('no'),autoDeployTrigger:z.literal('off').optional(),
 suspended:z.enum(['suspended','not_suspended']),
 serviceDetails:z.object({region:z.literal('frankfurt'),runtime:z.literal('image'),
  numInstances:z.number().int().positive(),autoscaling:z.unknown().optional()})});
const job=z.object({id:z.string().regex(/^job-[a-z0-9]{20}$/),serviceId,
 status:z.enum(['pending','running','succeeded','failed','canceled'])});
const deploy=z.object({id:identifier,status:z.enum(['created','queued','build_in_progress','update_in_progress',
 'live','deactivated','build_failed','update_failed','canceled','pre_deploy_in_progress','pre_deploy_failed']),
 image:z.object({ref:z.string().max(512).optional(),sha:z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/).optional()}).optional()});
const activeDeploys=['created','queued','build_in_progress','update_in_progress','pre_deploy_in_progress'];
const types={gateway:'web_service',web:'private_service',api:'private_service',scheduler:'background_worker'} as const;
const shutdownOrder=['gateway','scheduler','web','api'] as const;
const unresolved='Render maintenance is unresolved; inspect current services and jobs without automatically retrying mutations or reopening';
type Budget={requests:number;deadline:number};

/** Internal provider adapter; no route, worker or operator command activates
 * mutations. The separate inspection job exposes only observeConfiguration().
 * The caller must supply an authorised, separately trusted exact environment
 * registry and coordinate control-plane writers. A point-in-time suspension
 * observation is not a durable IAM fence, database fence or reopening permit. */
export class RenderMaintenanceControl {
 private readonly config:z.infer<typeof configuration>;
 constructor(raw:unknown,private readonly token:string,private readonly transport:typeof fetch=fetch){
  this.config=configuration.parse(raw);
  if(!/^[\x21-\x7e]{1,512}$/.test(token))throw new Error('Invalid Render maintenance credential');
 }
 configurationDigest(){return createHash('sha256').update(JSON.stringify({topology:'GATEWAY_PRIVATE_WEB_API_SCHEDULER_V1',...this.config})).digest('hex');}
 private checkService(actual:z.infer<typeof service>,expected:z.infer<typeof configuration>['services'][number]){
  if(actual.id!==expected.id||actual.ownerId!==this.config.ownerId||actual.environmentId!==this.config.environmentId
   ||actual.type!==types[expected.component]||actual.imagePath!==expected.imagePath)throw new Error();
  if(expected.component==='scheduler'&&(actual.serviceDetails.numInstances!==1||actual.serviceDetails.autoscaling!==undefined))throw new Error();
 }
 private budget():Budget{return{requests:0,deadline:performance.now()+60000};}
 private async request(path:string,query:Record<string,string>,method:'GET'|'POST',expected:number,budget:Budget){
  if(++budget.requests>96||performance.now()>=budget.deadline)throw new Error();
  const url=new URL('https://api.render.com/v1'+path);
  for(const [key,value] of Object.entries(query))url.searchParams.set(key,value);
  const signal=AbortSignal.timeout(Math.max(1,Math.min(5000,Math.floor(budget.deadline-performance.now()))));
  const response=await this.transport(url.href,{method,redirect:'error',signal,
   headers:{Authorization:'Bearer '+this.token,Accept:'application/json'}});
  try {
   if(response.status!==expected)throw new Error();
   // Suspension's 202 acknowledges a request, never shutdown completion.
   if(method==='POST')return undefined;
   if(!response.body)throw new Error();
   const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
   try {
    for(;;){signal.throwIfAborted();const next=await reader.read();if(next.done)break;
     length+=next.value.length;if(length>1024*1024)throw new Error();chunks.push(next.value);}
   }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
   return JSON.parse(Buffer.concat(chunks,length).toString('utf8')) as unknown;
  }finally{await response.body?.cancel().catch(()=>{});}
 }
 private async list<T extends {id:string}>(path:string,query:Record<string,string>,key:string,schema:z.ZodType<T>,budget:Budget,check:(row:T)=>void=()=>{}):Promise<T[]>{
  const rows:T[]=[],ids=new Set<string>(),cursors=new Set<string>();let cursor='';
  for(let page=0;page<11;page++){
   const raw=await this.request(path,{...query,limit:'100',...(cursor?{cursor}:{})},'GET',200,budget);
   const items=z.array(z.object({cursor:z.string().min(1).max(512)}).passthrough()).max(100).parse(raw);
   for(const item of items){const parsed=schema.parse(item[key]);if(ids.has(parsed.id))throw new Error();check(parsed);ids.add(parsed.id);rows.push(parsed);if(rows.length>1000)throw new Error();}
   // limit is a maximum, not a completeness assertion. A short page still
   // needs its cursor followed to an empty page within the same budget.
   if(items.length===0)return rows;
   cursor=items.at(-1)!.cursor;if(cursors.has(cursor))throw new Error();cursors.add(cursor);
  }
  throw new Error(); // A truncated inventory is not evidence of no active work.
 }
 private async snapshot(budget:Budget){
  const c=this.config;
  const services=await this.list('/services',{ownerId:c.ownerId,environmentId:c.environmentId,includePreviews:'true'},'service',service,budget);
  if(services.length!==4)throw new Error();
  for(const expected of c.services){
   const actual=services.find(s=>s.id===expected.id);
   if(!actual)throw new Error();this.checkService(actual,expected);
  }
  const jobs:z.infer<typeof job>[]=[],liveDeployments:Array<{serviceId:string;deployId:string;imagePath:string;sha:string}>=[];
  for(const current of services){
   // Read the bounded complete history rather than relying on a provider's
   // multi-value status filtering or allowing it to hide unfamiliar work.
   const deployments=await this.list(`/services/${current.id}/deploys`,{},'deploy',deploy,budget,
    d=>{if(activeDeploys.includes(d.status))throw new Error();});
   const live=deployments.filter(d=>d.status==='live'),expected=c.services.find(s=>s.id===current.id)!;
   if(live.length!==1||live[0]!.image?.ref!==expected.imagePath
    ||live[0]!.image?.sha?.replace(/^sha256:/,'')!==expected.imagePath.split('@sha256:')[1])throw new Error();
   liveDeployments.push({serviceId:current.id,deployId:live[0]!.id,imagePath:live[0]!.image!.ref!,sha:live[0]!.image!.sha!.replace(/^sha256:/,'')});
   const currentJobs=await this.list(`/services/${current.id}/jobs`,{},'job',job,budget);
   if(currentJobs.some(j=>j.serviceId!==current.id))throw new Error();
   jobs.push(...currentJobs.filter(j=>j.status==='pending'||j.status==='running'));
  }
  if(new Set(jobs.map(j=>j.id)).size!==jobs.length)throw new Error();
  return{services,jobs,liveDeployments};
 }
 /** Point-in-time readback only; active jobs are reported, not cancelled.
  * No env/secret files, IAM/controller writers or image provenance is proved. */
 async observeConfiguration(){
  try{
   const state=await this.snapshot(this.budget()),observedAt=new Date().toISOString();
   return{format:1,kind:'MANAGED_RENDER_CONFIGURATION_DIAGNOSTIC_V1' as const,
    scope:'RENDER_CONFIGURED_SERVICE_AND_WORK_OBSERVATION' as const,configurationDigest:this.configurationDigest(),observedAt,
    observationDigest:createHash('sha256').update(JSON.stringify({configurationDigest:this.configurationDigest(),state,observedAt})).digest('hex'),
    configuredServices:4,liveImagePinsMatched:state.liveDeployments.length,activeJobs:state.jobs.length,
    suspendedServices:state.services.filter(s=>s.suspended==='suspended').length,
    completeEnvironmentVerified:false as const,secretDeliveryVerified:false as const,imageProvenanceVerified:false as const,
    controlPlaneExclusionVerified:false as const,runningToolReleaseVerified:false as const,
    wholeBackendQuiesced:false as const,reopeningAuthorised:false as const,executionAuthorized:false as const,actionAuthorized:false as const};
  }catch{throw new Error(unresolved);}
 }
 private proof(state:Awaited<ReturnType<RenderMaintenanceControl['snapshot']>>){
  if(state.services.some(s=>s.suspended!=='suspended')||state.jobs.length)throw new Error();
  const observedAt=new Date().toISOString();
  return{scope:'RENDER_CONFIGURED_ENVIRONMENT_OBSERVATION' as const,observedAt,suspendedServices:4,activeJobs:0,
   observationDigest:createHash('sha256').update(JSON.stringify({config:this.config,state,observedAt})).digest('hex'),
   wholeBackendQuiesced:false as const,databaseWritersFenced:false as const,sourceHostFenced:false as const,
   reopeningAuthorised:false as const,actionAuthorized:false as const};
 }
 async observeSuspended(){
  try{return this.proof(await this.snapshot(this.budget()));}catch{throw new Error(unresolved);}
 }
 async suspend(){
  const budget=this.budget();
  try{
   const before=await this.snapshot(budget);
   // No automatic retries, cancellation of deploys, resume, deploy, deletion or
   // secret mutation. Unknown command outcomes need fresh read-only inspection.
   const gateway=this.config.services.find(s=>s.component==='gateway')!;
   const previousGateway=before.services.find(s=>s.id===gateway.id)!;
   if(previousGateway.suspended!=='suspended')await this.request(`/services/${gateway.id}/suspend`,{},'POST',202,budget);
   const observedGateway=service.parse(await this.request(`/services/${gateway.id}`,{},'GET',200,budget));
   this.checkService(observedGateway,gateway);if(observedGateway.suspended!=='suspended')throw new Error();
   // Block the observed front door before internal shutdown. Provider list order
   // never determines execution order, and a202 alone cannot advance this step.
   for(const name of shutdownOrder.slice(1)){
    const expected=this.config.services.find(s=>s.component===name)!;
    const current=before.services.find(s=>s.id===expected.id)!;
    if(current.suspended!=='suspended')await this.request(`/services/${current.id}/suspend`,{},'POST',202,budget);
   }
   const suspended=await this.snapshot(budget);
   if(suspended.services.some(s=>s.suspended!=='suspended'))throw new Error();
   // One-off jobs survive suspension of their base service. Inventory them
   // again after suspension, then cancel each observed active job once.
   for(const current of suspended.jobs)await this.request(`/services/${current.serviceId}/jobs/${current.id}/cancel`,{},'POST',200,budget);
   return this.proof(await this.snapshot(budget));
  }catch{throw new Error(unresolved);}
 }
}
