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

function fixture(t) {
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
  values.DATABASE_URL = maintenanceUrl;
  values.CHARITYPILOT_PRODUCTION_APP_ENV_FILE = appFile;
  const encode = entries => entries.map(([key,value]) => `${key}='${value}'`).join('\n') + '\n';
  writeFileSync(ownerFile, encode([...Object.entries(values),['MIGRATION_OPERATOR_ONLY_SECRET','synthetic-maintenance-marker']]), { mode: 0o600 });
  writeFileSync(appFile, encode(Object.entries(values).filter(([name]) => name !== 'CHARITYPILOT_PRODUCTION_APP_ENV_FILE')
    .map(([name,value]) => [name, name === 'DATABASE_URL' ? runtimeUrl : value])), { mode: 0o600 });
  const transport = buildProductionComposeEnvironment(ownerFile, { ...process.env,
    DATABASE_URL: 'unreviewed-ambient', CHARITYPILOT_PRODUCTION_APP_ENV_FILE: ownerFile,
    CHARITYPILOT_PRODUCTION_RUNTIME_DATABASE_URL: maintenanceUrl });
  const render = (overrides = {}) => spawnSync('docker', ['compose','--env-file',transport.binding.maintenancePath,
    '-f',source,'-f',overlay,'--profile','*','config','--format','json'], {
    cwd: repo, env: { ...transport.environment, ...overrides }, encoding: 'utf8', timeout: 30000,
  });
  return { transport, render };
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
