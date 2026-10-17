import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {independentOwnerProbeArguments,probeIndependentDaemonOwner} from './managed-daemon-owner-probe.mjs';
import {DEFAULT_POSTGRES_IMAGE,PROOF_CLIENT_DATA_TMPFS} from './postgres-backup.mjs';
test('independent owner acceptance exposes only fixed bounded synthetic Docker workload',()=>{
 const args=independentOwnerProbeArguments(randomUUID());assert.ok(args.includes(DEFAULT_POSTGRES_IMAGE));assert.ok(args.includes(PROOF_CLIENT_DATA_TMPFS));
 for(const value of ['--network=none','--read-only','--cap-drop=ALL','--memory=64m','--pids-limit=32','--pull=never'])assert.ok(args.includes(value));
 assert.equal(args.includes('--privileged'),false);assert.equal(args.some(v=>v==='-v'||v==='-p'||v==='--mount'),false);
 assert.throws(()=>independentOwnerProbeArguments('not-original-job'));assert.throws(()=>independentOwnerProbeArguments('../other-unit'));
});
test('actual independent request owner survives caller loss and owner loss stays unresolved',{
 skip:process.platform!=='linux'||process.env.CHARITYPILOT_TEST_DAEMON_OWNER!=='1',timeout:90000
},async()=>{
 for(const mode of ['caller-loss','owner-loss']){const value=await probeIndependentDaemonOwner(mode);
  assert.equal(value.ownerIndependent,true);assert.equal(value.callerStopped,true);assert.equal(value.recordedOwnerResponse,mode==='caller-loss');
  for(const key of ['pendingRequestResolved','productionIntegrated','independentProvider','sourceHostLossProven','completeResourceInventory','cleanupAuthorized','actionAuthorized'])assert.equal(value[key],false);
  console.log('INDEPENDENT_OWNER_PROBE='+JSON.stringify(value));
 }
});
