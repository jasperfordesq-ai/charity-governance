import assert from 'node:assert/strict';
import test from 'node:test';
import {RenderMaintenanceControl} from '../services/render-maintenance-control.js';
import {inspectManagedRender} from '../jobs/inspect-managed-render.js';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ids=['srv-'+ 'a'.repeat(20),'srv-'+ 'b'.repeat(20),'srv-'+ 'c'.repeat(20),'srv-'+ 'd'.repeat(20)];
const jobId='job-'+ 'd'.repeat(20);
const digest='sha256:'+ '1'.repeat(64);
const configuration={ownerId:'tea-synthetic',environmentId:'env-synthetic',
 services:[{component:'gateway',id:ids[0],imagePath:'ghcr.io/synthetic/gateway@'+digest},
 {component:'web',id:ids[1],imagePath:'ghcr.io/synthetic/web@'+digest},
 {component:'api',id:ids[2],imagePath:'ghcr.io/synthetic/api@'+digest},
 {component:'scheduler',id:ids[3],imagePath:'ghcr.io/synthetic/api@'+digest}]};
function fixture(){
 const services=configuration.services.map((s,i)=>({...s,ownerId:configuration.ownerId,environmentId:configuration.environmentId,
  type:['web_service','private_service','private_service','background_worker'][i],autoDeploy:'no',autoDeployTrigger:'off',
  suspended:'not_suspended',serviceDetails:{region:'frankfurt',runtime:'image',numInstances:1}}));
 const calls:Array<{path:string;method:string}>=[];
 const jobs=new Map(ids.map(id=>[id,[] as Array<{id:string;serviceId:string;status:string}>]));
 jobs.get(ids[3]!)!.push({id:jobId,serviceId:ids[3]!,status:'running'});
 let fault:((url:URL,method:string)=>Response|undefined)|undefined;
 const transport:typeof fetch=async(input,options)=>{
  const url=new URL(String(input)),method=options?.method??'GET';calls.push({path:url.pathname+url.search,method});
  assert.equal(url.origin,'https://api.render.com');assert.equal(options?.redirect,'error');
  if(/\/(?:deploys|jobs)$/.test(url.pathname))assert.equal(url.searchParams.has('status'),false);
  assert.equal(new Headers(options?.headers).get('Authorization'),'Bearer synthetic-token');
  assert.ok(options?.signal);const response=fault?.(url,method);if(response)return response;
  const parts=url.pathname.split('/'),id=parts[3];
  if(url.pathname==='/v1/services')return Response.json(url.searchParams.has('cursor')?[]:services.map(service=>({service,cursor:service.id})));
  const service=services.find(s=>s.id===id);assert.ok(service);
  if(parts.length===4)return Response.json(service);
  if(parts[4]==='suspend'){
   assert.equal(method,'POST');service.suspended='suspended';return new Response(null,{status:202});
  }
  if(parts[4]==='deploys')return Response.json(url.searchParams.has('cursor')?[]:[{deploy:{id:'dep-'+id!.slice(4),status:'live',image:{ref:service.imagePath,sha:digest}},cursor:'live'}]);
  if(parts[4]==='jobs'&&parts[6]==='cancel'){
   assert.equal(method,'POST');const job=jobs.get(id!)!.find(j=>j.id===parts[5]);assert.ok(job);
   job.status='canceled';return Response.json(job);
  }
  if(parts[4]==='jobs')return Response.json(url.searchParams.has('cursor')?[]:jobs.get(id!)!.map(job=>({job,cursor:job.id})));
  throw new Error('unexpected request');
 };
 return{services,calls,jobs,transport,setFault:(value:typeof fault)=>{fault=value;}};
}

