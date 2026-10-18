/** Synthetic original issuer/owner actors. No Docker request is dispatched. */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {containmentUnit,inspectContainmentUnit,currentContainmentBootId} from './managed-proof-systemd-containment.mjs';
import {verifyContainedExecutorSource} from './managed-proof-systemd-runner.mjs';
import {connectSyntheticCustody} from './synthetic-custody-client.mjs';
import {originalOwnerProbeCustody} from './managed-daemon-owner-custody.fixture.mjs';
import {independentOwnerProbeArguments} from './managed-daemon-owner-probe.mjs';
import {launchSyntheticOutcomeCustodyFixture} from './managed-outcome-custody-launcher.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex'),no=()=>new Error('Synthetic original issuer unresolved');
function identity(id,sourceSha,inputDigest){
 verifyContainedExecutorSource(sourceSha);const unit=containmentUnit(id),v=inspectContainmentUnit(unit);
 if(v.MainPID!==String(process.pid)||v.InvocationID!==process.env.INVOCATION_ID||v.ActiveState!=='active'
  ||readFileSync('/proc/self/cgroup','utf8').trim()!=='0::'+v.ControlGroup)throw no();
 return{ownerId:id,unit,invocationId:v.InvocationID,uid:process.getuid(),mainPid:process.pid,mainStartMonotonic:v.ExecMainStartTimestampMonotonic,
  sourceSha,inputDigest,bootId:currentContainmentBootId(),controlGroup:v.ControlGroup};
}
let size=0;const chunks=[];
try{
 if(process.platform!=='linux'||process.getuid()===0||process.argv.length!==3||!['--issuer','--owner'].includes(process.argv[2]))throw no();
 for await(const b of process.stdin){size+=b.length;if(size>16384)throw no();chunks.push(b);}let input;
 try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}finally{for(const b of chunks)b.fill(0);}
 if(process.argv[2]==='--owner'){
  process.stdout.write(JSON.stringify(identity(input.ownerId,input.sourceSha,'8'.repeat(64)))+'\n');setInterval(()=>{},1000);
 }else{
  const own=identity(input.jobId,input.sourceSha,'9'.repeat(64)),source=inspectContainmentUnit(own.unit);
  const o=inspectContainmentUnit(input.owner.unit);
  if(o.Id===source.Id||o.InvocationID!==input.owner.invocationId||o.MainPID!==String(input.owner.mainPid)||o.ActiveState!=='active'
   ||JSON.stringify(readFileSync('/proc/'+o.MainPID+'/cmdline','utf8').split('\0').filter(Boolean))!==JSON.stringify([process.execPath,fileURLToPath(import.meta.url),'--owner']))throw no();
  const backend=connectSyntheticCustody(input.synthetic.descriptor,input.synthetic.id,input.synthetic.config);
  const custody=await originalOwnerProbeCustody({jobId:input.jobId,sourceSha:input.sourceSha},source,independentOwnerProbeArguments(input.jobId),backend);
  await custody.session.reserveDaemonHeader(custody.header,custody.original);await custody.session.reserveDaemonIntent(custody.intent,custody.original);
  const owner=custody.artifact({format:1,kind:'MANAGED_DAEMON_REQUEST_OWNER_V1',jobId:input.jobId,sequence:1,
   intentPin:{sha256:custody.intent.sha256,byteLength:custody.intent.byteLength},identity:{...input.owner,inputDigest:custody.inputDigest}});
  await custody.session.bindDaemonOwner(owner,custody.original);
  const transfer=await custody.outcomeTransfer(),retained=await launchSyntheticOutcomeCustodyFixture({jobId:input.jobId,sourceSha:input.sourceSha,source,transfer},input.synthetic);
  const outcome=custody.outcome(owner,{status:0,transportError:false,signal:false,stdoutSha256:hash('synthetic retained outcome'),stdoutBytes:26,stderrSha256:hash(''),stderrBytes:0});
  process.stdout.write(JSON.stringify({source,receiver:retained.receiver,endpoint:retained.binding(),outcome,binding:custody.binding,original:custody.original})+'\n');
  setInterval(()=>{},1000);
 }
}catch{process.stderr.write('Synthetic original issuer unresolved\n');process.exitCode=1;}
