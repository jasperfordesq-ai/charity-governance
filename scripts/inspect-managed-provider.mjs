import {createHash,timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {compileManagedProviderPlan} from './managed-provider-plan.mjs';
import {RenderMaintenanceControl} from '../apps/api/dist/services/render-maintenance-control.js';
import {prepareManagedTlsBundle} from '../packages/shared/runtime/managed-tls-delivery.mjs';

const failure=()=>new Error('Managed provider readback refused; no provider action authorised');
const hash=raw=>createHash('sha256').update(raw).digest('hex');
function exact(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('|')!==[...keys].sort().join('|'))throw failure();}
function equal(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length>131072||b.length>131072)throw failure();const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
function rows(value){if(!Array.isArray(value)||value.length>100)throw failure();return value;}
const id=value=>typeof value==='string'&&/^[a-z][a-z0-9-]{1,99}$/.test(value);
function canonical(value){
 if(!value||typeof value!=='object')return value;
 if(Array.isArray(value))return value.map(canonical).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
}
const stable=value=>JSON.stringify(canonical(value));
const stages=new Set(['INPUT','BASELINE_WORK','ENVIRONMENT','GROUPS','BLUEPRINTS','SERVICE','VARIABLES','FILES','FINAL_WORK']);

/** Explicit internal transport seam. CLI never accepts an endpoint, dependency,
 * timeout, mutation or credential fallback. All HTTP, including the existing
 * service/work inspector, shares this GET-only bounded transport. */