test('Render suspension checks every service and independently cancels surviving one-off jobs',async()=>{
 const f=fixture(),config=structuredClone(configuration);
 const control=new RenderMaintenanceControl(config,'synthetic-token',f.transport);config.services[0]!.id='changed';
 await assert.rejects(control.observeSuspended());assert.equal(f.calls.some(c=>c.method==='POST'),false);
 const result=await control.suspend();assert.equal(result.scope,'RENDER_CONFIGURED_ENVIRONMENT_OBSERVATION');
 assert.equal(result.suspendedServices,4);assert.equal(result.activeJobs,0);
 for(const flag of ['wholeBackendQuiesced','databaseWritersFenced','sourceHostFenced','reopeningAuthorised','actionAuthorized'])assert.equal(result[flag as keyof typeof result],false);
 assert.equal(f.calls.filter(c=>c.path.endsWith('/suspend')).length,4);
 assert.equal(f.calls.filter(c=>c.path.endsWith('/cancel')).length,1);
 assert.ok(f.calls.find(c=>c.path.startsWith('/v1/services?'))?.path.includes('includePreviews=true'));
 const mutations=f.calls.filter(c=>c.method==='POST').length;
 await control.observeSuspended();await control.suspend();assert.equal(f.calls.filter(c=>c.method==='POST').length,mutations);
});

test('operator inspection follows current live image pins and reports jobs without any provider mutation',async()=>{
 const f=fixture(),control=new RenderMaintenanceControl(configuration,'synthetic-token',f.transport);
 const raw={format:1,registry:configuration,token:'synthetic-token',expectedConfigurationDigest:control.configurationDigest()};
 const report=await inspectManagedRender(raw,f.transport);
 assert.equal(report.liveImagePinsMatched,4);assert.equal(report.activeJobs,1);assert.equal(report.suspendedServices,0);
 assert.ok(f.calls.every(c=>c.method==='GET'));assert.ok(f.services.every(s=>s.suspended==='not_suspended'));
 assert.equal(report.completeEnvironmentVerified,false);assert.equal(report.executionAuthorized,false);
 assert.equal(JSON.stringify(report).includes('synthetic-token'),false);assert.equal(JSON.stringify(report).includes('ghcr.io'),false);
 const before=f.calls.length;
 for(const change of [{expectedConfigurationDigest:'0'.repeat(64)},{token:'PRIVATE\n'},{endpoint:'https://untrusted.invalid'}]){
  await assert.rejects(inspectManagedRender({...raw,...change},f.transport),error=>error instanceof Error&&!error.message.includes('PRIVATE'));
 }
 assert.equal(f.calls.length,before);
});

test('Render inspection CLI refuses malformed or oversized confidential input with fixed output',()=>{
 for(const body of ['{"token":"PRIVATE"',Buffer.alloc(16385,65),Buffer.from([0xff])]){
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../jobs/inspect-managed-render.js',import.meta.url)),'--stdin'],{input:body,encoding:'utf8',timeout:5000});
  assert.equal(result.status,1);assert.equal(result.stdout,'');assert.equal(result.stderr,'Managed Render inspection refused; no provider action authorised\n');
 }
});

test('short service pages require an empty continuation and cannot hide a fifth service',async()=>{
 for(const extra of [false,true]){
  const f=fixture();let emptyPages=0;
  f.setFault(url=>{
   if(url.pathname!=='/v1/services')return;
   const cursor=url.searchParams.get('cursor');
   if(cursor==='last'){emptyPages++;return Response.json([]);}
   const selected=cursor?f.services.slice(2):f.services.slice(0,2);
   if(cursor&&extra)selected.push({...f.services[0]!,id:'srv-'+'x'.repeat(20)});
   return Response.json(selected.map((service,i)=>({service,cursor:cursor&&i===selected.length-1?'last':service.id})));
  });
  const control=new RenderMaintenanceControl(configuration,'synthetic-token',f.transport);
  if(extra){await assert.rejects(control.suspend());assert.equal(f.calls.some(v=>v.method==='POST'),false);}
  else{assert.equal((await control.suspend()).suspendedServices,4);assert.equal(emptyPages,3);}
 }
});

