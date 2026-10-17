import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectProofContainerInventory,runPostgresBackupFromArgs} from './postgres-backup.mjs';

const job='8f046ad2-9d09-4996-ae3f-d154b385251e',id='a'.repeat(64),nowMs=1_800_000_000_000;
function fixture(patch={}){
 return {id,name:'/charitypilot-source-snapshot-1800000000000-123-abcdef12',running:true,proofLabel:'true',jobId:job,
  createdAtMs:String(nowMs-7_200_000),mounts:[{Type:'bind',Source:'/private/workspace'},{Type:'tmpfs'},
   {Type:'volume',Name:'synthetic-volume',Source:'/daemon/private'}],...patch};
}
function engine(value,{changed=false,failed=false}={}){
 let lists=0;const calls=[];
 return {calls,run(args){calls.push(args);assert.ok(['ps','inspect'].includes(args[0]),'Only read operations permitted');
  if(args[0]==='ps')return (++lists===2&&changed)?'':id+'\n';
  assert.equal(args.at(-1),id);assert.ok(!args[2].includes('.Config.Env'));if(failed)throw new Error('private transport payload');
  return JSON.stringify(value);
 }};
}
test('old running residue and attached storage are observed without exposing paths or granting authority',()=>{
 const e=engine(fixture()),report=inspectProofContainerInventory({jobId:job,nowMs},{run:e.run});
 assert.equal(report.containers.length,1);assert.equal(report.containers[0].ageClass,'OLDER_THAN_PROOF_TIMEOUT');
 assert.equal(report.containers[0].running,true);assert.equal(report.containers[0].metadataValid,true);
 assert.deepEqual(report.containers[0].storage,{bindMountCount:1,tmpfsMountCount:1,volumeNames:['synthetic-volume']});
 for(const key of ['cleanupAuthorized','executionAuthorized','actionAuthorized','completeResourceInventory',
  'pendingDaemonRequestsAccountedFor','unattachedVolumesAccountedFor','kernelCohortsAccountedFor'])assert.equal(report[key],false);
 assert.equal(report.jobFilter,job);assert.equal(report.stableContainerIdsObserved,true);
 assert.doesNotMatch(JSON.stringify(report),/\/private|\/daemon|Source|Config/);
 assert.equal(e.calls.filter(v=>v[0]==='ps').length,2);assert.ok(e.calls[0].includes('label=charitypilot.managed-proof-job='+job));
});
test('unrecognised or legacy labels are inspectable without being promoted to verified metadata',()=>{
 const e=engine(fixture({jobId:'private malicious label',createdAtMs:'unknown',name:'/unrecognised'}));
 const r=inspectProofContainerInventory({nowMs},{run:e.run});assert.equal(r.jobFilter,null);
 assert.equal(r.containers[0].metadataValid,false);assert.equal(r.containers[0].jobId,null);
 assert.equal(r.containers[0].name,null);assert.equal(r.containers[0].ageClass,'UNKNOWN');
 assert.doesNotMatch(JSON.stringify(r),/malicious|unrecognised/);
});
test('empty listing is not proof of complete accounting or permission to reopen',()=>{
 const r=inspectProofContainerInventory({nowMs},{run:args=>{assert.equal(args[0],'ps');return '';}});
 assert.deepEqual(r.containers,[]);assert.equal(r.completeResourceInventory,false);assert.equal(r.actionAuthorized,false);
});
test('changed listing, scope substitution and malformed inspection refuse without mutation or raw data',()=>{
 for(const [value,settings] of [[fixture(),{changed:true}],[fixture({jobId:'1f046ad2-9d09-4996-ae3f-d154b385251e'}),{}],
  [fixture({id:'b'.repeat(64)}),{}],[fixture({mounts:[{Type:'volume',Name:'../private'}]}),{}],
  [fixture({running:'true'}),{}],[fixture(),{failed:true}]]){
  const e=engine(value,settings);assert.throws(()=>inspectProofContainerInventory({jobId:job,nowMs},{run:e.run}),
   error=>error.message.includes('no cleanup authority inferred')&&!error.message.includes('private'));
 }
});
test('ambiguous, duplicate and excessive IDs and unsupported scopes refuse before inspection',()=>{
 for(const listing of [id+'\n'+id,'short',Array.from({length:65},(_,i)=>i.toString(16).padStart(64,'0')).join('\n')]){
  assert.throws(()=>inspectProofContainerInventory({nowMs},{run:args=>{assert.equal(args[0],'ps');return listing;}}));
 }
 for(const jobId of ['','../other','--all',null])assert.throws(()=>inspectProofContainerInventory({jobId,nowMs},{run:()=>{assert.fail('No daemon access');}}));
});
test('operator command accepts no cleanup, replay, remote target or output-file switches',async()=>{
 for(const flag of ['--cleanup','--replay','--docker-host=x','--output-file=x','--dry-run']){
  const r=await runPostgresBackupFromArgs(['inspect-proof-residue',flag],{});assert.equal(r.status,2);assert.match(r.stderr,/Unknown option/);
 }
 const invalid=await runPostgresBackupFromArgs(['inspect-proof-residue','--job-id=invalid'],{});assert.equal(invalid.status,1);
 assert.match(invalid.stderr,/no cleanup authority inferred/);
});
