import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {superviseManagedProofProcess,reconcileManagedProofContainers,managedProofWorkerEnvironment} from './managed-proof-runner.mjs';
const ack=JSON.stringify({format:1,kind:'MANAGED_IMPORTED_PROOF_WORKER_V1',ok:true});
function fixture(code){let owned;return{start(_command,_args,options){owned=spawn(process.execPath,['-e',code],options);return owned;},get child(){return owned;}};}
const input=()=>Buffer.from('{}');
const base=()=>({input:input(),env:process.env,timeoutMs:3000});
test('actual worker exit and exact acknowledgement are both necessary',async()=>{
 const f=fixture(`process.stdin.resume();process.stdin.on('end',()=>process.stdout.end(${JSON.stringify(ack)}));`);
 const r=await superviseManagedProofProcess(base(),f);assert.equal(r.workerExited,true);assert.equal(r.actionAuthorized,false);assert.equal(f.child.exitCode,0);
});
for(const [name,code] of [
 ['nonzero worker',`process.stdout.write(${JSON.stringify(ack)});process.exit(2);`],
 ['invalid acknowledgement',`process.stdout.end('{"ok":true}');`],
 ['stderr despite success',`process.stderr.write('private-secret');process.stdout.end(${JSON.stringify(ack)});`],
 ['output flood',`setInterval(()=>process.stdout.write('private-secret'.repeat(10000)),1);`]
])test(name+' refuses with sanitized diagnostics',async()=>{
 const f=fixture(code);await assert.rejects(superviseManagedProofProcess(base(),f),e=>!e.message.includes('private-secret')&&/unresolved/.test(e.message));
 assert.ok(f.child.exitCode!==null||f.child.signalCode!==null);
});
test('deadline waits for actual owned worker termination',async()=>{
 const f=fixture(`process.stdin.resume();setInterval(()=>{},1000);`);
 await assert.rejects(superviseManagedProofProcess({...base(),timeoutMs:100},f));assert.ok(f.child.exitCode!==null||f.child.signalCode!==null);
});
test('caller cancellation terminates the owned worker and never acknowledges',async()=>{
 const f=fixture(`process.stdin.resume();setInterval(()=>{},1000);`),controller=new AbortController();
 const p=superviseManagedProofProcess({...base(),signal:controller.signal},f);setTimeout(()=>controller.abort(),100);
 await assert.rejects(p);assert.ok(f.child.exitCode!==null||f.child.signalCode!==null);
});
test('pre-aborted request and invalid bounds never start a worker',async()=>{
 const controller=new AbortController();controller.abort();let calls=0;const deps={start(){calls++;throw new Error();}};
 await assert.rejects(superviseManagedProofProcess({...base(),signal:controller.signal},deps));
 await assert.rejects(superviseManagedProofProcess({...base(),timeoutMs:0},deps));
 await assert.rejects(superviseManagedProofProcess({...base(),input:Buffer.alloc(16385)},deps));assert.equal(calls,0);
});
test('spawn failure produces a sanitized unresolved outcome',async()=>{
 await assert.rejects(superviseManagedProofProcess(base(),{start(){throw new Error('private-secret');}}),e=>!e.message.includes('private-secret'));
});
function cloud(job,change={}){
 const id='a'.repeat(64),calls=[];let present=true;
 const info={Id:id,Name:'/charitypilot-source-snapshot-123-45-abcdef12',Config:{Labels:{'charitypilot.restore-proof':'true','charitypilot.managed-proof-job':job}},...change};
 return{calls,run(args){calls.push(args);if(args[0]==='ps')return present?id+'\n':'';if(args[0]==='inspect')return JSON.stringify(info);if(args[0]==='rm'){present=false;return id;}throw new Error();}};
}
test('reconciliation filters original job, verifies full identity and deletes only exact IDs',()=>{
 const job=randomUUID(),c=cloud(job),r=reconcileManagedProofContainers(job,{},c);
 assert.equal(r.removedCount,1);assert.equal(r.actionAuthorized,false);assert.equal(c.calls.filter(v=>v[0]==='ps').length,2);
 assert.ok(c.calls[0].includes('label=charitypilot.managed-proof-job='+job));assert.deepEqual(c.calls.find(v=>v[0]==='rm'),['rm','--force','a'.repeat(64)]);
});
for(const [name,change] of [
 ['different job',{Config:{Labels:{'charitypilot.restore-proof':'true','charitypilot.managed-proof-job':randomUUID()}}}],
 ['source container name',{Name:'/actual-source-database'}],['wrong exact ID',{Id:'b'.repeat(64)}],
 ['missing labels',{Config:{Labels:{}}}]
])test('reconciliation refuses '+name+' without removing it',()=>{
 const job=randomUUID(),c=cloud(job,change);assert.throws(()=>reconcileManagedProofContainers(job,{},c));assert.ok(!c.calls.some(v=>v[0]==='rm'));
});
test('reconciliation refuses aliases, duplicate listings, malformed job and persistent residue',()=>{
 for(const body of ['short-id','a'.repeat(64)+'\n'+'a'.repeat(64),'a'.repeat(65537)]){
  const calls=[];assert.throws(()=>reconcileManagedProofContainers(randomUUID(),{},{run(a){calls.push(a);return body;}}));assert.ok(!calls.some(v=>v[0]==='rm'));
 }
 let calls=0;assert.throws(()=>reconcileManagedProofContainers('saved-pid',{},{run(){calls++;}}));assert.equal(calls,0);
 const job=randomUUID(),c=cloud(job);const run=a=>a[0]==='ps'?'a'.repeat(64):c.run(a);
 assert.throws(()=>reconcileManagedProofContainers(job,{},{run}));
});