test('a short deploy page cannot hide a later active release before suspension',async()=>{
 const f=fixture();let pages=0;
 f.setFault(url=>{
  if(url.pathname!==`/v1/services/${ids[0]}/deploys`)return;
  pages++;
  return Response.json(url.searchParams.has('cursor')?[{deploy:{id:'dep-hidden',status:'queued'},cursor:'second'}]:
   [{deploy:{id:'dep-terminal',status:'deactivated'},cursor:'first'}]);
 });
 await assert.rejects(new RenderMaintenanceControl(configuration,'synthetic-token',f.transport).suspend());
 assert.equal(pages,2);assert.equal(f.calls.some(v=>v.method==='POST'),false);
});

test('later short-page jobs are accounted for and cancelled after the service is suspended',async()=>{
 const f=fixture();
 f.setFault(url=>{
  if(url.pathname!==`/v1/services/${ids[3]}/jobs`)return;
  const cursor=url.searchParams.get('cursor');if(cursor==='last')return Response.json([]);
  if(!cursor)return Response.json([{job:{id:'job-'+'e'.repeat(20),serviceId:ids[3],status:'succeeded'},cursor:'history'}]);
  return Response.json(f.jobs.get(ids[3]!)!.filter(v=>v.status==='running').map(job=>({job,cursor:'last'})));
 });
 assert.equal((await new RenderMaintenanceControl(configuration,'synthetic-token',f.transport).suspend()).activeJobs,0);
 assert.equal(f.calls.filter(v=>v.path.endsWith('/cancel')).length,1);
});

test('configured image alone is insufficient: live deploy must have one matching immutable ref and resolved SHA',async()=>{
 for(const mode of ['missing','duplicate','tag','sha','unknown-sha'] as const){
  const f=fixture();f.setFault(url=>{
   if(url.pathname!==`/v1/services/${ids[0]}/deploys`)return;
   if(url.searchParams.has('cursor'))return Response.json([]);
   const image={ref:f.services[0]!.imagePath,sha:digest};
   if(mode==='tag')image.ref=image.ref.split('@')[0]+':latest';
   if(mode==='sha')image.sha='sha256:'+'2'.repeat(64);
   if(mode==='unknown-sha')image.sha='unknown';
   const row={deploy:{id:'dep-live',status:'live',image},cursor:'last'};
   return Response.json(mode==='missing'?[]:mode==='duplicate'?[row,{...row,deploy:{...row.deploy,id:'dep-other'}}]:[row]);
  });
  await assert.rejects(new RenderMaintenanceControl(configuration,'synthetic-token',f.transport).suspend());
  assert.equal(f.calls.some(v=>v.method==='POST'),false,mode);
 }
});

test('Render preflight rejects extra previews, wrong ownership, mutable images, auto-deploy and active deploys before mutation',async()=>{
 for(const change of ['extra','owner','environment','type','region','image','auto','deploy','singleton'] as const){
  const f=fixture();
  if(change==='extra')f.services.push({...f.services[0]!,id:'srv-'+ 'z'.repeat(20)});
  if(change==='owner')f.services[0]!.ownerId='tea-other';
  if(change==='environment')f.services[0]!.environmentId='env-other';
  if(change==='type')f.services[0]!.type='cron_job';
  if(change==='region')f.services[0]!.serviceDetails.region='oregon';
  if(change==='image')f.services[0]!.imagePath='ghcr.io/synthetic/web:latest';
  if(change==='auto')f.services[0]!.autoDeployTrigger='commit';
  if(change==='singleton')f.services[3]!.serviceDetails.numInstances=2;
  if(change==='deploy')f.setFault(url=>url.pathname.endsWith('/deploys')?Response.json([{deploy:{id:'dep-active',status:'queued'},cursor:'next'}]):undefined);
  await assert.rejects(new RenderMaintenanceControl(configuration,'synthetic-token',f.transport).suspend(),/unresolved/);
  assert.equal(f.calls.some(c=>c.method==='POST'),false,change);
 }
});

