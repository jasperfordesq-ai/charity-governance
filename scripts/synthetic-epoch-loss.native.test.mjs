import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,chmodSync,writeFileSync,openSync,fsyncSync,closeSync,rmSync,realpathSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {callSyntheticCustody} from './synthetic-custody-wire.mjs';
import {provisionSyntheticEpochGenesis,validateOriginalSyntheticEpochAck} from './managed-epoch-native.fixture.mjs';
import {captureHelperImplementationBinding} from './postgres-backup.mjs';
import {syntheticEpochAckLossModes} from './synthetic-epoch-ack-loss.mjs';
import {syntheticEpochReadFaultModes} from './synthetic-epoch-read-fault.mjs';
const file=name=>fileURLToPath(new URL('./'+name,import.meta.url));
function terminal(child){const p=new Promise((yes,no)=>{child.once('error',no);child.once('close',(code,signal)=>yes({code,signal}));});void p.catch(()=>{});return p;}
function output(child){let body='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{body+=b.toString();if(body.length>1024*1024)child.kill('SIGKILL');});return()=>body;}
function persist(root,name,value){const path=join(root,name);writeFileSync(path,JSON.stringify(value),{flag:'wx',mode:0o600});for(const target of [path,root]){const fd=openSync(target,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}return path;}
for(const mode of ['NONE',...syntheticEpochAckLossModes])test('native epoch publication '+mode+' retains original ACK uncertainty across a fresh recovery process',{
 skip:process.platform!=='linux'||process.env.CHARITYPILOT_TEST_EPOCH_ACK_LOSS_NATIVE!=='1',timeout:180000
},async()=>{
 assert.notEqual(process.getuid(),0);assert.equal(process.env.CHARITYPILOT_TEST_SOURCE_PARENT_FIXTURE,undefined);
 const root=mkdtempSync(join(tmpdir(),'charitypilot-synthetic-custody-')),recoveryRoot=mkdtempSync(join(tmpdir(),'charitypilot-synthetic-custody-'));for(const path of [root,recoveryRoot])chmodSync(path,0o700);
 let service,serviceTerminal,source,sourceTerminal,reader,readerTerminal;const extraRoots=[];
 try{
  const cleanEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!['NODE_OPTIONS','NODE_PATH','NODE_TEST_CONTEXT','CHARITYPILOT_TEST_EPOCH_ACK_LOSS','CHARITYPILOT_TEST_EPOCH_CATALOGUE_PROBE'].includes(key)));
  const serviceEnv=Object.fromEntries(['PATH','SystemRoot','WINDIR','TEMP','TMP','HOME'].filter(k=>cleanEnv[k]!==undefined).map(k=>[k,cleanEnv[k]]));
  service=fork(file('synthetic-custody-service.fixture.mjs'),[],{execArgv:[],env:serviceEnv,stdio:['ignore','pipe','pipe','ipc']});serviceTerminal=terminal(service);const serviceLog=output(service);
  const announced=await new Promise((yes,no)=>{const timer=setTimeout(()=>no(new Error('Synthetic epoch custody readiness expired')),15000);service.once('message',v=>{clearTimeout(timer);yes(v);});service.once('exit',()=>{clearTimeout(timer);no(new Error(serviceLog().slice(-1000)));});});
  assert.equal(announced.kind,'SYNTHETIC_CUSTODY_PROCESS_V1');assert.notEqual(announced.capability,announced.recoveryCapability);
  const descriptor={kind:announced.kind,endpoint:announced.endpoint,capability:announced.capability},recovery={...descriptor,capability:announced.recoveryCapability};
  const sessionPath=persist(root,'session.json',descriptor),recoverySessionPath=persist(recoveryRoot,'session.json',recovery);
  const bootstrap=await provisionSyntheticEpochGenesis(descriptor),bootstrapPath=persist(root,'epoch-bootstrap.json',bootstrap);
  if(mode!=='NONE')await callSyntheticCustody(descriptor,{op:'flag',id:bootstrap.sessionId,name:'epochAckLoss',value:mode});
  const env={...cleanEnv,CHARITYPILOT_TEST_CUSTODY_SESSION_FILE:sessionPath,CHARITYPILOT_TEST_CONTAINED_SOURCE:'1',CHARITYPILOT_TEST_EPOCH_ONLY:'1',CHARITYPILOT_TEST_EPOCH_BOOTSTRAP_FILE:bootstrapPath,...(mode!=='NONE'?{CHARITYPILOT_TEST_EPOCH_ACK_LOSS:mode}:{})};
  const sourceSha=captureHelperImplementationBinding().commitSha,acks=[],unresolved=[];let receiptError;
  source=fork(file('managed-database-writer-fence-postgres.test.mjs'),[],{execArgv:[],env,stdio:['ignore','pipe','pipe','ipc']});sourceTerminal=terminal(source);const sourceLog=output(source);
  source.on('message',value=>{try{
   if(value.kind==='ORIGINAL_SYNTHETIC_EPOCH_ACK_V1'){
    const ack=validateOriginalSyntheticEpochAck(value,acks.length+1,sourceSha);assert.ok(ack.sequence<=(mode==='NONE'?2:1));persist(recoveryRoot,'original-epoch-ack-'+ack.sequence+'.json',ack);acks.push(ack);
   }else{
    assert.deepEqual(value,{kind:'ORIGINAL_SYNTHETIC_EPOCH_UNRESOLVED_V1',mode,maintenanceEpoch:2,sourceSha,originalAcknowledgementReconstructed:false});
    assert.equal(unresolved.length,0);persist(recoveryRoot,'original-unresolved-publication.json',value);unresolved.push(value);
   }
  }catch(error){receiptError=error;}});
  assert.equal((await sourceTerminal).code,0,sourceLog().slice(-6000));if(receiptError)throw receiptError;
  assert.equal(service.exitCode,null);assert.equal(acks.length,mode==='NONE'?2:1);assert.equal(unresolved.length,mode==='NONE'?0:1);
  const stats=await callSyntheticCustody(descriptor,{op:'stats',id:bootstrap.sessionId});
  if(mode!=='NONE')assert.deepEqual(stats.epochAckLoss,{mode,used:true,storedRecordPresent:true,responseLostAfterSdkOperation:true});
  const checkpoint=acks.at(-1),recoveryBootstrap=persist(recoveryRoot,'epoch-bootstrap.json',{...bootstrap,trustedCheckpoint:{sequence:checkpoint.sequence,sha256:checkpoint.entrySha256}});
  const runReader=async(path=recoveryBootstrap,probe=false)=>{
   reader=fork(file('synthetic-epoch-reader.fixture.mjs'),[],{execArgv:[],env:{...env,CHARITYPILOT_TEST_CUSTODY_SESSION_FILE:recoverySessionPath,CHARITYPILOT_TEST_EPOCH_BOOTSTRAP_FILE:path,...(probe?{CHARITYPILOT_TEST_EPOCH_CATALOGUE_PROBE:'1'}:{})},stdio:['ignore','pipe','pipe','ipc']});readerTerminal=terminal(reader);const log=output(reader),reports=[];reader.on('message',v=>reports.push(v));
   return{terminal:await readerTerminal,reports,log:log()};
  };
  const initial=await runReader(),reports=initial.reports;
  assert.equal(initial.terminal.code,0,initial.log.slice(-6000));assert.equal(reports.length,1);assert.equal(reports[0].kind,'SYNTHETIC_COLD_EPOCH_RESULT_V1');assert.equal(reports[0].mode,mode);
  if(mode==='NONE')assert.deepEqual(reports[0].result,{entries:2,latestEpoch:2,verifiedCurrentRoots:1,externalOriginalAckCheckpoint:true});
  else assert.deepEqual(reports[0].result,{entries:mode.startsWith('HEAD_')?2:1,checkpointSequence:1,savedEntry2Visible:true,head2Published:mode.startsWith('HEAD_'),verifiedHistoricalRoots:1,currentControlMismatchRefused:mode.startsWith('ENTRY_'),originalPublicationUnresolved:true,originalAcknowledgementReconstructed:false,executionAuthorized:false,sourceHostLossProven:false});
  if(mode==='NONE'){
   const refusals=[];let positiveChecks=1;
   const refuse=async(name,path=recoveryBootstrap)=>{const failed=await runReader(path,true);assert.notEqual(failed.terminal.code,0);assert.equal(failed.terminal.signal,null);assert.equal(failed.reports.length,0);assert.match(failed.log,/Managed recovery epoch catalogue is unresolved/);refusals.push(name);};
   const positive=async()=>{const fresh=await runReader();assert.equal(fresh.terminal.code,0,fresh.log.slice(-3000));assert.deepEqual(fresh.reports,reports);positiveChecks++;};
   for(const fault of syntheticEpochReadFaultModes){
    await callSyntheticCustody(descriptor,{op:'flag',id:bootstrap.sessionId,name:'epochReadFault',value:fault});
    try{await refuse(fault);const observed=await callSyntheticCustody(descriptor,{op:'stats',id:bootstrap.sessionId});assert.equal(observed.epochReadFault.mode,fault);assert.ok(observed.epochReadFault.applied>=1);}
    finally{await callSyntheticCustody(descriptor,{op:'flag',id:bootstrap.sessionId,name:'epochReadFault',value:null});}
    await positive();
   }
   const differentSha=value=>value==='a'.repeat(64)?'b'.repeat(64):'a'.repeat(64),trusted={...bootstrap,trustedCheckpoint:{sequence:checkpoint.sequence,sha256:checkpoint.entrySha256}};
   for(const [name,change] of [['WRONG_CHECKPOINT_SHA',{trustedCheckpoint:{sequence:2,sha256:differentSha(checkpoint.entrySha256)}}],['FUTURE_CHECKPOINT',{trustedCheckpoint:{sequence:3,sha256:checkpoint.entrySha256}}],['SUBSTITUTED_GENESIS',{genesisHeadSha256:differentSha(bootstrap.genesisHeadSha256)}]]){
    const substituted=mkdtempSync(join(tmpdir(),'charitypilot-synthetic-custody-'));chmodSync(substituted,0o700);extraRoots.push(substituted);
    await refuse(name,persist(substituted,'epoch-bootstrap.json',{...trusted,...change}));await positive();
   }
   assert.equal(refusals.length,6);assert.equal(positiveChecks,7);console.log('NATIVE_EPOCH_READ_REFUSALS='+JSON.stringify({refusals,positiveChecks,sourceIdsOrArchivePinsSupplied:false}));
  }
  const after=await callSyntheticCustody(descriptor,{op:'stats',id:bootstrap.sessionId});assert.equal(after.writes,stats.writes);assert.equal(after.generates,stats.generates);
  console.log('NATIVE_EPOCH_ACK_LOSS_COUNTS='+JSON.stringify({mode,originalPublicationAcks:acks.length,...reports[0].result}));
  service.send({kind:'STOP_SYNTHETIC_CUSTODY_V1'});assert.equal((await serviceTerminal).code,0);await assert.rejects(callSyntheticCustody(descriptor,{op:'sessions'}));
 }finally{
  for(const child of [reader,source,service])if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  await Promise.allSettled([readerTerminal,sourceTerminal,serviceTerminal].filter(Boolean));
  for(const path of [root,recoveryRoot,...extraRoots]){assert.equal(dirname(path),resolve(tmpdir()));assert.match(basename(path),/^charitypilot-synthetic-custody-[A-Za-z0-9]{6}$/);assert.equal(realpathSync(path),path);assert.equal(lstatSync(path).uid,process.getuid());assert.equal(lstatSync(path).mode&0o777,0o700);rmSync(path,{recursive:true,force:true});}
 }
});
