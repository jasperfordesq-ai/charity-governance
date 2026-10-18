import test from 'node:test';
import {proveContainedParentLoss} from './managed-contained-parent-loss.fixture.mjs';
for(const captureFormat of ['3','5'])test('format '+captureFormat+' real source caller loss stops its cohort while the original independent request owner and unresolved quarantine survive',{
 skip:process.platform!=='linux'||process.env.CHARITYPILOT_TEST_CONTAINED_PARENT!=='1',timeout:120000
},()=>proveContainedParentLoss({captureFormat}));
