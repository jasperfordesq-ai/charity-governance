import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient, Prisma } from '@prisma/client';
import { createApplicationPrismaClient } from '../utils/application-prisma-client.js';

const canonical='postgresql://cp_runtime:synthetic-private-password@db.charitypilot.ie/charitypilot?sslmode=verify-full&target_session_attrs=read-write';
const privateVm: NodeJS.ProcessEnv={
  NODE_ENV:'production',
  DATABASE_URL:canonical.replace('db.charitypilot.ie','db:5432'),
  CHARITYPILOT_TENANCY:'multi', CHARITYPILOT_REGISTRATION:'closed',
  CHARITYPILOT_EMAIL_DELIVERY:'manual-link', CHARITYPILOT_BILLING:'none',
  CHARITYPILOT_ERROR_ALERTS:'none', DOCUMENT_STORAGE_DRIVER:'local',
  FRONTEND_URL:'https://charitypilot.tail0000.ts.net',
  NEXT_PUBLIC_API_URL:'https://charitypilot.tail0000.ts.net',
  CHARITYPILOT_CANONICAL_WEB_ORIGIN:'https://charitypilot.tail0000.ts.net',
  CHARITYPILOT_CANONICAL_API_ORIGIN:'https://charitypilot.tail0000.ts.net',
};
function fixture(rows: unknown=[{ safe:true }]) {
  const calls: unknown[]=[];
  const client={
    async $connect() {calls.push('connect');},
    async $disconnect() {calls.push('disconnect');},
    async $transaction(fn: (tx: unknown)=>Promise<unknown>) {
      return fn({
        async $executeRaw(sql: TemplateStringsArray) {calls.push(sql[0]);},
        async $queryRaw(query: Prisma.Sql) {calls.push({sql:query.text,values:query.values});return rows;},
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
  assert.deepEqual((f.calls[4] as {values:unknown[]}).values,['cp_runtime','cp_runtime','charitypilot']);
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

test('existing private VM profile retains its documented internal database transport',async()=>{
  const f=fixture();
  await createApplicationPrismaClient(privateVm,{createClient:f.createClient});
  assert.deepEqual(f.calls,[{url:undefined}]);
});

for(const override of [
  {CHARITYPILOT_DEPLOYMENT_MODE:'production'},
  {CHARITYPILOT_REGISTRATION:'open'}, {CHARITYPILOT_EMAIL_DELIVERY:'provider'},
  {CHARITYPILOT_TENANCY:'single'}, {CHARITYPILOT_BILLING:'stripe'},
  {CHARITYPILOT_ERROR_ALERTS:'webhook'}, {DOCUMENT_STORAGE_DRIVER:'supabase'},
  {CHARITYPILOT_CANONICAL_API_ORIGIN:'https://api.charitypilot.ie'},
  {FRONTEND_URL:'https://other.tail0000.ts.net'},
  {NEXT_PUBLIC_API_URL:'https://other.tail0000.ts.net'},
  {CHARITYPILOT_CANONICAL_WEB_ORIGIN:'https://app.charitypilot.ie'},
  {DATABASE_URL:canonical},
  {DATABASE_URL:privateVm.DATABASE_URL+'&sslrootcert=system'},
  {DATABASE_URL:privateVm.DATABASE_URL?.replace('db:5432','db:6432')},
  {DATABASE_URL:privateVm.DATABASE_URL?.replace('db:5432','db.example:5432')},
]) {
  test(`private VM compatibility cannot apply outside its exact profile: ${Object.keys(override)[0]}`,async()=>{
    const f=fixture();
    await createApplicationPrismaClient({...privateVm,...override},{createClient:f.createClient});
    assert.equal(f.calls[1],'connect');
  });
}

for(const origin of ['http://charitypilot.tail0000.ts.net','https://api.charitypilot.ie',
  'https://charitypilot.tail0000.ts.net:8443','https://charitypilot.tail0000.ts.net/path',
  'https://charitypilot.tail0000.ts.net.attacker.example']) {
  test(`non-private origin cannot select internal transport: ${origin}`,async()=>{
    const f=fixture();
    await createApplicationPrismaClient({...privateVm,FRONTEND_URL:origin,NEXT_PUBLIC_API_URL:origin,
      CHARITYPILOT_CANONICAL_WEB_ORIGIN:origin,CHARITYPILOT_CANONICAL_API_ORIGIN:origin},
    {createClient:f.createClient});
    assert.equal(f.calls[1],'connect');
  });
}

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
