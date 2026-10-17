import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {planManagedProofStorage,DEFAULT_POSTGRES_IMAGE,PROOF_CLIENT_DATA_TMPFS} from './postgres-backup.mjs';
import {compareOriginalProofMounts,inspectOriginalProofStorage} from './managed-proof-storage-inspect.mjs';
const jobId='12345678-1234-4234-8234-123456789012',id='a'.repeat(64),other='b'.repeat(64),target='charitypilot-source-snapshot-123-456-abcdef12';
const source=join(tmpdir(),'private-synthetic-source'),plan=planManagedProofStorage(['run','--name',target,'--tmpfs',PROOF_CLIENT_DATA_TMPFS,'-v',source+':/proof',DEFAULT_POSTGRES_IMAGE],jobId);
const scope={root:'unused-test-seam',jobId,inputDigest:'a'.repeat(64)};
const requests={jobId,state:'UNRESOLVED_REQUESTS',declaredImageVolumesCovered:true,plannedContainers:[{target,storagePlan:plan}]};
function view(change={}){return{id,name:'/'+target,image:DEFAULT_POSTGRES_IMAGE,proofLabel:'true',jobId,
 mounts:[{Type:'bind',Destination:'/proof',Source:source,RW:true}],tmpfs:{'/var/lib/postgresql/data':'rw,noexec,nosuid,size=1m'},...change};}
function engine({container=view(),changed=false,substitutedVolume=false}={}){
 let volumeLists=0;const calls=[];
 return{calls,run(args){calls.push(args);assert.ok(['ps','inspect','volume'].includes(args[0]));
  if(args[0]==='ps')return args.some(v=>v.startsWith('volume='))?(args.includes('volume=attached')?other:''):id;
  if(args[0]==='inspect'){assert.equal(args.at(-1),id);assert.ok(!args.at(-2).includes('.Config.Env'));return JSON.stringify(container);}
  if(args[1]==='ls')return ++volumeLists>1&&changed?'attached':'attached\norphan';
  assert.equal(args[1],'inspect');return JSON.stringify({name:substitutedVolume?'wrong':args.at(-1),driver:'local',jobId:args.at(-1)==='orphan'?jobId:''});
 }};
}
test('original bind/tmpfs observation compares source digests, readonly, declared image and options without exposing paths',()=>{
 assert.equal(compareOriginalProofMounts(plan,view(),jobId),'ORIGINAL_PLAN_MATCHES_CURRENT_MOUNTS');
 assert.equal(compareOriginalProofMounts(plan,view({tmpfs:{'/var/lib/postgresql/data':'nosuid,rw,size=1048576,noexec'}}),jobId),'ORIGINAL_PLAN_MATCHES_CURRENT_MOUNTS');
 for(const v of [view({image:'postgres:latest'}),view({mounts:[{Type:'bind',Destination:'/proof',Source:source,RW:false}]}),
  view({mounts:[{Type:'bind',Destination:'/proof',Source:source+'-changed',RW:true}]}),view({tmpfs:{'/var/lib/postgresql/data':'rw,size=1m'}}),
  view({tmpfs:{'/var/lib/postgresql/data':'rw,noexec,nosuid,size=4g'}}),view({mounts:[{Type:'volume',Destination:'/proof',Name:'unexpected',RW:true}]})])assert.equal(compareOriginalProofMounts(plan,v,jobId),'MOUNT_MISMATCH');
 assert.equal(compareOriginalProofMounts({...plan,format:1},view(),jobId),'PLAN_DETAIL_INSUFFICIENT');
});
test('current plan correlation and attached/unattached metadata never promote a label into cleanup authority',()=>{
 const e=engine(),r=inspectOriginalProofStorage(scope,{run:e.run,readRequests:()=>requests});
 assert.equal(r.containers[0].state,'ORIGINAL_PLAN_MATCHES_CURRENT_MOUNTS');assert.equal(r.requestState,'UNRESOLVED_REQUESTS');
 assert.equal(r.volumes[0].attachmentState,'ATTACHMENTS_OBSERVED');assert.deepEqual(r.volumes[0].containerIds,[other]);
 assert.equal(r.volumes[1].attachmentState,'NO_ATTACHMENTS_OBSERVED');assert.equal(r.volumes[1].attribution,'JOB_LABEL_ONLY_UNVERIFIED');
 for(const flag of ['cleanupAuthorized','executionAuthorized','actionAuthorized','completeResourceInventory','pendingDaemonRequestsAccountedFor','historicalVolumesAccountedFor'])assert.equal(r[flag],false);
 assert.doesNotMatch(JSON.stringify(r),/private-synthetic-source|Source|Mountpoint|Config/);
 assert.ok(e.calls.every(v=>v[0]!=='volume'||['ls','inspect'].includes(v[1])));
});
test('absent planned containers and missing legacy plans are not complete inventory or permission to reopen',()=>{
 const r=inspectOriginalProofStorage(scope,{run:args=>{assert.ok(['ps','volume'].includes(args[0]));return '';},readRequests:()=>requests});
 assert.equal(r.containers[0].state,'NOT_LISTED_AT_BOUNDARY');assert.equal(r.completeResourceInventory,false);
 const legacy=inspectOriginalProofStorage(scope,{run:()=>assert.fail('No current daemon attribution'),readRequests:()=>({...requests,declaredImageVolumesCovered:false})});
 assert.equal(legacy.state,'ORIGINAL_PLANS_NOT_RECORDED');assert.deepEqual(legacy.volumes,[]);
});
test('changed listings, substituted identity/volume and unplanned container do not imply ownership',()=>{
 for(const settings of [{changed:true},{substitutedVolume:true},{container:view({jobId:'other'})}]){
  const e=engine(settings);assert.throws(()=>inspectOriginalProofStorage(scope,{run:e.run,readRequests:()=>requests}),/without cleanup/);
 }
 const e=engine({container:view({name:'/charitypilot-source-snapshot-999-456-abcdef12'})});
 const r=inspectOriginalProofStorage(scope,{run:e.run,readRequests:()=>requests});assert.equal(r.containers[0].state,'UNPLANNED_JOB_CONTAINER');assert.equal(r.containers[1].state,'NOT_LISTED_AT_BOUNDARY');
});
