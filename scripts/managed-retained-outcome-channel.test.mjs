import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createManagedDaemonCustodyChannel} from './managed-daemon-custody-channel.mjs';
import {requestManagedDaemonCustody} from './managed-daemon-custody-client.mjs';
import {prepareOutcomeCustodyEndpoint,serveOutcomeCustody} from './managed-outcome-custodian.mjs';
import {runManagedDaemonOwner} from './managed-daemon-owner-worker.mjs';
import {independentOwnerProbeArguments} from './managed-daemon-owner-probe.mjs';
import {planManagedProofStorage} from './postgres-backup.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex'),artifact=v=>{const body=JSON.stringify(v);return{body,sha256:hash(body),byteLength:Buffer.byteLength(body)};};
const saved=(kind='BASELINE')=>({pin:{kind,versionId:'synthetic-version',sha256:'a'.repeat(64),byteLength:100},savedEvidenceAuthorizesDispatch:false,independentOwnerDispatchVerified:false,pendingRequestResolved:false,actionAuthorized:false});
const enabled=process.platform==='linux'&&process.getuid()!==0;
for(const mode of ['complete','missing-handoff','wrong-job','probe-refused','receipt-refused'])test('explicit retained outcome wire: '+mode,{skip:!enabled,timeout:10000},async()=>{
 const jobId=randomUUID(),sourceSha='1'.repeat(40),inputDigest='2'.repeat(64),receiverId=randomUUID(),endpoint=prepareOutcomeCustodyEndpoint();let gate,service,writes=0,executed=0,receipts=0;
 const receiver={format:1,kind:'MANAGED_OUTCOME_RECEIVER_V1',jobId,sourceSha,receiverId,inputDigest:'3'.repeat(64),identity:{unit:`charitypilot-containment-${receiverId}.service`,
  invocationId:'4'.repeat(32),uid:process.getuid(),mainPid:process.pid,mainStartMonotonic:'12345',bootId:'12345678-1234-1234-1234-123456789012',
  controlGroup:`/user.slice/user-${process.getuid()}.slice/user@${process.getuid()}.service/app.slice/charitypilot-containment-${receiverId}.service`}};
 try{
  service=await serveOutcomeCustody({endpoint:endpoint.binding(),receiver,expiresMonotonicNs:(process.hrtime.bigint()+10000000000n).toString(),grant:{publish:async()=>{writes++;return saved('OBSERVATION');},revoke(){}}});
  const handoff={format:1,kind:'MANAGED_RETAINED_OUTCOME_HANDOFF_V1',endpoint:{...endpoint.binding(),...(mode==='probe-refused'?{capability:'0'.repeat(64)}:{})},
   receiver:{...receiver,...(mode==='wrong-job'?{jobId:randomUUID()}:{})}};
  gate=await createManagedDaemonCustodyChannel({jobId,inputDigest,sourceSha,requireIndependentOwner:true,requireIndependentOutcome:true,requireOwnerInput:true,requireRetainedOutcome:true,
   onHeader:async()=>saved(),onIntent:async()=>saved(),onOwner:async()=>({...saved(),...(mode==='missing-handoff'?{}:{retainedOutcome:handoff})}),
   onOwnerOutcome:async(_a,receipt)=>{receipts++;assert.deepEqual(receipt.pin,saved('OBSERVATION').pin);if(mode==='receipt-refused')throw Error('synthetic receipt refusal');return saved('OBSERVATION');},
   onResponse:async()=>saved('OBSERVATION'),onEnd:async()=>saved('OBSERVATION')});
  const args=independentOwnerProbeArguments(jobId),intent=artifact({format:2,kind:'MANAGED_DAEMON_REQUEST_INTENT_V2',jobId,sequence:1,previousDigest:'5'.repeat(64),operation:'run',
   target:args[args.indexOf('--name')+1],storagePlan:planManagedProofStorage(args,jobId),argumentsDigest:hash('CHARITYPILOT_DAEMON_ARGUMENTS_V1\n'+jobId+'\n'+JSON.stringify(args))});
  const send=(kind,a)=>requestManagedDaemonCustody({kind,artifact:a,descriptorPath:gate.descriptorPath,jobId,inputDigest,sourceSha});
  await send('HEADER',artifact({kind:'MANAGED_DAEMON_REQUEST_HEADER_V2',jobId,inputDigest}));await send('INTENT',intent);
  const input={format:1,kind:'MANAGED_DAEMON_OWNER_INPUT_V1',jobId,ownerId:randomUUID(),sourceSha,inputDigest,descriptorPath:gate.descriptorPath,intent,args,environment:{},timeoutMs:1000,maxBuffer:4096,outcomeMode:'RETAINED_SDK_V1'};
  const run=()=>runManagedDaemonOwner(input,{identity:()=>({ownerId:input.ownerId,inputDigest:hash(JSON.stringify(input))}),execute:()=>{executed++;return{status:0,stdout:'synthetic wire result',stderr:''};}});
  if(mode==='complete'){assert.equal((await run()).stdout,'synthetic wire result');assert.equal(gate.snapshot().ownerOutcomeCount,1);
   await send('RESPONSE',artifact({kind:'MANAGED_DAEMON_CLIENT_RESPONSE_V1',jobId,sequence:1,intentPin:{sha256:intent.sha256,byteLength:intent.byteLength},status:0,transportError:false,signal:false,removalAlreadyAbsent:false}));assert.equal(gate.snapshot().responseCount,1);
  }else await assert.rejects(run());
  assert.equal(executed,['complete','receipt-refused'].includes(mode)?1:0);assert.equal(writes,executed);assert.equal(receipts,executed);
 }finally{await gate?.close();await service?.close();endpoint.close();}
});
