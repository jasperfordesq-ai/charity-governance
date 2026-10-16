import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyProductionRuntimeDatabaseRole, type RuntimeRoleProbeClient } from '../services/production-runtime-database-role.js';

const target = { runtimeRole: 'cp_runtime', maintenanceRole: 'migration_owner', database: 'charitypilot', phase: 'after-migration' as const };
function client(rows: unknown = [{ safe: true }]) {
  const calls: unknown[] = [];
  const value: RuntimeRoleProbeClient = {
    async $transaction(fn, options) {
      calls.push(options);
      return fn({
        async $executeRawUnsafe(sql) { calls.push(sql); return 0; },
        async $queryRawUnsafe<T>(sql: string, ...parameters: unknown[]) { calls.push({ sql, parameters }); return rows as T; },
      });
    },
  };
  return { value, calls };
}

test('runtime catalogue probe uses a read-only repeatable-read transaction and bound metadata', async () => {
  const f = client();
  assert.deepEqual(await verifyProductionRuntimeDatabaseRole(f.value, target), { verified: true, phase: 'after-migration' });
  assert.deepEqual(f.calls[0], { isolationLevel: 'RepeatableRead', timeout: 15000, maxWait: 5000 });
  assert.equal(f.calls[1], 'SET TRANSACTION READ ONLY');
  assert.equal(f.calls[2], 'SET LOCAL search_path = pg_catalog, public, pg_temp');
  assert.deepEqual((f.calls[3] as { parameters: unknown[] }).parameters, ['cp_runtime', 'migration_owner', 'charitypilot', true]);
});

for (const rows of [[], [{ safe: false }], [{ safe: 'true' }], [{ safe: true }, { safe: true }], null]) {
  test(`runtime catalogue probe refuses ambiguous or unsafe result ${JSON.stringify(rows)}`, async () => {
    await assert.rejects(verifyProductionRuntimeDatabaseRole(client(rows).value, target), /runtime database verification failed/);
  });
}

test('driver failures cannot expose credentials or raw diagnostics', async () => {
  const f = client();
  f.value.$transaction = async () => { throw new Error('postgresql://owner:synthetic-private-password@private-host/database'); };
  await assert.rejects(verifyProductionRuntimeDatabaseRole(f.value, target), error => {
    assert.equal((error as Error).message, 'Production runtime database verification failed.');
    assert.equal((error as Error).cause, undefined);
    return true;
  });
});

for (const invalid of [{ ...target, runtimeRole: 'migration_owner' }, { ...target, database: '' },
  { ...target, maintenanceRole: 'bad\nrole' }, { ...target, phase: 'unknown' }]) {
  test('invalid runtime target refuses before connecting', async () => {
    const f = client();
    await assert.rejects(verifyProductionRuntimeDatabaseRole(f.value, invalid as typeof target));
    assert.equal(f.calls.length, 0);
  });
}
