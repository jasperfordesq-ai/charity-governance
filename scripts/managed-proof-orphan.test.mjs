import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {inspectOriginalProofCohort} from './managed-proof-orphan.mjs';
import {containmentUnit,parseCgroupPopulation,observeOriginalControlGroup,requireOriginalControlGroup} from './managed-proof-systemd-containment.mjs';
const jobId='10101010-1010-4010-8010-101010101010',unit=containmentUnit(jobId),bootId='12345678-1234-1234-1234-123456789012';
const controlGroup='/user.slice/user-1000.slice/user@1000.service/app.slice/'+unit;
const identity={format:2,kind:'MANAGED_GUARDIAN_LIVE_BINDING_V2',jobId,unit,uid:1000,mainPid:123,invocationId:'a'.repeat(32),mainStartMonotonic:'456',bootId,controlGroup};
const current={InvocationID:identity.invocationId,ExecMainStartTimestampMonotonic:'456',ControlGroup:controlGroup,MainPID:'0'};
const deps={platform:'linux',uid:1000,boot:()=>bootId,unitState:()=>current,population:()=>'EMPTY'};
test('saved boot and group observations refuse cleanup even when original cohort is empty',()=>{
 const r=inspectOriginalProofCohort(identity,deps);assert.equal(r.state,'ORIGINAL_COHORT_EMPTY');
 for(const flag of ['completeResourceInventory','pendingDaemonRequestsAccountedFor','cleanupAuthorized','executionAuthorized','actionAuthorized'])assert.equal(r[flag],false);
 assert.equal(inspectOriginalProofCohort(identity,{...deps,population:()=>'POPULATED'}).state,'ORIGINAL_COHORT_POPULATED');
 assert.equal(inspectOriginalProofCohort(identity,{...deps,unitState:()=>null}).state,'UNIT_ABSENT_GROUP_EMPTY');
 assert.equal(inspectOriginalProofCohort(identity,{...deps,unitState:()=>null,population:()=>'POPULATED'}).state,'UNIT_ABSENT_GROUP_POPULATED');
});
test('legacy and different-boot records do not probe a new boot using a saved name or PID',()=>{
 const forbidden=()=>assert.fail('No current-unit or cgroup read allowed');
 const legacy={...identity,format:1,kind:'MANAGED_GUARDIAN_LIVE_BINDING_V1'};delete legacy.bootId;delete legacy.controlGroup;
 assert.equal(inspectOriginalProofCohort(legacy,{...deps,boot:forbidden,unitState:forbidden,population:forbidden}).state,'LEGACY_BINDING_UNVERIFIABLE');
 assert.equal(inspectOriginalProofCohort(identity,{...deps,boot:()=>bootId.replace('1','2'),unitState:forbidden,population:forbidden}).state,'DIFFERENT_BOOT');
});
test('reused name, invocation, start or group cannot be attributed to original cohort',()=>{
 for(const change of [{InvocationID:'b'.repeat(32)},{ExecMainStartTimestampMonotonic:'457'},{ControlGroup:controlGroup+'/child'},{MainPID:'456'}]){
  assert.equal(inspectOriginalProofCohort(identity,{...deps,unitState:()=>({...current,...change}),population:()=>assert.fail('No attribution')}).state,'UNIT_IDENTITY_CHANGED');
 }
 let reads=0;assert.equal(inspectOriginalProofCohort(identity,{...deps,unitState:()=>++reads===1?current:null}).state,'OBSERVATION_CHANGED');
 assert.equal(inspectOriginalProofCohort(identity,{...deps,unitState:()=>({...current,MainPID:'123'})}).state,'OBSERVATION_INCONSISTENT');
});
test('recursive cgroup events require a valid populated bit and never infer empty from a direct PID list',()=>{
 assert.equal(parseCgroupPopulation('populated 1\nfrozen 0\n'),'POPULATED');assert.equal(parseCgroupPopulation('populated 0\nfrozen 0\n'),'EMPTY');
 for(const body of ['','populated 2','populated 0\npopulated 1','frozen 0','populated 0\nprivate data'])assert.throws(()=>parseCgroupPopulation(body));
 const root='/sys/fs/cgroup'+controlGroup,paths=[];
 const result=observeOriginalControlGroup(controlGroup,unit,1000,{realpath:path=>path,read:path=>{paths.push(path);return'populated 1\n';}});
 assert.equal(result,'POPULATED');assert.deepEqual(paths,[join(root,'cgroup.events')]);
 assert.equal(observeOriginalControlGroup(controlGroup,unit,1000,{realpath:()=>{const e=new Error();e.code='ENOENT';throw e;}}),'ABSENT');
 assert.throws(()=>observeOriginalControlGroup(controlGroup,unit,1000,{realpath:()=>root+'/elsewhere'}));
});
test('cross-owner, traversal and malformed paths refuse before kernel reads',()=>{
 for(const path of [controlGroup.replace('user-1000','user-2000'),controlGroup.replace('/app.slice/','/../'),controlGroup.replace('/app.slice/','//'),controlGroup+'/child',controlGroup.replace('app.slice','bad\npath')])assert.throws(()=>requireOriginalControlGroup(path,unit,1000));
 assert.throws(()=>inspectOriginalProofCohort({...identity,uid:2000},deps));
});
