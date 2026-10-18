import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {compileManagedProviderPlan} from './managed-provider-plan.mjs';
import {createManagedServiceMeshBinding} from '../packages/shared/runtime/managed-service-mesh.mjs';
import {createManagedApiBuildPin} from '../packages/shared/runtime/managed-api-build-pin.mjs';
import {createManagedWebBuildPin} from '../packages/shared/runtime/managed-web-build-pin.mjs';
import {resolveManagedWebContext} from '../apps/web/managed-tls.mjs';
import {gatewayRuntimeBinding} from '../caddy/managed/config.mjs';

export function providerPlanFixture(){
 const mesh={format:2,provider:'render',region:'frankfurt',installationId:'synthetic',ownerId:'tea-synthetic',environmentId:'env-synthetic',
  sourceSha:'1'.repeat(40),publicOrigin:'https://managed.charitypilot.test',gatewayServiceId:'srv-'+'a'.repeat(20),webServiceId:'srv-'+'b'.repeat(20),
  apiServiceId:'srv-'+'c'.repeat(20),schedulerServiceId:'srv-'+'d'.repeat(20),apiServiceName:'charitypilot-review-api',apiOrigin:'https://charitypilot-review-api-ab12:3002',
  webServiceName:'charitypilot-review-web',webOrigin:'https://charitypilot-review-web-cd34:3003',issuerCertSha256:'2'.repeat(64),apiCertSha256:'3'.repeat(64),
  webCertSha256:'4'.repeat(64),gatewayClientCertSha256:'5'.repeat(64),webClientCertSha256:'6'.repeat(64)};
 const binding=createManagedServiceMeshBinding(mesh);
 return {format:1,purpose:'SYNTHETIC_MANAGED_REVIEW',mesh,names:{gateway:'charitypilot-review-gateway',scheduler:'charitypilot-review-scheduler'},
  images:Object.fromEntries(['gateway','web','api'].map((role,i)=>[role,{url:'ghcr.io/jasperfordesq-ai/charitypilot-'+role+'@sha256:'+String(i+7).repeat(64),
   sourceSha:mesh.sourceSha,bindingSha256:binding.sha256,platform:'linux/amd64'}])),
  recoveryKeys:Object.fromEntries(['storageKeyArn','dataKeyArn','indexMacKeyArn','rootMacKeyArn'].map((key,i)=>[key,'arn:aws:kms:eu-west-1:111122223333:key/'+String(i+1).repeat(8)+'-1111-1111-1111-111111111111']))};
}
test('compiled blueprint keeps default loaders, private topology and singleton worker; metadata grants no authority',()=>{
 const raw=providerPlanFixture(),plan=compileManagedProviderPlan(raw),services=plan.blueprint.projects[0].environments[0].services;
 assert.deepEqual(services.map(v=>v.type),['web','pserv','pserv','worker']);
 assert.ok(services.every(v=>v.region==='frankfurt'&&v.numInstances===1&&v.autoDeployTrigger==='off'&&!v.preDeployCommand));
 assert.ok(services.slice(0,3).every(v=>!Object.hasOwn(v,'dockerCommand')));
 assert.equal(services[3].dockerCommand,'node dist/jobs/production-scheduler.js');
 assert.equal(services[3].image.url,services[2].image.url);
 for(const [role,path] of [['gateway','../caddy/managed/Dockerfile'],['web','../apps/web/Dockerfile'],['api','../apps/api/Dockerfile']]){
  const body=readFileSync(new URL(path,import.meta.url),'utf8');assert.match(body,/USER node/);
  assert.ok(plan.build.find(v=>v.role===role).args.CHARITYPILOT_BUILD_COMMIT===raw.mesh.sourceSha);
 }
 assert.equal(plan.maintenanceRegistry.services.length,4);assert.equal(plan.secretFiles.length,3);assert.equal(plan.databaseCaFiles.length,2);
 assert.equal(new Set(Object.values(plan.recoveryKeys)).size,4);
 for(const flag of ['providerInventoryVerified','imageProvenanceVerified','secretDeliveryVerified','applyAuthorized','releaseReady','actionAuthorized'])assert.equal(plan[flag],false);
 assert.equal(JSON.stringify(plan).includes('generateValue'),false);
});
test('generated web/gateway environments pass actual runtime binding parsers and build-pin helpers',()=>{
 const raw=providerPlanFixture(),plan=compileManagedProviderPlan(raw),services=plan.blueprint.projects[0].environments[0].services;
 const environment=index=>Object.fromEntries(services[index].envVars.filter(v=>Object.hasOwn(v,'value')).map(v=>[v.key,v.value]));
 const webEnv={...environment(1),...plan.providerManagedIdentity[1]},webPin=createManagedWebBuildPin(plan.build[1].args);
 assert.deepEqual(resolveManagedWebContext(webEnv,webPin),raw.mesh);
 const pin={sourceSha:raw.mesh.sourceSha,bindingSha256:plan.meshSha256};
 assert.equal(gatewayRuntimeBinding({...environment(0),...plan.providerManagedIdentity[0]},pin).sha256,plan.meshSha256);
 assert.deepEqual(createManagedApiBuildPin(plan.build[2].args),{format:1,...pin});
 for(const key of ['TENANCY','REGISTRATION','EMAIL_DELIVERY','BILLING'])assert.equal(webEnv['NEXT_PUBLIC_CHARITYPILOT_'+key],environment(2)['CHARITYPILOT_'+key]);
 for(const v of services[0].envVars)assert.notEqual(v.sync,false);
 assert.ok(services[2].envVars.some(v=>v.key==='DATABASE_URL'&&v.sync===false&&!Object.hasOwn(v,'value')));
});
test('input property ordering does not change the compiled configuration digest',()=>{
 const reverse=value=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).reverse().map(([k,v])=>[k,reverse(v)])):value;
 const raw=providerPlanFixture();assert.deepEqual(compileManagedProviderPlan(reverse(raw)),compileManagedProviderPlan(raw));
});
test('wrong image/source/mesh, old placeholders, cross-account keys and secret injection refuse',()=>{
 for(const mutate of [
  r=>{r.extra='PRIVATE';},r=>{r.names.gateway='charitypilot-gateway\ncommand';},r=>{r.images.api.sourceSha='a'.repeat(40);},
  r=>{r.images.web.bindingSha256='b'.repeat(64);},r=>{r.images.gateway.url=r.images.gateway.url.split('@')[0]+':latest';},
  r=>{r.images.gateway.url=r.images.gateway.url.split('@')[0]+'@sha256:'+'0'.repeat(64);},r=>{r.images.api.platform='linux/arm64';},
  r=>{r.images.web.url=r.images.web.url.replace('jasperfordesq-ai','untrusted');},r=>{r.mesh.apiOrigin='http://charitypilot-review-api-ab12:3002';},
  r=>{r.recoveryKeys.rootMacKeyArn=r.recoveryKeys.indexMacKeyArn;},r=>{r.recoveryKeys.dataKeyArn=r.recoveryKeys.dataKeyArn.replace('111122223333','444455556666');},
  r=>{r.images.api.password='PRIVATE';},r=>{delete r.images.web;},
 ]){const raw=providerPlanFixture();mutate(raw);assert.throws(()=>compileManagedProviderPlan(raw),error=>error instanceof Error&&error.message==='Managed provider configuration refused; no provider action authorised');}
});
test('CLI emits a bounded local review artifact and refuses secret-bearing or malformed inputs',()=>{
 const run=(body,args=['--stdin'])=>spawnSync(process.execPath,[fileURLToPath(new URL('./managed-provider-plan.mjs',import.meta.url)),...args],{input:body,encoding:'utf8',timeout:5000});
 const pass=run(JSON.stringify(providerPlanFixture()));assert.equal(pass.status,0);assert.equal(pass.stderr,'');assert.equal(JSON.parse(pass.stdout).applyAuthorized,false);
 for(const body of ['{"secret":"PRIVATE"}',Buffer.alloc(32769,65),Buffer.from([0xff])]){const fail=run(body);assert.equal(fail.status,1);assert.equal(fail.stdout,'');assert.equal(fail.stderr.includes('PRIVATE'),false);}
 assert.equal(run('{}',['--apply']).status,1);
});
