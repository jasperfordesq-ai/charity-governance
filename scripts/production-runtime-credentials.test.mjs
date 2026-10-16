import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateProductionRuntimeDatabasePair } from './production-runtime-credentials.mjs';

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
