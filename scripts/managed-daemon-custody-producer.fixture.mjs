import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createManagedDaemonRequestJournal,DEFAULT_POSTGRES_IMAGE,PROOF_CLIENT_DATA_TMPFS} from './postgres-backup.mjs';
import {acknowledgeManagedDaemonCustodySync} from './managed-daemon-custody-client.mjs';
try{
 let body='';for await(const b of process.stdin){body+=b;if(body.length>8192)throw new Error();}const v=JSON.parse(body);
 const journal=createManagedDaemonRequestJournal(v.scope,{imageVolumes:()=>['/var/lib/postgresql/data'],acknowledge:(kind,artifact)=>acknowledgeManagedDaemonCustodySync({
  descriptorPath:v.descriptorPath,kind,artifact,jobId:v.scope.jobId,inputDigest:v.scope.inputDigest,sourceSha:v.sourceSha})});
 journal.dispatch(['run','--name','charitypilot-source-snapshot-123-456-abcdef12','--tmpfs',PROOF_CLIENT_DATA_TMPFS,DEFAULT_POSTGRES_IMAGE,'sh'],()=>{
  writeFileSync(join(v.scope.root,'synthetic-dispatched.txt'),'DISPATCHED',{flag:'wx',mode:0o600});return{status:0};
 });journal.finish();
}catch{process.exitCode=1;}
