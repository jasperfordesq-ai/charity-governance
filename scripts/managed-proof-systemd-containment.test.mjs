import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {containmentUnit,parseScopeProperties,assertIndependentOwnerObservation,assertOutcomeCustodyObservation} from './managed-proof-systemd-containment.mjs';
const id='11111111-1111-4111-8111-111111111111',unit=containmentUnit(id);
const fields={Id:unit,LoadState:'loaded',ActiveState:'active',SubState:'running',MainPID:'123',ControlGroup:'/user.slice/user-1000.slice/user@1000.service/app.slice/'+unit,
 KillMode:'control-group',Type:'exec',Transient:'yes',InvocationID:'a'.repeat(32),ExecMainStartTimestampMonotonic:'123456789',Result:'success',ExecMainCode:'0',ExecMainStatus:'0',NoNewPrivileges:'yes'};
const body=v=>Object.entries(v).map(([k,v])=>k+'='+v).join('\n');

test('independent owner readiness requires actual original process, command, boot, groups and resource limits',()=>{
 const ownerId='22222222-2222-4222-8222-222222222222',ownerUnit=containmentUnit(ownerId),group='/user.slice/user-1000.slice/user@1000.service/app.slice/'+ownerUnit;
 const value={format:1,kind:'MANAGED_DAEMON_REQUEST_OWNER_V1',jobId:id,sequence:1,identity:{ownerId,unit:ownerUnit,uid:1000,mainPid:456,
  invocationId:'b'.repeat(32),mainStartMonotonic:'987654321',controlGroup:group,sourceSha:'1'.repeat(40),inputDigest:'9'.repeat(64),bootId:'12345678-1234-1234-1234-123456789012'}};
 const options={source:fields,sourceSha:value.identity.sourceSha,ownerInputDigest:value.identity.inputDigest,expectedCommandLine:[process.execPath,'/fixed-owner','--socket','/original']};
 const actual={uid:1000,bootId:value.identity.bootId,source:{...fields},unit:{...fields,Id:ownerUnit,MainPID:'456',InvocationID:'b'.repeat(32),ExecMainStartTimestampMonotonic:'987654321',ControlGroup:group},
  commandLine:options.expectedCommandLine,processGroup:'0::'+group+'\n',status:'Uid:\t1000\t1000\t1000\t1000\nNoNewPrivs:\t1\n',memory:'134217728',pids:'32',cpu:'50000 100000',
  unsetEnvironment:'NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH'};
 const receiver={format:1,kind:'MANAGED_OUTCOME_RECEIVER_V1',jobId:id,receiverId:ownerId,sourceSha:value.identity.sourceSha,inputDigest:value.identity.inputDigest,
  identity:Object.fromEntries(Object.entries(value.identity).filter(([key])=>!['ownerId','sourceSha','inputDigest'].includes(key)))};
 const receiverOptions={...options,jobId:id,receiverId:ownerId,inputDigest:value.identity.inputDigest};
 assert.deepEqual(assertOutcomeCustodyObservation(receiver,receiverOptions,actual),{liveCustodyIdentityVerified:true,originalOutcomeCustodyVerified:false,executionAuthorized:false,actionAuthorized:false});
 for(const change of [{receiverId:id},{sourceSha:'8'.repeat(40)},{inputDigest:'7'.repeat(64)},{identity:{...receiver.identity,uid:1001}},{identity:{...receiver.identity,mainPid:789}}])assert.throws(()=>assertOutcomeCustodyObservation({...receiver,...change},receiverOptions,actual));
 for(const change of [{bootId:'other-boot'},{commandLine:[process.execPath,'/other-worker']},{memory:'max'},{unit:{...actual.unit,InvocationID:'c'.repeat(32)}}])assert.throws(()=>assertOutcomeCustodyObservation(receiver,receiverOptions,{...actual,...change}));
 assert.equal(assertIndependentOwnerObservation(value,options,actual).liveOwnerIdentityVerified,true);
 for(const key of ['independentOwnerDispatchVerified','executionAuthorized','actionAuthorized'])assert.equal(assertIndependentOwnerObservation(value,options,actual)[key],false);
 for(const change of [{bootId:'other-boot'},{commandLine:[process.execPath,'/other-worker']},{processGroup:'0::'+fields.ControlGroup},
  {status:'Uid:\t1001\t1001\t1001\t1001\nNoNewPrivs:\t1\n'},{memory:'max'},{pids:'129'},{cpu:'200000 100000'},{unsetEnvironment:''},
  {unit:{...actual.unit,InvocationID:'c'.repeat(32)}},{unit:{...actual.unit,MainPID:'789'}},{source:{...fields,InvocationID:'d'.repeat(32)}}])assert.throws(()=>assertIndependentOwnerObservation(value,options,{...actual,...change}));
 assert.throws(()=>assertIndependentOwnerObservation({...value,identity:{...value.identity,inputDigest:'8'.repeat(64)}},options,actual));
});
test('fresh transient identity and exact user cgroup are parsed without becoming an execution lease',()=>{
 const p=parseScopeProperties(body(fields),unit,1000);assert.equal(p.InvocationID,fields.InvocationID);assert.equal(p.MainPID,'123');
});
test('aliases, other units/users, weaker kill mode and namespace traversal refuse',()=>{
 for(const change of [{Id:'app.service'},{ControlGroup:'/system.slice/'+unit},{ControlGroup:'/user.slice/user-1001.slice/user@1001.service/app.slice/'+unit},
  {ControlGroup:'/user.slice/user-1000.slice/user@1000.service/../app.slice/'+unit},{KillMode:'process'},{Type:'simple'},{Transient:'no'},{NoNewPrivileges:'no'},
  {InvocationID:'saved-pid'},{MainPID:'123;kill'},{ExecMainStartTimestampMonotonic:'NaN'}])assert.throws(()=>parseScopeProperties(body({...fields,...change}),unit,1000));
 assert.throws(()=>parseScopeProperties(body(fields)+'\nMainPID=456',unit,1000));assert.throws(()=>parseScopeProperties(body(fields),unit,0));
});
test('unit names cannot be chosen from arbitrary saved names or command syntax',()=>{
 for(const value of ['app.service',id.toUpperCase()+';stop','../'+id,{},null])assert.throws(()=>containmentUnit(value));
 assert.throws(()=>parseScopeProperties(body(fields),'app.service',1000));
});
test('non-Linux hosts refuse the kernel probe without a fallback process killer',{skip:process.platform==='linux'},()=>{
 const r=spawnSync(process.execPath,[fileURLToPath(new URL('./managed-proof-systemd-containment.mjs',import.meta.url)),'--probe'],{encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:4096});
 assert.equal(r.status,1);assert.equal(r.stdout,'');assert.match(r.stderr,/unresolved/);
});
