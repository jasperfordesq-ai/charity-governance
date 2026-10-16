import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { assertProductionRuntimeEnvironmentUnchanged, buildProductionComposeEnvironment, readProductionRuntimeEnvironment,
  validateProductionRuntimeDatabasePair } from './production-runtime-credentials.mjs';

const owner = 'postgresql://migration_owner:synthetic-owner-password@db.charitypilot.ie:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write';
const runtime = 'postgresql://cp_runtime:synthetic-runtime-password@db.charitypilot.ie/charitypilot?target_session_attrs=read-write&sslmode=verify-full';

test('production role pair identifies the same direct database without returning credentials', () => {
  const result = validateProductionRuntimeDatabasePair(owner, runtime);
  assert.deepEqual(result, { hostname: 'db.charitypilot.ie', port: '5432', database: 'charitypilot',
    maintenanceRole: 'migration_owner', runtimeRole: 'cp_runtime' });
  assert.ok(!JSON.stringify(result).includes('password'));
  assert.deepEqual(validateProductionRuntimeDatabasePair(owner.replace('postgresql:', 'postgres:'), runtime), result);
});

for (const [name, value] of [
  ['same role', runtime.replace('cp_runtime:', 'migration_owner:')],
  ['encoded same role', runtime.replace('cp_runtime:', '%6digration_owner:')],
  ['same password', runtime.replace('synthetic-runtime-password', 'synthetic-owner-password')],
  ['other host', runtime.replace('db.charitypilot.ie', 'other.charitypilot.ie')],
  ['other port', runtime.replace('.ie/', '.ie:6432/')],
  ['other database', runtime.replace('/charitypilot?', '/other?')],
  ['encoded database slash', runtime.replace('/charitypilot?', '/charitypilot%2fother?')],
  ['missing password', runtime.replace(':synthetic-runtime-password', '')],
  ['encoded control password', runtime.replace('synthetic-runtime-password', 'synthetic%0asecret')],
  ['non-simple runtime role', runtime.replace('cp_runtime:', 'cp_runtime.admin:')],
  ['TLS downgraded', runtime.replace('verify-full', 'require')],
  ['TLS omitted', runtime.replace('&sslmode=verify-full', '')],
  ['TLS repeated', runtime + '&sslmode=disable'],
  ['TLS mixed-case option', runtime.replace('sslmode', 'SSLMode')],
  ['target override', runtime + '&host=other.charitypilot.ie'],
  ['role override', runtime + '&options=-c%20role%3Dmigration_owner'],
  ['fragment', runtime + '#synthetic-secret'],
  ['empty fragment', runtime + '#'],
  ['read-only routing', runtime.replace('read-write', 'any')],
  ['SSL root mismatch', runtime + '&sslrootcert=%2Fother-ca.pem'],
  ['alternate protocol', runtime.replace('postgresql:', 'https:')],
]) test(`production role pair refuses ${name} without disclosing input`, () => {
  assert.throws(() => validateProductionRuntimeDatabasePair(owner, value), error => {
    assert.equal(error.message, 'Production database credentials must use distinct roles for the same verified-TLS database.');
    assert.ok(!error.message.includes(value));
    assert.ok(!error.message.includes('synthetic-owner-password'));
    return true;
  });
});

test('production role pair refuses malformed maintenance credentials and shared local targets', () => {
  for (const value of ['', 'postgresql://secret%ZZ@broken', owner + '&user=cp_runtime',
    owner.replace('verify-full', 'disable'), owner + '&sslmode=verify-full']) {
    assert.throws(() => validateProductionRuntimeDatabasePair(value, runtime), /same verified-TLS database/);
  }
  for (const hostname of ['localhost', '127.0.0.1', '[::1]', '0.0.0.0', '[::]',
    '127.1', '0177.0.0.1', '2130706433', '[::ffff:127.0.0.1]']) {
    assert.throws(() => validateProductionRuntimeDatabasePair(owner.replace('db.charitypilot.ie', hostname),
      runtime.replace('db.charitypilot.ie', hostname)), /same verified-TLS database/);
  }
});

test('production role pair accepts shared explicit CA and bounded connection options', () => {
  const options = '&sslrootcert=%2Fprotected%2Fca.pem&connect_timeout=10';
  assert.equal(validateProductionRuntimeDatabasePair(owner + options, runtime + options).runtimeRole, 'cp_runtime');
  assert.throws(() => validateProductionRuntimeDatabasePair(owner, runtime + '&connect_timeout=0'));
  assert.throws(() => validateProductionRuntimeDatabasePair(owner, runtime + '&connect_timeout=999'));
});

