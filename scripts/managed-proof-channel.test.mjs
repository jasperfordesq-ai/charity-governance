import test from 'node:test';
import assert from 'node:assert/strict';
import {createManagedGuardianChannel,connectManagedGuardianParent} from './managed-proof-channel.mjs';
test('missing source/custody and invalid channels refuse before any service or worker launch',async()=>{
 for(const config of [{},{jobId:'saved-service'},{sourceSha:'wrong',input:Buffer.from('{}'),authorizeInvocation:()=>true}])await assert.rejects(createManagedGuardianChannel(config));
 for(const path of [null,'/tmp/guardian.sock','/tmp/../guardian.sock','/tmp/charitypilot-managed-channel-aaaaaa/arbitrary.sock'])await assert.rejects(connectManagedGuardianParent(path));
});
test('job substitution, unsafe environment and pre-aborted original invocation refuse',async()=>{
 const jobId='11111111-1111-4111-8111-111111111111',base={jobId,sourceSha:'1'.repeat(40),input:Buffer.from(JSON.stringify({jobId})),env:{},authorizeInvocation:()=>true};
 await assert.rejects(createManagedGuardianChannel({...base,input:Buffer.from(JSON.stringify({jobId:'22222222-2222-4222-8222-222222222222'}))}));
 for(const env of [{NODE_OPTIONS:'--inspect'},{INVOCATION_ID:'saved-invocation'},{PATH:42},{PATH:'bad\0path'}])await assert.rejects(createManagedGuardianChannel({...base,env}));
 const controller=new AbortController();controller.abort();await assert.rejects(createManagedGuardianChannel({...base,signal:controller.signal}));
});
