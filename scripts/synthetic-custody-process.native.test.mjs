import test from 'node:test';
import assert from 'node:assert/strict';
import {fork,spawn} from 'node:child_process';
import {mkdtempSync,chmodSync,writeFileSync,openSync,fsyncSync,closeSync,rmSync,realpathSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {callSyntheticCustody} from './synthetic-custody-wire.mjs';
const file=name=>fileURLToPath(new URL('./'+name,import.meta.url));
function terminal(child){const p=new Promise((yes,no)=>{child.once('error',no);child.once('close',(code,signal)=>yes({code,signal}));});void p.catch(()=>{});return p;}
function childOutput(child){let body='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{body+=b.toString();if(body.length>1024*1024)child.kill('SIGKILL');});return()=>body;}
test('separate synthetic custody survives source exit and source SIGKILL, then cold readers use original SDK archive checks',{
 skip:process.platform!=='linux'||process.env.CHARITYPILOT_TEST_SEPARATE_CUSTODY!=='1',timeout:480000
},async()=>{
 assert.notEqual(process.getuid(),0);const root=mkdtempSync(join(tmpdir(),'charitypilot-synthetic-custody-'));chmodSync(root,0o700);
 let service,serviceTerminal,source,sourceTerminal,reader,readerTerminal,descriptor;
 try{
  const serviceEnv=Object.fromEntries(['PATH','SystemRoot','WINDIR','TEMP','TMP','HOME'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
  service=fork(file('synthetic-custody-service.fixture.mjs'),[],{execArgv:[],env:serviceEnv,stdio:['ignore','pipe','pipe','ipc']});serviceTerminal=terminal(service);const serviceLog=childOutput(service);
  descriptor=await new Promise((yes,no)=>{const timeout=setTimeout(()=>no(new Error('Synthetic custody service not ready')),15000);service.once('message',v=>{clearTimeout(timeout);yes(v);});service.once('exit',()=>{clearTimeout(timeout);no(new Error('Synthetic custody service stopped: '+serviceLog().slice(-500)));});});
  assert.equal(descriptor.kind,'SYNTHETIC_CUSTODY_PROCESS_V1');const path=join(root,'session.json');writeFileSync(path,JSON.stringify(descriptor),{flag:'wx',mode:0o600});
  for(const target of [path,root]){const fd=openSync(target,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
  const env={...process.env,CHARITYPILOT_TEST_CUSTODY_SESSION_FILE:path,CHARITYPILOT_TEST_CONTAINED_SOURCE:'1'};delete env.NODE_OPTIONS;delete env.NODE_PATH;delete env.NODE_TEST_CONTEXT;
  for(const name of ['managed-database-writer-fence-postgres.test.mjs','managed-contained-parent-loss.native.test.mjs']){
   source=spawn(process.execPath,['--test',file(name)],{env:{...env,...(name.includes('parent-loss')?{CHARITYPILOT_TEST_CONTAINED_PARENT:'1'}:{})},stdio:['ignore','pipe','pipe']});sourceTerminal=terminal(source);const log=childOutput(source);
   assert.equal((await sourceTerminal).code,0,'Synthetic original source refused: '+log().slice(-6000));assert.equal(service.exitCode,null);
  }
  const states=await callSyntheticCustody(descriptor,{op:'sessions'});assert.ok(states.length>=2);
  reader=fork(file('synthetic-custody-reader.fixture.mjs'),[],{execArgv:[],env,stdio:['ignore','pipe','pipe','ipc']});let result,reportCount=0;reader.on('message',value=>{result=value;reportCount++;});readerTerminal=terminal(reader);const readLog=childOutput(reader);
  assert.equal((await readerTerminal).code,0,readLog().slice(-4000));assert.equal(reportCount,1);assert.equal(result.kind,'SYNTHETIC_COLD_CUSTODY_READER_V1');assert.ok(result.verifiedRoots>=1);assert.ok(result.killedSourceServiceRecords>=1);assert.equal(result.suppliedSourceIdsOrPins,false);assert.equal(result.executionAuthorized,false);
  service.send({kind:'STOP_SYNTHETIC_CUSTODY_V1'});assert.equal((await serviceTerminal).code,0);
  await assert.rejects(callSyntheticCustody(descriptor,{op:'sessions'}));
  console.log('PASS independent synthetic process: source normal exit + genuine source SIGKILL; cold SDK LIST/GET/MAC/decrypt verifies retained roots and killed-source service bytes without source IDs/pins or new writes/data keys; service loss has no cache fallback; not real provider/VM-loss proof');
  console.log('COLD_READER_COUNTS='+JSON.stringify({sessions:result.sessions,records:result.records,roots:result.verifiedRoots,killedSourceServices:result.killedSourceServiceRecords}));
 }finally{
  for(const child of [reader,source,service])if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  await Promise.allSettled([readerTerminal,sourceTerminal,serviceTerminal].filter(Boolean));assert.equal(dirname(root),resolve(tmpdir()));assert.match(basename(root),/^charitypilot-synthetic-custody-[A-Za-z0-9]{6}$/);assert.equal(realpathSync(root),root);assert.equal(lstatSync(root).uid,process.getuid());rmSync(root,{recursive:true,force:true});
 }
});
