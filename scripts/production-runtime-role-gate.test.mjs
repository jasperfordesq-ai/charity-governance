import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProductionRuntimeRoleReceipt } from './production-compose-deploy.mjs';

test('runtime role receipt requires an exact successful phase-bound protocol',()=>{
  const value=JSON.stringify({schemaVersion:1,verified:true,phase:'after-migration'});
  assert.deepEqual(parseProductionRuntimeRoleReceipt(value+'\n','after-migration'),JSON.parse(value));
});
for(const value of [undefined,'', 'not-json','x'.repeat(2049),JSON.stringify({schemaVersion:1,verified:false,phase:'after-migration'}),
  JSON.stringify({schemaVersion:1,verified:true,phase:'before-migration'}),
  JSON.stringify({schemaVersion:1,verified:true,phase:'after-migration',unreviewed:true}),
  '{"schemaVersion":1,"verified":false,"verified":true,"phase":"after-migration"}']) {
  test('runtime role receipt refuses absent, stale or ambiguous evidence',()=>{
    assert.throws(()=>parseProductionRuntimeRoleReceipt(value,'after-migration'),error=>{
      assert.equal(error.message,'Production runtime database role verification failed.');
      assert.equal(error.cause,undefined);return true;
    });
  });
}
