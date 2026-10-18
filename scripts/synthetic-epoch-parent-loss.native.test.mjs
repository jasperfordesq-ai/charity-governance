import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,chmodSync,writeFileSync,openSync,fsyncSync,closeSync,rmSync,realpathSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {proveContainedParentLoss} from './managed-contained-parent-loss.fixture.mjs';
import {provisionSyntheticEpochGenesis,validateOriginalSyntheticEpochAck} from './managed-epoch-native.fixture.mjs';
import {captureHelperImplementationBinding} from './postgres-backup.mjs';
import {callSyntheticCustody} from './synthetic-custody-wire.mjs';
const file=name=>fileURLToPath(new URL('./'+name,import.meta.url));
function terminal(child){const p=new Promise((yes,no)=>{child.once('error',no);child.once('close',(code,signal)=>yes({code,signal}));});void p.catch(()=>{});return p;}
function output(child){let body='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{body+=b.toString();if(body.length>1024*1024)child.kill('SIGKILL');});return()=>body;}
function persist(root,name,value){const path=join(root,name);writeFileSync(path,JSON.stringify(value),{flag:'wx',mode:0o600});for(const target of [path,root]){const fd=openSync(target,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}return path;}
test('genuine epoch2 caller loss preserves the original two-epoch checkpoint, historical archive and unresolved current candidate',{
 skip:process.platform!=='linux'||process.env.CHARITYPILOT_TEST_EPOCH_PARENT_NATIVE!=='1',timeout:180000
},async()=>{
 assert.notEqual(process.getuid(),0);const helper=captureHelperImplementationBinding();assert.equal(helper.sourceMatchesCommit,true);assert.equal(helper.canonicalRepositoryMatched,true);
 const roots=Array.from({length:2},()=>{const root=mkdtempSync(join(tmpdir(),'charitypilot-synthetic-custody-'));chmodSync(root,0o700);return root;});let service,serviceTerminal,reader,readerTerminal;
 try{
  const base=Object.fromEntries(['PATH','SystemRoot','WINDIR','TEMP','TMP','HOME'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
  service=fork(file('synthetic-custody-service.fixture.mjs'),[],{execArgv:[],env:base,stdio:['ignore','pipe','pipe','ipc']});serviceTerminal=terminal(service);const serviceLog=output(service);
  const announced=await new Promise((yes,no)=>{const timer=setTimeout(()=>no(new Error('Synthetic custody readiness expired')),15000);service.once('message',v=>{clearTimeout(timer);yes(v);});service.once('exit',()=>{clearTimeout(timer);no(new Error(serviceLog().slice(-1000)));});});
  assert.equal(announced.kind,'SYNTHETIC_CUSTODY_PROCESS_V1');assert.notEqual(announced.capability,announced.recoveryCapability);
  const owner={kind:announced.kind,endpoint:announced.endpoint,capability:announced.capability},recovery={...owner,capability:announced.recoveryCapability};
  const sessionPath=persist(roots[0],'session.json',owner),recoverySessionPath=persist(roots[1],'session.json',recovery),bootstrap=await provisionSyntheticEpochGenesis(owner),bootstrapPath=persist(roots[0],'epoch-bootstrap.json',bootstrap),acks=[];
  await proveContainedParentLoss({captureFormat:'5',custodySessionFile:sessionPath,epoch:{bootstrapFile:bootstrapPath,
   onAcknowledgement(value){const ack=validateOriginalSyntheticEpochAck(value,acks.length+1,helper.commitSha);assert.ok(ack.sequence<=2);persist(roots[1],'original-epoch-ack-'+ack.sequence+'.json',ack);acks.push(ack);},
   async afterLoss(){
    assert.equal(acks.length,2);assert.notEqual(acks[0].entrySha256,acks[1].entrySha256);assert.notEqual(acks[0].headRevision,acks[1].headRevision);assert.equal(service.exitCode,null);
    const path=persist(roots[1],'epoch-bootstrap.json',{...bootstrap,trustedCheckpoint:{sequence:2,sha256:acks[1].entrySha256}}),before=await callSyntheticCustody(owner,{op:'stats',id:bootstrap.sessionId});
    reader=fork(file('synthetic-epoch-reader.fixture.mjs'),[],{execArgv:[],env:{...base,CHARITYPILOT_TEST_CUSTODY_SESSION_FILE:recoverySessionPath,CHARITYPILOT_TEST_EPOCH_BOOTSTRAP_FILE:path,CHARITYPILOT_TEST_EPOCH_CALLER_LOSS:'1'},stdio:['ignore','pipe','pipe','ipc']});readerTerminal=terminal(reader);const log=output(reader),reports=[];reader.on('message',value=>reports.push(value));
    assert.equal((await readerTerminal).code,0,log().slice(-5000));assert.deepEqual(reports,[{kind:'SYNTHETIC_COLD_EPOCH_RESULT_V1',mode:'NONE',result:{entries:2,latestEpoch:2,checkpointSequence:2,currentUnresolvedCandidates:1,currentVerifiedRoots:0,verifiedHistoricalRoots:1,originalAcknowledgementReconstructed:false,cleanupAuthorized:false,executionAuthorized:false,sourceHostLossProven:false}}]);
    const after=await callSyntheticCustody(owner,{op:'stats',id:bootstrap.sessionId});assert.equal(after.writes,before.writes);assert.equal(after.generates,before.generates);
    console.log('NATIVE_SHARED_EPOCH_CALLER_LOSS_COUNTS='+JSON.stringify({originalPublicationAcks:acks.length,...reports[0].result,sourceIdsOrArchivePinsSupplied:false}));
   }
  }});
  service.send({kind:'STOP_SYNTHETIC_CUSTODY_V1'});assert.equal((await serviceTerminal).code,0);await assert.rejects(callSyntheticCustody(owner,{op:'sessions'}));
 }finally{
  for(const child of [reader,service])if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await Promise.allSettled([readerTerminal,serviceTerminal].filter(Boolean));
  for(const root of roots){assert.equal(dirname(root),resolve(tmpdir()));assert.match(basename(root),/^charitypilot-synthetic-custody-[A-Za-z0-9]{6}$/);assert.equal(realpathSync(root),root);assert.equal(lstatSync(root).uid,process.getuid());assert.equal(lstatSync(root).mode&0o777,0o700);rmSync(root,{recursive:true,force:true});}
 }
});
