import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runManagedDaemonOwner,validateManagedDaemonOwnerInput} from './managed-daemon-owner-worker.mjs';
import {independentOwnerProbeArguments} from './managed-daemon-owner-probe.mjs';
import {planManagedProofStorage} from './postgres-backup.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
function fixture(){
 const jobId=randomUUID(),args=independentOwnerProbeArguments(jobId),body=JSON.stringify({format:2,kind:'MANAGED_DAEMON_REQUEST_INTENT_V2',jobId,sequence:1,
  previousDigest:'a'.repeat(64),operation:'run',target:args[args.indexOf('--name')+1],storagePlan:planManagedProofStorage(args,jobId),
  argumentsDigest:hash('CHARITYPILOT_DAEMON_ARGUMENTS_V1\n'+jobId+'\n'+JSON.stringify(args))});
 return{format:1,kind:'MANAGED_DAEMON_OWNER_INPUT_V1',jobId,ownerId:randomUUID(),sourceSha:'1'.repeat(40),inputDigest:'2'.repeat(64),
  descriptorPath:'/synthetic/gate.json',intent:{body,sha256:hash(body),byteLength:Buffer.byteLength(body)},args,environment:{},timeoutMs:15000,maxBuffer:65536};
}
test('fixed owner validates exact original arguments, storage and bounded secret transport before custody or dispatch',async()=>{
 const base=fixture();assert.deepEqual(validateManagedDaemonOwnerInput(base),base);
 for(const change of [{extra:true},{sourceSha:'HEAD'},{ownerId:base.jobId},{timeoutMs:90001},{maxBuffer:1048577},{environment:{NODE_OPTIONS:'--inspect'}},
  {environment:{DOCKER_HOST:'tcp://other'}},{args:[...base.args,'changed']},{intent:{...base.intent,body:base.intent.body+' '}},{args:['ps']},
  {args:['run','--privileged',...base.args.slice(1)]}]){
  let calls=0;await assert.rejects(runManagedDaemonOwner({...base,...change},{identity(){calls++;},acknowledge(){calls++;},execute(){calls++;}}));assert.equal(calls,0);
 }
});
test('original OWNER ACK precedes execution and exact OUTCOME ACK precedes returning private output',async()=>{
 const input=fixture(),events=[],identity={inputDigest:hash(JSON.stringify(input))};let owner;
 const r=await runManagedDaemonOwner(input,{identity:()=>identity,acknowledge:async v=>{
  events.push(v.kind);const record=JSON.parse(v.artifact.body);
  if(v.kind==='OWNER')owner=v.artifact;else{
   assert.equal(record.kind,'MANAGED_DAEMON_OWNER_OUTCOME_V1');assert.equal(record.ownerPin.sha256,owner.sha256);
   assert.equal(record.ownerInputDigest,identity.inputDigest);assert.equal(record.stdout.sha256,hash('private result'));
   assert.equal(record.stdout.byteLength,14);assert.equal(record.stderr.sha256,hash(''));
   assert.equal(v.artifact.body.includes('private result'),false);
  }return true;
 },execute:(command,env)=>{events.push('EXECUTE');assert.deepEqual(command,['docker',...input.args]);assert.equal(env.NODE_OPTIONS,undefined);return{status:0,stdout:'private result',stderr:''};}});
 assert.deepEqual(events,['OWNER','EXECUTE','OUTCOME']);assert.equal(r.stdout,'private result');
});
test('unknown OWNER never executes; unknown OUTCOME withholds output and never repeats execution',async()=>{
 for(const kind of ['OWNER','OUTCOME']){let executed=0;await assert.rejects(runManagedDaemonOwner(fixture(),{identity:()=>({inputDigest:'a'.repeat(64)}),
  acknowledge:async v=>{if(v.kind===kind)throw new Error('synthetic unknown ACK');return true;},execute:()=>{executed++;return{status:0,stdout:'',stderr:''};}}));assert.equal(executed,kind==='OWNER'?0:1);}
});
test('unintegrated worker refuses the actual default identity and CLI before any execution',async()=>{
 await assert.rejects(runManagedDaemonOwner(fixture()));
 const r=spawnSync(process.execPath,[fileURLToPath(new URL('./managed-daemon-owner-worker.mjs',import.meta.url)),'--stdin'],{
  input:JSON.stringify(fixture()),encoding:'utf8',timeout:10000,maxBuffer:4096});
 assert.equal(r.status,1);assert.equal(r.stdout,'');assert.equal(r.stderr,'Original daemon owner unresolved\n');
});
