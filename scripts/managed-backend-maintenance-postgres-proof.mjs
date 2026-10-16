import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {randomUUID,createHash} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {S3Client,GetObjectCommand,PutObjectCommand} from '@aws-sdk/client-s3';
import {ManagedDatabaseWriterFence} from '../apps/api/dist/services/managed-database-writer-fence.js';
import {RenderMaintenanceControl} from '../apps/api/dist/services/render-maintenance-control.js';
import {S3ManagedMaintenanceControl} from '../apps/api/dist/services/managed-maintenance-control.js';
import {ManagedBackendMaintenance} from '../apps/api/dist/services/managed-backend-maintenance.js';

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
 const ids=['srv-'+ 'a'.repeat(20),'srv-'+ 'b'.repeat(20),'srv-'+ 'c'.repeat(20)];
 const image='ghcr.io/synthetic/api@sha256:'+ '1'.repeat(64),credentials={accessKeyId:'synthetic',secretAccessKey:'synthetic'};
 const storage={installationId:'synthetic-managed',bucket:'synthetic-managed-control',accountId:'123456789012',
  kmsKeyArn:'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-1111-1111-111111111111'};
 for(const scenario of ['success','acquire-ack-lost','database-ack-lost','password-ack-lost','record-ack-lost']){
  // Only this disposable fixture reopens synthetic roles between independent
  // cases. Neither production primitive nor coordinator exposes reopening.
  await admin.$executeRaw`ALTER ROLE managed_writer_a LOGIN PASSWORD 'synthetic-writer-only'`;
  await admin.$executeRaw`ALTER ROLE managed_writer_b LOGIN PASSWORD 'synthetic-writer-only'`;
  const writerUrl=new URL(url);writerUrl.username='managed_writer_a';writerUrl.password='synthetic-writer-only';
  const writer=new PrismaClient({datasources:{db:{url:writerUrl.href}}});
  const events=[];let commands=0,job='running',version=1,value,databaseClosed=false,transactions=0;
  const services=ids.map((id,i)=>({id,ownerId:'tea-synthetic',environmentId:'env-synthetic',
   type:['web_service','private_service','background_worker'][i],imagePath:image,autoDeploy:'no',autoDeployTrigger:'off',
   suspended:'not_suspended',serviceDetails:{region:'frankfurt',runtime:'image',numInstances:1}}));
  const provider=new RenderMaintenanceControl({ownerId:'tea-synthetic',environmentId:'env-synthetic',services:ids.map((id,i)=>
   ({component:['web','api','scheduler'][i],id,imagePath:image}))},'synthetic-token',async(input,options)=>{
   const endpoint=new URL(String(input)),parts=endpoint.pathname.split('/'),id=parts[3];
   assert.equal(endpoint.origin,'https://api.render.com');assert.equal(options.redirect,'error');
   if(endpoint.pathname==='/v1/services'){
    if(databaseClosed){const [row]=await admin.$queryRaw`SELECT count(*)::integer AS n FROM pg_roles WHERE rolname IN ('managed_writer_a','managed_writer_b') AND rolcanlogin`;
     assert.equal(row.n,0);events.push('post-database-provider-read');}
    return Response.json(services.map(service=>({service,cursor:service.id})));
   }
   if(parts[4]==='suspend'){
    assert.equal(options.method,'POST');commands++;events.push('suspend');
    const [row]=await admin.$queryRaw`SELECT count(*)::integer AS n FROM pg_roles WHERE rolname IN ('managed_writer_a','managed_writer_b') AND rolcanlogin`;
    assert.equal(row.n,2);services.find(s=>s.id===id).suspended='suspended';return new Response(null,{status:202});
   }
   if(parts[4]==='deploys')return Response.json([]);
   if(parts[6]==='cancel'){assert.equal(options.method,'POST');commands++;events.push('cancel');job='canceled';return Response.json({status:'canceled'});}
   if(parts[4]==='jobs')return Response.json(id===ids[2]&&job==='running'?
    [{job:{id:'job-'+ 'd'.repeat(20),serviceId:id,status:job},cursor:'last-job'}]:[]);
   throw new Error('unexpected synthetic endpoint');
  });
  const sdk=new S3Client({region:'eu-west-1',credentials});
  const metadata=()=>({VersionId:'version-'+version,ETag:'"etag-'+version+'"',ServerSideEncryption:'aws:kms',SSEKMSKeyId:storage.kmsKeyArn});
  sdk.send=async command=>{
   assert.equal(command.input.ExpectedBucketOwner,storage.accountId);
   assert.equal(command.input.Key,`managed-maintenance/${storage.installationId}/control.json`);
   if(command instanceof GetObjectCommand){const body=JSON.stringify(value);return{...metadata(),ContentLength:Buffer.byteLength(body),Body:Readable.from([Buffer.from(body)])};}
   assert.ok(command instanceof PutObjectCommand);assert.equal(command.input.IfMatch,metadata().ETag);
   assert.equal(command.input.ChecksumSHA256,createHash('sha256').update(String(command.input.Body)).digest('base64'));
   value=JSON.parse(String(command.input.Body));version++;events.push('control-'+value.phase);
   if((scenario==='acquire-ack-lost'&&value.phase==='ATTEMPTED')||(scenario==='record-ack-lost'&&value.phase==='OBSERVED_CLOSED'))throw new Error('synthetic committed SDK acknowledgement lost');
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
  const coordinator=new ManagedBackendMaintenance(operation,provider,database,store);
  value={format:1,installationId:storage.installationId,maintenanceEpoch:1,planDigest:coordinator.planDigest(),
   phase:'READY',attemptId:null,observations:null,publicationId:randomUUID()};
  try{
   await writer.$queryRaw`SELECT 1`;
   if(scenario==='success'){
    const result=await coordinator.close();assert.equal(result.phase,'OBSERVED_CLOSED');assert.equal(result.wholeBackendQuiesced,false);
    assert.equal(events[0],'control-ATTEMPTED');assert.ok(events.indexOf('cancel')<events.indexOf('database-close'));
    assert.ok(events.indexOf('database-close')<events.indexOf('password-invalidate'));
    assert.ok(events.includes('post-database-provider-read'));assert.equal(events.at(-1),'control-OBSERVED_CLOSED');
   }else{
    await assert.rejects(coordinator.close());
    if(scenario==='acquire-ack-lost'){
     assert.equal(commands,0);assert.equal(value.phase,'ATTEMPTED');await writer.$queryRaw`SELECT 1`;
     // Explicit fixture-only cleanup; the coordinator never silently drains an
     // operation for which acquisition may have reached storage without consent.
     const cleanup=new ManagedDatabaseWriterFence(admin,configuration);await cleanup.close();await cleanup.invalidatePasswords();
     for(const service of services)service.suspended='suspended';job='canceled';databaseClosed=true;
    }
    if(scenario==='database-ack-lost'){
     assert.equal(commands,4);assert.equal(value.phase,'ATTEMPTED');
     await writer.$executeRaw`INSERT INTO public.synthetic_managed_writer VALUES ('managed-old-session-after-lost-commit')`;
     await assert.rejects(coordinator.inspect());
     const cleanup=new ManagedDatabaseWriterFence(admin,configuration);await cleanup.close();await cleanup.invalidatePasswords();databaseClosed=true;
    }
    if(scenario==='password-ack-lost'){
     assert.equal(commands,4);assert.equal(value.phase,'ATTEMPTED');
     const [state]=await admin.$queryRaw`SELECT count(*)::integer AS n FROM pg_authid WHERE rolname IN ('managed_writer_a','managed_writer_b') AND rolpassword IS NULL AND NOT rolcanlogin`;
     assert.equal(state.n,2);
    }
   }
   const before=commands,fresh=new ManagedBackendMaintenance(operation,provider,new ManagedDatabaseWriterFence(admin,configuration),store);
   await assert.rejects(fresh.close());assert.equal(commands,before);
   const inspected=await fresh.inspect();assert.equal(inspected.phase,value.phase);
   assert.equal(inspected.recordedObservations===null,['acquire-ack-lost','database-ack-lost','password-ack-lost'].includes(scenario));
   assert.equal(inspected.reopeningAuthorised,false);assert.equal(inspected.actionAuthorized,false);
   const freshWriter=new PrismaClient({datasources:{db:{url:writerUrl.href}}});
   try{await assert.rejects(freshWriter.$queryRaw`SELECT 1`);}finally{await freshWriter.$disconnect();}
   console.log('PASS integrated managed maintenance '+scenario+'; roles closed, fresh retry read-only/refused');
  }finally{await writer.$disconnect();sdk.destroy();}
 }
}