test('Render lost suspension acknowledgement stops without retry or resuming any service',async()=>{
 const f=fixture();f.setFault((url,method)=>{
  if(method==='POST'&&url.pathname.endsWith('/suspend')){f.services[0]!.suspended='suspended';throw new Error('PRIVATE-token-body');}
  return undefined;
 });
 const control=new RenderMaintenanceControl(configuration,'synthetic-token',f.transport);
 await assert.rejects(control.suspend(),error=>error instanceof Error&&!error.message.includes('PRIVATE')&&error.cause===undefined);
 assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
 assert.equal(f.services[0]!.suspended,'suspended');assert.equal(f.services[1]!.suspended,'not_suspended');
});

test('Render accepts no acknowledgement as terminal job proof, and unknown cancellation is never retried',async()=>{
 for(const mode of ['running','lost','new-job','foreign-job'] as const){
  const f=fixture();
  f.setFault((url,method)=>{
   if(mode==='foreign-job'&&url.pathname.endsWith('/jobs'))return Response.json([{job:{id:jobId,serviceId:'srv-'+ 'x'.repeat(20),status:'running'},cursor:'c'}]);
   if(method==='POST'&&url.pathname.endsWith('/cancel')){
    if(mode==='lost')throw new Error('lost cancel');
    if(mode==='new-job'){f.jobs.get(ids[3]!)!.push({id:'job-'+ 'e'.repeat(20),serviceId:ids[3]!,status:'pending'});f.jobs.get(ids[3]!)![0]!.status='canceled';}
    return Response.json({id:jobId,serviceId:ids[3],status:'canceled'});
   }
  });
  await assert.rejects(new RenderMaintenanceControl(configuration,'synthetic-token',f.transport).suspend());
  assert.ok(f.calls.filter(c=>c.path.endsWith('/cancel')).length<=1,mode);
 }
});

test('Render bounded pagination refuses repeated cursors, duplicates and truncated/malformed inventories',async()=>{
 for(const mode of ['cursor','duplicate','malformed','large','http','redirect'] as const){
  const f=fixture();f.setFault(url=>{
   if(url.pathname!=='/v1/services')return;
   if(mode==='malformed')return Response.json({services:f.services});
   if(mode==='large')return new Response(' '.repeat(1024*1024+1));
   if(mode==='http')return new Response('PRIVATE provider credentials',{status:429});
   if(mode==='redirect')return new Response(null,{status:302,headers:{Location:'https://other.invalid'}});
   if(mode==='duplicate')return Response.json([{service:f.services[0],cursor:'one'},{service:f.services[0],cursor:'two'}]);
   return Response.json(Array.from({length:100},()=>({service:f.services[0],cursor:'repeated'})));
  });
  await assert.rejects(new RenderMaintenanceControl(configuration,'synthetic-token',f.transport).suspend());
  assert.equal(f.calls.some(c=>c.method==='POST'),false);
 }
});

test('Render configuration rejects unsafe paths and incomplete component sets before any request',()=>{
 const f=fixture();
 for(const config of [{...configuration,services:configuration.services.slice(0,2)},
  {...configuration,services:[configuration.services[0],configuration.services[0],configuration.services[2],configuration.services[3]]},
  {...configuration,ownerId:'tea-x?other=1'},
  {...configuration,services:configuration.services.map(s=>({...s,imagePath:'image:latest'}))}]){
  assert.throws(()=>new RenderMaintenanceControl(config,'synthetic-token',f.transport));
 }
 assert.throws(()=>new RenderMaintenanceControl(configuration,'bad\r\ntoken',f.transport));assert.equal(f.calls.length,0);
});

