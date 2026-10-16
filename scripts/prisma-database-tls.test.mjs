import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateLocalDockerEndpoint } from './personal-server-docker-boundary.mjs';
import { toStrictPrismaTlsUrl } from '../packages/shared/runtime/prisma-database-url.mjs';
import { PrismaClient } from '@prisma/client';
import { verifyProductionRuntimeDatabaseRole } from '../apps/api/dist/services/production-runtime-database-role.js';
import { createApplicationPrismaClient } from '../apps/api/dist/utils/application-prisma-client.js';
import { PRODUCTION_RUNTIME_DATABASE_ROLE_SQL as sql, PRODUCTION_RUNTIME_PROTECTED_TABLES as tables,
  PRODUCTION_RUNTIME_MAINTENANCE_FUNCTIONS as functions } from '../apps/api/dist/services/production-runtime-database-role.js';

const image = 'postgres@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c';
function run(command,args,options={}) {
  const result = spawnSync(command,args,{ encoding:'utf8', timeout:30000, maxBuffer:1024*1024, ...options });
  assert.equal(result.status,0, result.stderr || result.error?.message || 'synthetic fixture command failed');
  return result.stdout.trim();
}
test('strict Prisma application and CLI TLS reject wrong CA, hostname, password and plaintext', { timeout:180000 }, async () => {
const endpoint = JSON.parse(run('docker',['context','inspect','--format','{{json .Endpoints.docker}}']));
validateLocalDockerEndpoint({endpoint:endpoint.Host,skipTlsVerify:endpoint.SkipTLSVerify},process.env);
const docker = (args,input) => run('docker',['--host',endpoint.Host,...args],{ input });
assert.equal(docker(['info','--format','{{.OSType}}']),'linux');
const certDir = mkdtempSync(join(tmpdir(),'charitypilot-role-tls-'));
assert.equal(dirname(resolve(certDir)),resolve(tmpdir()));
assert.ok(basename(certDir).startsWith('charitypilot-role-tls-'));
const name = `charitypilot-role-proof-${randomUUID()}`;
let id;
let checks = 0;
try {
  const openssl = process.platform==='win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl';
  run(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(certDir,'key.pem'),'-out',join(certDir,'cert.pem'),
    '-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-addext','basicConstraints=critical,CA:TRUE']);
  id = docker(['run','--detach','--network','bridge','--publish','127.0.0.1::5432','--name',name,'--tmpfs','/var/lib/postgresql/data','--tmpfs','/tmp',
    '--env','POSTGRES_PASSWORD=synthetic-maintenance-only','--env','POSTGRES_HOST_AUTH_METHOD=scram-sha-256',
    '--env','POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=trust',
    '--entrypoint','sh',image,'-eu','-c',
    'while [ ! -f /tmp/role-ready ]; do sleep 0.1; done; chown postgres:postgres /tmp/cert.pem /tmp/key.pem; chmod 600 /tmp/key.pem; exec docker-entrypoint.sh postgres -c ssl_cert_file=/tmp/cert.pem -c ssl_key_file=/tmp/key.pem']);
  assert.match(id,/^[a-f0-9]{64}$/);
  // exec writes into the running tmpfs mount; Docker cp did not do so here.
  docker(['exec','-i',id,'sh','-c','cat > /tmp/cert.pem'],readFileSync(join(certDir,'cert.pem')));
  docker(['exec','-i',id,'sh','-c','cat > /tmp/key.pem'],readFileSync(join(certDir,'key.pem')));
  // Enable TLS through configuration so the final test can actually disable it
  // by reload. A command-line ssl=on setting would override ALTER SYSTEM.
  docker(['exec','-i',id,'sh','-c','cat > /docker-entrypoint-initdb.d/001-role-tls.sh'],
    'printf "\\nssl=on\\n" >> "$PGDATA/postgresql.conf"\n');
  docker(['exec',id,'touch','/tmp/role-ready']);
  let ready = false;
  for (let attempt=0;attempt<100;attempt++) {
    const result = spawnSync('docker',['--host',endpoint.Host,'exec',id,'pg_isready','-h','127.0.0.1','-U','postgres'],{encoding:'utf8',timeout:5000});
    if(result.status===0) {ready=true;break;}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  if (!ready) {
    const logs = spawnSync('docker',['--host',endpoint.Host,'logs',id],{encoding:'utf8',timeout:10000});
    throw new Error(`disposable TLS PostgreSQL did not start: ${(logs.stdout+logs.stderr).slice(-3000)}`);
  }
  const query = (statement,role='postgres',sslmode='verify-full',database='postgres') => docker(['exec','-i',
    '--env',`PGPASSWORD=${role==='postgres'?'synthetic-maintenance-only':'synthetic-runtime-only'}`,
    '--env',`PGSSLMODE=${sslmode}`,'--env','PGSSLROOTCERT=/tmp/cert.pem',id,'psql',
    '-X','-h','localhost','-U',role,'-d',database,'-v','ON_ERROR_STOP=1','-Atq'],statement);
  query(`CREATE ROLE cp_runtime LOGIN PASSWORD 'synthetic-runtime-only' NOINHERIT;
    GRANT CONNECT ON DATABASE postgres TO cp_runtime; GRANT USAGE ON SCHEMA public TO cp_runtime;
    ${tables.map(name=>`CREATE TABLE public."${name}" (id text PRIMARY KEY); GRANT SELECT ON public."${name}" TO cp_runtime;`).join('\n')}
    ${functions.map(name=>`CREATE FUNCTION public."${name}"() RETURNS integer LANGUAGE sql SET search_path=pg_catalog,public,pg_temp AS 'SELECT 1'; REVOKE ALL ON FUNCTION public."${name}"() FROM PUBLIC;`).join('\n')}`);
  const probe = (runtime='cp_runtime',database='postgres',after=true,sslmode='verify-full',role='cp_runtime',prefix='') => query(`
    ${prefix} BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
    SET LOCAL search_path=pg_catalog,public,pg_temp;
    PREPARE role_probe(text,text,text,boolean) AS ${sql};
    EXECUTE role_probe('${runtime}','postgres','${database}',${after}); ROLLBACK;`,role,sslmode);
  function check(label,actual,expected) {assert.deepEqual(actual,expected,label); checks++;process.stdout.write(`PASS ${label}\n`);}
  check('TLS login and safe catalogue positive control',probe(),'t');
  const port = /^127\.0\.0\.1:(\d+)$/u.exec(docker(['port',id,'5432/tcp']))?.[1];
  assert.ok(port,'fixture must publish only to loopback');
  async function prismaAttempt(options={}) {
    const canonical = new URL(`postgresql://cp_runtime:synthetic-runtime-only@${options.hostname??'localhost'}:${port}/postgres`);
    canonical.searchParams.set('connect_timeout','3');
    canonical.searchParams.set('sslmode','verify-full');
    canonical.searchParams.set('target_session_attrs','read-write');
    if(options.ca!==false) canonical.searchParams.set('sslrootcert',options.ca??join(certDir,'cert.pem'));
    if(options.password) canonical.password=options.password;
    const url = options.plaintext ? new URL(canonical) : new URL(toStrictPrismaTlsUrl(canonical.href));
    if(options.plaintext) url.searchParams.set('sslmode','disable');
    let client;
    try {
      client=options.applicationFactory
        ? await createApplicationPrismaClient({DATABASE_URL:canonical.href,CHARITYPILOT_DEPLOYMENT_MODE:'production'})
        : new PrismaClient({datasources:{db:{url:url.href}},log:[],errorFormat:'minimal'});
      const rows=await client.$queryRawUnsafe('SELECT current_user, ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()');
      try {
        await verifyProductionRuntimeDatabaseRole(client,{runtimeRole:'cp_runtime',maintenanceRole:'postgres',database:'postgres',phase:'after-migration'});
        return {connected:true,verified:true,tls:rows[0].ssl};
      } catch {return {connected:true,verified:false,tls:rows[0].ssl};}
    } catch {
      return {connected:false};
    } finally {await client?.$disconnect();}
  }
  function cliAttempt(options={}) {
    const canonical=new URL(`postgresql://cp_runtime:synthetic-runtime-only@${options.hostname??'localhost'}:${port}/postgres`);
    canonical.searchParams.set('sslmode','verify-full');canonical.searchParams.set('target_session_attrs','read-write');
    canonical.searchParams.set('connect_timeout','3');canonical.searchParams.set('sslrootcert',options.ca??join(certDir,'cert.pem'));
    if(options.password) canonical.password=options.password;
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('../node_modules/prisma/build/index.js',import.meta.url)),
      'db','execute','--schema',fileURLToPath(new URL('../apps/api/prisma/schema.prisma',import.meta.url)),'--stdin'],{
      encoding:'utf8',timeout:15000,maxBuffer:1024*1024,
      env:{...process.env,DATABASE_URL:toStrictPrismaTlsUrl(canonical.href),CHECKPOINT_DISABLE:'1',PRISMA_HIDE_UPDATE_MESSAGE:'1'},
      // Terminal assertion: no later ROLLBACK can mask a DO failure in the CLI.
      input:`BEGIN TRANSACTION READ ONLY; DO $probe$ BEGIN
        IF current_user <> 'cp_runtime' OR NOT EXISTS(SELECT 1 FROM pg_stat_ssl WHERE pid=pg_backend_pid() AND ssl)
        THEN RAISE EXCEPTION 'synthetic TLS identity refused'; END IF; END $probe$;`,
    });
    return result.status===0;
  }
  function roleJobAttempt(phase='after-migration',rawInput) {
    const canonical=new URL(`postgresql://cp_runtime:synthetic-runtime-only@localhost:${port}/postgres`);
    canonical.searchParams.set('sslmode','verify-full');canonical.searchParams.set('target_session_attrs','read-write');
    canonical.searchParams.set('sslrootcert',join(certDir,'cert.pem'));canonical.searchParams.set('connect_timeout','3');
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('../apps/api/dist/jobs/verify-runtime-database-role.js',import.meta.url))],{
      encoding:'utf8',timeout:15000,maxBuffer:16384,
      env:{...process.env,NODE_ENV:'production',CHARITYPILOT_DEPLOYMENT_MODE:'production',DATABASE_URL:canonical.href},
      input:rawInput??JSON.stringify({runtimeRole:'cp_runtime',maintenanceRole:'postgres',database:'postgres',phase}),
    });
    if(result.status!==0) {
      assert.equal(result.stdout,'');assert.equal(result.stderr.trim(),'Runtime database role probe failed.');
      return false;
    }
    assert.deepEqual(JSON.parse(result.stdout),{schemaVersion:1,verified:true,phase});
    return true;
  }
  const migrationRoot=join(certDir,'cli-migration');
  const migrationDir=join(migrationRoot,'migrations','20261016000000_synthetic_tls');
  mkdirSync(migrationDir,{recursive:true});
  const migrationSchema=join(migrationRoot,'schema.prisma');
  writeFileSync(migrationSchema,'datasource db {\n provider = "postgresql"\n url = env("DATABASE_URL")\n}\nmodel SyntheticTlsMigration {\n id String @id\n @@map("synthetic_tls_migration")\n}\n');
  writeFileSync(join(migrationRoot,'migrations','migration_lock.toml'),'provider = "postgresql"\n');
  writeFileSync(join(migrationDir,'migration.sql'),'CREATE TABLE "synthetic_tls_migration" ("id" TEXT PRIMARY KEY);\n');
  query('CREATE DATABASE synthetic_cli_tls;');
  function cliMigrateAttempt(hostname='localhost') {
    const canonical=new URL(`postgresql://postgres:synthetic-maintenance-only@${hostname}:${port}/synthetic_cli_tls`);
    canonical.searchParams.set('sslmode','verify-full');canonical.searchParams.set('target_session_attrs','read-write');
    canonical.searchParams.set('sslrootcert',join(certDir,'cert.pem'));canonical.searchParams.set('connect_timeout','3');
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('../node_modules/prisma/build/index.js',import.meta.url)),
      'migrate','deploy','--schema',migrationSchema],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024,
      env:{...process.env,DATABASE_URL:toStrictPrismaTlsUrl(canonical.href),CHECKPOINT_DISABLE:'1',PRISMA_HIDE_UPDATE_MESSAGE:'1'}});
    return result.status===0;
  }
  // Full current source schema: this complements, rather than replaces, the
  // fault-isolation fixture above. No production credentials or provider IO.
  query('CREATE DATABASE synthetic_full_source;');
  const fullMaintenance=new URL(`postgresql://postgres:synthetic-maintenance-only@localhost:${port}/synthetic_full_source`);
  fullMaintenance.searchParams.set('sslmode','verify-full');
  fullMaintenance.searchParams.set('target_session_attrs','read-write');
  fullMaintenance.searchParams.set('sslrootcert',join(certDir,'cert.pem'));
  fullMaintenance.searchParams.set('connect_timeout','3');
  const fullMigration=spawnSync(process.execPath,[fileURLToPath(new URL('../node_modules/prisma/build/index.js',import.meta.url)),
    'migrate','deploy','--schema',fileURLToPath(new URL('../apps/api/prisma/schema.prisma',import.meta.url))],{
    encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,
    env:{...process.env,DATABASE_URL:toStrictPrismaTlsUrl(fullMaintenance.href),CHECKPOINT_DISABLE:'1',PRISMA_HIDE_UPDATE_MESSAGE:'1'}});
  assert.equal(fullMigration.status,0,fullMigration.stderr||fullMigration.stdout);
  const sourceMigrations=readdirSync(fileURLToPath(new URL('../apps/api/prisma/migrations/',import.meta.url)),{withFileTypes:true})
    .filter(entry=>entry.isDirectory()).length;
  check('full source migration ledger has no failed or unfinished migrations',
    query('SELECT count(*) FROM public.\"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
      'postgres','verify-full','synthetic_full_source'),String(sourceMigrations));
  const reconcileFull=()=>docker(['exec','-i','--env','CHARITYPILOT_RUNTIME_ROLE=cp_runtime',
    '--env','CHARITYPILOT_RUNTIME_PASSWORD=synthetic-runtime-only',id,'psql','-X','-q','-U','postgres',
    '-d','synthetic_full_source','-v','ON_ERROR_STOP=1'],
    readFileSync(fileURLToPath(new URL('bluegreen/runtime-role-grants.psql',import.meta.url)),'utf8'));
  reconcileFull();
  const fullRuntime=new URL(fullMaintenance.href);fullRuntime.username='cp_runtime';fullRuntime.password='synthetic-runtime-only';
  const fullClient=await createApplicationPrismaClient({DATABASE_URL:fullRuntime.href,CHARITYPILOT_DEPLOYMENT_MODE:'production'});
  try {
    const target={runtimeRole:'cp_runtime',maintenanceRole:'postgres',database:'synthetic_full_source',phase:'after-migration'};
    check('full source schema reconciled runtime passes actual catalogue checker',
      await verifyProductionRuntimeDatabaseRole(fullClient,target),{verified:true,phase:'after-migration'});
    for(const table of tables) {
      await assert.rejects(fullClient.$executeRawUnsafe(`DELETE FROM public."${table}" WHERE false`),
        error=>error.meta?.code==='42501');
      checks++;
    }
    await assert.rejects(fullClient.$queryRawUnsafe(`SELECT public."ConfluenceCopyRecovery_rows"('synthetic')`),
      error=>error.meta?.code==='42501');
    checks++;
    process.stdout.write('PASS full schema denies direct DML on all protected tables and maintenance replay entry point\n');
    const {org,user}=await fullClient.$transaction(async tx=>{
      const org=await tx.organisation.create({data:{name:'Synthetic grant compatibility'}});
      const user=await tx.user.create({data:{email:'runtime-grants@example.invalid',name:'Synthetic Owner',
        passwordHash:'synthetic-not-a-usable-login',role:'OWNER',organisationId:org.id}});
      return {org,user};
    });
    await fullClient.organisation.update({where:{id:org.id},data:{name:'Synthetic updated'}});
    check('restricted Prisma application login can create and read ordinary tenant/user records',
      (await fullClient.user.findUniqueOrThrow({where:{id:user.id}})).organisationId,org.id);
    query('CREATE TABLE public.synthetic_later_business (id text PRIMARY KEY);','postgres','verify-full','synthetic_full_source');
    await assert.rejects(fullClient.$queryRawUnsafe('SELECT * FROM public.synthetic_later_business'));
    reconcileFull();
    await fullClient.$executeRawUnsafe(`INSERT INTO public.synthetic_later_business VALUES ('synthetic')`);
    check('grant reconciliation restores access to a newly migrated ordinary table',
      await fullClient.$queryRawUnsafe('SELECT id FROM public.synthetic_later_business'),[{id:'synthetic'}]);
    check('reconciled later table preserves full runtime catalogue restrictions',
      await verifyProductionRuntimeDatabaseRole(fullClient,target),{verified:true,phase:'after-migration'});
  } finally {await fullClient.$disconnect();}
  const positive={connected:true,verified:true,tls:true};
  check('fresh Prisma login, TLS and actual transaction wrapper',await prismaAttempt(),positive);
  check('actual application factory verifies strict TLS and target',await prismaAttempt({applicationFactory:true}),positive);
  check('actual role job before migration emits verified receipt',roleJobAttempt('before-migration'),true);
  check('actual role job after migration emits verified receipt',roleJobAttempt(),true);
  check('actual role job refuses oversized stdin before connecting',roleJobAttempt('after-migration',' '.repeat(4097)),false);
  query('GRANT UPDATE ON public."DocumentRecoveryEnforcement" TO cp_runtime;');
  check('actual role job refuses protected-table write authority',roleJobAttempt(),false);
  query('REVOKE UPDATE ON public."DocumentRecoveryEnforcement" FROM cp_runtime;');
  check('actual role job positive control after grant rollback',roleJobAttempt(),true);
  check('Prisma wrong hostname refuses',await prismaAttempt({hostname:'127.0.0.1'}),{connected:false});
  check('application factory refuses wrong hostname',await prismaAttempt({applicationFactory:true,hostname:'127.0.0.1'}),{connected:false});
  check('actual Prisma CLI strict TLS positive',cliAttempt(),true);
  check('actual Prisma CLI wrong hostname refuses',cliAttempt({hostname:'127.0.0.1'}),false);
  check('actual migrate deploy accepts strict TLS',cliMigrateAttempt(),true);
  assert.equal(query("SELECT to_regclass('public.synthetic_tls_migration') IS NOT NULL",'postgres','verify-full','synthetic_cli_tls'),'t');
  check('actual migrate deploy wrong hostname refuses',cliMigrateAttempt('127.0.0.1'),false);
  check('Prisma untrusted certificate refuses',await prismaAttempt({ca:false}),{connected:false});
  check('Prisma wrong password refuses',await prismaAttempt({password:'wrong-synthetic-password'}),{connected:false});
  run(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(certDir,'wrong-key.pem'),'-out',join(certDir,'wrong-cert.pem'),
    '-days','1','-subj','/CN=wrong-root','-addext','basicConstraints=critical,CA:TRUE']);
  check('Prisma explicitly wrong CA refuses',await prismaAttempt({ca:join(certDir,'wrong-cert.pem')}),{connected:false});
  check('application factory refuses wrong CA',await prismaAttempt({applicationFactory:true,ca:join(certDir,'wrong-cert.pem')}),{connected:false});
  check('actual Prisma CLI wrong CA refuses',cliAttempt({ca:join(certDir,'wrong-cert.pem')}),false);
  check('actual Prisma CLI wrong password refuses',cliAttempt({password:'wrong-synthetic-password'}),false);
  check('catalogue wrapper refuses a plaintext client',await prismaAttempt({plaintext:true}),{connected:true,verified:false,tls:false});
  query('ALTER ROLE cp_runtime SET default_transaction_read_only=on;');
  check('catalogue wrapper refuses a read-only target',await prismaAttempt(),{connected:true,verified:false,tls:true});
  check('application factory refuses the actual read-only connection',await prismaAttempt({applicationFactory:true}),{connected:false});
  query('ALTER ROLE cp_runtime RESET default_transaction_read_only;');
  check('Prisma positive control after faults',await prismaAttempt(),positive);
  query('ALTER SYSTEM SET ssl=off; SELECT pg_reload_conf();');
  let disabled=false;
  for(let attempt=0;attempt<30;attempt++) {
    if(query('SHOW ssl','postgres','disable')==='off') {disabled=true;break;}
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.ok(disabled,'synthetic server TLS must actually be off for fallback refusal proof');
  check('Prisma requires TLS when server no longer offers it',await prismaAttempt(),{connected:false});
  check('application factory refuses a TLS-disabled server',await prismaAttempt({applicationFactory:true}),{connected:false});
  check('actual Prisma CLI requires TLS',cliAttempt(),false);
  check('actual migrate deploy requires TLS',cliMigrateAttempt(),false);
  process.stdout.write(`${checks} real TLS/Prisma checks passed\n`);
} finally {
  try { if (id) docker(['rm','--force',id]); }
  finally { rmSync(certDir,{recursive:true,force:true}); }
}
});
