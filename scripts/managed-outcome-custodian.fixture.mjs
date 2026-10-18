/** Fixed synthetic SDK handler only. Never selected by production CLI/input. */
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {runOutcomeCustodian,actualOutcomeCustodianIdentity} from './managed-outcome-custodian.mjs';
import {connectSyntheticCustody} from './synthetic-custody-client.mjs';
import {ManagedDaemonIntentCustody} from '../apps/api/dist/services/managed-daemon-intent-custody.js';
const no=()=>new Error('Synthetic outcome receiver unresolved');
export async function runSyntheticOutcomeCustodian(bytes){
 let client;try{
  if(!Buffer.isBuffer(bytes)||bytes.length>131072)throw no();const digest=createHash('sha256').update(bytes).digest('hex');
  let v;try{v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}finally{bytes.fill(0);}
  if(!v||Object.keys(v).sort().join(',')!=='input,synthetic'||Object.keys(v.synthetic??{}).sort().join(',')!=='config,descriptor,id')throw no();
  client=connectSyntheticCustody(v.synthetic.descriptor,v.synthetic.id,v.synthetic.config).s3();
  return await runOutcomeCustodian(Buffer.from(JSON.stringify(v.input)),{
   identity:(input)=>actualOutcomeCustodianIdentity(input,digest),
   accept:(ticket,claim)=>ManagedDaemonIntentCustody.acceptOwnerOutcomeTransfer(ticket,claim,client)});
 }finally{client?.destroy();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 process.stdout.on('error',()=>{});process.stderr.on('error',()=>{});const chunks=[];let size=0;
 try{if(process.argv.length!==3||process.argv[2]!=='--stdin')throw no();for await(const b of process.stdin){size+=b.length;if(size>131072)throw no();chunks.push(Buffer.from(b));}
  await runSyntheticOutcomeCustodian(Buffer.concat(chunks));
 }catch{process.stderr.write('Synthetic outcome receiver unresolved\n');process.exitCode=1;}finally{for(const b of chunks)b.fill(0);}
}
