import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {recoveryReaderPolicy} from './recovery-reader-policy.mjs';
const accountId='123456789012',key=n=>`arn:aws:kms:eu-west-1:${accountId}:key/00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const config={accountId,bucket:'synthetic-recovery-review',installationId:'synthetic-installation',storageKeyArn:key(1),dataKeyArn:key(2),indexMacKeyArn:key(3),rootMacKeyArn:key(4),s3BucketKeyEnabled:false};
const bucket='arn:aws:s3:::'+config.bucket;
const array=v=>Array.isArray(v)?v:[v];
const matches=(patterns,value)=>typeof value==='string'&&array(patterns).some(p=>new RegExp('^'+p.split('*').map(v=>v.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$').test(value));
// Deliberately bounded evaluator of generated StringEquals/Like and Not variants.
// Not AWS policy validation. A broad external grant is included to exercise explicit denies.
function decision(policy,action,resource,context={},externalGrant=false){
 context={'s3:ResourceAccount':accountId,...context};
 let allow=externalGrant;
 for(const s of policy.Statement){
  if(s.Action&&!array(s.Action).includes(action)||s.NotAction&&array(s.NotAction).includes(action))continue;
  if(s.Resource&&!matches(s.Resource,resource)||s.NotResource&&matches(s.NotResource,resource))continue;
  if(!Object.entries(s.Condition??{}).every(([op,values])=>Object.entries(values).every(([k,v])=>{
   if(!['StringEquals','StringLike','StringNotEquals','StringNotLike'].includes(op))throw new Error('Unsupported test operator');
   const same=op.includes('Like')?matches(v,context[k]):array(v).includes(context[k]);return op.includes('Not')?!same:same;
  })))continue;
  if(s.Effect==='Deny')return false;if(s.Effect==='Allow')allow=true;
 }
 return allow;
}
test('archive and maintenance discovery, exact versions, direct decrypt and MAC verification remain usable',()=>{
 const {policy}=recoveryReaderPolicy(config);
 for(const prefix of ['business-data','managed-maintenance']){
  assert.ok(decision(policy,'s3:ListBucket',bucket,{'s3:prefix':prefix+'/'+config.installationId+'/'}));
  for(const action of ['s3:GetObject','s3:GetObjectVersion'])assert.ok(decision(policy,action,bucket+'/'+prefix+'/'+config.installationId+'/record.json'));
  for(const action of ['kms:Decrypt','kms:GenerateDataKey'])assert.ok(decision(policy,action,key(1),{'kms:ViaService':'s3.eu-west-1.amazonaws.com','kms:CallerAccount':accountId,'kms:EncryptionContext:aws:s3:arn':bucket+'/'+prefix+'/'+config.installationId+'/record.json'}));
 }
 for(const purpose of ['charitypilot-database-byte-backup-v1','charitypilot-document-byte-backup-v1'])assert.ok(decision(policy,'kms:Decrypt',key(2),{'kms:EncryptionContext:installationId':config.installationId,'kms:EncryptionContext:purpose':purpose}));
 for(const k of [key(3),key(4)])assert.ok(decision(policy,'kms:VerifyMac',k));
});
test('explicit denies survive an external broad grant and absent request context',()=>{
 const {policy}=recoveryReaderPolicy(config),denied=(action,resource,context)=>assert.equal(decision(policy,action,resource,context,true),false,JSON.stringify({action,resource,context}));
 for(const action of ['s3:PutObject','s3:DeleteObjectVersion','s3:PutBucketPolicy','kms:GenerateDataKey','kms:GenerateMac','kms:CreateGrant','iam:PutRolePolicy','sts:AssumeRole'])denied(action,'*');
 for(const prefix of [undefined,'','business-data/another/','business-data/'+config.installationId+'-other/'])denied('s3:ListBucket',bucket,{'s3:prefix':prefix});
 denied('s3:ListBucket','arn:aws:s3:::other',{'s3:prefix':'business-data/'+config.installationId+'/'});
 for(const owner of [undefined,'999999999999']){
  denied('s3:ListBucket',bucket,{'s3:prefix':'business-data/'+config.installationId+'/','s3:ResourceAccount':owner});
  denied('s3:GetObjectVersion',bucket+'/business-data/'+config.installationId+'/file',{'s3:ResourceAccount':owner});
 }
 for(const action of ['s3:GetObject','s3:GetObjectVersion'])for(const resource of [bucket+'/business-data/another/file',bucket+'/business-data/'+config.installationId+'-other/file','arn:aws:s3:::other/business-data/'+config.installationId+'/file'])denied(action,resource);
 for(const k of [key(1),key(2),key(5)])denied('kms:VerifyMac',k);
 for(const k of [key(3),key(4),key(5)])denied('kms:Decrypt',k);
 const storage={'kms:ViaService':'s3.eu-west-1.amazonaws.com','kms:CallerAccount':accountId,'kms:EncryptionContext:aws:s3:arn':bucket+'/business-data/'+config.installationId+'/file'};
 for(const action of ['kms:Decrypt','kms:GenerateDataKey'])for(const name of Object.keys(storage))for(const value of [undefined,'wrong'])denied(action,key(1),{...storage,[name]:value});
 for(const k of [key(1),key(2),key(3),key(5)])denied('kms:GenerateDataKey',k);
 denied('kms:Decrypt',key(1),{...storage,'kms:EncryptionContext:aws:s3:arn':bucket}); // Bucket Keys unsupported.
 const data={'kms:EncryptionContext:installationId':config.installationId,'kms:EncryptionContext:purpose':'charitypilot-database-byte-backup-v1'};
 for(const name of Object.keys(data))for(const value of [undefined,'wrong'])denied('kms:Decrypt',key(2),{...data,[name]:value});
});
test('configuration rejects wildcard, policy-variable, cross-account/region, key reuse and Bucket Key broadening',()=>{
 const bad=[null,[],{...config,unexpected:true},{...config,s3BucketKeyEnabled:true},{...config,rootMacKeyArn:key(3)}];
 for(const field of ['installationId','bucket','accountId','storageKeyArn'])for(const value of ['*','?','${aws:username}','../other','',42])bad.push({...config,[field]:value});
 bad.push({...config,dataKeyArn:key(2).replace(accountId,'999999999999')},{...config,dataKeyArn:key(2).replace('eu-west-1','us-east-1')});
 for(const input of bad)assert.throws(()=>recoveryReaderPolicy(input));
 const plan=recoveryReaderPolicy({...config,bucket:'b'.repeat(63),installationId:'a'.repeat(120)});assert.ok(Buffer.byteLength(JSON.stringify(plan.policy))<=10240);assert.equal(plan.accessGranted,false);assert.equal(plan.providerValidated,false);
});
test('CLI produces local review JSON and sanitises malformed input without leaking it',()=>{
 const run=input=>spawnSync(process.execPath,['scripts/recovery-reader-policy.mjs','--stdin'],{input,encoding:'utf8'});
 const good=run(JSON.stringify(config));assert.equal(good.status,0);assert.deepEqual(JSON.parse(good.stdout),recoveryReaderPolicy(config));
 const bad=run('{"secret":"SYNTHETIC_DO_NOT_ECHO"}');assert.equal(bad.status,1);assert.equal(bad.stdout,'');assert.equal(bad.stderr.includes('SYNTHETIC_DO_NOT_ECHO'),false);
});
