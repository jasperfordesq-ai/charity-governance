import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {gatewayTlsFixture} from './managed-gateway-tls-fixture.mjs';
import {compileManagedProviderPlan} from './managed-provider-plan.mjs';
import {inspectManagedProvider} from './inspect-managed-provider.mjs';
import {RenderMaintenanceControl} from '../apps/api/dist/services/render-maintenance-control.js';

const hash=raw=>createHash('sha256').update(raw).digest('hex');
function fixture(tls){
 const roles=['gateway','web','api','scheduler'],mesh=tls.binding.record;
 const configuration={format:1,purpose:'SYNTHETIC_MANAGED_REVIEW',mesh,names:{gateway:'charitypilot-review-gateway',scheduler:'charitypilot-review-scheduler'},
  images:Object.fromEntries(['gateway','web','api'].map((role,i)=>[role,{url:'ghcr.io/jasperfordesq-ai/charitypilot-'+role+'@sha256:'+String(i+7).repeat(64),sourceSha:mesh.sourceSha,bindingSha256:tls.binding.sha256,platform:'linux/amd64'}])),
  recoveryKeys:Object.fromEntries(['storageKeyArn','dataKeyArn','indexMacKeyArn','rootMacKeyArn'].map((key,i)=>[key,'arn:aws:kms:eu-west-1:111122223333:key/'+String(i+1).repeat(8)+'-1111-1111-1111-111111111111']))};
 const plan=compileManagedProviderPlan(configuration),definitions=plan.blueprint.projects[0].environments[0].services;
 const input={format:1,configuration,expectedConfigurationSha256:plan.configurationSha256,token:'synthetic-render-private-token',projectId:'prj-synthetic',blueprintId:'exs-'+'e'.repeat(20),secrets:{api:{},scheduler:{}},secretFileSha256:{}};
 const environments={},files={},services=definitions.map((definition,i)=>({id:mesh[roles[i]+'ServiceId'],name:definition.name,ownerId:mesh.ownerId,environmentId:mesh.environmentId,
  type:['web_service','private_service','private_service','background_worker'][i],imagePath:definition.image.url,autoDeploy:'no',autoDeployTrigger:'off',suspended:'not_suspended',
  serviceDetails:{region:'frankfurt',runtime:'image',numInstances:1,plan:'1c-2g',maxShutdownDelaySeconds:60,previews:{generation:'off'},
   envSpecificDetails:{dockerCommand:definition.dockerCommand??'',dockerContext:'.',dockerfilePath:'',preDeployCommand:''}}}));
 for(const[i,role]of roles.entries()){
  environments[role]=definitions[i].envVars.map(v=>{
   if(v.sync===false){const value='synthetic-private-'+v.key+'-0123456789';input.secrets[role][v.key]=value;return{key:v.key,value};}return{key:v.key,value:v.value};});
  files[role]=[];
  if(role!=='scheduler'){
   const bundle={format:1,service:role,meshSha256:tls.binding.sha256,issuerCertPem:tls.issuer};
   if(role!=='gateway')Object.assign(bundle,{serverCertPem:tls[role].cert,serverKeyPem:tls[role].key});
   if(role!=='api'){const leaf=role==='gateway'?tls.gateway:tls.webClient;Object.assign(bundle,{clientCertPem:leaf.cert,clientKeyPem:leaf.key});}
   files[role].push({name:'charitypilot-'+role+'-tls.json',content:JSON.stringify(bundle)+'\n'});
  }
  if(['api','scheduler'].includes(role))files[role].push({name:'database-ca.pem',content:tls.issuer});
  input.secretFileSha256[role]=Object.fromEntries(files[role].map(v=>[v.name,hash(v.content)]));
 }
 const environment={id:mesh.environmentId,name:'synthetic-review',projectId:input.projectId,serviceIds:services.map(v=>v.id),envGroupIds:[],databasesIds:[],redisIds:[],networkIsolationEnabled:true};
 const project={id:input.projectId,name:'CharityPilot synthetic managed review',owner:{id:mesh.ownerId},environmentIds:[mesh.environmentId]};
 const blueprint={id:input.blueprintId,name:'Synthetic review',status:'in_sync',autoSync:false,repo:'https://github.com/jasperfordesq-ai/charity-governance',branch:'master',path:'private-managed-review.yaml',resources:services.map(v=>({id:v.id,name:v.name,type:v.type}))};
 const groups=[],blueprints=[blueprint],syncs=[],jobs=[],calls=[];let fault;
 function page(values,url,key){const offset=Number(url.searchParams.get('cursor')??0),chunk=values.slice(offset,offset+10);return chunk.map((value,i)=>key?{[key]:value,cursor:String(offset+i+1)}:{...value,cursor:String(offset+i+1)});}
 const transport=async(url,options)=>{
  url=new URL(url);assert.equal(url.origin,'https://api.render.com');assert.equal(options.method,'GET');assert.equal(options.redirect,'error');
  assert.equal(new Headers(options.headers).get('Authorization'),'Bearer synthetic-render-private-token');calls.push(url.pathname+url.search);
  const override=await fault?.(url,options);if(override)return override;
  const parts=url.pathname.split('/'),index=services.findIndex(v=>v.id===parts[3]),role=roles[index];
  if(url.pathname==='/v1/services')return Response.json(page(services,url,'service'));
  if(url.pathname==='/v1/environments/'+mesh.environmentId)return Response.json(environment);
  if(url.pathname==='/v1/projects/'+input.projectId)return Response.json(project);
  if(url.pathname==='/v1/env-groups')return Response.json(page(groups,url,null));
  if(url.pathname==='/v1/blueprints')return Response.json(page(blueprints.map(({resources,...v})=>v),url,'blueprint'));
  if(parts[2]==='blueprints'&&parts[4]==='syncs')return Response.json(page(syncs,url,'sync'));
  if(parts[2]==='blueprints')return Response.json(blueprints.find(v=>v.id===parts[3]));
  assert.ok(role);
  if(parts.length===4)return Response.json(services[index]);
  if(parts[4]==='deploys')return Response.json(page([{id:'dep-'+parts[3].slice(4),status:'live',image:{ref:services[index].imagePath,sha:services[index].imagePath.split('@')[1]}}],url,'deploy'));
  if(parts[4]==='jobs')return Response.json(page(jobs.filter(v=>v.serviceId===parts[3]),url,'job'));
  if(parts[4]==='env-vars')return Response.json(page(environments[role],url,'envVar'));
  if(parts[4]==='secret-files')return Response.json(page(files[role],url,'secretFile'));
  throw new Error('PRIVATE unexpected path');
 };
 return{input,plan,services,environments,files,environment,project,groups,blueprints,syncs,jobs,calls,transport,setFault:v=>{fault=v;}};
}