function files(t) {
  const directory = mkdtempSync(join(tmpdir(), 'charitypilot-production-runtime-'));
  t.after(() => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('charitypilot-production-runtime-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const maintenance = join(directory, 'maintenance.env'), app = join(directory, 'app.env');
  const common = 'NODE_ENV=production\nJWT_SECRET=synthetic-shared-root\nCHARITYPILOT_PRIVILEGED_MFA_MODE=required\n';
  const saveOwner = extra => writeFileSync(maintenance,
    `${common}DATABASE_URL=${owner}\nCHARITYPILOT_PRODUCTION_APP_ENV_FILE='${app}'\n${extra ?? ''}`, { mode: 0o600 });
  const saveApp = extra => writeFileSync(app, `${common}DATABASE_URL=${runtime}\n${extra ?? ''}`, { mode: 0o600 });
  saveOwner(); saveApp();
  return { directory, maintenance, app, common, saveOwner, saveApp };
}

test('runtime files bind separate identities and return only the app values plus nonsecret file evidence', t => {
  const f = files(t), result = readProductionRuntimeEnvironment(f.maintenance);
  assert.equal(result.appEnvFile, f.app);
  assert.equal(result.appEnvironment.DATABASE_URL, runtime);
  assert.equal(result.identity.runtimeRole, 'cp_runtime');
  assert.equal(result.privatePermissionsVerified, process.platform !== 'win32');
  assert.ok(!JSON.stringify(result).includes('synthetic-owner-password'));
  assert.match(result.binding.maintenanceSha256, /^[a-f0-9]{64}$/);
  assertProductionRuntimeEnvironmentUnchanged(result.binding);
  f.saveApp('# changed after validation\n');
  assert.throws(() => assertProductionRuntimeEnvironmentUnchanged(result.binding), /changed/);
});

for (const scenario of ['missing selector', 'relative selector', 'same path', 'hard link']) {
  test(`runtime file boundary refuses ${scenario}`, t => {
    const f = files(t);
    if (scenario === 'missing selector') writeFileSync(f.maintenance, `${f.common}DATABASE_URL=${owner}\n`);
    if (scenario === 'relative selector') writeFileSync(f.maintenance,
      `${f.common}DATABASE_URL=${owner}\nCHARITYPILOT_PRODUCTION_APP_ENV_FILE=app.env\n`);
    if (scenario === 'same path') writeFileSync(f.maintenance,
      `${f.common}DATABASE_URL=${owner}\nCHARITYPILOT_PRODUCTION_APP_ENV_FILE='${f.maintenance}'\n`);
    if (scenario === 'hard link') { rmSync(f.app); linkSync(f.maintenance, f.app); }
    assert.throws(() => readProductionRuntimeEnvironment(f.maintenance), /separate protected runtime configuration/);
  });
}

test('runtime file boundary refuses a symlink to the maintenance file', t => {
  const f = files(t); rmSync(f.app);
  try { symlinkSync(f.maintenance, f.app, 'file'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('OS does not permit fixture symlinks'); return; } throw error; }
  assert.throws(() => readProductionRuntimeEnvironment(f.maintenance), /separate protected runtime configuration/);
});

for (const extra of ['DATABASE_URL=postgresql://unexpected\n', 'MIGRATION_DATABASE_URL=synthetic\n',
  'POSTGRES_PASSWORD=synthetic\n', 'PGOPTIONS=-c role=migration_owner\n', 'NODE_OPTIONS=--require=synthetic\n',
  'CHARITYPILOT_PRIVILEGED_MFA_MODE=optional\n', 'UNKNOWN_RUNTIME_KEY=synthetic\n',
  'JWT_SECRET=${DATABASE_URL}\n', 'JWT_SECRET="synthetic\\nroot"\n', 'bad-key=synthetic\n',
  'JWT_SECRET=synthetic\x00root\n']) {
  test(`runtime file refuses ambiguous, owner or unreviewed input ${JSON.stringify(extra.split('=')[0])}`, t => {
    const f = files(t); f.saveApp(extra);
    assert.throws(() => readProductionRuntimeEnvironment(f.maintenance), error => {
      assert.equal(error.message, 'Production requires a separate protected runtime configuration.');
      assert.ok(!error.message.includes('synthetic-owner-password'));
      return true;
    });
  });
}

test('runtime values cannot diverge from reviewed maintenance configuration or copy its password', t => {
  const f = files(t);
  writeFileSync(f.app, `${f.common.replace('=required', '=optional')}DATABASE_URL=${runtime}\n`);
  assert.throws(() => readProductionRuntimeEnvironment(f.maintenance));
  f.saveOwner('EXTRA_SECRET=synthetic-owner-password\n'); f.saveApp('EXTRA_SECRET=synthetic-owner-password\n');
  assert.throws(() => readProductionRuntimeEnvironment(f.maintenance));
});

for (const extra of ['MIGRATION_DATABASE_URL=synthetic-maintenance\n', 'POSTGRES_PASSWORD=synthetic-maintenance\n',
  'PGOPTIONS=-c role=migration_owner\n', 'NODE_OPTIONS=--require=synthetic\n', 'DOCKER_HOST=synthetic\n']) {
  test(`runtime rejects maintenance/executor input even when declared in both files: ${extra.split('=')[0]}`, t => {
    const f = files(t); f.saveOwner(extra); f.saveApp(extra);
    assert.throws(() => readProductionRuntimeEnvironment(f.maintenance));
  });
}

test('runtime cannot carry its own selector or maintenance URL as a shared extra value', t => {
  const f = files(t); f.saveApp(`CHARITYPILOT_PRODUCTION_APP_ENV_FILE='${f.app}'\n`);
  assert.throws(() => readProductionRuntimeEnvironment(f.maintenance));
  f.saveOwner(`EXTRA_CONNECTION=${owner}\n`); f.saveApp(`EXTRA_CONNECTION=${owner}\n`);
  assert.throws(() => readProductionRuntimeEnvironment(f.maintenance));
});

test('even matching source files refuse interpolation or interpreted escapes', t => {
  const f = files(t);
  for (const value of ['synthetic-${UNREVIEWED_SECRET}-root', '"synthetic\\nroot"']) {
    writeFileSync(f.maintenance, `${f.common.replace('synthetic-shared-root', value)}DATABASE_URL=${owner}\nCHARITYPILOT_PRODUCTION_APP_ENV_FILE='${f.app}'\n`);
    writeFileSync(f.app, `${f.common.replace('synthetic-shared-root', value)}DATABASE_URL=${runtime}\n`);
    assert.throws(() => readProductionRuntimeEnvironment(f.maintenance));
  }
});

test('review binding also detects changed maintenance bytes and rejects oversized inputs', t => {
  const f = files(t), result = readProductionRuntimeEnvironment(f.maintenance);
  f.saveOwner('# changed maintenance file\n');
  assert.throws(() => assertProductionRuntimeEnvironmentUnchanged(result.binding), /changed/);
  writeFileSync(f.app, '#'.repeat(256 * 1024 + 1));
  assert.throws(() => readProductionRuntimeEnvironment(f.maintenance));
});

test('POSIX runtime files require owner-only permissions', t => {
  if (process.platform === 'win32') { t.skip('Windows ACL certification remains a separate integration gate'); return; }
  const f = files(t); chmodSync(f.app, 0o644);
  assert.throws(() => readProductionRuntimeEnvironment(f.maintenance), /separate protected runtime configuration/);
});

test('Compose transport derives runtime inputs and overrides inherited credential/selector aliases', t => {
  const f = files(t);
  const result = buildProductionComposeEnvironment(f.maintenance, {
    PATH: 'synthetic-path', DATABASE_URL: 'unreviewed', database_url: 'case-alias',
    CHARITYPILOT_PRODUCTION_APP_ENV_FILE: f.maintenance,
    CHARITYPILOT_PRODUCTION_ENV_FILE: 'unreviewed-owner.env',
    charitypilot_production_env_file: 'case-alias-owner.env',
    CHARITYPILOT_PRODUCTION_RUNTIME_DATABASE_URL: owner,
    COMPOSE_FILE: 'unreviewed.yml', compose_project_name: 'unreviewed', DOCKER_HOST: 'tcp://unreviewed:2375',
    NODE_OPTIONS: '--require=unreviewed',
  });
  assert.equal(result.environment.DATABASE_URL, owner);
  assert.equal(result.environment.CHARITYPILOT_PRODUCTION_RUNTIME_DATABASE_URL, runtime);
  assert.equal(result.environment.CHARITYPILOT_PRODUCTION_APP_ENV_FILE, f.app);
  assert.equal(result.environment.CHARITYPILOT_PRODUCTION_ENV_FILE, result.binding.maintenancePath);
  assert.equal(result.environment.PATH, 'synthetic-path');
  for (const key of ['database_url','charitypilot_production_env_file','COMPOSE_FILE','compose_project_name','DOCKER_HOST','NODE_OPTIONS']) {
    assert.equal(result.environment[key], undefined);
  }
  assertProductionRuntimeEnvironmentUnchanged(result.binding);
  f.saveOwner('COMPOSE_FILE=unreviewed.yml\n');
  assert.throws(() => buildProductionComposeEnvironment(f.maintenance));
});
