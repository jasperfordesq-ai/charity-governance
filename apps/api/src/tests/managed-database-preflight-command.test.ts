import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ManagedDatabaseWriterFence} from '../services/managed-database-writer-fence.js';
import {preflightManagedDatabase,readManagedDatabasePreflightInput} from '../jobs/preflight-managed-database.js';

const configuration={database:'synthetic_db',databaseOid:'16384',maintenance:{name:'maintenance',oid:'10'},
 writers:[{name:'application_writer',oid:'16385'}],custodians:[{name:'maintenance',oid:'10'}]};
const raw={format:1,databaseUrl:'postgresql://maintenance:synthetic-private@db.example/synthetic_db?sslmode=verify-full&target_session_attrs=read-write',
 configuration,expectedConfigurationDigest:new ManagedDatabaseWriterFence(undefined as never,configuration).configurationDigest()};
test('CLI refuses argument or malformed secret input with only a fixed stderr line',()=>{
 for(const args of [[],['--stdin'],['--stdin','--apply']]){
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../jobs/preflight-managed-database.js',import.meta.url)),...args],
   {input:'{"secret":"synthetic-private"',encoding:'utf8',timeout:5000});
  assert.equal(result.status,1);assert.equal(result.stdout,'');
  assert.equal(result.stderr,'Managed database preflight refused; no maintenance actions authorised\n');
 }
});
test('preflight input refuses oversized, malformed and non-UTF8 input without disclosing bytes',async()=>{
 for(const body of [Buffer.alloc(16385,65),Buffer.from('{"secret":"synthetic-private"'),Buffer.from([0xff])])
  await assert.rejects(readManagedDatabasePreflightInput((async function*(){yield body;})()),/Managed database preflight refused/);
 assert.deepEqual(await readManagedDatabasePreflightInput((async function*(){yield Buffer.from('{"format":1}');})()),{format:1});
});
test('preflight validates explicit URL, identity and reviewed registry before connecting',async()=>{
 let connects=0;const create=()=>{connects++;throw new Error('must not connect');};
 for(const change of [{format:2},{unexpected:true},{expectedConfigurationDigest:'0'.repeat(64)},
  {databaseUrl:raw.databaseUrl.replace('maintenance:','other:')},{databaseUrl:raw.databaseUrl.replace('/synthetic_db','/other')},
  {databaseUrl:raw.databaseUrl.replace('verify-full','disable')},{databaseUrl:raw.databaseUrl+'&sslmode=verify-full'},
  {databaseUrl:raw.databaseUrl+'&options=-csearch_path%3Dpublic'},{databaseUrl:'\n'+raw.databaseUrl}])await assert.rejects(preflightManagedDatabase({...raw,...change},create),/Managed database preflight refused/);
 assert.equal(connects,0);
});
test('driver and disconnect failures are redacted and do not produce a compatibility report',async()=>{
 for(const disconnectFails of [false,true]){
  let closed=0;
  await assert.rejects(preflightManagedDatabase(raw,url=>{
   assert.ok(url.includes('sslaccept=strict'));assert.ok(url.includes('connect_timeout=10'));
   return {$transaction:async()=>{throw new Error('PRIVATE connection or provider body');},$disconnect:async()=>{closed++;if(disconnectFails)throw new Error('PRIVATE cleanup');}} as never;
  }),error=>error instanceof Error&&!error.message.includes('PRIVATE')&&error.cause===undefined);
  assert.equal(closed,1);
 }
});
