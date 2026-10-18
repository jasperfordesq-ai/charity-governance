import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createManagedServiceMeshBinding} from '../packages/shared/runtime/managed-service-mesh.mjs';

const refused=()=>new Error('Managed provider configuration refused; no provider action authorised');
const exact=(value,keys)=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('|')!==[...keys].sort().join('|'))throw refused();
};
const profile={CHARITYPILOT_DEPLOYMENT_MODE:'production',CHARITYPILOT_TENANCY:'multi',CHARITYPILOT_REGISTRATION:'closed',
 CHARITYPILOT_EMAIL_DELIVERY:'manual-link',CHARITYPILOT_BILLING:'none',CHARITYPILOT_ERROR_ALERTS:'none',CHARITYPILOT_PRIVILEGED_MFA_MODE:'required'};
const axes=['TENANCY','REGISTRATION','EMAIL_DELIVERY','BILLING'];
const secretKeys=['DATABASE_URL','JWT_SECRET','OWNER_JWT_SECRET','AUTH_RECOVERY_SECRET','INTEGRATION_ENCRYPTION_KEY','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY'];
const roles=['gateway','web','api','scheduler'];

/** Pure compiler for an existing, separately inventoried synthetic environment.
 * No network, provider token, credentials, file upload or deployment path.
 * Supplied image metadata is checked for consistency, never self-attested. */