test('cancellation terminates a real child descendant as well as its worker',async()=>{
 const controller=new AbortController();let descendant;
 const f=fixture(`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(String(c.pid));setInterval(()=>{},1000);`);
 const start=f.start.bind(f);f.start=(...args)=>{const c=start(...args);c.stdout.once('data',b=>{descendant=Number(b.toString());controller.abort();});return c;};
 try{
  await assert.rejects(superviseManagedProofProcess({...base(),timeoutMs:5000,signal:controller.signal},f));assert.ok(Number.isSafeInteger(descendant));
  let alive=true;for(let i=0;i<30&&alive;i++){try{process.kill(descendant,0);await new Promise(r=>setTimeout(r,50));}catch(e){if(e.code!=='ESRCH')throw e;alive=false;}}
  // A killed Linux orphan can remain a zombie until the host init reaps it.
  if(alive&&process.platform==='linux'){const {readFileSync}=await import('node:fs');try{alive=!/^.*\) Z /.test(readFileSync('/proc/'+descendant+'/stat','utf8'));}catch(e){if(e.code!=='ENOENT')throw e;alive=false;}}
  assert.equal(alive,false);
 }finally{if(descendant){try{process.kill(descendant,'SIGKILL');}catch{}}}
});

test('entire job cleanup batch is validated before any container is removed',()=>{
 const job=randomUUID(),good='a'.repeat(64),bad='b'.repeat(64),removed=[];
 const run=args=>{
  if(args[0]==='ps')return good+'\n'+bad;
  if(args[0]==='inspect')return JSON.stringify({Id:args.at(-1),Name:args.at(-1)===good?'/charitypilot-source-snapshot-123-45-abcdef12':'/source-database-control',
   Config:{Labels:{'charitypilot.restore-proof':'true','charitypilot.managed-proof-job':job}}});
  if(args[0]==='rm'){removed.push(args.at(-1));return '';}
  throw new Error();
 };
 assert.throws(()=>reconcileManagedProofContainers(job,{},{run}));assert.deepEqual(removed,[]);
});

test('explicit synthetic diagnostic observer receives bounded stderr while default failure remains sanitized',async()=>{
 const f=fixture(`process.stderr.end('synthetic-private-marker');`);let body='',copy;
 await assert.rejects(superviseManagedProofProcess(base(),{...f,onStderr:b=>{body+=b.toString();copy=b;}}),e=>!e.message.includes('synthetic-private-marker'));
 assert.equal(body,'synthetic-private-marker');assert.ok(copy.every(v=>v===0));
});
test('diagnostic observer failure stops the worker and cannot turn failure into acknowledgement',async()=>{
 const f=fixture(`process.stderr.write('fixture');setInterval(()=>{},1000);`);
 await assert.rejects(superviseManagedProofProcess(base(),{...f,onStderr(){throw new Error('private-observer-error');}}),e=>!e.message.includes('private-observer-error'));
 assert.ok(f.child.exitCode!==null||f.child.signalCode!==null);
});

test('fixed guardian refuses standalone execution without the original inherited IPC channel',()=>{
 const r=spawnSync(process.execPath,[fileURLToPath(new URL('./managed-proof-guardian.mjs',import.meta.url))],{env:process.env,windowsHide:true,input:'{}',encoding:'utf8',timeout:5000,maxBuffer:4096});
 assert.equal(r.status,1);assert.equal(r.stdout,'');assert.equal(r.stderr,'');
});

test('source helper environment excludes cloud/signing credentials and stale gates while retaining explicit DB and OS paths',()=>{
 const source={PATH:'synthetic-path',HOME:'/synthetic-home',XDG_RUNTIME_DIR:'/run/user/1000',AWS_ACCESS_KEY_ID:'synthetic-cloud',AWS_SECRET_ACCESS_KEY:'synthetic-secret',
  AUTH_RECOVERY_SECRET:'synthetic-recovery',INTEGRATION_ENCRYPTION_KEY:'synthetic-integration',NODE_OPTIONS:'--import=synthetic',CHARITYPILOT_INTERNAL_DAEMON_GATE:'/old-job/gate.json',DATABASE_URL:'old-db'};
 assert.deepEqual(managedProofWorkerEnvironment(source,'postgresql://synthetic-source'),{PATH:'synthetic-path',HOME:'/synthetic-home',XDG_RUNTIME_DIR:'/run/user/1000',DATABASE_URL:'postgresql://synthetic-source'});
 assert.equal(source.DATABASE_URL,'old-db');
});
