import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,chmodSync,rmSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createManagedDaemonRequestJournal,inspectManagedDaemonRequests,planManagedProofStorage,DEFAULT_POSTGRES_IMAGE,PROOF_CLIENT_DATA_TMPFS} from './postgres-backup.mjs';
const createJournal=scope=>createManagedDaemonRequestJournal(scope,{imageVolumes:()=>['/var/lib/postgresql/data']});
const runArgs=(extra=[])=>['run','--name','charitypilot-source-snapshot-123-456-abcdef12','--tmpfs',PROOF_CLIENT_DATA_TMPFS,...extra,DEFAULT_POSTGRES_IMAGE,'sh'];
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'charitypilot-daemon-journal-test-'));chmodSync(root,0o700);
 if(process.platform==='win32'){const r=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./personal-server-windows-acl.ps1',import.meta.url)),'-Path',root,'-Kind','Directory'],{encoding:'utf8',timeout:30000});assert.equal(r.status,0);}
 const scope={root,jobId:randomUUID(),inputDigest:'a'.repeat(64)};
 return{root,scope,close(){assert.equal(dirname(root),resolve(tmpdir()));assert.ok(basename(root).startsWith('charitypilot-daemon-journal-test-'));rmSync(root,{recursive:true,force:true});}};
}
test('original intent exists before dispatch and a fresh reader requires responses and original end',()=>{
 const f=fixture();try{
  const j=createJournal(f.scope);assert.equal(inspectManagedDaemonRequests(f.scope).state,'UNRESOLVED_REQUESTS');
  j.dispatch(runArgs(['--env','PRIVATE=synthetic-secret']),()=>{
   const observed=inspectManagedDaemonRequests(f.scope);assert.equal(observed.requestCount,1);assert.equal(observed.mutatingRequestsObservedSuccessful,false);
   assert.ok(readFileSync(join(f.root,'proof-daemon.001.intent.json'),'utf8').includes('argumentsDigest'));return{status:0};
  });
  assert.equal(inspectManagedDaemonRequests(f.scope).state,'UNRESOLVED_REQUESTS');const end=j.finish();assert.equal(end.state,'RECORDED_CLIENT_RESPONSES');
  assert.equal(end.completeResourceInventory,false);assert.equal(end.cleanupAuthorized,false);assert.equal(end.executionAuthorized,false);
  for(const name of readdirSync(f.root))assert.doesNotMatch(readFileSync(join(f.root,name),'utf8'),/synthetic-secret|PRIVATE=/);
  assert.throws(()=>createJournal(f.scope));assert.throws(()=>j.dispatch(runArgs(),()=>assert.fail('No replay')));
 }finally{f.close();}
});
test('lost or ambiguous response remains unresolved even with an end marker and no listed containers',()=>{
 for(const reply of [null,{status:1},{status:null,error:new Error('private error')},{status:0,signal:'SIGKILL'}]){
  const f=fixture();try{
   const j=createJournal(f.scope);
   if(reply===null)assert.throws(()=>j.dispatch(runArgs(),()=>{throw new Error('Original client response lost');}));
   else j.dispatch(runArgs(),()=>reply);
   assert.equal(j.finish().state,'UNRESOLVED_REQUESTS');assert.equal(inspectManagedDaemonRequests(f.scope).mutatingRequestsObservedSuccessful,false);
  }finally{f.close();}
 }
});
test('idempotent daemon removal absence is distinct from an unknown create and is not a retry grant',()=>{
 const f=fixture();try{
  const j=createJournal(f.scope);j.dispatch(['rm','-f','charitypilot-source-snapshot-123-456-abcdef12'],()=>({status:1,stderr:'Error response from daemon: No such container: charitypilot-source-snapshot-123-456-abcdef12\n'}));
  assert.equal(j.finish().mutatingRequestsObservedSuccessful,true);
 }finally{f.close();}
});
test('scope substitution, record corruption and unexpected catalogue entries refuse inspection',()=>{
 const f=fixture();try{
  const j=createJournal(f.scope);j.dispatch(['exec','charitypilot-source-snapshot-123-456-abcdef12','createdb'],()=>({status:0}));j.finish();
  assert.throws(()=>inspectManagedDaemonRequests({...f.scope,jobId:randomUUID()}));
  assert.throws(()=>inspectManagedDaemonRequests({...f.scope,inputDigest:'b'.repeat(64)}));
  const path=join(f.root,'proof-daemon.001.response.json'),saved=readFileSync(path,'utf8');writeFileSync(path,saved.replace('"status":0','"status":1'));
  assert.equal(inspectManagedDaemonRequests(f.scope).state,'UNRESOLVED_REQUESTS');
  writeFileSync(join(f.root,'proof-daemon.unexpected.json'),'{}');assert.throws(()=>inspectManagedDaemonRequests(f.scope));
 }finally{f.close();}
});
test('unsupported future mutation refuses before dispatch while read-only probes do not create mutation intents',()=>{
 const f=fixture();try{
  const j=createJournal(f.scope);assert.throws(()=>j.dispatch(['volume','create'],()=>assert.fail('No daemon mutation')));
  j.dispatch(['ps','-a'],()=>({status:0}));
  j.dispatch(['exec','charitypilot-isolated-restore-123-456-abcdef12','pg_isready'],()=>({status:1}));
  assert.equal(j.finish().requestCount,0);
 }finally{f.close();}
});

