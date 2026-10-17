import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const refused=()=>new Error('Recovery reader policy configuration refused');
/** Local review artifact only: no SDK, credentials, IAM calls or resource creation. */
export function recoveryReaderPolicy(raw){
 const names=['accountId','bucket','installationId','storageKeyArn','dataKeyArn','indexMacKeyArn','rootMacKeyArn','s3BucketKeyEnabled'];
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).sort().join()!==names.sort().join())throw refused();
 const c={...raw};
 if(!/^[0-9]{12}$/.test(c.accountId)||typeof c.accountId!=='string'||typeof c.bucket!=='string'
  ||!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(c.bucket)||typeof c.installationId!=='string'
  ||!/^[A-Za-z0-9_-]{1,120}$/.test(c.installationId)||c.s3BucketKeyEnabled!==false)throw refused();
 const keys=['storageKeyArn','dataKeyArn','indexMacKeyArn','rootMacKeyArn'].map(k=>c[k]);
 if(new Set(keys).size!==4||keys.some(k=>typeof k!=='string'||!new RegExp('^arn:aws:kms:eu-west-1:'+c.accountId+':key/[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$').test(k)))throw refused();
 const bucket='arn:aws:s3:::'+c.bucket;
 const prefixes=['business-data/'+c.installationId+'/','managed-maintenance/'+c.installationId+'/'];
 const objects=prefixes.map(p=>bucket+'/'+p+'*');
 const read=['s3:ListBucket','s3:GetObject','s3:GetObjectVersion','kms:Decrypt','kms:VerifyMac','kms:GenerateDataKey'];
 const statements=[{Sid:'DenyEveryOtherAction',Effect:'Deny',NotAction:read,Resource:'*'}];
 const grant=(sid,actions,resources,conditions={})=>{
  statements.push({Sid:sid,Effect:'Allow',Action:actions,Resource:resources,...(Object.keys(conditions).length?{Condition:conditions}:{})});
 };
 const scope=(sid,actions,resources)=>statements.push({Sid:sid,Effect:'Deny',Action:actions,NotResource:resources});
 const requireCondition=(sid,actions,resources,operator,key,value)=>statements.push({Sid:sid,Effect:'Deny',Action:actions,Resource:resources,Condition:{[operator]:{[key]:value}}});
 grant('ListInstallation', ['s3:ListBucket'],bucket,{StringLike:{'s3:prefix':prefixes.map(p=>p+'*')},StringEquals:{'s3:ResourceAccount':c.accountId}});
 scope('DenyOtherBuckets',['s3:ListBucket'],bucket);
 requireCondition('DenyOtherPrefixes',['s3:ListBucket'],bucket,'StringNotLike','s3:prefix',prefixes.map(p=>p+'*'));
 grant('ReadInstallationVersions',['s3:GetObject','s3:GetObjectVersion'],objects,{StringEquals:{'s3:ResourceAccount':c.accountId}});
 scope('DenyOtherObjects',['s3:GetObject','s3:GetObjectVersion'],objects);
 requireCondition('DenyOtherS3Owners',['s3:ListBucket','s3:GetObject','s3:GetObjectVersion'],[bucket,...objects],'StringNotEquals','s3:ResourceAccount',c.accountId);
 scope('DenyOtherDecryptKeys',['kms:Decrypt'],[c.storageKeyArn,c.dataKeyArn]);
 scope('DenyApplicationKeyGeneration',['kms:GenerateDataKey'],c.storageKeyArn);
 const storageConditions={'kms:ViaService':'s3.eu-west-1.amazonaws.com','kms:CallerAccount':c.accountId};
 // GetObject reference currently names both KMS actions. Only S3 may use the
 // storage key; this never grants direct application data-key generation.
 const storageActions=['kms:Decrypt','kms:GenerateDataKey'];
 grant('ReadS3StorageKey',storageActions,c.storageKeyArn,{StringEquals:storageConditions,StringLike:{'kms:EncryptionContext:aws:s3:arn':objects}});
 let n=0;for(const [key,value] of Object.entries(storageConditions))requireCondition('DenyWrongS3Context'+(++n),storageActions,c.storageKeyArn,'StringNotEquals',key,value);
 requireCondition('DenyOtherS3EncryptionContext',storageActions,c.storageKeyArn,'StringNotLike','kms:EncryptionContext:aws:s3:arn',objects);
 const dataConditions={'kms:EncryptionContext:installationId':c.installationId,'kms:EncryptionContext:purpose':['charitypilot-database-byte-backup-v1','charitypilot-document-byte-backup-v1']};
 grant('DecryptBackupData',['kms:Decrypt'],c.dataKeyArn,{StringEquals:dataConditions});
 n=0;for(const [key,value] of Object.entries(dataConditions))requireCondition('DenyWrongDataContext'+(++n),['kms:Decrypt'],c.dataKeyArn,'StringNotEquals',key,value);
 grant('VerifyOriginalMac',['kms:VerifyMac'],[c.indexMacKeyArn,c.rootMacKeyArn]);
 scope('DenyOtherMacKeys',['kms:VerifyMac'],[c.indexMacKeyArn,c.rootMacKeyArn]);
 const policy={Version:'2012-10-17',Statement:statements};
 const body=JSON.stringify(policy);
 // Dedicated role inline policy (10,240 non-whitespace characters aggregate),
 // not a managed-policy/permissions-boundary artifact (6,144 characters).
 if(Buffer.byteLength(body)>10240)throw refused();
 return {kind:'CHARITYPILOT_RECOVERY_READER_POLICY_REVIEW_V1',policy,sha256:createHash('sha256').update(body).digest('hex'),
  providerValidated:false,resourcesCreated:false,accessGranted:false};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  if(process.argv.length!==3||process.argv[2]!=='--stdin')throw refused();
  let body='';for await(const chunk of process.stdin){body+=chunk;if(Buffer.byteLength(body)>8192)throw refused();}
  process.stdout.write(JSON.stringify(recoveryReaderPolicy(JSON.parse(body)),null,2)+'\n');
 }catch{process.stderr.write('Recovery reader policy configuration refused\n');process.exitCode=1;}
}
