import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {createManagedDaemonRequestJournal,DEFAULT_POSTGRES_IMAGE,PROOF_CLIENT_DATA_TMPFS} from './postgres-backup.mjs';
import {acknowledgeManagedDaemonCustodySync} from './managed-daemon-custody-client.mjs';
try{
 let body='';for await(const b of process.stdin){body+=b;if(body.length>8192)throw new Error();}const v=JSON.parse(body);
 const send=(kind,artifact)=>acknowledgeManagedDaemonCustodySync({descriptorPath:v.descriptorPath,kind,artifact,jobId:v.scope.jobId,inputDigest:v.scope.inputDigest,sourceSha:v.sourceSha});
 const journal=createManagedDaemonRequestJournal(v.scope,{imageVolumes:()=>['/var/lib/postgresql/data'],acknowledge:(kind,artifact)=>{
  send(kind,artifact);
  if(kind==='INTENT'&&v.owner===true){
   // Transport-only fixture; real identity validation is exercised by the live owner probe.
   const body=JSON.stringify({format:1,kind:'MANAGED_DAEMON_REQUEST_OWNER_V1',jobId:v.scope.jobId,sequence:JSON.parse(artifact.body).sequence,
    intentPin:{sha256:artifact.sha256,byteLength:artifact.byteLength},identity:{syntheticWireFixture:true}});
   send('OWNER',{body,sha256:createHash('sha256').update(body).digest('hex'),byteLength:Buffer.byteLength(body)});
  }return true;
 }});
 journal.dispatch(['run','--name','charitypilot-source-snapshot-123-456-abcdef12','--tmpfs',PROOF_CLIENT_DATA_TMPFS,DEFAULT_POSTGRES_IMAGE,'sh'],()=>{
  writeFileSync(join(v.scope.root,'synthetic-dispatched.txt'),'DISPATCHED',{flag:'wx',mode:0o600});return{status:0};
 });journal.finish();
}catch{process.exitCode=1;}
