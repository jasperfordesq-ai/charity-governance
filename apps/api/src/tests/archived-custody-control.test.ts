import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {GetObjectCommand,PutObjectCommand} from '@aws-sdk/client-s3';
import {backend,config} from './fixtures/archived-custody.js';

test('synthetic keeper control CAS accepts one original writer and preserves immutable other paths',async()=>{
 const b=backend(),client=b.s3(),key=`managed-maintenance/${config.installationId}/control.json`;
 const put=(Key:string,Body:string,condition:{IfMatch?:string;IfNoneMatch?:string})=>client.send(new PutObjectCommand({
  Bucket:config.bucket,ExpectedBucketOwner:config.accountId,Key,Body,...condition,ChecksumSHA256:createHash('sha256').update(Body).digest('base64'),
  ServerSideEncryption:'aws:kms',SSEKMSKeyId:config.storageKeyArn}));
 try{
  const original=await put(key,'{"phase":"READY"}',{IfNoneMatch:'*'});
  const outcomes=await Promise.allSettled([put(key,'{"phase":"ONE"}',{IfMatch:original.ETag}),put(key,'{"phase":"TWO"}',{IfMatch:original.ETag})]);
  assert.equal(outcomes.filter(v=>v.status==='fulfilled').length,1);assert.equal(outcomes.filter(v=>v.status==='rejected').length,1);
  const saved=await client.send(new GetObjectCommand({Bucket:config.bucket,ExpectedBucketOwner:config.accountId,Key:key}));
  assert.notEqual(saved.ETag,original.ETag);assert.equal(await saved.Body!.transformToString(),'{"phase":"ONE"}');
  await assert.rejects(put(key,'{"phase":"REPLACED"}',{IfNoneMatch:'*'}));
  await assert.rejects(put('business-data/'+config.installationId+'/control.json','{}',{IfMatch:saved.ETag}));
  const fixed='managed-maintenance/'+config.installationId+'/attempt/baseline.json';
  await put(fixed,'{}',{IfNoneMatch:'*'});await assert.rejects(put(fixed,'{}',{IfNoneMatch:'*'}));
 }finally{client.destroy();b.close();}
});
