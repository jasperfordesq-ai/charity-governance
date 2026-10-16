import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { validateLocalDockerEndpoint } from './personal-server-docker-boundary.mjs';
import { PRODUCTION_RUNTIME_DATABASE_ROLE_SQL as sql, PRODUCTION_RUNTIME_PROTECTED_TABLES as tables,
  PRODUCTION_RUNTIME_MAINTENANCE_FUNCTIONS as functions } from '../apps/api/dist/services/production-runtime-database-role.js';

const image = 'postgres@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c';
function run(command,args,options={}) {
  const result = spawnSync(command,args,{ encoding:'utf8', timeout:30000, maxBuffer:1024*1024, ...options });
  assert.equal(result.status,0, result.stderr || result.error?.message || 'synthetic fixture command failed');
  return result.stdout.trim();
}
test('production runtime catalogue probe uses TLS login and rejects compound privilege faults', { timeout:60000 }, async () => {
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
    '-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-addext','basicConstraints=critical,CA:TRUE']);
  id = docker(['run','--detach','--network','none','--name',name,'--tmpfs','/var/lib/postgresql/data','--tmpfs','/tmp',
    '--env','POSTGRES_PASSWORD=synthetic-maintenance-only','--env','POSTGRES_HOST_AUTH_METHOD=scram-sha-256',
    '--env','POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=trust',
    '--entrypoint','sh',image,'-eu','-c',
    'while [ ! -f /tmp/role-ready ]; do sleep 0.1; done; chown postgres:postgres /tmp/cert.pem /tmp/key.pem; chmod 600 /tmp/key.pem; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/cert.pem -c ssl_key_file=/tmp/key.pem']);
  assert.match(id,/^[a-f0-9]{64}$/);
  // exec writes into the running tmpfs mount; Docker cp did not do so here.
  docker(['exec','-i',id,'sh','-c','cat > /tmp/cert.pem'],readFileSync(join(certDir,'cert.pem')));
  docker(['exec','-i',id,'sh','-c','cat > /tmp/key.pem'],readFileSync(join(certDir,'key.pem')));
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
  function check(label,actual,expected) {assert.equal(actual,expected,label); checks++;process.stdout.write(`PASS ${label}\n`);}
  check('TLS login and safe catalogue positive control',probe(),'t');
  check('plaintext connection refuses',probe('cp_runtime','postgres',true,'disable'),'f');
  check('wrong expected role refuses',probe('missing_runtime'),'f');
  check('wrong database refuses',probe('cp_runtime','wrong_database'),'f');
  check('SET ROLE cannot impersonate a fresh login',probe('cp_runtime','postgres',true,'verify-full','postgres','SET ROLE cp_runtime;'),'f');
  query('ALTER ROLE cp_runtime CREATEDB;');check('elevated role refuses',probe(),'f');query('ALTER ROLE cp_runtime NOCREATEDB;');
  query('GRANT postgres TO cp_runtime;');check('role membership refuses',probe(),'f');query('REVOKE postgres FROM cp_runtime;');
  query('GRANT UPDATE ON public."DocumentRecoveryEnforcement" TO cp_runtime;');check('protected write grant refuses',probe(),'f');
  query('REVOKE UPDATE ON public."DocumentRecoveryEnforcement" FROM cp_runtime;');
  query('GRANT EXECUTE ON FUNCTION public."ConfluenceCopyLedgerRecovery_assert"() TO PUBLIC;');check('maintenance PUBLIC EXECUTE refuses',probe(),'f');
  query('REVOKE EXECUTE ON FUNCTION public."ConfluenceCopyLedgerRecovery_assert"() FROM PUBLIC;');
  query(`CREATE FUNCTION public.synthetic_unsafe_definer() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';`);
  check('unknown callable SECURITY DEFINER refuses',probe(),'f');
  query(`ALTER FUNCTION public.synthetic_unsafe_definer() SET search_path=pg_catalog,public,pg_temp;
    REVOKE ALL ON FUNCTION public.synthetic_unsafe_definer() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.synthetic_unsafe_definer() TO cp_runtime;`);
  check('unknown definer with otherwise safe ACL/search path still refuses',probe(),'f');
  query('DROP FUNCTION public.synthetic_unsafe_definer();');
  query(`CREATE FUNCTION public."DocumentByteExecutionLease_claim"(text,text) RETURNS integer LANGUAGE sql SECURITY DEFINER
    SET search_path=pg_catalog,public,pg_temp AS 'SELECT 1';
    REVOKE ALL ON FUNCTION public."DocumentByteExecutionLease_claim"(text,text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public."DocumentByteExecutionLease_claim"(text,text) TO cp_runtime;`);
  check('exact allowed helper with pinned attributes passes',probe(),'t');
  query('ALTER FUNCTION public."DocumentByteExecutionLease_claim"(text,text) RESET search_path;');
  check('allowed helper without pinned search path refuses',probe(),'f');
  query('DROP FUNCTION public."DocumentByteExecutionLease_claim"(text,text);');
  query(`DROP FUNCTION public."ConfluenceCopyRecovery_rows"();
    CREATE FUNCTION public."ConfluenceCopyRecovery_replay"(text) RETURNS integer LANGUAGE sql
    SET search_path=pg_catalog,public,pg_temp AS 'SELECT 1';
    REVOKE ALL ON FUNCTION public."ConfluenceCopyRecovery_replay"(text) FROM PUBLIC;`);
  check('overload cannot replace a missing maintenance function name',probe(),'f');
  query(`DROP FUNCTION public."ConfluenceCopyRecovery_replay"(text);
    CREATE FUNCTION public."ConfluenceCopyRecovery_rows"() RETURNS integer LANGUAGE sql SET search_path=pg_catalog,public,pg_temp AS 'SELECT 1';
    REVOKE ALL ON FUNCTION public."ConfluenceCopyRecovery_rows"() FROM PUBLIC;`);
  query('DROP TABLE public."DocumentRecoveryEnforcement";');
  check('missing protected table refuses after migration',probe(),'f');
  check('missing later table permitted before migration',probe('cp_runtime','postgres',false),'t');
  query('CREATE TABLE public."DocumentRecoveryEnforcement"(id text PRIMARY KEY); GRANT SELECT ON public."DocumentRecoveryEnforcement" TO cp_runtime;');
  check('restored positive control',probe(),'t');
  const wrongPassword = spawnSync('docker',['--host',endpoint.Host,'exec','--env','PGPASSWORD=wrong-synthetic-password',
    '--env','PGSSLMODE=verify-full','--env','PGSSLROOTCERT=/tmp/cert.pem',id,'psql','-X','-h','localhost','-U','cp_runtime','-d','postgres','-Atqc','SELECT current_user'],{encoding:'utf8',timeout:10000});
  assert.notEqual(wrongPassword.status,0);checks++;
  process.stdout.write(`PASS wrong password refuses\n${checks} real PostgreSQL TLS/catalogue checks passed\n`);
} finally {
  try { if (id) docker(['rm','--force',id]); }
  finally { rmSync(certDir,{recursive:true,force:true}); }
}
});