export function compileManagedProviderPlan(raw){
 try{
  exact(raw,['format','purpose','mesh','names','images','recoveryKeys']);
  if(raw.format!==1||raw.purpose!=='SYNTHETIC_MANAGED_REVIEW')throw refused();
  const binding=createManagedServiceMeshBinding(raw.mesh),r=binding.record;
  exact(raw.names,['gateway','scheduler']);
  for(const role of ['gateway','scheduler'])if(typeof raw.names[role]!=='string'||!new RegExp(`^charitypilot(?:-[a-z0-9]+)*-${role}$`).test(raw.names[role])||raw.names[role].length>63)throw refused();
  exact(raw.images,['gateway','web','api']);
  for(const role of ['gateway','web','api']){
   const image=raw.images[role];exact(image,['url','sourceSha','bindingSha256','platform']);
   if(typeof image.url!=='string'||image.url.length>512||!/^ghcr\.io\/jasperfordesq-ai\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/.test(image.url)
    ||image.url.endsWith('sha256:'+'0'.repeat(64))||image.sourceSha!==r.sourceSha||image.bindingSha256!==binding.sha256||image.platform!=='linux/amd64')throw refused();
  }
  if(new Set(Object.values(raw.images).map(v=>v.url)).size!==3)throw refused();
  exact(raw.recoveryKeys,['storageKeyArn','dataKeyArn','indexMacKeyArn','rootMacKeyArn']);
  const keys=Object.values(raw.recoveryKeys);
  if(keys.some(v=>typeof v!=='string'||!/^arn:aws:kms:eu-west-1:[0-9]{12}:key\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v))
   ||new Set(keys).size!==4||new Set(keys.map(v=>v.split(':')[4])).size!==1)throw refused();
  const common={NODE_ENV:'production',CHARITYPILOT_BUILD_COMMIT:r.sourceSha};
  const publicWeb=Object.fromEntries(axes.map(axis=>['NEXT_PUBLIC_CHARITYPILOT_'+axis,profile['CHARITYPILOT_'+axis]]));
  const webBuild={...publicWeb,NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE:'public-production',NEXT_PUBLIC_API_URL:r.publicOrigin,
   NEXT_PUBLIC_CHARITYPILOT_CANONICAL_API_ORIGIN:r.publicOrigin,NEXT_PUBLIC_CHARITYPILOT_MANAGED_WEB_BINDING_SHA256:binding.sha256};
  const app={...common,...profile,FRONTEND_URL:r.publicOrigin,NEXT_PUBLIC_API_URL:r.publicOrigin,
   CHARITYPILOT_CANONICAL_WEB_ORIGIN:r.publicOrigin,CHARITYPILOT_CANONICAL_API_ORIGIN:r.publicOrigin,
   DOCUMENT_STORAGE_DRIVER:'supabase',SUPABASE_STORAGE_BUCKET:'charitypilot-synthetic-review'};
  const tls={CHARITYPILOT_MANAGED_PROVIDER:'render',CHARITYPILOT_MANAGED_TLS_DELIVERY:'render-secret-file-v1'};
  const environments={
   gateway:{...common,...tls,PORT:'10000',CHARITYPILOT_MANAGED_GATEWAY_BINDING:binding.json},
   web:{...common,...profile,...tls,...webBuild,HOST:'0.0.0.0',PORT:'3003',CHARITYPILOT_MANAGED_WEB_BINDING:binding.json,CHARITYPILOT_INTERNAL_API_URL:r.apiOrigin},
   api:{...app,...tls,PORT:'3002',CHARITYPILOT_MANAGED_API_PEER_BINDING:binding.json},
   scheduler:{...app},
  };
  const names={...raw.names,web:r.webServiceName,api:r.apiServiceName},types={gateway:'web',web:'pserv',api:'pserv',scheduler:'worker'};
  const imageFor=role=>raw.images[role==='scheduler'?'api':role];
  const services=roles.map(role=>({name:names[role],type:types[role],runtime:'image',region:'frankfurt',plan:'1c-2g',numInstances:1,
   autoDeployTrigger:'off',maxShutdownDelaySeconds:60,image:{url:imageFor(role).url},
   // Keep the compiled startup loaders. Only the worker overrides the API CMD.
   ...(role==='scheduler'?{dockerCommand:'node dist/jobs/production-scheduler.js'}:{}),
   envVars:[...Object.entries(environments[role]).map(([key,value])=>({key,value})),
    ...(['api','scheduler'].includes(role)?secretKeys.map(key=>({key,sync:false})):[]),
    ...(role==='api'?[{key:'READINESS_API_KEY',sync:false}]:[])],
   ...(role==='gateway'?{healthCheckPath:'/api/v1/health'}:{}),
  }));
  const build=[
   {role:'gateway',dockerfile:'caddy/managed/Dockerfile',args:{CHARITYPILOT_BUILD_COMMIT:r.sourceSha,CHARITYPILOT_MANAGED_GATEWAY_BINDING_SHA256:binding.sha256}},
   {role:'web',dockerfile:'apps/web/Dockerfile',args:{CHARITYPILOT_BUILD_COMMIT:r.sourceSha,...webBuild}},
   {role:'api',dockerfile:'apps/api/Dockerfile',args:{CHARITYPILOT_BUILD_COMMIT:r.sourceSha,CHARITYPILOT_MANAGED_API_PEER_BINDING_SHA256:binding.sha256}},
  ];
  const core={format:1,kind:'MANAGED_PROVIDER_CONFIGURATION_REVIEW_V1',purpose:raw.purpose,sourceSha:r.sourceSha,meshSha256:binding.sha256,
   build,blueprint:{previews:{generation:'off'},projects:[{name:'CharityPilot synthetic managed review',environments:[{name:'synthetic-review',services}]}]},
   maintenanceRegistry:{ownerId:r.ownerId,environmentId:r.environmentId,services:roles.map(component=>({component,id:r[component+'ServiceId'],imagePath:imageFor(component).url}))},
   recoveryKeys:Object.fromEntries(['storageKeyArn','dataKeyArn','indexMacKeyArn','rootMacKeyArn'].map(key=>[key,raw.recoveryKeys[key]])),
   secretFiles:['gateway','web','api'].map(role=>({serviceId:r[role+'ServiceId'],path:'/etc/secrets/charitypilot-'+role+'-tls.json'})),
   databaseCaFiles:['api','scheduler'].map(role=>({serviceId:r[role+'ServiceId'],path:'/etc/secrets/database-ca.pem'})),
   providerManagedIdentity:roles.map(role=>({serviceId:r[role+'ServiceId'],RENDER_SERVICE_ID:r[role+'ServiceId'],RENDER_SERVICE_TYPE:types[role]})),
   completeEnvironmentReadbackRequired:true,blueprintDeletesOmittedEnvironment:false,
  };
  return {...core,configurationSha256:createHash('sha256').update(JSON.stringify(core)).digest('hex'),
   providerInventoryVerified:false,imageProvenanceVerified:false,secretDeliveryVerified:false,databaseCompatibilityVerified:false,
   controlPlaneExclusionVerified:false,independentRecoveryVerified:false,applyAuthorized:false,releaseReady:false,executionAuthorized:false,actionAuthorized:false};
 }catch{throw refused();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  if(process.argv.length!==3||process.argv[2]!=='--stdin')throw refused();
  const chunks=[];let size=0;
  for await(const chunk of process.stdin){size+=chunk.length;if(size>32768)throw refused();chunks.push(chunk);}
  const result=compileManagedProviderPlan(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));
  process.stdout.write(JSON.stringify(result)+'\n');
 }catch{process.stderr.write(refused().message+'\n');process.exitCode=1;}
}