test('storage plan covers the pinned image volume while recording only bind-source digests',()=>{
 const source=join(tmpdir(),'synthetic-private-source'),args=runArgs(['-v',source+':/proof','--mount','type=bind,source='+source+',target=/run/charitypilot/database-ca.pem,readonly']);
 const plan=planManagedProofStorage(args,randomUUID());assert.equal(plan.declaredImageVolumesCovered,true);
 assert.equal(plan.mounts.length,3);assert.equal(plan.mounts.find(v=>v.target==='/var/lib/postgresql/data').type,'tmpfs');
 assert.doesNotMatch(JSON.stringify(plan),/synthetic-private-source/);assert.ok(plan.mounts.filter(v=>v.type==='bind').every(v=>/^[a-f0-9]{64}$/.test(v.sourceDigest)));
});
test('missing volume coverage, named storage, duplicate targets and unsupported storage options refuse before launch',()=>{
 const source=join(tmpdir(),'synthetic-source');
 for(const args of [runArgs().filter(v=>!['--tmpfs',PROOF_CLIENT_DATA_TMPFS].includes(v)),runArgs(['-v','unattributed-volume:/proof']),
  runArgs(['--tmpfs',PROOF_CLIENT_DATA_TMPFS]),runArgs(['--volumes-from','other-job']),runArgs(['-v',source+':/backup']),runArgs(['--mount','type=volume,source=old,target=/proof']),
  runArgs().map(v=>v===DEFAULT_POSTGRES_IMAGE?'postgres:latest':v)])assert.throws(()=>planManagedProofStorage(args,randomUUID()));
});
test('unexpected image-declared volume refuses before original catalogue creation',()=>{
 const f=fixture();try{assert.throws(()=>createManagedDaemonRequestJournal(f.scope,{imageVolumes:()=>['/var/lib/postgresql/data','/unreviewed']}));assert.deepEqual(readdirSync(f.root),[]);}finally{f.close();}
});
test('legacy request catalogue remains readable without invented image coverage',()=>{
 const f=fixture();try{
  const header={format:1,kind:'MANAGED_DAEMON_REQUEST_HEADER_V1',jobId:f.scope.jobId,inputDigest:f.scope.inputDigest},body=JSON.stringify(header);
  writeFileSync(join(f.root,'proof-daemon.header.json'),body,{mode:0o600});
  const r=inspectManagedDaemonRequests(f.scope);assert.equal(r.declaredImageVolumesCovered,false);assert.equal(r.mutatingRequestsObservedSuccessful,false);
 }finally{f.close();}
});

test('original custody ACK precedes dispatch; refused or unknown header/intent ACK cannot call the daemon',()=>{
 for(const failure of ['header','intent','none']){
  const f=fixture();let dispatched=0,headers=0,intents=0;
  try{
   const make=()=>createManagedDaemonRequestJournal(f.scope,{imageVolumes:()=>['/var/lib/postgresql/data'],acknowledge:(kind,artifact)=>{
    assert.equal(dispatched,0);assert.equal(Buffer.byteLength(artifact.body),artifact.byteLength);
    if(kind==='HEADER')headers++;else intents++;
    return failure===(kind==='HEADER'?'header':'intent')&&(kind==='HEADER'||intents===1)?false:true;
   }});
   if(failure==='header'){assert.throws(make);assert.equal(headers,1);assert.equal(intents,0);}
   else{const journal=make(),dispatch=()=>journal.dispatch(runArgs(),()=>{dispatched++;return{status:0};});
    if(failure==='intent'){assert.throws(dispatch);assert.throws(dispatch);assert.equal(intents,1);assert.equal(inspectManagedDaemonRequests(f.scope).state,'UNRESOLVED_REQUESTS');}
    else{dispatch();assert.equal(journal.finish().mutatingRequestsObservedSuccessful,true);}
   }
   assert.equal(dispatched,failure==='none'?1:0);
  }finally{f.close();}
 }
});
