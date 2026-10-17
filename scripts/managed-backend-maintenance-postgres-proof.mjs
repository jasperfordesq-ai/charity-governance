import {proveManagedCandidateCapture} from './managed-candidate-capture-postgres-proof.mjs';
import {managedS3WorkingFixture} from '../apps/api/dist/tests/fixtures/managed-s3-working.js';
import {managedS3CurrentFixture} from '../apps/api/dist/tests/fixtures/managed-s3-current.js';
import {managedSignedResumableFixture} from '../apps/api/dist/tests/fixtures/managed-signed-resumable.js';
import {resumableCohortFixture} from '../apps/api/dist/tests/fixtures/resumable-cohort.js';
import {managedSignedFixture} from '../apps/api/dist/tests/fixtures/managed-signed-upload.js';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {randomUUID,createHash} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {S3Client,GetObjectCommand,PutObjectCommand} from '@aws-sdk/client-s3';
import {ManagedDatabaseWriterFence} from '../apps/api/dist/services/managed-database-writer-fence.js';
import {RenderMaintenanceControl} from '../apps/api/dist/services/render-maintenance-control.js';
import {S3ManagedMaintenanceControl} from '../apps/api/dist/services/managed-maintenance-control.js';
import {ManagedBackendMaintenance} from '../apps/api/dist/services/managed-backend-maintenance.js';
import {SupabaseStorageWriterControl} from '../apps/api/dist/services/supabase-storage-writer-control.js';
import {SupabaseCredentialReadProof} from '../apps/api/dist/services/supabase-credential-read-proof.js';
import {ManagedStorageWriteEvidence} from '../apps/api/dist/services/managed-storage-write-evidence.js';

export async function proveManagedPasswordInvalidation({admin,configuration,url}){
 const service=new ManagedDatabaseWriterFence(admin,configuration);
 const passwordStates=()=>admin.$queryRaw`SELECT rolpassword IS NULL AS invalidated FROM pg_authid
  WHERE rolname IN ('managed_writer_a','managed_writer_b') ORDER BY rolname`;
 assert.ok((await passwordStates()).every(r=>!r.invalidated));
 await assert.rejects(service.observePasswordsInvalidated());
 await admin.$executeRaw`ALTER ROLE managed_writer_a LOGIN`;
 try{await assert.rejects(service.invalidatePasswords());assert.ok((await passwordStates()).every(r=>!r.invalidated));}
 finally{await admin.$executeRaw`ALTER ROLE managed_writer_a NOLOGIN`;}

 await admin.$executeRaw`CREATE ROLE managed_catalog_maintenance LOGIN PASSWORD 'synthetic-maintenance-view-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`;
 const maintenanceUrl=new URL(url);maintenanceUrl.username='managed_catalog_maintenance';maintenanceUrl.password='synthetic-maintenance-view-only';
 const limited=new PrismaClient({datasources:{db:{url:maintenanceUrl.href}}});
 try{
  const [identity]=await admin.$queryRaw`SELECT rolname::text AS name,oid::text AS oid FROM pg_roles WHERE rolname='managed_catalog_maintenance'`;
  const [privilege]=await limited.$queryRaw`SELECT has_table_privilege(current_user,'pg_authid','SELECT') AS allowed`;
  assert.equal(privilege.allowed,false);
  await assert.rejects(new ManagedDatabaseWriterFence(limited,{...configuration,maintenance:identity,custodians:[...configuration.custodians,identity]}).invalidatePasswords());
  assert.ok((await passwordStates()).every(r=>!r.invalidated));
 }finally{await limited.$disconnect();await admin.$executeRaw`DROP ROLE managed_catalog_maintenance`;}

 const rollback={$transaction:(fn,options)=>admin.$transaction(async tx=>{await fn(tx);throw new Error('synthetic late invalidation rollback');},options)};
 await assert.rejects(new ManagedDatabaseWriterFence(rollback,configuration).invalidatePasswords());
 assert.ok((await passwordStates()).every(r=>!r.invalidated));
 const unknown={$transaction:async(fn,options)=>{await admin.$transaction(fn,options);throw new Error('synthetic committed PASSWORD NULL acknowledgement lost');}};
 await assert.rejects(new ManagedDatabaseWriterFence(unknown,configuration).invalidatePasswords());
 assert.ok((await passwordStates()).every(r=>r.invalidated));
 assert.equal((await service.observePasswordsInvalidated()).passwordCredentialsInvalidated,true);
 assert.equal((await service.invalidatePasswords()).passwordCredentialsInvalidated,true);

 const oldUrl=new URL(url);oldUrl.username='managed_writer_a';oldUrl.password='synthetic-writer-only';
 let old,replacement;
 try{
  // Counterfactual is fixture-only: remove the NOLOGIN barrier to prove the old
  // password itself fails, then prove the same TLS path accepts a new password.
  await admin.$executeRaw`ALTER ROLE managed_writer_a LOGIN`;
  old=new PrismaClient({datasources:{db:{url:oldUrl.href}}});await assert.rejects(old.$queryRaw`SELECT 1`);
  await admin.$executeRaw`ALTER ROLE managed_writer_a PASSWORD 'synthetic-replacement-only'`;
  const replacementUrl=new URL(oldUrl);replacementUrl.password='synthetic-replacement-only';
  replacement=new PrismaClient({datasources:{db:{url:replacementUrl.href}}});
  assert.equal((await replacement.$queryRaw`SELECT 1 AS ok`)[0].ok,1);
  await assert.rejects(old.$queryRaw`SELECT 1`);
 }finally{
  await old?.$disconnect();await replacement?.$disconnect();await admin.$executeRaw`ALTER ROLE managed_writer_a NOLOGIN PASSWORD NULL`;
 }
 assert.equal((await service.observePasswordsInvalidated()).passwordCredentialsInvalidated,true);
 console.log('PASS actual password invalidation, atomic rollback/lost commit, catalogue refusal and LOGIN counterfactual with replacement positive control');
}

