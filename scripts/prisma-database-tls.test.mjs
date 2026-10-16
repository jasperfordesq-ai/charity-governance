import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { validateLocalDockerEndpoint } from './personal-server-docker-boundary.mjs';
import { toStrictPrismaTlsUrl } from '../packages/shared/runtime/prisma-database-url.mjs';
import { PrismaClient } from '@prisma/client';
import { verifyProductionRuntimeDatabaseRole } from '../apps/api/dist/services/production-runtime-database-role.js';
import { PRODUCTION_RUNTIME_DATABASE_ROLE_SQL as sql, PRODUCTION_RUNTIME_PROTECTED_TABLES as tables,
  PRODUCTION_RUNTIME_MAINTENANCE_FUNCTIONS as functions } from '../apps/api/dist/services/production-runtime-database-role.js';

const image = 'postgres@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c';
function run(command,args,options={}) {
  const result = spawnSync(command,args,{ encoding:'utf8', timeout:30000, maxBuffer:1024*1024, ...options });
  assert.equal(result.status,0, result.stderr || result.error?.message || 'synthetic fixture command failed');
  return result.stdout.trim();
}
test('strict Prisma TLS transport rejects wrong CA, hostname, password and plaintext', { timeout:60000 }, async () => {
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
  const query = (statement,role='postgres',sslmode='verify-full') => docker(['exec','-i',
    '--env',`PGPASSWORD=${role==='postgres'?'synthetic-maintenance-only':'synthetic-runtime-only'}`,
    '--env',`PGSSLMODE=${sslmode}`,'--env','PGSSLROOTCERT=/tmp/cert.pem',id,'psql',
    '-X','-h','localhost','-U',role,'-d','postgres','-v','ON_ERROR_STOP=1','-Atq'],statement);
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
    const client = new PrismaClient({datasources:{db:{url:url.href}},log:[],errorFormat:'minimal'});
    try {
      const rows=await client.$queryRawUnsafe('SELECT current_user, ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()');
      try {
        await verifyProductionRuntimeDatabaseRole(client,{runtimeRole:'cp_runtime',maintenanceRole:'postgres',database:'postgres',phase:'after-migration'});
        return {connected:true,verified:true,tls:rows[0].ssl};
      } catch {return {connected:true,verified:false,tls:rows[0].ssl};}
    } catch {
      return {connected:false};
    } finally {await client.$disconnect();}
  }
  const positive={connected:true,verified:true,tls:true};
  check('fresh Prisma login, TLS and actual transaction wrapper',await prismaAttempt(),positive);
  check('Prisma wrong hostname refuses',await prismaAttempt({hostname:'127.0.0.1'}),{connected:false});
  check('Prisma untrusted certificate refuses',await prismaAttempt({ca:false}),{connected:false});
  check('Prisma wrong password refuses',await prismaAttempt({password:'wrong-synthetic-password'}),{connected:false});
  run(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(certDir,'wrong-key.pem'),'-out',join(certDir,'wrong-cert.pem'),
    '-days','1','-subj','/CN=wrong-root','-addext','basicConstraints=critical,CA:TRUE']);
  check('Prisma explicitly wrong CA refuses',await prismaAttempt({ca:join(certDir,'wrong-cert.pem')}),{connected:false});
  check('catalogue wrapper refuses a plaintext client',await prismaAttempt({plaintext:true}),{connected:true,verified:false,tls:false});
  query('ALTER ROLE cp_runtime SET default_transaction_read_only=on;');
  check('catalogue wrapper refuses a read-only target',await prismaAttempt(),{connected:true,verified:false,tls:true});
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
  process.stdout.write(`${checks} real TLS/Prisma checks passed\n`);
} finally {
  try { if (id) docker(['rm','--force',id]); }
  finally { rmSync(certDir,{recursive:true,force:true}); }
}
});
