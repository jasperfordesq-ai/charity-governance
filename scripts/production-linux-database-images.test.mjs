import { prepareDatabaseCaDockerTransport } from './postgres-backup.mjs';
import { readdirSync } from 'node:fs';
import { toStrictPrismaTlsUrl } from '../packages/shared/runtime/prisma-database-url.mjs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { validateLocalDockerEndpoint,validateLocalDockerRuntime,pinnedLocalDockerEnvironment } from './personal-server-docker-boundary.mjs';

const image = 'postgres@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c';
function run(command,args,options={}) {
  const result = spawnSync(command,args,{ encoding:'utf8', timeout:30000, maxBuffer:1024*1024, ...options });
  assert.equal(result.status,0, result.stderr || result.error?.message || 'synthetic fixture command failed');
  return result.stdout.trim();
}
test('actual Linux API and migration images verify TLS and restricted database operations', { timeout:240000 }, async () => {
const endpoint = JSON.parse(run('docker',['context','inspect','--format','{{json .Endpoints.docker}}']));
validateLocalDockerEndpoint({endpoint:endpoint.Host,skipTlsVerify:endpoint.SkipTLSVerify},process.env);
const dockerEnv=pinnedLocalDockerEnvironment(process.env,endpoint.Host);
const docker = (args,input) => run('docker',['--host',endpoint.Host,...args],{ input,env:dockerEnv });
const daemonInfo=JSON.parse(docker(['info','--format','{{json .}}']));
validateLocalDockerRuntime({endpoint:endpoint.Host,skipTlsVerify:endpoint.SkipTLSVerify,
  operatingSystem:daemonInfo.OperatingSystem,serverOs:daemonInfo.OSType,
  apiVersion:docker(['version','--format','{{.Server.APIVersion}}'])},process.env);
const certDir = mkdtempSync(join(tmpdir(),'charitypilot-role-tls-'));
assert.equal(dirname(resolve(certDir)),resolve(tmpdir()));
assert.ok(basename(certDir).startsWith('charitypilot-role-tls-'));
const name = `charitypilot-role-proof-${randomUUID()}`;
let id;
try {
  const openssl = process.platform==='win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl';
  run(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(certDir,'key.pem'),'-out',join(certDir,'cert.pem'),
    '-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-addext','basicConstraints=critical,CA:TRUE']);
  id = docker(['run','--detach','--network','none','--name',name,'--tmpfs','/var/lib/postgresql/data','--tmpfs','/tmp',
    '--env','POSTGRES_PASSWORD=synthetic-maintenance-only','--env','POSTGRES_HOST_AUTH_METHOD=scram-sha-256',
    '--env','POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=trust',
    '--entrypoint','sh','--pull=missing',image,'-eu','-c',
    'while [ ! -f /tmp/role-ready ]; do sleep 0.1; done; chown postgres:postgres /tmp/cert.pem /tmp/key.pem; chmod 600 /tmp/key.pem; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/cert.pem -c ssl_key_file=/tmp/key.pem']);
  assert.match(id,/^[a-f0-9]{64}$/);
  // exec writes into the running tmpfs mount; Docker cp did not do so here.
  docker(['exec','-i',id,'sh','-c','cat > /tmp/cert.pem'],readFileSync(join(certDir,'cert.pem')));
  docker(['exec','-i',id,'sh','-c','cat > /tmp/key.pem'],readFileSync(join(certDir,'key.pem')));
  docker(['exec',id,'touch','/tmp/role-ready']);
  let ready = false;
  for (let attempt=0;attempt<100;attempt++) {
    const result = spawnSync('docker',['--host',endpoint.Host,'exec',id,'pg_isready','-h','127.0.0.1','-U','postgres'],{env:dockerEnv,encoding:'utf8',timeout:5000});
    if(result.status===0) {ready=true;break;}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  if (!ready) {
    const logs = spawnSync('docker',['--host',endpoint.Host,'logs',id],{env:dockerEnv,encoding:'utf8',timeout:10000});
    throw new Error(`disposable TLS PostgreSQL did not start: ${(logs.stdout+logs.stderr).slice(-3000)}`);
  }
  const query = (statement,role='postgres',sslmode='verify-full') => docker(['exec','-i',
    '--env',`PGPASSWORD=${role==='postgres'?'synthetic-maintenance-only':'synthetic-runtime-only'}`,
    '--env',`PGSSLMODE=${sslmode}`,'--env','PGSSLROOTCERT=/tmp/cert.pem',id,'psql',
    '-X','-h','localhost','-U',role,'-d','postgres','-v','ON_ERROR_STOP=1','-Atq'],statement);
  const runtimeImage=process.env.CHARITYPILOT_TEST_API_IMAGE;
  const migrationImage=process.env.CHARITYPILOT_TEST_MIGRATION_IMAGE;
  const expectedSource=process.env.CHARITYPILOT_TEST_SOURCE_COMMIT;
  assert.match(expectedSource??'',/^[a-f0-9]{40}$/, 'Set exact source commit for these locally built images');
  for(const imageId of [runtimeImage,migrationImage]) {
    assert.match(imageId??'',/^sha256:[a-f0-9]{64}$/, 'Set local immutable API and migration image IDs');
    const metadata=JSON.parse(docker(['image','inspect',imageId]))[0];
    assert.equal(metadata.Os,'linux');assert.equal(metadata.Config.User,'node');
    assert.equal(metadata.Config.Labels['org.opencontainers.image.revision'],expectedSource);
  }
  const result={sourceCommit:expectedSource,runtimeImage,migrationImage,localOnly:true,checks:[]};
  const target={runtimeRole:'cp_runtime',maintenanceRole:'postgres',database:'postgres'};
  query("CREATE ROLE cp_runtime LOGIN PASSWORD 'synthetic-runtime-only' NOINHERIT; GRANT CONNECT ON DATABASE postgres TO cp_runtime; GRANT USAGE ON SCHEMA public TO cp_runtime;");
  const runtimeUrl='postgresql://cp_runtime:synthetic-runtime-only@localhost:5432/postgres?sslmode=verify-full&target_session_attrs=read-write&sslrootcert=%2Frun%2Fcharitypilot%2Fdatabase-ca.pem&connect_timeout=3';
  const ownerUrl=runtimeUrl.replace('cp_runtime:synthetic-runtime-only@','postgres:synthetic-maintenance-only@');
  const common=['run','--rm','--pull=never','-i','--network','container:'+id,'--read-only','--tmpfs','/tmp',
    '--security-opt','no-new-privileges:true','--cap-drop','ALL','--mount',
    'type=bind,source='+join(certDir,'cert.pem')+',target=/run/charitypilot/database-ca.pem,readonly',
    '-e','DATABASE_URL','-e','NODE_ENV=production','-e','CHARITYPILOT_DEPLOYMENT_MODE=production'];
  function child(args,url=runtimeUrl,input='') {return spawnSync('docker',['--host',endpoint.Host,...args],{
    env:{...dockerEnv,DATABASE_URL:url},input,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});}
  function check(label,fn) {fn();result.checks.push(label);process.stdout.write('PASS '+label+'\n');}
  function roleJob(phase='after-migration',url=runtimeUrl) {return child([...common,'--entrypoint','node',runtimeImage,
    'dist/jobs/verify-runtime-database-role.js'],url,JSON.stringify({...target,phase}));}
  function validRole(phase) {const r=roleJob(phase);assert.equal(r.status,0,r.stderr);
    assert.deepEqual(JSON.parse(r.stdout),{schemaVersion:1,verified:true,phase});}
  check('Linux API native Prisma verifies pre-migration restricted TLS login',()=>validRole('before-migration'));
  check('Linux migration image applies complete source migration chain',()=>{
    const r=child([...common,migrationImage],toStrictPrismaTlsUrl(ownerUrl));assert.equal(r.status,0,r.stderr||r.stdout);
    const count=readdirSync(fileURLToPath(new URL('../apps/api/prisma/migrations/',import.meta.url)),{withFileTypes:true}).filter(e=>e.isDirectory()).length;
    assert.equal(query('SELECT count(*) FROM public."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'),String(count));
    result.appliedMigrations=count;
  });
  docker(['exec','-i','--env','CHARITYPILOT_RUNTIME_ROLE=cp_runtime','--env','CHARITYPILOT_RUNTIME_PASSWORD=synthetic-runtime-only',
    id,'psql','-X','-q','-U','postgres','-v','ON_ERROR_STOP=1'],readFileSync(new URL('../scripts/bluegreen/runtime-role-grants.psql',import.meta.url),'utf8'));
  check('Linux migration image refuses wrong hostname',()=>{
    const r=child([...common,migrationImage],toStrictPrismaTlsUrl(ownerUrl.replace('@localhost:', '@127.0.0.1:')));
    assert.notEqual(r.status,0);
  });
  check('Linux API native Prisma verifies complete post-migration role catalogue',()=>validRole('after-migration'));
  function libpqAttempt({raw=false,trusted=false,explicitSystem=false,hostname='localhost'}={}) {
    const url=new URL(runtimeUrl);url.hostname=hostname;url.searchParams.delete('sslrootcert');
    if(explicitSystem) url.searchParams.set('sslrootcert','system');
    const args=['run','--rm','--pull=never','--user','65534:65534','--network','container:'+id,
      '--read-only','--tmpfs','/tmp','--cap-drop','ALL','--security-opt','no-new-privileges:true',
      ...(trusted?['--mount','type=bind,source='+join(certDir,'cert.pem')+',target=/etc/ssl/certs/ca-certificates.crt,readonly']:[]),
      '-e','CHARITYPILOT_PROOF_DATABASE_URL',image,'sh','-eu','-c',
      'psql -X --dbname \"$CHARITYPILOT_PROOF_DATABASE_URL\" -Atqc \"SELECT current_user, ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()\"'];
    const environment={...dockerEnv,CHARITYPILOT_PROOF_DATABASE_URL:url.href};
    const transport=raw?{args,env:environment,assertUnchanged(){},close(){}}:prepareDatabaseCaDockerTransport(args,environment);
    try {
      const r=spawnSync('docker',['--host',endpoint.Host,...transport.args],{
        env:transport.env,encoding:'utf8',timeout:15000,maxBuffer:16384});
      transport.assertUnchanged();return r;
    } finally {transport.close();}
  }
  check('raw PostgreSQL16 verified URL without CA fails at missing user root file',()=>{
    const r=libpqAttempt({raw:true,trusted:true});assert.notEqual(r.status,0);assert.match(r.stderr,/root\.crt.*does not exist/s);
  });
  check('default libpq transport refuses an untrusted synthetic certificate',()=>{
    const r=libpqAttempt();assert.notEqual(r.status,0);assert.match(r.stderr,/certificate.*(verify|verification).*fail/i);
  });
  check('default libpq transport verifies against its readonly image CA bundle',()=>{
    const r=libpqAttempt({trusted:true});assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),'cp_runtime|t');
  });
  check('explicit system policy uses the pinned PostgreSQL16 image CA bundle',()=>{
    const r=libpqAttempt({trusted:true,explicitSystem:true});assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),'cp_runtime|t');
  });
  check('default libpq image trust still refuses hostname mismatch',()=>{
    const r=libpqAttempt({trusted:true,hostname:'127.0.0.1'});assert.notEqual(r.status,0);
  });

  for(const [label,url] of [['wrong hostname',runtimeUrl.replace('@localhost:', '@127.0.0.1:')],
    ['wrong password',runtimeUrl.replace('synthetic-runtime-only@','wrong-synthetic-password@')]]) {
    check('Linux API refuses '+label,()=>{const r=roleJob('after-migration',url);assert.notEqual(r.status,0);
      assert.equal(r.stdout,'');assert.equal(r.stderr.trim(),'Runtime database role probe failed.');});
  }
  run(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(certDir,'wrong-key.pem'),
    '-out',join(certDir,'wrong-cert.pem'),'-days','1','-subj','/CN=UnrelatedSyntheticCA',
    '-addext','basicConstraints=critical,CA:TRUE']);
  check('Linux API refuses an unrelated CA',()=>{
    const args=[...common,'--entrypoint','node',runtimeImage,'dist/jobs/verify-runtime-database-role.js']
      .map(value=>value.replace('source='+join(certDir,'cert.pem')+',','source='+join(certDir,'wrong-cert.pem')+','));
    const r=child(args,runtimeUrl,JSON.stringify({...target,phase:'after-migration'}));
    assert.notEqual(r.status,0);assert.equal(r.stdout,'');
    assert.equal(r.stderr.trim(),'Runtime database role probe failed.');
  });
  query('GRANT UPDATE ON public."DocumentRecoveryEnforcement" TO cp_runtime;');
  check('Linux API refuses a protected-table write grant',()=>{const r=roleJob();assert.notEqual(r.status,0);assert.equal(r.stdout,'');});
  query('REVOKE UPDATE ON public."DocumentRecoveryEnforcement" FROM cp_runtime;');
  check('Linux API restored positive control',()=>validRole('after-migration'));
  check('Linux API factory supports atomic tenant/Owner operations and update/read',()=>{
    const code=`import {createApplicationPrismaClient} from './dist/utils/application-prisma-client.js';
      const db=await createApplicationPrismaClient();try{
        const org=await db.$transaction(async tx=>{const o=await tx.organisation.create({data:{name:'Synthetic Linux proof'}});
          await tx.user.create({data:{email:'linux-proof@example.invalid',name:'Synthetic Owner',passwordHash:'not-a-usable-login',role:'OWNER',organisationId:o.id}});return o;});
        await db.organisation.update({where:{id:org.id},data:{name:'Synthetic Linux updated'}});
        const value=await db.organisation.findUniqueOrThrow({where:{id:org.id}});
        if(value.name!=='Synthetic Linux updated')throw new Error('synthetic operation refused');process.stdout.write('verified');
      }finally{await db.$disconnect();}`;
    const r=child([...common,'--entrypoint','node',runtimeImage,'--input-type=module','-e',code]);
    assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,'verified');
  });
  process.stdout.write(JSON.stringify(result)+'\n');
} finally {
  try {if(id) docker(['rm','--force',id]);}
  finally {rmSync(certDir,{recursive:true,force:true});}
}
});
