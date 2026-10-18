import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {independentOwnerProbeArguments,probeIndependentDaemonOwner,probeFixedDaemonOwner,ownerProbeInspectAbsent} from './managed-daemon-owner-probe.mjs';
import {DEFAULT_POSTGRES_IMAGE,PROOF_CLIENT_DATA_TMPFS} from './postgres-backup.mjs';
test('independent owner acceptance exposes only fixed bounded synthetic Docker workload',()=>{
 const args=independentOwnerProbeArguments(randomUUID());assert.ok(args.includes(DEFAULT_POSTGRES_IMAGE));assert.ok(args.includes(PROOF_CLIENT_DATA_TMPFS));
 for(const value of ['--network=none','--read-only','--cap-drop=ALL','--memory=64m','--pids-limit=32','--pull=never'])assert.ok(args.includes(value));
 assert.equal(args.includes('--privileged'),false);assert.equal(args.some(v=>v==='-v'||v==='-p'||v==='--mount'),false);
 assert.throws(()=>independentOwnerProbeArguments('not-original-job'));assert.throws(()=>independentOwnerProbeArguments('../other-unit'));
});
test('inspect absence requires exact original target, exit1 and empty-array response without transport uncertainty',()=>{
 const target='charitypilot-owner-probe-'+randomUUID(),base={status:1,stdout:'[]\n',stderr:'error: no such object: '+target+'\n'};
 assert.equal(ownerProbeInspectAbsent(base,target),true);
 assert.equal(ownerProbeInspectAbsent({...base,stderr:'Error: No such object: '+target},target),true);
 for(const change of [{status:2},{status:null},{error:new Error('synthetic')},{signal:'SIGKILL'},{stdout:''},{stdout:'[{}]'},{stderr:'error: no such object: other'},{stderr:'error: no such object: '+target+'\nconnection lost'}])assert.equal(ownerProbeInspectAbsent({...base,...change},target),false);
});
test('actual independent request owner survives caller loss and owner loss stays unresolved',{
 skip:process.platform!=='linux'||process.env.CHARITYPILOT_TEST_DAEMON_OWNER!=='1',timeout:90000
},async()=>{
 for(const mode of ['caller-loss','owner-loss']){const value=await probeIndependentDaemonOwner(mode);
  assert.equal(value.ownerIndependent,true);assert.equal(value.callerStopped,true);assert.equal(value.recordedOwnerResponse,mode==='caller-loss');
  assert.equal(value.originalOwnerAcknowledgementObserved,true);
  assert.equal(value.sourceContextClosedBeforeOutcome,true);assert.equal(value.ownerOutcomeStored,mode==='caller-loss');
  for(const key of ['pendingRequestResolved','productionIntegrated','independentProvider','sourceHostLossProven','completeResourceInventory','cleanupAuthorized','actionAuthorized'])assert.equal(value[key],false);
  console.log('INDEPENDENT_OWNER_PROBE='+JSON.stringify(value));
 }
});

test('owner outcome stored after source closure with unknown ACK stays discoverable without retry',{
 skip:process.platform!=='linux'||process.env.CHARITYPILOT_TEST_DAEMON_OWNER!=='1',timeout:45000
},async()=>{
 const value=await probeIndependentDaemonOwner('outcome-ack-lost');assert.equal(value.ownerOutcomeStored,true);
 assert.equal(value.originalOutcomeAcknowledgementObserved,false);assert.equal(value.sourceContextClosedBeforeOutcome,true);
 assert.equal(value.pendingRequestResolved,false);assert.equal(value.actionAuthorized,false);
 console.log('ORIGINAL_OWNER_OUTCOME_ACK_LOSS='+JSON.stringify(value));
});

test('stored owner outcome with lost original wire ACK stays readable after source closure without retry',{
 skip:process.platform!=='linux'||process.env.CHARITYPILOT_TEST_DAEMON_OWNER!=='1',timeout:45000
},async()=>{
 const value=await probeIndependentDaemonOwner('outcome-wire-ack-lost');assert.equal(value.ownerOutcomeStored,true);
 assert.equal(value.originalOutcomeAcknowledgementObserved,false);assert.equal(value.sourceContextClosedBeforeOutcome,true);
 assert.equal(value.ownerOutcomeThroughPrivateChannel,true);assert.equal(value.pendingRequestResolved,false);assert.equal(value.actionAuthorized,false);
 console.log('ORIGINAL_OWNER_OUTCOME_WIRE_ACK_LOSS='+JSON.stringify(value));
});

test('stored OWNER binding with lost original channel ACK cannot release the independent service',{
 skip:process.platform!=='linux'||process.env.CHARITYPILOT_TEST_DAEMON_OWNER!=='1',timeout:45000
},async()=>{
 const value=await probeIndependentDaemonOwner('owner-ack-lost');
 assert.equal(value.ownerBindingStored,true);assert.equal(value.requestDispatched,false);assert.equal(value.originalOwnerAcknowledgementObserved,false);
 assert.equal(value.originalAcknowledgementReconstructed,false);assert.equal(value.pendingRequestResolved,false);assert.equal(value.actionAuthorized,false);
 console.log('ORIGINAL_OWNER_ACK_LOSS='+JSON.stringify(value));
});

test('actual fixed owner worker preserves custody through caller loss and unknown wire ACKs',{
 skip:process.platform!=='linux'||process.env.CHARITYPILOT_TEST_DAEMON_OWNER!=='1',timeout:120000
},async()=>{
 for(const mode of ['complete','caller-loss','owner-ack-lost','outcome-ack-lost']){
  const v=await probeFixedDaemonOwner(mode);assert.equal(v.actualFixedWorker,true);assert.equal(v.originalOwnerServiceVerified,true);
  assert.equal(v.ownerOutcomeStored,mode!=='owner-ack-lost');assert.equal(v.privateOutputReturned,mode==='complete');
  assert.equal(v.sourceCallerStopped,['caller-loss','outcome-ack-lost'].includes(mode));
  for(const key of ['productionIntegrated','independentProvider','sourceParentLossProven','sourceHostLossProven','pendingRequestResolved','cleanupAuthorized','actionAuthorized'])assert.equal(v[key],false);
  console.log('ACTUAL_FIXED_OWNER_SERVICE='+JSON.stringify(v));
 }
});

test('actual fixed custody receiver with denied original claim never releases daemon dispatch',{
 skip:process.platform!=='linux'||process.env.CHARITYPILOT_TEST_DAEMON_OWNER!=='1',timeout:45000
},async()=>{
 const v=await probeFixedDaemonOwner('custody-claim-denied');assert.equal(v.actualKernelCustodyClaimDenied,true);
 assert.equal(v.ownerOutcomeStored,false);assert.equal(v.privateOutputReturned,false);assert.equal(v.pendingRequestResolved,false);
 assert.equal(v.originalAcknowledgementReconstructed,false);assert.equal(v.actionAuthorized,false);
 console.log('ACTUAL_CUSTODY_CLAIM_DENIED='+JSON.stringify(v));
});
