import { rootCertificates } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { productionPrismaMaintenanceEnvironment } from './production-runtime-credentials.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildProductionComposeEnvironment } from './production-runtime-credentials.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const source = join(repo, 'compose.production.yml');
const overlay = join(repo, 'compose.production.roles.yml');
const maintenanceUrl = 'postgresql://migration_owner:synthetic-owner-only@db.charitypilot.ie:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write';
const runtimeUrl = 'postgresql://cp_runtime:synthetic-runtime-only@db.charitypilot.ie:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write';

function fixture(t,withCa=false) {
  const directory = mkdtempSync(join(tmpdir(), 'charitypilot-runtime-compose-'));
  t.after(() => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('charitypilot-runtime-compose-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const ownerFile = join(directory, 'maintenance.env'), appFile = join(directory, 'app.env');
  const required = [...(readFileSync(source,'utf8')+readFileSync(overlay,'utf8')).matchAll(/\$\{([A-Z][A-Z0-9_]*):\?/g)].map(match => match[1]);
  const values = Object.fromEntries(required.filter(name => name !== 'CHARITYPILOT_PRODUCTION_RUNTIME_DATABASE_URL')
    .map(name => [name, 'synthetic-only']));
  for (const name of ['CHARITYPILOT_API_IMAGE','CHARITYPILOT_WEB_IMAGE','CHARITYPILOT_MIGRATION_IMAGE']) {
    values[name] = 'synthetic.invalid/charitypilot:review-only';
  }
  const caFile=join(directory,'database-ca.pem');
  if(withCa) {const pem=rootCertificates.find(p=>{const cert=new X509Certificate(p);
    return cert.ca&&Date.parse(cert.validFrom)<Date.now()&&Date.parse(cert.validTo)>Date.now();});
    assert.ok(pem);writeFileSync(caFile,pem,{mode:0o644});}
  const caSuffix=withCa?'&sslrootcert='+encodeURIComponent(caFile):'';
  values.DATABASE_URL = maintenanceUrl+caSuffix;
  values.CHARITYPILOT_PRODUCTION_APP_ENV_FILE = appFile;
  const encode = entries => entries.map(([key,value]) => `${key}='${value}'`).join('\n') + '\n';
  writeFileSync(ownerFile, encode([...Object.entries(values),['MIGRATION_OPERATOR_ONLY_SECRET','synthetic-maintenance-marker']]), { mode: 0o600 });
  writeFileSync(appFile, encode(Object.entries(values).filter(([name]) => !name.startsWith('CHARITYPILOT_PRODUCTION_'))
    .map(([name,value]) => [name, name === 'DATABASE_URL' ? runtimeUrl+caSuffix : value])), { mode: 0o600 });
  const transport = buildProductionComposeEnvironment(ownerFile, { ...process.env,
    DATABASE_URL: 'unreviewed-ambient', CHARITYPILOT_PRODUCTION_APP_ENV_FILE: ownerFile,
    CHARITYPILOT_PRODUCTION_RUNTIME_DATABASE_URL: maintenanceUrl });
  const render = (overrides = {}) => spawnSync('docker', ['compose','--env-file',transport.binding.maintenancePath,
    '-f',source,'-f',overlay,...(withCa?['-f',join(repo,'compose.production.database-ca.yml')]:[]),'--profile','*','config','--format','json'], {
    cwd: repo, env: { ...transport.environment, ...overrides }, encoding: 'utf8', timeout: 30000,
  });
  return { transport, render, caFile };
}

test('rendered production runtime services never receive the migration credential', t => {
  const f = fixture(t), result = f.render();
  assert.equal(result.status, 0, result.stderr);
  const services = JSON.parse(result.stdout).services;
  assert.equal(services.api.environment.MIGRATION_OPERATOR_ONLY_SECRET,undefined,'runtime env_file must replace, not merge maintenance values');
  for (const name of ['api','production-scheduler','deadline-reminders','document-storage-cleanup','document-publication']) {
    assert.equal(services[name].environment.DATABASE_URL, runtimeUrl, name);
    assert.ok(!JSON.stringify(services[name].environment).includes('synthetic-owner-only'), name);
  }
  for (const name of ['migrate','auth-recovery-secret-rotation']) {
    assert.equal(services[name].environment.DATABASE_URL, maintenanceUrl, name);
  }
  assert.equal(services['runtime-role-check'].environment.DATABASE_URL,runtimeUrl);
  assert.deepEqual(Object.keys(services['runtime-role-check'].environment).sort(),['CHARITYPILOT_DEPLOYMENT_MODE','DATABASE_URL','NODE_ENV']);
  assert.equal(services['runtime-role-check'].ports,undefined);
  // Ordinary workers retain their explicit secret allowlists instead of
  // inheriting the complete API environment to obtain one database value.
  for (const name of ['production-scheduler','deadline-reminders','document-storage-cleanup','document-publication']) {
    assert.equal(services[name].environment.OWNER_JWT_SECRET, undefined, name);
  }
});

test('production configuration has no owner fallback when derived runtime input is absent', t => {
  const f = fixture(t), result = f.render({ CHARITYPILOT_PRODUCTION_RUNTIME_DATABASE_URL: '' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CHARITYPILOT_PRODUCTION_RUNTIME_DATABASE_URL/);
});

test('effective CA overlay mounts only the reviewed public certificate on every database consumer',t=>{
  const f=fixture(t,true), rendered=f.render();assert.equal(rendered.status,0,rendered.stderr);
  const services=JSON.parse(rendered.stdout).services;
  for(const name of ['api','production-scheduler','deadline-reminders','document-storage-cleanup',
    'document-publication','runtime-role-check','migrate','auth-recovery-secret-rotation']) {
    const ca=services[name].volumes.find(v=>v.target==='/run/charitypilot/database-ca.pem');
    assert.equal(ca.type,'bind');assert.equal(ca.read_only,true);
    assert.equal(ca.source.replaceAll('\\','/'),f.caFile.replaceAll('\\','/'));
    assert.equal(ca.bind.create_host_path,false);
    assert.equal(new URL(services[name].environment.DATABASE_URL).searchParams.get('sslrootcert'),ca.target);
  }
  assert.equal(services.web.volumes,undefined);
  const cli=f.render(productionPrismaMaintenanceEnvironment(f.transport.environment));
  assert.equal(cli.status,0,cli.stderr);
  const url=new URL(JSON.parse(cli.stdout).services.migrate.environment.DATABASE_URL);
  assert.equal(url.searchParams.get('sslcert'),'/run/charitypilot/database-ca.pem');
  assert.equal(url.searchParams.get('sslaccept'),'strict');
});
