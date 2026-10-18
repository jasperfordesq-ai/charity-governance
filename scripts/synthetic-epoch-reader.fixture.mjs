import assert from 'node:assert/strict';
import {readSyntheticCustodyDescriptor} from './synthetic-custody-wire.mjs';
import {inspectSyntheticEpochRecovery,inspectSyntheticEpochLossRecovery} from './managed-epoch-native.fixture.mjs';
import {syntheticEpochAckLossModes} from './synthetic-epoch-ack-loss.mjs';
assert.equal(process.platform,'linux');assert.equal(process.connected,true);assert.equal(process.argv.length,2);
const descriptor=readSyntheticCustodyDescriptor(process.env.CHARITYPILOT_TEST_CUSTODY_SESSION_FILE),path=process.env.CHARITYPILOT_TEST_EPOCH_BOOTSTRAP_FILE,mode=process.env.CHARITYPILOT_TEST_EPOCH_ACK_LOSS;
assert.ok(mode===undefined||syntheticEpochAckLossModes.includes(mode));
const result=mode?await inspectSyntheticEpochLossRecovery(descriptor,path,mode):await inspectSyntheticEpochRecovery(descriptor,path);
await new Promise((yes,no)=>process.send({kind:'SYNTHETIC_COLD_EPOCH_RESULT_V1',mode:mode??'NONE',result},error=>error?no(error):yes()));process.disconnect();
