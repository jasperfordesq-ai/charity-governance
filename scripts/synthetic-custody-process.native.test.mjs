import test from 'node:test';
import assert from 'node:assert/strict';
import {fork,spawn} from 'node:child_process';
import {mkdtempSync,chmodSync,writeFileSync,openSync,fsyncSync,closeSync,rmSync,realpathSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {PutObjectCommand} from '@aws-sdk/client-s3';
import {GenerateDataKeyCommand,GenerateMacCommand} from '@aws-sdk/client-kms';
import {callSyntheticCustody} from './synthetic-custody-wire.mjs';
import {connectSyntheticCustody} from './synthetic-custody-client.mjs';
const file=name=>fileURLToPath(new URL('./'+name,import.meta.url));
function terminal(child){const p=new Promise((yes,no)=>{child.once('error',no);child.once('close',(code,signal)=>yes({code,signal}));});void p.catch(()=>{});return p;}
function childOutput(child){let body='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{body+=b.toString();if(body.length>1024*1024)child.kill('SIGKILL');});return()=>body;}
test('separate synthetic custody survives source exit and source SIGKILL, then cold readers use original SDK archive checks',{
 skip:process.platform!=='linux'||process.env.CHARITYPILOT_TEST_SEPARATE_CUSTODY!=='1',timeout:480000
},async()=>{
 assert.notEqual(process.getuid(),0);const root=mkdtempSync(join(tmpdir(),'charitypilot-synthetic-custody-'));chmodSync(root,0o700);
 let service,serviceTerminal,source,sourceTerminal,reader,readerTerminal,descriptor,recoveryRoot;
 try{
  const serviceEnv=Object.fromEntries(['PATH','SystemRoot','WINDIR','TEMP','TMP','HOME'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
  service=fork(file('synthetic-custody-service.fixture.mjs'),[],{execArgv:[],env:serviceEnv,stdio:['ignore','pipe','pipe','ipc']});serviceTerminal=terminal(service);const serviceLog=childOutput(service);
  descriptor=await new Promise((yes,no)=>{const timeout=setTimeout(()=>no(new Error('Synthetic custody service not ready')),15000);service.once('message',v=>{clearTimeout(timeout);yes(v);});service.once('exit',()=>{clearTimeout(timeout);no(new Error('Synthetic custody service stopped: '+serviceLog().slice(-500)));});});
  assert.equal(descriptor.kind,'SYNTHETIC_CUSTODY_PROCESS_V1');const recoveryDescriptor={kind:descriptor.kind,endpoint:descriptor.endpoint,capability:descriptor.recoveryCapability};
  descriptor={kind:descriptor.kind,endpoint:descriptor.endpoint,capability:descriptor.capability};assert.ok(descriptor.capability!==recoveryDescriptor.capability);
  recoveryRoot=mkdtempSync(join(tmpdir(),'charitypilot-synthetic-custody-'));chmodSync(recoveryRoot,0o700);
  const path=join(root,'session.json'),recoveryPath=join(recoveryRoot,'session.json');writeFileSync(path,JSON.stringify(descriptor),{flag:'wx',mode:0o600});writeFileSync(recoveryPath,JSON.stringify(recoveryDescriptor),{flag:'wx',mode:0o600});
  for(const target of [path,root,recoveryPath,recoveryRoot]){const fd=openSync(target,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
  const env={...process.env,CHARITYPILOT_TEST_CUSTODY_SESSION_FILE:path,CHARITYPILOT_TEST_CONTAINED_SOURCE:'1'};delete env.NODE_OPTIONS;delete env.NODE_PATH;delete env.NODE_TEST_CONTEXT;
  for(const name of ['managed-database-writer-fence-postgres.test.mjs','managed-contained-parent-loss.native.test.mjs']){
   source=spawn(process.execPath,['--test',file(name)],{env:{...env,...(name.includes('parent-loss')?{CHARITYPILOT_TEST_CONTAINED_PARENT:'1'}:{})},stdio:['ignore','pipe','pipe']});sourceTerminal=terminal(source);const log=childOutput(source);
   assert.equal((await sourceTerminal).code,0,'Synthetic original source refused: '+log().slice(-6000));assert.equal(service.exitCode,null);
   if(name.includes('parent-loss')){
    for(const format of [3,5])assert.ok(log().includes('PASS genuine format '+format+' source parent SIGKILL:'),'Missing actual caller-loss proof for format '+format);
    console.log('GENUINE_CALLER_SIGKILL_FORMATS=3|5');
   }
  }
  const states=await callSyntheticCustody(descriptor,{op:'sessions'});assert.ok(states.length>=2);
  const selected=states[0],owner=connectSyntheticCustody(descriptor,selected.id,selected.config),recovery=connectSyntheticCustody(recoveryDescriptor,selected.id,selected.config);
  const ownerClients={s3:owner.s3(),kms:owner.kms()},recoveryClients={s3:recovery.s3(),kms:recovery.kms()};
  try{
   const before={writes:owner.writes,generates:owner.generates},body=Buffer.from('{"kind":"SYNTHETIC_CAPABILITY_PROBE_V1"}');
   const put={Bucket:selected.config.bucket,ExpectedBucketOwner:selected.config.accountId,Key:'capability-probe/'+randomUUID()+'.json',Body:body,
    IfNoneMatch:'*',ChecksumSHA256:createHash('sha256').update(body).digest('base64'),ServerSideEncryption:'aws:kms',SSEKMSKeyId:selected.config.storageKeyArn};
   const dataKey={KeyId:selected.config.dataKeyArn,KeySpec:'AES_256'},mac={KeyId:selected.config.rootMacKeyArn,MacAlgorithm:'HMAC_SHA_256',Message:Buffer.from('CHARITYPILOT_ARCHIVED_RECOVERY_SET_V2\nsynthetic capability probe')};
   await assert.rejects(recoveryClients.s3.send(new PutObjectCommand(put)));await assert.rejects(recoveryClients.kms.send(new GenerateDataKeyCommand(dataKey)));await assert.rejects(recoveryClients.kms.send(new GenerateMacCommand(mac)));
   await assert.rejects(callSyntheticCustody(recoveryDescriptor,{op:'open',config:selected.config,role:'owner'}));await assert.rejects(callSyntheticCustody(recoveryDescriptor,{op:'flag',id:selected.id,name:'loseRoot',value:false,role:'owner'}));
   assert.equal(owner.writes,before.writes);assert.equal(owner.generates,before.generates);
   await ownerClients.s3.send(new PutObjectCommand(put));const generated=await ownerClients.kms.send(new GenerateDataKeyCommand(dataKey));assert.equal(generated.Plaintext.length,32);generated.Plaintext.fill(0);
   const signed=await ownerClients.kms.send(new GenerateMacCommand(mac));assert.equal(signed.Mac.length,32);signed.Mac.fill(0);
   assert.equal(owner.writes,before.writes+1);assert.equal(owner.generates,before.generates+1);
  }finally{for(const c of [...Object.values(ownerClients),...Object.values(recoveryClients)])c.destroy();}
  reader=fork(file('synthetic-custody-reader.fixture.mjs'),[],{execArgv:[],env:{...env,CHARITYPILOT_TEST_CUSTODY_SESSION_FILE:recoveryPath},stdio:['ignore','pipe','pipe','ipc']});let result,reportCount=0;reader.on('message',value=>{result=value;reportCount++;});readerTerminal=terminal(reader);const readLog=childOutput(reader);
  assert.equal((await readerTerminal).code,0,readLog().slice(-4000));assert.equal(reportCount,1);assert.equal(result.kind,'SYNTHETIC_COLD_CUSTODY_READER_V1');assert.ok(result.verifiedRoots>=1);assert.ok(result.killedSourceServiceRecords>=1);assert.equal(result.suppliedSourceIdsOrPins,false);assert.equal(result.executionAuthorized,false);
  console.log('CURRENT_INSPECTION_COUNTS='+JSON.stringify({inspected:result.currentInspections,verifiedRoots:result.currentVerifiedRoots,unresolved:result.currentUnresolved}));
  // Ten legacy, five read-role and five retired-control ACK-fault cases plus
  // the original controls retained by two genuinely killed callers (formats 3/5).
  assert.equal(result.currentInspections,22);assert.equal(result.currentVerifiedRoots,6);assert.equal(result.currentUnresolved,16);
  assert.equal(result.readRoleCurrentInspections,5);assert.equal(result.readRoleCurrentVerifiedRoots,2);assert.equal(result.readRoleCurrentUnresolved,3);
  assert.equal(result.retiredControlCurrentInspections,6);assert.equal(result.retiredControlCurrentVerifiedRoots,2);assert.equal(result.retiredControlCurrentUnresolved,4);
   assert.ok(result.daemonCatalogues>=2);assert.ok(result.daemonCompleted>=2);assert.ok(result.daemonUnresolved>=1);
   assert.equal(result.daemonCatalogues,result.daemonCompleted+result.daemonUnresolved);
   console.log('COLD_DAEMON_DISCOVERY_COUNTS='+JSON.stringify({catalogues:result.daemonCatalogues,completed:result.daemonCompleted,unresolved:result.daemonUnresolved}));
  service.send({kind:'STOP_SYNTHETIC_CUSTODY_V1'});assert.equal((await serviceTerminal).code,0);
  await assert.rejects(callSyntheticCustody(descriptor,{op:'sessions'}));
  console.log('PASS independent synthetic process: source normal exit + genuine source SIGKILL; cold SDK LIST/GET/MAC/decrypt verifies retained roots and killed-source service bytes without source IDs/pins or new writes/data keys; service loss has no cache fallback; not real provider/VM-loss proof');
  console.log('COLD_READER_COUNTS='+JSON.stringify({sessions:result.sessions,records:result.records,roots:result.verifiedRoots,killedSourceServices:result.killedSourceServiceRecords,currentInspections:result.currentInspections,currentVerifiedRoots:result.currentVerifiedRoots,currentUnresolved:result.currentUnresolved}));
 }finally{
  for(const child of [reader,source,service])if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  await Promise.allSettled([readerTerminal,sourceTerminal,serviceTerminal].filter(Boolean));for(const path of [root,recoveryRoot].filter(Boolean)){assert.equal(dirname(path),resolve(tmpdir()));assert.match(basename(path),/^charitypilot-synthetic-custody-[A-Za-z0-9]{6}$/);assert.equal(realpathSync(path),path);assert.equal(lstatSync(path).uid,process.getuid());rmSync(path,{recursive:true,force:true});}
 }
});
