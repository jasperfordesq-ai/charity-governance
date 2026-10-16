import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { readRuntimeRoleProbeInput, runRuntimeRoleProbe } from '../jobs/verify-runtime-database-role.js';

const target={runtimeRole:'cp_runtime',maintenanceRole:'migration_owner',database:'charitypilot',phase:'after-migration'};
async function* input(value: string|Buffer) {yield value;}

test('role probe input is bounded and parses only valid UTF-8 JSON',async()=>{
  assert.deepEqual(await readRuntimeRoleProbeInput(input(JSON.stringify(target))),target);
  for(const raw of [' '.repeat(4097),'not json',Buffer.from([0xff])]) {
    await assert.rejects(readRuntimeRoleProbeInput(input(raw)),/Runtime database role probe failed/);
  }
});

test('role probe validates exact target before creating any database client',async()=>{
  let created=0;
  for(const raw of [{...target,extra:'unreviewed'},{...target,phase:'unknown'},{...target,runtimeRole:'migration_owner'},[]]) {
    await assert.rejects(runRuntimeRoleProbe(raw,{createClient:async()=>{created++;throw new Error();}}));
  }
  assert.equal(created,0);
});

test('role probe emits a minimal phase-bound receipt and disconnects',async()=>{
  let disconnected=0;
  const client={ $disconnect:async()=>{disconnected++;} } as unknown as PrismaClient;
  const receipt=await runRuntimeRoleProbe(target,{
    createClient:async()=>client,
    verify:async(_client,actual)=>{assert.deepEqual(actual,target);return {verified:true,phase:actual.phase};},
  });
  assert.deepEqual(receipt,{schemaVersion:1,verified:true,phase:'after-migration'});
  assert.equal(disconnected,1);
});

test('role probe disconnects and hides raw verification failures',async()=>{
  let disconnected=0;
  const client={ $disconnect:async()=>{disconnected++;} } as unknown as PrismaClient;
  await assert.rejects(runRuntimeRoleProbe(target,{createClient:async()=>client,
    verify:async()=>{throw new Error('postgresql://owner:synthetic-private@private-host/database');}}),error=>{
    assert.equal((error as Error).message,'Runtime database role probe failed.');
    assert.equal((error as Error).cause,undefined);return true;
  });
  assert.equal(disconnected,1);
});

test('role probe cannot report success for the wrong phase or failed cleanup',async()=>{
  const client={ $disconnect:async()=>{} } as unknown as PrismaClient;
  await assert.rejects(runRuntimeRoleProbe(target,{createClient:async()=>client,
    verify:async()=>({verified:true,phase:'before-migration'})}),/Runtime database role probe failed/);
  client.$disconnect=async()=>{throw new Error('synthetic private driver detail');};
  await assert.rejects(runRuntimeRoleProbe(target,{createClient:async()=>client,
    verify:async()=>({verified:true,phase:'after-migration'})}),/Runtime database role probe failed/);
});