export async function inspectManagedProvider(raw,{transport=fetch,requestTimeoutMs=5000}={}){
 let stage='INPUT';
 try{
  raw=structuredClone(raw);
  exact(raw,['format','configuration','expectedConfigurationSha256','token','projectId','blueprintId','secrets','secretFileSha256']);
  if(raw.format!==1||typeof raw.token!=='string'||! /^[\x21-\x7e]{1,512}$/.test(raw.token)||!id(raw.projectId)
   ||!/^exs-[a-z0-9]{20}$/.test(raw.blueprintId)||!Number.isInteger(requestTimeoutMs)||requestTimeoutMs<1||requestTimeoutMs>5000)throw failure();
  const plan=compileManagedProviderPlan(raw.configuration),r=raw.configuration.mesh;
  if(raw.expectedConfigurationSha256!==plan.configurationSha256)throw failure();
  const definitions=plan.blueprint.projects[0].environments[0].services,roles=['gateway','web','api','scheduler'];
  exact(raw.secrets,['api','scheduler']);exact(raw.secretFileSha256,roles);
  const expectedEnvironments={},expectedFiles={};
  for(const [i,role] of roles.entries()){
   const definition=definitions[i],secretKeys=definition.envVars.filter(v=>v.sync===false).map(v=>v.key);
   const secrets=secretKeys.length?raw.secrets[role]:{};exact(secrets,secretKeys);
   for(const value of Object.values(secrets))if(typeof value!=='string'||! /^[\x21-\x7e]{1,8192}$/.test(value))throw failure();
   expectedEnvironments[role]={...Object.fromEntries(definition.envVars.filter(v=>Object.hasOwn(v,'value')).map(v=>[v.key,v.value])),...secrets};
   expectedFiles[role]=[...plan.secretFiles,...plan.databaseCaFiles].filter(v=>v.serviceId===r[role+'ServiceId']).map(v=>v.path.slice('/etc/secrets/'.length));
   exact(raw.secretFileSha256[role],expectedFiles[role]);
   for(const pin of Object.values(raw.secretFileSha256[role]))if(typeof pin!=='string'||! /^[a-f0-9]{64}$/.test(pin))throw failure();
  }
  let requests=0,totalBytes=0;const deadline=performance.now()+90000;
  async function getTransport(input,options={}){
   const url=new URL(String(input));
   if(url.origin!=='https://api.render.com'||!url.pathname.startsWith('/v1/')||url.username||url.password||url.hash||options.method!=='GET'
    ||options.redirect!=='error'||new Headers(options.headers).get('Authorization')!=='Bearer '+raw.token||++requests>256||performance.now()>=deadline)throw failure();
   const timeout=AbortSignal.timeout(Math.max(1,Math.min(requestTimeoutMs,Math.floor(deadline-performance.now()))));
   const signal=options.signal?AbortSignal.any([timeout,options.signal]):timeout;
   let response,reader,cancelling=false;
   function dispose(){
    if(reader){if(!cancelling){cancelling=true;void reader.cancel().catch(()=>{});}try{reader.releaseLock();reader=undefined;}catch{}}
    else if(response)void response.body?.cancel().catch(()=>{});
   }
   const operation=(async()=>{
    try{
    signal.throwIfAborted();
    response=await transport(url.href,{...options,signal});signal.throwIfAborted();
    if(response.status!==200||response.redirected||!response.body)throw failure();
    reader=response.body.getReader();const chunks=[];let size=0;
    for(;;){const next=await reader.read();signal.throwIfAborted();if(next.done)break;size+=next.value.length;totalBytes+=next.value.length;if(size>1048576||totalBytes>8388608)throw failure();chunks.push(next.value);}
    const body=Buffer.concat(chunks,size);
    try{return Response.json(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body)));}finally{body.fill(0);for(const chunk of chunks)chunk.fill(0);}
    }finally{dispose();}
   })();
   let abort;
   try{return await Promise.race([operation,new Promise((_,reject)=>{abort=()=>reject(failure());signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]);}
   finally{if(abort)signal.removeEventListener('abort',abort);if(signal.aborted)dispose();}
  }
  async function get(path,query={}){
   const url=new URL('https://api.render.com/v1'+path);for(const[k,v]of Object.entries(query))url.searchParams.set(k,v);
   return (await getTransport(url.href,{method:'GET',redirect:'error',headers:{Authorization:'Bearer '+raw.token,Accept:'application/json'}})).json();
  }
  async function list(path,query,key){
   const result=[],ids=new Set(),cursors=new Set();let cursor='';
   for(let page=0;page<11;page++){
    const values=rows(await get(path,{...query,limit:'100',...(cursor?{cursor}:{})}));
    if(!values.length)return result;
    for(const row of values){const value=key?row[key]:Object.fromEntries(Object.entries(row).filter(([name])=>name!=='cursor'));const identity=key==='envVar'?value?.key:key==='secretFile'?value?.name:value?.id;
     if(typeof identity!=='string'||!identity||ids.has(identity)||result.length>=1000)throw failure();ids.add(identity);result.push(value);}
    const next=values.at(-1)?.cursor;if(typeof next!=='string'||!next||next.length>512||cursors.has(next))throw failure();cursors.add(next);cursor=next;
   }throw failure();
  }
  const control=new RenderMaintenanceControl(plan.maintenanceRegistry,raw.token,getTransport);
  function checkProviderReport(value){
   if(value.kind!=='MANAGED_RENDER_CONFIGURATION_DIAGNOSTIC_V1'||value.scope!=='RENDER_CONFIGURED_SERVICE_AND_WORK_OBSERVATION'
    ||value.configurationDigest!==control.configurationDigest()||! /^[a-f0-9]{64}$/.test(value.configurationStateSha256??'')
    ||value.configuredServices!==4||value.liveImagePinsMatched!==4||value.activeJobs!==0
    ||value.executionAuthorized!==false||value.actionAuthorized!==false)throw failure();
  }
  stage='BASELINE_WORK';const before=await control.observeConfiguration();
  checkProviderReport(before);
  async function snapshot(){
   stage='ENVIRONMENT';
   const environment=await get('/environments/'+r.environmentId),project=await get('/projects/'+raw.projectId);
   if(environment.id!==r.environmentId||environment.name!=='synthetic-review'||environment.projectId!==raw.projectId
    ||JSON.stringify([...(environment.serviceIds??[])].sort())!==JSON.stringify(roles.map(v=>r[v+'ServiceId']).sort())
    ||!Array.isArray(environment.envGroupIds)||environment.envGroupIds.length||!Array.isArray(environment.databasesIds)||environment.databasesIds.length
    ||!Array.isArray(environment.redisIds)||environment.redisIds.length||environment.networkIsolationEnabled!==true
    ||project.id!==raw.projectId||project.name!==plan.blueprint.projects[0].name||project.owner?.id!==r.ownerId
    ||JSON.stringify(project.environmentIds)!==JSON.stringify([r.environmentId]))throw failure();
   // A group outside the selected environment can still link these services.
   // Metadata lacks mandatory cursors in the published schema: if nonempty
   // results have no actual continuation witness, remain unverified.
   stage='GROUPS';const groups=await list('/env-groups',{ownerId:r.ownerId},null);
   for(const group of groups){if(!id(group.id)||group.ownerId!==r.ownerId||!Array.isArray(group.serviceLinks))throw failure();
    for(const link of group.serviceLinks){if(!id(link.id)||roles.some(role=>link.id===r[role+'ServiceId']))throw failure();}}
   stage='BLUEPRINTS';const summaries=await list('/blueprints',{ownerId:r.ownerId},'blueprint'),blueprints=[];
   if(!summaries.some(v=>v.id===raw.blueprintId))throw failure();
   for(const summary of summaries){if(!/^exs-[a-z0-9]{20}$/.test(summary.id))throw failure();
    const blueprint=await get('/blueprints/'+summary.id);
    if(blueprint.id!==summary.id||!Array.isArray(blueprint.resources))throw failure();
    for(const key of ['name','status','autoSync','repo','branch','path'])if(blueprint[key]!==summary[key])throw failure();blueprints.push(blueprint);
    if(blueprint.id!==raw.blueprintId&&blueprint.resources.some(v=>roles.some(role=>v.id===r[role+'ServiceId'])))throw failure();}
   const blueprint=blueprints.find(v=>v.id===raw.blueprintId);
   if(blueprint.id!==raw.blueprintId||blueprint.autoSync!==false||blueprint.status!=='in_sync'
    ||!['https://github.com/jasperfordesq-ai/charity-governance','https://github.com/jasperfordesq-ai/charity-governance.git'].includes(blueprint.repo)
    ||blueprint.branch!=='master'||typeof blueprint.path!=='string'||!blueprint.path||blueprint.path.includes('..')||blueprint.path.startsWith('/')
    ||JSON.stringify((blueprint.resources??[]).map(v=>v.id).sort())!==JSON.stringify(roles.map(v=>r[v+'ServiceId']).sort()))throw failure();
   const syncs=await list('/blueprints/'+raw.blueprintId+'/syncs',{},'sync');
   if(syncs.some(v=>!['success','error'].includes(v.state)))throw failure();
   const facts=[];
   for(const[i,role]of roles.entries()){
    stage='SERVICE';
    const serviceId=r[role+'ServiceId'],definition=definitions[i],service=await get('/services/'+serviceId),detail=service.serviceDetails;
    if(service.id!==serviceId||service.ownerId!==r.ownerId||service.environmentId!==r.environmentId||service.name!==definition.name
     ||service.imagePath!==definition.image.url||service.autoDeploy!=='no'||service.autoDeployTrigger!=='off'||detail?.runtime!=='image'||detail.region!=='frankfurt'||detail.plan!=='1c-2g'||detail.numInstances!==1
     ||detail.autoscaling!==undefined||detail.previews?.generation&&detail.previews.generation!=='off'||detail.pullRequestPreviewsEnabled===true
     ||detail.envSpecificDetails?.dockerCommand!==(definition.dockerCommand??'')||detail.envSpecificDetails?.preDeployCommand
     ||detail.maxShutdownDelaySeconds!==60)throw failure();
    stage='VARIABLES';const environmentRows=await list('/services/'+serviceId+'/env-vars',{},'envVar');
    exact(Object.fromEntries(environmentRows.map(v=>[v.key,v.value])),Object.keys(expectedEnvironments[role]));
    for(const value of environmentRows)if(!equal(value.value,expectedEnvironments[role][value.key]))throw failure();
    stage='FILES';const files=await list('/services/'+serviceId+'/secret-files',{},'secretFile');exact(Object.fromEntries(files.map(v=>[v.name,v.content])),expectedFiles[role]);
    for(const file of files){if(typeof file.content!=='string'||Buffer.byteLength(file.content)>98304||hash(file.content)!==raw.secretFileSha256[role][file.name])throw failure();
     if(file.name==='charitypilot-'+role+'-tls.json')prepareManagedTlsBundle(file.content,role,r);}
    facts.push({serviceId,environment:environmentRows.sort((a,b)=>a.key.localeCompare(b.key)),files:files.sort((a,b)=>a.name.localeCompare(b.name)),service});
   }
   return {environment,project,groups,blueprint,blueprints,syncs,facts};
  }
  const first=await snapshot(),second=await snapshot();stage='FINAL_WORK';const after=await control.observeConfiguration();
  checkProviderReport(after);
  // Large snapshots can contain secret values. Compare locally, never hash or
  // export them. Collection/property ordering alone is not configuration drift.
  if(stable(first)!==stable(second)||before.configurationStateSha256!==after.configurationStateSha256||after.activeJobs!==0)throw failure();
  const facts={format:1,kind:'MANAGED_PROVIDER_READBACK_OBSERVATION_V1',configurationSha256:plan.configurationSha256,
   providerConfigurationStateSha256:after.configurationStateSha256,observedAt:new Date().toISOString(),configuredServices:4,
   firstServiceObservationAt:before.observedAt,lastServiceObservationAt:after.observedAt,configurationSamples:2,
   declaredEnvironmentsMatched:4,configuredSecretFilesMatched:plan.secretFiles.length+plan.databaseCaFiles.length,
   linkedGroupsAbsentObserved:true,blueprintAutoSyncOffObserved:true};
  return {...facts,observationSha256:hash(JSON.stringify(facts)),runtimeEnvironmentVerified:false,runtimeSecretDeliveryVerified:false,
   providerVisibilityCompletenessVerified:false,imageProvenanceVerified:false,privateDnsVerified:false,controlPlaneExclusionVerified:false,
   unapprovedBlueprintSyncsExcluded:false,
   independentRecoveryVerified:false,runningToolReleaseVerified:false,wholeBackendQuiesced:false,releaseReady:false,executionAuthorized:false,actionAuthorized:false};
 }catch{const error=failure();error.stage=stage;throw error;}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const chunks=[];let size=0,body;
 try{if(process.argv.length!==3||process.argv[2]!=='--stdin')throw failure();
  for await(const chunk of process.stdin){size+=chunk.length;if(size>65536)throw failure();chunks.push(chunk);}
  body=Buffer.concat(chunks);const result=await inspectManagedProvider(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body)));
  process.stdout.write(JSON.stringify(result)+'\n');
 }catch(error){process.stderr.write(failure().message+(stages.has(error?.stage)?' (stage: '+error.stage+')':'')+'\n');process.exitCode=1;}
 finally{body?.fill(0);for(const chunk of chunks)chunk.fill(0);}
}