test('Render 202 is not suspension proof and commands are not retried on provider refusal',async()=>{
 for(const status of [202,400,401,403,404,429,500,503]){
  const f=fixture();f.setFault((url,method)=>method==='POST'&&url.pathname.endsWith('/suspend')?new Response(null,{status}):undefined);
  await assert.rejects(new RenderMaintenanceControl(configuration,'synthetic-token',f.transport).suspend());
  assert.equal(f.calls.filter(c=>c.path.endsWith('/suspend')).length,1);
  assert.equal(f.calls.some(c=>c.path.endsWith('/cancel')),false);
 }
});

test('Render paginated deploy inventory follows the cursor and catches a later active deploy',async()=>{
 for(const cycle of [false,true]){
  const f=fixture();let pages=0;
  f.setFault(url=>{
   if(url.pathname!==`/v1/services/${ids[0]}/deploys`)return;
   pages++;
   if(pages===1||cycle)return Response.json(Array.from({length:100},(_,i)=>({deploy:{id:`dep-p${pages}-${i}`,status:'deactivated'},cursor:'same-cursor'})));
   assert.equal(url.searchParams.get('cursor'),'same-cursor');
   return Response.json([{deploy:{id:'dep-hidden-active',status:'pre_deploy_in_progress'},cursor:'last'}]);
  });
  await assert.rejects(new RenderMaintenanceControl(configuration,'synthetic-token',f.transport).suspend());
  assert.equal(pages,2);assert.equal(f.calls.some(c=>c.method==='POST'),false);
 }
});

test('Render final readback refuses a service or image changed while cancellation was in flight',async()=>{
 for(const change of ['resume','image','extra'] as const){
  const f=fixture();f.setFault((url,method)=>{
   if(method==='POST'&&url.pathname.endsWith('/cancel')){
    f.jobs.get(ids[3]!)![0]!.status='canceled';
    if(change==='resume')f.services[0]!.suspended='not_suspended';
    if(change==='image')f.services[0]!.imagePath='ghcr.io/synthetic/web@sha256:'+ '2'.repeat(64);
    if(change==='extra')f.services.push({...f.services[0]!,id:'srv-'+ 'z'.repeat(20)});
    return Response.json({id:jobId,serviceId:ids[3],status:'canceled'});
   }
   return undefined;
  });
  await assert.rejects(new RenderMaintenanceControl(configuration,'synthetic-token',f.transport).suspend());
  assert.equal(f.calls.filter(c=>c.path.endsWith('/cancel')).length,1);
 }
});

test('Render request deadline aborts transport and preserves a sanitised unresolved outcome',{timeout:8000},async()=>{
 const transport:typeof fetch=async(_url,options)=>new Promise((_resolve,reject)=>{
  options!.signal!.addEventListener('abort',()=>reject(new Error('PRIVATE credential timeout')),{once:true});
 });
 const keepAlive=setTimeout(()=>{},7000);
 try{await assert.rejects(new RenderMaintenanceControl(configuration,'synthetic-token',transport).observeSuspended(),error=>
  error instanceof Error&&error.message.includes('unresolved')&&!error.message.includes('PRIVATE')&&error.cause===undefined);
 }finally{clearTimeout(keepAlive);}
});

test('Render complete paginated terminal history permits suspension without canceling historical work',async()=>{
 const f=fixture();let continuationPages=0;
 f.setFault(url=>{
  if(url.pathname!==`/v1/services/${ids[0]}/deploys`)return;
  if(url.searchParams.has('cursor')){
   continuationPages++;
   if(url.searchParams.get('cursor')==='cursor-99')return Response.json([{deploy:{id:'dep-live',status:'live',image:{ref:f.services[0]!.imagePath,sha:digest}},cursor:'live'}]);
   assert.equal(url.searchParams.get('cursor'),'live');return Response.json([]);
  }
  return Response.json(Array.from({length:100},(_,i)=>({deploy:{id:`dep-terminal-${i}`,status:'deactivated'},cursor:`cursor-${i}`})));
 });
 const result=await new RenderMaintenanceControl(configuration,'synthetic-token',f.transport).suspend();
 assert.equal(result.activeJobs,0);assert.equal(continuationPages,6);
 assert.equal(f.calls.filter(c=>c.path.endsWith('/cancel')).length,1);
});

