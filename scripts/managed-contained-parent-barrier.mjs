import {readFileSync} from 'node:fs';
import {dirname,basename} from 'node:path';
import {createHash} from 'node:crypto';
const refuse=()=>new Error('Synthetic contained parent barrier refused');
/** Source fixture only. The surviving test driver receives original pins before
 * it kills its owned producer; this creates no production execution lease. */
export async function pauseContainedSourceForParentLoss({sourceId,database,certificate,parentDirectory,workspaceRoot,signal}){
 if(process.env.CHARITYPILOT_TEST_SOURCE_PARENT_FIXTURE!=='1')return;
 if(process.platform!=='linux'||process.getuid()===0||typeof process.send!=='function'||!process.connected
  ||!/^managed_writer_[a-f0-9]{32}$/.test(database)||!/^[a-f0-9]{64}$/.test(sourceId)
  ||!/^charitypilot-imported-proof-[A-Za-z0-9]{6}$/.test(basename(parentDirectory))||dirname(workspaceRoot)!==parentDirectory)throw refuse();
 const original=JSON.parse(readFileSync(workspaceRoot+'/proof-job.request.json','utf8'));
 const bytes=readFileSync(workspaceRoot+'/proof-job.service.json'),service=JSON.parse(bytes.toString('utf8'));
 if(service.jobId!==original.jobId||service.identity.sourceSha!==original.sourceSha)throw refuse();
 signal.throwIfAborted();
 let stop,disconnected,aborted,timer;
 const release=new Promise((yes,no)=>{
  const fail=()=>no(refuse());disconnected=fail;aborted=fail;
  stop=value=>{if(value?.kind==='RELEASE_SYNTHETIC_CONTAINED_SOURCE_V1'&&value.jobId===original.jobId&&Object.keys(value).length===2)yes();else fail();};
  process.on('message',stop);process.once('disconnect',disconnected);signal.addEventListener('abort',aborted,{once:true});timer=setTimeout(fail,10000);
 });void release.catch(()=>{});
 try{
  await new Promise((yes,no)=>process.send({kind:'ORIGINAL_CONTAINED_SOURCE_READY_V1',jobId:original.jobId,sourceSha:original.sourceSha,
   sourceId,database,certificate,parentDirectory,workspaceRoot,scope:original.scope,requestPin:service.requestPin,
   servicePin:{sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length},identity:service.identity,
   executionAuthorized:false,actionAuthorized:false},error=>error?no(refuse()):yes()));
  await release;signal.throwIfAborted();
 }finally{clearTimeout(timer);process.removeListener('message',stop);process.removeListener('disconnect',disconnected);signal.removeEventListener('abort',aborted);}
}
