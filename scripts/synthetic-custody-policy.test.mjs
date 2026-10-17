import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticCustodyAllowed} from './synthetic-custody-policy.mjs';
test('recovery fixture capability allows discovery, exact reads, decrypt and MAC verification',()=>{
 for(const op of ['sessions','stats','metadata'])assert.equal(syntheticCustodyAllowed('recovery',{op}),true);
 assert.equal(syntheticCustodyAllowed('recovery',{op:'sdk',service:'s3',request:{method:'GET'}}),true);
 for(const method of ['Decrypt','VerifyMac'])assert.equal(syntheticCustodyAllowed('recovery',{op:'sdk',service:'kms',request:{headers:{'x-amz-target':'TrentService.'+method}}}),true);
});
test('recovery fixture rejects owner actions, writes, new keys, signing and caller role spoofing',()=>{
 for(const op of ['open','flag','bindControl'])assert.equal(syntheticCustodyAllowed('recovery',{op,role:'owner'}),false);
 for(const method of ['PUT','POST','DELETE','PATCH'])assert.equal(syntheticCustodyAllowed('recovery',{op:'sdk',service:'s3',request:{method},role:'owner'}),false);
 for(const method of ['GenerateDataKey','GenerateMac','Encrypt','CreateKey','ScheduleKeyDeletion'])assert.equal(syntheticCustodyAllowed('recovery',{op:'sdk',service:'kms',request:{headers:{'x-amz-target':'TrentService.'+method}}}),false);
 assert.equal(syntheticCustodyAllowed('unknown',{op:'sdk'}),false);assert.equal(syntheticCustodyAllowed('recovery',{op:'sdk',service:'other',request:{method:'GET'}}),false);
 assert.equal(syntheticCustodyAllowed('owner',{op:'flag'}),true);assert.equal(syntheticCustodyAllowed('owner',{op:'unknown'}),false);
});
