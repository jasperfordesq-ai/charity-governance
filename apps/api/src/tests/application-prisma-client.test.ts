import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { createApplicationPrismaClient } from '../utils/application-prisma-client.js';

const canonical='postgresql://cp_runtime:synthetic-private-password@db.charitypilot.ie/charitypilot?sslmode=verify-full&target_session_attrs=read-write';
function fixture(rows: unknown=[{ safe:true }]) {
  const calls: unknown[]=[];
  const client={
    async $connect() {calls.push('connect');},
    async $disconnect() {calls.push('disconnect');},
    async $transaction(fn: (tx: unknown)=>Promise<unknown>) {
      return fn({
        async $executeRawUnsafe(sql: string) {calls.push(sql);},
        async $queryRawUnsafe(sql: string,...values: unknown[]) {calls.push({sql,values});return rows;},
      });
    },
  } as unknown as PrismaClient;
  return {client,calls,createClient:(url?:string)=>{calls.push({url});return client;}};
}

test('application client uses strict translated TLS and checks the observed connection',async()=>{
  const f=fixture();
  assert.equal(await createApplicationPrismaClient({DATABASE_URL:canonical},{createClient:f.createClient}),f.client);
  const url=new URL((f.calls[0] as {url:string}).url);
  assert.equal(url.searchParams.get('sslaccept'),'strict');
  assert.equal(url.searchParams.get('sslmode'),'require');
  assert.equal(f.calls[1],'connect');
  assert.equal(f.calls[2],'SET TRANSACTION READ ONLY');
  assert.deepEqual((f.calls[4] as {values:unknown[]}).values,['cp_runtime','charitypilot']);
});

for(const rows of [[],[{safe:false}],[{safe:'true'}],[{safe:true},{safe:true}]]) {
  test('unsafe or ambiguous connection proof disconnects and refuses',async()=>{
    const f=fixture(rows);
    await assert.rejects(createApplicationPrismaClient({DATABASE_URL:canonical},{createClient:f.createClient}),/Application database connection verification failed/);
    assert.equal(f.calls.at(-1),'disconnect');
  });
}

test('private local connection retains normal constructor and lazy connection behaviour',async()=>{
  const f=fixture();
  await createApplicationPrismaClient({DATABASE_URL:'postgresql://runtime:synthetic@db/charitypilot',CHARITYPILOT_DEPLOYMENT_MODE:'personal-server'},{createClient:f.createClient});
  assert.deepEqual(f.calls,[{url:undefined}]);
});

test('declared public production cannot fall back to an unverified URL',async()=>{
  const f=fixture();
  await assert.rejects(createApplicationPrismaClient({DATABASE_URL:'postgresql://user:synthetic@db/charitypilot',CHARITYPILOT_DEPLOYMENT_MODE:'production'},{createClient:f.createClient}));
  assert.equal(f.calls.length,0);
});

test('connection exceptions are sanitised and the client is disconnected',async()=>{
  const f=fixture();
  f.client.$connect=async()=>{throw new Error(canonical);};
  await assert.rejects(createApplicationPrismaClient({DATABASE_URL:canonical},{createClient:f.createClient}),error=>{
    assert.equal((error as Error).message,'Application database connection verification failed.');
    assert.equal((error as Error).cause,undefined);return true;
  });
  assert.equal(f.calls.at(-1),'disconnect');
});
