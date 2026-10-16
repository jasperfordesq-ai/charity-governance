import assert from 'node:assert/strict';
import test from 'node:test';
import type { Prisma } from '@prisma/client';
import { verifyProductionRuntimeDatabaseRole, PRODUCTION_RUNTIME_DATABASE_ROLE_SQL, type RuntimeRoleProbeClient } from '../services/production-runtime-database-role.js';

const target = { runtimeRole: 'cp_runtime', maintenanceRole: 'migration_owner', database: 'charitypilot', phase: 'after-migration' as const };
function client(rows: unknown = [{ safe: true }]) {
  const calls: unknown[] = [];
  const value: RuntimeRoleProbeClient = {
    async $transaction(fn, options) {
      calls.push(options);
      return fn({
        async $executeRaw(sql) { calls.push(sql[0]); return 0; },
        async $queryRaw<T>(query: Prisma.Sql) { calls.push({ sql: query.text, parameters: query.values }); return rows as T; },
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
  assert.equal((f.calls[3] as {sql:string}).sql, PRODUCTION_RUNTIME_DATABASE_ROLE_SQL);
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

test('quoted maintenance metadata stays bound and cannot alter the catalogue query', async () => {
  const f = client();
  const quoted = { ...target, maintenanceRole: 'owner"; SELECT 1; --', database: "charity'quoted" };
  await verifyProductionRuntimeDatabaseRole(f.value, quoted);
  const query = f.calls[3] as { sql: string; parameters: unknown[] };
  assert.equal(query.sql, PRODUCTION_RUNTIME_DATABASE_ROLE_SQL);
  assert.deepEqual(query.parameters, [quoted.runtimeRole, quoted.maintenanceRole, quoted.database, true]);
  assert.equal(query.sql.includes(quoted.maintenanceRole), false);
});