test('Render unknown job state and scheduler autoscaling refuse before any mutation',async()=>{
 for(const mode of ['unknown','autoscaling'] as const){
  const f=fixture();
  if(mode==='autoscaling')Object.assign(f.services[3]!.serviceDetails,{autoscaling:{enabled:false}});
  else f.jobs.get(ids[3]!)![0]!.status='future-unknown';
  // Return the unknown state even if the service incorrectly ignores filters.
  if(mode==='unknown')f.setFault(url=>url.pathname===`/v1/services/${ids[3]}/jobs`?
   Response.json(f.jobs.get(ids[3]!)!.map(job=>({job,cursor:job.id}))):undefined);
  await assert.rejects(new RenderMaintenanceControl(configuration,'synthetic-token',f.transport).suspend());
  assert.equal(f.calls.some(c=>c.method==='POST'),false);
 }
});

test('four-component shutdown confirms gateway before internal services, regardless of inventory order',async()=>{
 const f=fixture();f.services.reverse();
 for(const [index,id] of ids.entries()){
  f.jobs.set(id,[{id:'job-'+String.fromCharCode(101+index).repeat(20),serviceId:id!,status:'running'}]);
 }
 const result=await new RenderMaintenanceControl(configuration,'synthetic-token',f.transport).suspend();
 assert.equal(result.suspendedServices,4);
 const commands=f.calls.filter(c=>c.method==='POST');
 assert.deepEqual(commands.slice(0,4).map(c=>c.path),[ids[0],ids[3],ids[1],ids[2]].map(id=>`/v1/services/${id}/suspend`));
 const gatewayRead=f.calls.findIndex(c=>c.method==='GET'&&c.path===`/v1/services/${ids[0]}`);
 assert.ok(gatewayRead>f.calls.findIndex(c=>c.path.endsWith('/suspend')));
 assert.ok(gatewayRead<f.calls.findIndex(c=>c.path===`/v1/services/${ids[3]}/suspend`));
 assert.equal(commands.filter(c=>c.path.endsWith('/cancel')).length,4);
});

test('gateway readback mismatch stops before any internal shutdown or job cancellation',async()=>{
 for(const mode of ['pending','owner','image','type','http'] as const){
  const f=fixture();f.setFault((url,method)=>{
   if(method!=='GET'||url.pathname!==`/v1/services/${ids[0]}`)return;
   if(mode==='http')return new Response(null,{status:503});
   const gateway=structuredClone(f.services[0]!);
   if(mode==='pending')gateway.suspended='not_suspended';
   if(mode==='owner')gateway.ownerId='tea-other';
   if(mode==='image')gateway.imagePath='ghcr.io/synthetic/gateway@sha256:'+ '2'.repeat(64);
   if(mode==='type')gateway.type='private_service';
   return Response.json(gateway);
  });
  await assert.rejects(new RenderMaintenanceControl(configuration,'synthetic-token',f.transport).suspend());
  assert.deepEqual(f.calls.filter(c=>c.method==='POST').map(c=>c.path),[`/v1/services/${ids[0]}/suspend`]);
 }
});

test('legacy three-service or publicly exposed web topology is refused',async()=>{
 const f=fixture();assert.throws(()=>new RenderMaintenanceControl({...configuration,services:configuration.services.slice(1)},'synthetic-token',f.transport));
 f.services[1]!.type='web_service';
 await assert.rejects(new RenderMaintenanceControl(configuration,'synthetic-token',f.transport).suspend());
 assert.equal(f.calls.some(c=>c.method==='POST'),false);
});