// Actual TLS PostgreSQL fencing composed with synthetic provider HTTP and SDK
// transport. This is not live Render/S3 custody or physical host-loss evidence.
export async function proveManagedBackendMaintenance({admin,configuration,url}){
 const ids=['srv-'+ 'a'.repeat(20),'srv-'+ 'b'.repeat(20),'srv-'+ 'c'.repeat(20),'srv-'+ 'd'.repeat(20)];
 const image='ghcr.io/synthetic/api@sha256:'+ '1'.repeat(64),credentials={accessKeyId:'synthetic',secretAccessKey:'synthetic'};
 const storage={installationId:'synthetic-managed',bucket:'synthetic-managed-control',accountId:'123456789012',
  kmsKeyArn:'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-1111-1111-111111111111'};
 for(const scenario of ['legacy-three-service-plan','success','acquire-ack-lost','baseline-ack-lost','write-baseline-ack-lost','write-head-ack-lost','signed-credential-ack-lost','signed-baseline-ack-lost','signed-head-ack-lost','resumable-location-ack-lost','resumable-child-baseline-ack-lost','resumable-manifest-baseline-ack-lost','resumable-head-ack-lost','resumable-child-report-ack-lost','resumable-manifest-report-ack-lost','resumable-still-writable','signed-tus-credential-ack-lost','signed-tus-baseline-ack-lost','signed-tus-readback-ack-lost','signed-tus-head-ack-lost','signed-tus-report-ack-lost','signed-tus-still-writable','database-ack-lost','password-ack-lost','storage-ack-lost','write-report-ack-lost','signed-report-ack-lost','signing-ack-lost','record-ack-lost','s3-canary-ack-lost','s3-baseline-ack-lost','s3-readback-ack-lost','s3-head-ack-lost','s3-head-readback-ack-lost','s3-report-ack-lost','s3-report-readback-ack-lost','s3-post-stale-gateway','s3-enabled-metadata','working-s3-success']){
  // Only this disposable fixture reopens synthetic roles between independent
  // cases. Neither production primitive nor coordinator exposes reopening.
  await admin.$executeRaw`ALTER ROLE managed_writer_a LOGIN PASSWORD 'synthetic-writer-only'`;
  await admin.$executeRaw`ALTER ROLE managed_writer_b LOGIN PASSWORD 'synthetic-writer-only'`;
  const writerUrl=new URL(url);writerUrl.username='managed_writer_a';writerUrl.password='synthetic-writer-only';
  const writer=new PrismaClient({datasources:{db:{url:writerUrl.href}}});
  const events=[];let commands=0,job='running',version=1,value,databaseClosed=false,transactions=0;
  const services=ids.map((id,i)=>({id,ownerId:'tea-synthetic',environmentId:'env-synthetic',
   type:['web_service','private_service','private_service','background_worker'][i],imagePath:image,autoDeploy:'no',autoDeployTrigger:'off',
   suspended:'not_suspended',serviceDetails:{region:'frankfurt',runtime:'image',numInstances:1}}));
  const provider=new RenderMaintenanceControl({ownerId:'tea-synthetic',environmentId:'env-synthetic',services:ids.map((id,i)=>
   ({component:['gateway','web','api','scheduler'][i],id,imagePath:image}))},'synthetic-token',async(input,options)=>{
   const endpoint=new URL(String(input)),parts=endpoint.pathname.split('/'),id=parts[3];
   assert.equal(endpoint.origin,'https://api.render.com');assert.equal(options.redirect,'error');
   if(endpoint.pathname==='/v1/services'){
    if(databaseClosed){const [row]=await admin.$queryRaw`SELECT count(*)::integer AS n FROM pg_authid WHERE rolname IN ('managed_writer_a','managed_writer_b') AND NOT rolcanlogin AND rolpassword IS NULL`;
     assert.equal(row.n,2);events.push('post-database-provider-read');}
    return Response.json(services.map(service=>({service,cursor:service.id})));
   }
   if(parts.length===4)return Response.json(services.find(s=>s.id===id));
   if(parts[4]==='suspend'){
    assert.equal(options.method,'POST');assert.equal(value.phase,'S3_BASELINED');assert.ok(value.s3BaselinePin);commands++;events.push('suspend-'+id);
    const [row]=await admin.$queryRaw`SELECT count(*)::integer AS n FROM pg_roles WHERE rolname IN ('managed_writer_a','managed_writer_b') AND rolcanlogin`;
    assert.equal(row.n,2);services.find(s=>s.id===id).suspended='suspended';return new Response(null,{status:202});
   }
   if(parts[4]==='deploys')return Response.json([]);
   if(parts[6]==='cancel'){assert.equal(options.method,'POST');commands++;events.push('cancel');job='canceled';return Response.json({status:'canceled'});}
   if(parts[4]==='jobs')return Response.json(id===ids[3]&&job==='running'?
    [{job:{id:'job-'+ 'd'.repeat(20),serviceId:id,status:job},cursor:'last-job'}]:[]);
   throw new Error('unexpected synthetic endpoint');
  });
  const sdk=new S3Client({region:'eu-west-1',credentials});
  const artifacts=new Map();let signedTusReadbackFaultUsed=false,s3ReadbackFaultUsed=false,s3HeadReadbackFaultUsed=false;
  const metadata=()=>({VersionId:'version-'+version,ETag:'"etag-'+version+'"',ServerSideEncryption:'aws:kms',SSEKMSKeyId:storage.kmsKeyArn});
  sdk.send=async command=>{
   assert.equal(command.input.ExpectedBucketOwner,storage.accountId);
   if(command.input.Key!==`managed-maintenance/${storage.installationId}/control.json`){
    if(command instanceof PutObjectCommand){
     assert.equal(command.input.IfNoneMatch,'*');assert.equal(artifacts.has(command.input.Key),false);
     const row={body:String(command.input.Body),version:'artifact-'+(artifacts.size+1)};artifacts.set(command.input.Key,row);
     if((scenario==='write-baseline-ack-lost'&&command.input.Key.endsWith('write-baseline.json'))||(scenario==='write-report-ack-lost'&&command.input.Key.endsWith('write-observation.json'))||(scenario==='signed-credential-ack-lost'&&command.input.Key.endsWith('signed-upload-credential.json'))||(scenario==='signed-baseline-ack-lost'&&command.input.Key.endsWith('signed-baseline.json'))||(scenario==='signed-report-ack-lost'&&command.input.Key.endsWith('signed-observation.json'))||(scenario==='resumable-location-ack-lost'&&command.input.Key.endsWith('/resumable-location.json'))||(scenario==='resumable-child-baseline-ack-lost'&&command.input.Key.endsWith('/resumable-baseline.json'))||(scenario==='resumable-manifest-baseline-ack-lost'&&command.input.Key.endsWith('/resumable-cohort-baseline.json'))||(scenario==='resumable-child-report-ack-lost'&&command.input.Key.endsWith('/resumable-observation.json'))||(scenario==='resumable-manifest-report-ack-lost'&&command.input.Key.endsWith('/resumable-cohort-observation.json'))||(scenario==='signed-tus-credential-ack-lost'&&command.input.Key.endsWith('/signed-resumable-credential.json'))||(scenario==='signed-tus-baseline-ack-lost'&&command.input.Key.endsWith('/signed-resumable-baseline.json'))||(scenario==='signed-tus-report-ack-lost'&&command.input.Key.endsWith('/signed-resumable-observation.json'))||(scenario==='s3-baseline-ack-lost'&&command.input.Key.endsWith('/s3-current-feature-baseline.json'))||(scenario==='s3-report-ack-lost'&&command.input.Key.endsWith('/s3-current-feature-observation.json')))throw new Error('synthetic artifact committed ACK lost');
     return{...metadata(),VersionId:row.version};
    }
    const row=artifacts.get(command.input.Key);assert.equal(command.input.VersionId,row.version);
    if(scenario==='signed-tus-readback-ack-lost'&&!signedTusReadbackFaultUsed&&command.input.Key.endsWith('/signed-resumable-baseline.json')){signedTusReadbackFaultUsed=true;throw new Error('synthetic signed TUS baseline readback lost');}
    if(!s3ReadbackFaultUsed&&((scenario==='s3-readback-ack-lost'&&command.input.Key.endsWith('/s3-current-feature-baseline.json'))||(scenario==='s3-report-readback-ack-lost'&&command.input.Key.endsWith('/s3-current-feature-observation.json')))){s3ReadbackFaultUsed=true;throw new Error('synthetic S3 public readback ACK lost');}
    return{...metadata(),VersionId:row.version,ContentLength:Buffer.byteLength(row.body),Body:Readable.from([Buffer.from(row.body)])};
   }
   if(command instanceof GetObjectCommand){if(scenario==='s3-head-readback-ack-lost'&&!s3HeadReadbackFaultUsed&&value.phase==='S3_BASELINED'){s3HeadReadbackFaultUsed=true;throw new Error('synthetic S3 head readback ACK lost');}const body=JSON.stringify(value);return{...metadata(),ContentLength:Buffer.byteLength(body),Body:Readable.from([Buffer.from(body)])};}
   assert.ok(command instanceof PutObjectCommand);assert.equal(command.input.IfMatch,metadata().ETag);
   assert.equal(command.input.ChecksumSHA256,createHash('sha256').update(String(command.input.Body)).digest('base64'));
   value=JSON.parse(String(command.input.Body));version++;events.push('control-'+value.phase);
   if((scenario==='acquire-ack-lost'&&value.phase==='ATTEMPTED')||(scenario==='baseline-ack-lost'&&value.phase==='BASELINED')||(scenario==='write-head-ack-lost'&&value.phase==='WRITE_BASELINED')||(scenario==='signed-head-ack-lost'&&value.phase==='SIGNED_BASELINED')||(scenario==='resumable-head-ack-lost'&&value.phase==='RESUMABLE_BASELINED')||(scenario==='signed-tus-head-ack-lost'&&value.phase==='SIGNED_RESUMABLE_BASELINED')||(scenario==='s3-head-ack-lost'&&value.phase==='S3_BASELINED')||(scenario==='record-ack-lost'&&value.phase==='OBSERVED_CLOSED'))throw new Error('synthetic committed SDK acknowledgement lost');
   return metadata();
  };
  const store=new S3ManagedMaintenanceControl(storage,credentials,sdk);
  const driver=['database-ack-lost','password-ack-lost'].includes(scenario)?{$transaction:async(fn,options)=>{
   const result=await admin.$transaction(fn,options);transactions++;
   if((scenario==='database-ack-lost'&&transactions===1)||(scenario==='password-ack-lost'&&transactions===4))throw new Error('synthetic real role transaction commit acknowledgement lost');
   return result;
  }}:admin;
  const database=new ManagedDatabaseWriterFence(driver,configuration),originalClose=database.close.bind(database);
  database.close=async()=>{events.push('database-close');const result=await originalClose();databaseClosed=true;return result;};
  const originalInvalidate=database.invalidatePasswords.bind(database);
  database.invalidatePasswords=async()=>{events.push('password-invalidate');return originalInvalidate();};
  const operation={installationId:storage.installationId,sourceSha:'1'.repeat(40),maintenanceEpoch:1};
  const storageConfig={installationId:storage.installationId,projectRef:'abcdefghijklmnopqrst',bucket:'documents',
   organisationId:'org-synthetic',region:'eu-central-1',captureKeyId:'11111111-1111-4111-8111-111111111111',
   writerKeys:[{id:'22222222-2222-4222-8222-222222222222',type:'secret'}]};
  let legacyEnabled=true,s3Enabled=['s3-enabled-metadata','working-s3-success'].includes(scenario),writerKeyPresent=true,storageCommands=0;
  const storageTransport=async(input,options)=>{
   const endpoint=new URL(String(input)),path=endpoint.pathname;
   assert.equal(endpoint.origin,'https://api.supabase.com');assert.equal(options.redirect,'error');
   if(options.method!=='GET'){
    storageCommands++;const [closed]=await admin.$queryRaw`SELECT count(*)::integer AS n FROM pg_authid
      WHERE rolname IN ('managed_writer_a','managed_writer_b') AND NOT rolcanlogin AND rolpassword IS NULL`;
    assert.equal(closed.n,2);events.push('storage-'+options.method);
   }
   if(path.endsWith('/config/storage')){
    if(options.method==='PATCH'){s3Enabled=false;return Response.json({});}
    return Response.json({features:{s3Protocol:{enabled:s3Enabled}}});
   }
   if(path.endsWith('/api-keys/legacy')){if(options.method==='PUT')legacyEnabled=false;return Response.json({enabled:legacyEnabled});}
   if(path.endsWith('/api-keys'))return Response.json([{id:storageConfig.captureKeyId,type:'secret'},...(writerKeyPresent?storageConfig.writerKeys:[])]);
   if(options.method==='DELETE'){
    assert.ok(path.endsWith(storageConfig.writerKeys[0].id));writerKeyPresent=false;
    if(scenario==='storage-ack-lost')throw new Error('synthetic committed Supabase key deletion ACK lost');
    return Response.json(storageConfig.writerKeys[0]);
   }
   return Response.json({ref:storageConfig.projectRef,organization_id:storageConfig.organisationId,region:storageConfig.region,status:'ACTIVE_HEALTHY'});
  };
  const newStorageControl=()=>new SupabaseStorageWriterControl(storageConfig,'synthetic-supabase-management',storageTransport);
  const controlCredential={id:storageConfig.captureKeyId,secret:'sb_secret_'+ 'a'.repeat(40)},
   retiredCredential={id:storageConfig.writerKeys[0].id,secret:'sb_secret_'+ 'b'.repeat(40)},canary='synthetic native recovery canary';
  const fingerprint=text=>createHash('sha256').update(text).digest('hex');
  const newReadProof=()=>new SupabaseCredentialReadProof({installationId:storage.installationId,projectRef:storageConfig.projectRef,
   bucket:'charitypilot-recovery-canaries',canary:{fileUrl:'charitypilot-recovery-canary/'+storage.installationId+'/native.txt',bytes:Buffer.byteLength(canary),sha256:fingerprint(canary)},
   control:{id:controlCredential.id,sha256:fingerprint(controlCredential.secret)},retired:[{id:retiredCredential.id,sha256:fingerprint(retiredCredential.secret)}]},
   {control:controlCredential,retired:[retiredCredential]},async(input,options)=>{
    const target=new URL(String(input)),key=new Headers(options.headers).get('apikey');
    assert.equal(target.origin,'https://'+storageConfig.projectRef+'.supabase.co');assert.equal(options.method,'GET');assert.equal(options.redirect,'error');
    assert.ok(key===controlCredential.secret||key===retiredCredential.secret);
    if(key===retiredCredential.secret&&!writerKeyPresent)return new Response(null,{status:401});
    if(target.pathname.includes('/bucket/'))return Response.json({id:'charitypilot-recovery-canaries',public:false});
    events.push('canary-read');return new Response(Buffer.from(canary),{headers:{'content-type':'text/plain','content-length':String(Buffer.byteLength(canary))}});
   });
  const probeObjects=new Map(),writeTransport=async(input,options)=>{
   const target=new URL(String(input)),key=new Headers(options.headers).get('apikey'),method=options.method;
   assert.equal(target.origin,'https://'+storageConfig.projectRef+'.supabase.co');assert.equal(options.redirect,'error');
   assert.ok(key===controlCredential.secret||key===retiredCredential.secret);
   if(key===retiredCredential.secret&&!writerKeyPresent)return new Response(null,{status:401});
   if(target.pathname.includes('/bucket/'))return Response.json({id:'charitypilot-recovery-write-probes',public:false});
   const path=target.pathname.slice('/storage/v1/object/charitypilot-recovery-write-probes/'.length);
   if(method==='GET')return probeObjects.has(path)?new Response(probeObjects.get(path),{headers:{'content-type':'text/plain','content-length':String(Buffer.byteLength(probeObjects.get(path)))}}):new Response(null,{status:404});
   if(method==='DELETE'){const {prefixes}=JSON.parse(options.body);assert.equal(prefixes.length,1);probeObjects.delete(prefixes[0]);return Response.json([]);}
   if(method==='POST'&&probeObjects.has(path))return new Response(null,{status:409});
   assert.ok(method==='POST'||method==='PUT');probeObjects.set(path,String(options.body));return Response.json({});
  };
  const newWriteEvidence=()=>new ManagedStorageWriteEvidence({installationId:storage.installationId,projectRef:storageConfig.projectRef,bucket:'charitypilot-recovery-write-probes',
   control:{id:controlCredential.id,sha256:fingerprint(controlCredential.secret)},retired:[{id:retiredCredential.id,sha256:fingerprint(retiredCredential.secret)}]},
   {control:controlCredential,retired:[retiredCredential]},storage,credentials,writeTransport,sdk);
  const signed=managedSignedFixture(storage,sdk,events,controlCredential);
  if(scenario==='signing-ack-lost')signed.loseRevocationAck=true;
  const resumable=resumableCohortFixture({storage,client:sdk,events,control:controlCredential,retired:[retiredCredential],isRetiredAllowed:()=>writerKeyPresent});
  if(scenario==='resumable-still-writable')resumable.allowRetiredAfterClose=true;
  const signedTus=managedSignedResumableFixture(signed,storage,sdk,events);
  if(scenario==='signed-tus-still-writable')signedTus.mode.stillWorks=true;
  const actualStorage=newStorageControl(),s3Current=managedS3CurrentFixture(storage,sdk,actualStorage,controlCredential,events);
  const s3=scenario==='working-s3-success'?managedS3WorkingFixture(storage,sdk,actualStorage,controlCredential,events,()=>({attemptId:value.attemptId,planDigest:value.planDigest,sourceSha:operation.sourceSha,maintenanceEpoch:1}),()=>!s3Enabled):s3Current;
  if(scenario==='s3-canary-ack-lost')s3Current.mode.lostCanaryAck=true;
  if(scenario==='s3-post-stale-gateway')s3Current.mode.stalePostGateway=true;
  const coordinator=new ManagedBackendMaintenance(operation,provider,database,store,actualStorage,newReadProof(),newWriteEvidence(),signed.factory(),resumable.factory(),signedTus.factory(),s3.factory());
  value={format:1,installationId:storage.installationId,maintenanceEpoch:1,planDigest:coordinator.planDigest(),
   phase:'READY',attemptId:null,observations:null,publicationId:randomUUID()};
  try{
   await writer.$queryRaw`SELECT 1`;
   if(scenario==='legacy-three-service-plan'){
    const hash=text=>createHash('sha256').update(text).digest('hex');
    const legacy={ownerId:'tea-synthetic',environmentId:'env-synthetic',services:ids.slice(0,3).map((id,i)=>({component:['web','api','scheduler'][i],id,imagePath:image}))};
    value.planDigest=hash(JSON.stringify({format:2,...operation,databaseCredentialPolicy:'PASSWORD_NULL_WHILE_CLOSED',
     provider:hash(JSON.stringify(legacy)),database:database.configurationDigest()}));
    await assert.rejects(coordinator.close());assert.equal(commands,0);assert.equal(value.phase,'READY');
    await writer.$queryRaw`SELECT 1`;await assert.rejects(coordinator.inspect());
    console.log('PASS legacy three-service control refuses before provider/role mutation');continue;
   }
   if(['success','working-s3-success'].includes(scenario)){
    const result=await coordinator.close();assert.equal(result.phase,'OBSERVED_CLOSED');assert.equal(result.configuredS3CoverageObserved,true);assert.ok(value.s3BaselinePin&&value.s3ObservationPin&&value.observations.s3ProofDigest);assert.ok(events.indexOf('control-S3_BASELINED')>=0&&events.indexOf('control-S3_BASELINED')<events.indexOf('suspend-'+ids[0]));assert.equal(result.wholeBackendQuiesced,false);
    assert.equal(result.storageAccessPathsObservedClosed,true);assert.equal(storageCommands,scenario==='working-s3-success'?3:2);assert.ok(value.observations.storageDigest);
    assert.equal(events[0],'control-ATTEMPTED');assert.ok(events.indexOf('control-BASELINED')<events.indexOf('suspend-'+ids[0]));
    assert.ok(value.readBaseline&&value.readObservation);assert.equal(result.credentialReadRefusalsObserved,true);assert.ok(events.indexOf('cancel')<events.indexOf('database-close'));
    assert.ok(value.resumableBaselinePin&&value.resumableObservationPin);assert.equal(result.resumableCredentialCohortRefusalsObserved,true);assert.equal(result.testedSignedResumablePatchRefusalObserved,true);assert.ok(value.signedResumableBaselinePin&&value.signedResumableObservationPin);
    assert.ok(events.indexOf('control-SIGNED_RESUMABLE_BASELINED')<events.indexOf('suspend-'+ids[0]));assert.ok(Buffer.byteLength(JSON.stringify(value))<=8192);
    assert.ok(events.indexOf('control-RESUMABLE_BASELINED')<events.indexOf('suspend-'+ids[0]));
    assert.ok(value.signedBaselinePin&&value.signedObservationPin);assert.equal(result.testedSignedUploadRefusalObserved,true);
    assert.ok(events.indexOf('control-SIGNED_BASELINED')<events.indexOf('suspend-'+ids[0]));assert.ok(value.writeBaselinePin&&value.writeObservationPin);assert.equal(result.standardWriteRefusalsObserved,true);
    assert.ok(events.indexOf('control-WRITE_BASELINED')<events.indexOf('suspend-'+ids[0]));
    assert.deepEqual(events.filter(event=>event.startsWith('suspend-')),[ids[0],ids[3],ids[1],ids[2]].map(id=>'suspend-'+id));
    assert.ok(events.indexOf('database-close')<events.indexOf('password-invalidate'));
    assert.ok(events.indexOf('password-invalidate')<events.indexOf('storage-PUT'));
    if(scenario==='working-s3-success'){assert.ok(events.indexOf('storage-PATCH')>events.indexOf('password-invalidate'));assert.equal(s3.children.size,4);assert.ok(s3.crypto.plaintext.every(p=>p.every(v=>v===0)));}
    assert.ok(events.includes('post-database-provider-read'));assert.equal(events.at(-1),'control-OBSERVED_CLOSED');
   }else{
    await assert.rejects(coordinator.close());
    if(['acquire-ack-lost','baseline-ack-lost','write-baseline-ack-lost','write-head-ack-lost','signed-credential-ack-lost','signed-baseline-ack-lost','signed-head-ack-lost','resumable-location-ack-lost','resumable-child-baseline-ack-lost','resumable-manifest-baseline-ack-lost','resumable-head-ack-lost','signed-tus-credential-ack-lost','signed-tus-baseline-ack-lost','signed-tus-readback-ack-lost','signed-tus-head-ack-lost','s3-canary-ack-lost','s3-baseline-ack-lost','s3-readback-ack-lost','s3-head-ack-lost','s3-head-readback-ack-lost','s3-enabled-metadata'].includes(scenario)){
     assert.equal(commands,0);assert.equal(value.phase,scenario==='acquire-ack-lost'?'ATTEMPTED':['s3-head-ack-lost','s3-head-readback-ack-lost'].includes(scenario)?'S3_BASELINED':['s3-canary-ack-lost','s3-baseline-ack-lost','s3-readback-ack-lost','s3-enabled-metadata'].includes(scenario)?'SIGNED_RESUMABLE_BASELINED':scenario==='signed-tus-head-ack-lost'?'SIGNED_RESUMABLE_BASELINED':['resumable-head-ack-lost','signed-tus-credential-ack-lost','signed-tus-baseline-ack-lost','signed-tus-readback-ack-lost'].includes(scenario)?'RESUMABLE_BASELINED':['resumable-location-ack-lost','resumable-child-baseline-ack-lost','resumable-manifest-baseline-ack-lost','signed-head-ack-lost'].includes(scenario)?'SIGNED_BASELINED':['write-head-ack-lost','signed-credential-ack-lost','signed-baseline-ack-lost'].includes(scenario)?'WRITE_BASELINED':'BASELINED');await writer.$queryRaw`SELECT 1`;
     // Explicit fixture-only cleanup; the coordinator never silently drains an
     // operation for which acquisition may have reached storage without consent.
     const cleanup=new ManagedDatabaseWriterFence(admin,configuration);await cleanup.close();await cleanup.invalidatePasswords();
     for(const service of services)service.suspended='suspended';job='canceled';databaseClosed=true;
    }
    if(scenario==='database-ack-lost'){
     assert.equal(commands,5);assert.equal(value.phase,'S3_BASELINED');
     await writer.$executeRaw`INSERT INTO public.synthetic_managed_writer VALUES ('managed-old-session-after-lost-commit')`;
     await assert.rejects(coordinator.inspect());
     const cleanup=new ManagedDatabaseWriterFence(admin,configuration);await cleanup.close();await cleanup.invalidatePasswords();databaseClosed=true;
    }
    if(scenario==='password-ack-lost'){
     assert.equal(commands,5);assert.equal(value.phase,'S3_BASELINED');
     const [state]=await admin.$queryRaw`SELECT count(*)::integer AS n FROM pg_authid WHERE rolname IN ('managed_writer_a','managed_writer_b') AND rolpassword IS NULL AND NOT rolcanlogin`;
     assert.equal(state.n,2);
    }
   }
   // Explicit synthetic fixture resolution after the earlier uncertain DB/
   // acquisition cases; never part of production inspect or an automatic retry.
   if(['acquire-ack-lost','baseline-ack-lost','write-baseline-ack-lost','write-head-ack-lost','signed-credential-ack-lost','signed-baseline-ack-lost','signed-head-ack-lost','resumable-location-ack-lost','resumable-child-baseline-ack-lost','resumable-manifest-baseline-ack-lost','resumable-head-ack-lost','signed-tus-credential-ack-lost','signed-tus-baseline-ack-lost','signed-tus-readback-ack-lost','signed-tus-head-ack-lost','database-ack-lost','password-ack-lost','s3-canary-ack-lost','s3-baseline-ack-lost','s3-readback-ack-lost','s3-head-ack-lost','s3-head-readback-ack-lost','s3-enabled-metadata'].includes(scenario))await newStorageControl().close();
   if(scenario==='storage-ack-lost'){assert.equal(storageCommands,scenario==='working-s3-success'?3:2);assert.equal(value.phase,'S3_BASELINED');}
   if(!signed.revoked)signed.forceRevoked(); // explicit synthetic fixture resolution; never parent inspection.
   const activeProbeMutations=()=>events.filter(e=>e.startsWith('signed-kms-')||e==='signed-storage-POST'||e==='signed-storage-PUT'||e==='signed-management-PATCH'||e.startsWith('kms-')||e==='tus-POST'||e==='tus-PATCH'||e==='signed-tus-POST'||e==='signed-tus-PATCH'||e.startsWith('secret-kms-')||e.startsWith('s3-feature-')||e.startsWith('s3-working-')).length;
   const activeBefore=activeProbeMutations();
   signedTus.aws.setFault(()=>undefined); // explicit synthetic transport resolution, not parent backfill.
   const before=commands,storageBefore=storageCommands,probeCount=probeObjects.size,artifactCount=artifacts.size,versionBefore=version,fresh=new ManagedBackendMaintenance(operation,provider,new ManagedDatabaseWriterFence(admin,configuration),store,newStorageControl(),newReadProof(),newWriteEvidence(),signed.factory(),resumable.factory(),signedTus.factory(),s3.factory());
   await assert.rejects(fresh.close());assert.equal(commands,before);assert.equal(storageCommands,storageBefore);
   const inspected=await fresh.inspect();assert.equal(inspected.phase,value.phase);
   assert.equal(inspected.recordedObservations===null,!['success','working-s3-success','record-ack-lost'].includes(scenario));
   assert.equal(inspected.credentialReadRefusalsObserved,scenario!=='acquire-ack-lost');
   assert.equal(inspected.recordedReadObservation===null,!['success','working-s3-success','record-ack-lost'].includes(scenario));
   assert.equal(inspected.recordedStandardWriteRefusalsObserved,['success','working-s3-success','record-ack-lost'].includes(scenario));
   assert.equal(inspected.recordedTestedSignedUploadRefusalObserved,['success','working-s3-success','record-ack-lost'].includes(scenario));assert.equal(inspected.freshSignedUploadRefusalObserved,false);
   assert.equal(inspected.recordedResumableCredentialCohortRefusalsObserved,['success','working-s3-success','record-ack-lost'].includes(scenario));assert.equal(inspected.freshResumableCredentialCohortRefusalsObserved,false);
   assert.equal(inspected.recordedSignedResumablePatchRefusalObserved,['success','working-s3-success','record-ack-lost'].includes(scenario));assert.equal(inspected.freshSignedResumablePatchRefusalObserved,false);
   assert.equal(artifacts.size,artifactCount);assert.equal(version,versionBefore);assert.ok(resumable.plaintext.every(p=>p.every(v=>v===0)));assert.ok(signedTus.aws.plaintextResponses.every(p=>p.every(v=>v===0)));
   assert.equal(inspected.recordedS3CoverageObserved,['success','working-s3-success','record-ack-lost'].includes(scenario));assert.equal(inspected.freshS3CoverageObserved,false);assert.equal(inspected.freshStandardWriteRefusalsObserved,false);assert.equal(probeObjects.size,probeCount);assert.equal(activeProbeMutations(),activeBefore);assert.ok(signed.plaintext.every(p=>p.every(v=>v===0)));
   assert.equal(inspected.reopeningAuthorised,false);assert.equal(inspected.actionAuthorized,false);
   if(scenario==='success')await proveManagedCandidateCapture({coordinator:fresh,control:store,admin,configuration,operation,scope:newStorageControl().candidateCaptureScope(),url});
   const freshWriter=new PrismaClient({datasources:{db:{url:writerUrl.href}}});
   try{await assert.rejects(freshWriter.$queryRaw`SELECT 1`);}finally{await freshWriter.$disconnect();}
   console.log('PASS integrated managed maintenance '+scenario+'; roles closed, fresh retry read-only/refused');
  }finally{await writer.$disconnect();sdk.destroy();}
 }
}
