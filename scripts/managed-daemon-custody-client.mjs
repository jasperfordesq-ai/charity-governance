import {validateOutcomeCustodyHandoff,validateOutcomeCustodyReceipt} from './managed-outcome-custodian.mjs';
import {createConnection} from 'node:net';
import {spawnSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {readFileSync,lstatSync,realpathSync,openSync,closeSync,fstatSync,constants} from 'node:fs';
import {dirname,join,basename} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {requireDaemonGateDirectory} from './managed-daemon-custody-channel.mjs';
const refuse=()=>new Error('Original daemon custody acknowledgement unavailable; no dispatch');
const file=fileURLToPath(import.meta.url);
export async function requestManagedDaemonCustody(v){
 const withInput=v?.kind==='OWNER'&&v.ownerInput!==undefined,withReceipt=v?.kind==='OUTCOME'&&v.receipt!==undefined;
 if(!v||Object.keys(v).sort().join(',')!==(withInput?'artifact,descriptorPath,inputDigest,jobId,kind,ownerInput,sourceSha':withReceipt?'artifact,descriptorPath,inputDigest,jobId,kind,receipt,sourceSha':'artifact,descriptorPath,inputDigest,jobId,kind,sourceSha')||typeof v.descriptorPath!=='string'||basename(v.descriptorPath)!=='gate.json')throw refuse();
 const root=dirname(v.descriptorPath),originalRoot=requireDaemonGateDirectory(root);if(realpathSync(v.descriptorPath)!==v.descriptorPath)throw refuse();
 const fd=openSync(v.descriptorPath,constants.O_RDONLY|(constants.O_NOFOLLOW??0));let descriptor;
 try{const s=fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&0o777)!==0o600||s.size<1||s.size>4096)throw refuse();descriptor=JSON.parse(readFileSync(fd,'utf8'));}finally{closeSync(fd);}
 const afterRoot=requireDaemonGateDirectory(root);if(afterRoot.dev!==originalRoot.dev||afterRoot.ino!==originalRoot.ino)throw refuse();
 const retained=descriptor.outcomeMode==='RETAINED_SDK_V1';
 if(Object.keys(descriptor).sort().join(',')!==(retained?'capability,format,inputDigest,jobId,kind,outcomeMode,path,sourceSha':'capability,format,inputDigest,jobId,kind,path,sourceSha')||descriptor.format!==1||descriptor.kind!=='MANAGED_DAEMON_GATE_V1'
  ||descriptor.path!==join(root,'gate.sock')||descriptor.jobId!==v.jobId||descriptor.inputDigest!==v.inputDigest||descriptor.sourceSha!==v.sourceSha||!(/^[a-f0-9]{64}$/).test(descriptor.capability))throw refuse();
 if(v.kind==='OWNER'&&(retained!==(v.ownerInput?.outcomeMode==='RETAINED_SDK_V1')))throw refuse();
 if(v.kind==='OUTCOME'){if(retained!==withReceipt)throw refuse();if(withReceipt)validateOutcomeCustodyReceipt(v.receipt);}
 const s=lstatSync(descriptor.path);if(!s.isSocket()||s.uid!==process.getuid()||(s.mode&0o777)!==0o600)throw refuse();
 const a=v.artifact;if(!a||typeof a.body!=='string'||Buffer.byteLength(a.body)>8192||a.byteLength!==Buffer.byteLength(a.body)||createHash('sha256').update(a.body).digest('hex')!==a.sha256)throw refuse();
 if(!['HEADER','INTENT','RESPONSE','END','OWNER','OUTCOME'].includes(v.kind))throw refuse();
 const ordinal=['HEADER','END'].includes(v.kind)?0:JSON.parse(a.body).sequence,nonce=randomBytes(32).toString('hex');
 if(withInput&&(!v.ownerInput||typeof v.ownerInput!=='object'||Array.isArray(v.ownerInput)||Buffer.byteLength(JSON.stringify(v.ownerInput))>65536))throw refuse();
 const body=JSON.stringify({kind:v.kind,jobId:v.jobId,inputDigest:v.inputDigest,sourceSha:v.sourceSha,nonce,capability:descriptor.capability,artifact:a,...(withInput?{ownerInput:v.ownerInput}:{}),...(withReceipt?{receipt:v.receipt}:{})})+'\n';if(Buffer.byteLength(body)>(withInput?131072:32768))throw refuse();
 let handoff;await new Promise((yes,no)=>{
  const socket=createConnection(descriptor.path);let result='',done=false;
  const finish=error=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();error?no(refuse()):yes();};
  const timer=setTimeout(()=>finish(true),18000);socket.once('error',()=>finish(true));socket.once('connect',()=>socket.write(body));
  socket.on('data',b=>{result+=b.toString('utf8');if(Buffer.byteLength(result)>12288)finish(true);});
  socket.once('end',()=>{try{const selected=retained&&v.kind==='OWNER'?validateOutcomeCustodyHandoff(JSON.parse(result).retainedOutcome,{jobId:v.jobId,sourceSha:v.sourceSha}):undefined;const expected={kind:selected?'MANAGED_DAEMON_OWNER_READY_ACK_V3':'MANAGED_DAEMON_CUSTODY_ACK_V2',recordKind:v.kind,jobId:v.jobId,inputDigest:v.inputDigest,sourceSha:v.sourceSha,nonce,ordinal,
    localRecordPin:{sha256:a.sha256,byteLength:a.byteLength},savedEvidenceAuthorizesDispatch:false,...(selected?{retainedOutcome:selected}:{})};if(result!==JSON.stringify(expected)+'\n')throw refuse();handoff=selected;finish();}catch{finish(true);}});
  socket.once('close',()=>{if(!done)finish(true);});
 });return handoff??true;
}
/** Fixed credentialless child: the source helper is synchronously blocked, so
 * the separate original parent remains responsible for asynchronous custody. */
export function acknowledgeManagedDaemonCustodySync(input){
 if(input?.kind==='OWNER'&&input.ownerInput?.outcomeMode!==undefined)throw refuse();
 const env=Object.fromEntries(['PATH','HOME','SystemRoot','WINDIR','TMPDIR','TEMP','TMP'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
 const r=spawnSync(process.execPath,[file,'--stdin'],{input:JSON.stringify(input),env,encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:4096});
 if(r.status!==0||r.error||r.stderr||r.stdout!=='{"acknowledged":true}\n')throw refuse();return true;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{if(process.argv.length!==3||process.argv[2]!=='--stdin')throw refuse();let body='';for await(const b of process.stdin){body+=b;if(Buffer.byteLength(body)>32768)throw refuse();}
  await requestManagedDaemonCustody(JSON.parse(body));process.stdout.write('{"acknowledged":true}\n');
 }catch{process.stderr.write('Original daemon custody acknowledgement unavailable\n');process.exitCode=1;}
}