test('provider configuration readback uses real pinned TLS material, exact secrets and GET-only paginated rechecks',async t=>{
 const tls=gatewayTlsFixture();t.after(tls.cleanup);
 await t.test('positive observations omit credentials/private material and retain all unproved authority boundaries',async()=>{
  const f=fixture(tls),result=await inspectManagedProvider(f.input,{transport:f.transport});
  assert.equal(result.declaredEnvironmentsMatched,4);assert.equal(result.configuredSecretFilesMatched,5);
  assert.equal(result.linkedGroupsAbsentObserved,true);assert.equal(result.blueprintAutoSyncOffObserved,true);
  for(const flag of ['runtimeEnvironmentVerified','runtimeSecretDeliveryVerified','providerVisibilityCompletenessVerified','controlPlaneExclusionVerified','wholeBackendQuiesced','releaseReady','actionAuthorized'])assert.equal(result[flag],false);
  assert.equal(/synthetic-private|PRIVATE KEY|synthetic-render-private-token|BEGIN CERTIFICATE/.test(JSON.stringify(result)),false);
  assert.ok(f.calls.filter(v=>v.includes('/env-vars?')&&v.includes('cursor=')).length>=8);
 });
 await t.test('unrelated group metadata is fully followed, with no inherited group accepted',async()=>{
  const f=fixture(tls);f.groups.push({id:'evg-unrelated',ownerId:f.input.configuration.mesh.ownerId,serviceLinks:[{id:'srv-'+'z'.repeat(20),type:'web'}]});
  assert.equal((await inspectManagedProvider(f.input,{transport:f.transport})).linkedGroupsAbsentObserved,true);
 });
 await t.test('collection/property ordering is not drift and pagination cursors are not configuration',async()=>{
  const f=fixture(tls);let reads=0,groupReads=0;
  f.setFault(url=>{
   if(url.pathname==='/v1/environments/'+f.environment.id){reads++;return Response.json({...f.environment,serviceIds:reads%2?[...f.environment.serviceIds].reverse():f.environment.serviceIds});}
   if(url.pathname==='/v1/env-groups')return Response.json(url.searchParams.has('cursor')?[]:[{id:'evg-unrelated',ownerId:f.input.configuration.mesh.ownerId,serviceLinks:[],cursor:'opaque-'+(++groupReads)}]);
  });
  assert.equal((await inspectManagedProvider(f.input,{transport:f.transport})).configurationSamples,2);
 });
 await t.test('wrong caller digest refuses before HTTP and input is snapshotted across asynchronous reads',async()=>{
  const bad=fixture(tls);await assert.rejects(inspectManagedProvider({...bad.input,expectedConfigurationSha256:'0'.repeat(64)},{transport:bad.transport}));assert.equal(bad.calls.length,0);
  const f=fixture(tls);let changed=false;f.setFault(()=>{if(!changed){changed=true;f.input.secrets.api.JWT_SECRET='later-private';}});
  assert.equal((await inspectManagedProvider(f.input,{transport:f.transport})).declaredEnvironmentsMatched,4);
 });
 await t.test('an older compiled API without a state fingerprint cannot pass the two-sample comparison',async()=>{
  const previous=RenderMaintenanceControl.prototype.observeConfiguration;
  RenderMaintenanceControl.prototype.observeConfiguration=async function(){return {...await previous.call(this),configurationStateSha256:undefined};};
  try{const f=fixture(tls);await assert.rejects(inspectManagedProvider(f.input,{transport:f.transport}));}
  finally{RenderMaintenanceControl.prototype.observeConfiguration=previous;}
 });
 for(const mode of ['env-extra','secret','missing-secret','file','file-pin','cross-service-key','inherited-group','group-cursor','competing-blueprint','autosync','command','isolation','owner','instances','job','sync','extra-environment','http','body-large']){
  await t.test(mode+' refuses without a successful report or secret-bearing error',async()=>{
   const f=fixture(tls);
   if(mode==='env-extra')f.environments.web.push({key:'NODE_OPTIONS',value:'--import=PRIVATE'});
   if(mode==='secret')f.environments.api.find(v=>v.key==='JWT_SECRET').value='PRIVATE different secret';
   if(mode==='missing-secret')f.environments.api=f.environments.api.filter(v=>v.key!=='JWT_SECRET');
   if(mode==='file')f.files.web.push({name:'unreviewed.key',content:'PRIVATE'});
   if(mode==='file-pin')f.input.secretFileSha256.web['charitypilot-web-tls.json']='0'.repeat(64);
   if(mode==='cross-service-key'){const file=f.files.web[0],bundle=JSON.parse(file.content);bundle.clientKeyPem=tls.gateway.key;file.content=JSON.stringify(bundle)+'\n';f.input.secretFileSha256.web[file.name]=hash(file.content);}
   if(mode==='inherited-group')f.groups.push({id:'evg-other-environment',ownerId:f.input.configuration.mesh.ownerId,serviceLinks:[{id:f.services[1].id,type:'pserv'}]});
   if(mode==='group-cursor')f.setFault(url=>url.pathname==='/v1/env-groups'?Response.json([{id:'evg-unreviewed',ownerId:f.input.configuration.mesh.ownerId,serviceLinks:[]}]):undefined);
   if(mode==='competing-blueprint')f.blueprints.push({...f.blueprints[0],id:'exs-'+'f'.repeat(20)});
   if(mode==='autosync')f.blueprints[0].autoSync=true;
   if(mode==='command')f.services[0].serviceDetails.envSpecificDetails.dockerCommand='caddy run --config /PRIVATE';
   if(mode==='isolation')f.environment.networkIsolationEnabled=false;
   if(mode==='owner')f.project.owner.id='tea-foreign';
   if(mode==='instances')f.services[1].serviceDetails.numInstances=2;
   if(mode==='job')f.jobs.push({id:'job-'+'j'.repeat(20),serviceId:f.services[2].id,status:'running'});
   if(mode==='sync')f.syncs.push({id:'exe-'+'x'.repeat(20),state:'pending'});
   if(mode==='extra-environment')f.project.environmentIds.push('env-unreviewed');
   if(mode==='http')f.setFault(()=>new Response('PRIVATE provider detail',{status:403}));
   if(mode==='body-large')f.setFault(()=>new Response('PRIVATE'.repeat(200000)));
   await assert.rejects(inspectManagedProvider(f.input,{transport:f.transport}),error=>error instanceof Error&&error.message==='Managed provider readback refused; no provider action authorised'&&error.cause===undefined&&/^[A-Z_]+$/.test(error.stage));
  });
 }
 await t.test('late changes and uncooperative transport timeout cannot produce an observation',async()=>{
  const f=fixture(tls);let reads=0;f.setFault(url=>{if(url.pathname==='/v1/projects/'+f.input.projectId&&++reads===2)f.environments.api.find(v=>v.key==='JWT_SECRET').value='PRIVATE changed';});
  await assert.rejects(inspectManagedProvider(f.input,{transport:f.transport}));
  const keepAlive=setTimeout(()=>{},1000);
  try{
   await assert.rejects(inspectManagedProvider(fixture(tls).input,{transport:async()=>new Promise(()=>{}),requestTimeoutMs:10}));
   let deliver,cancelled=false;
   const late=inspectManagedProvider(fixture(tls).input,{transport:()=>new Promise(resolve=>{deliver=resolve;}),requestTimeoutMs:10});
   await assert.rejects(late);deliver(new Response(new ReadableStream({cancel(){cancelled=true;}})));
   await new Promise(resolve=>setImmediate(resolve));assert.equal(cancelled,true);
   cancelled=false;
   await assert.rejects(inspectManagedProvider(fixture(tls).input,{transport:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}})),requestTimeoutMs:10}));
   assert.equal(cancelled,true);
  }finally{clearTimeout(keepAlive);}
 });
});

test('readback CLI refuses malformed confidential input and has no apply or endpoint argument',()=>{
 for(const [input,args] of [['{"token":"PRIVATE"',['--stdin']],['{}',['--apply']],['{}',['--stdin','--endpoint=https://PRIVATE.invalid']]]){
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./inspect-managed-provider.mjs',import.meta.url)),...args],{input,encoding:'utf8',timeout:5000});
  assert.equal(result.status,1);assert.equal(result.stdout,'');assert.equal(result.stderr,'Managed provider readback refused; no provider action authorised\n');
 }
});
