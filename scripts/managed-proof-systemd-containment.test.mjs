import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {containmentUnit,parseScopeProperties} from './managed-proof-systemd-containment.mjs';
const id='11111111-1111-4111-8111-111111111111',unit=containmentUnit(id);
const fields={Id:unit,LoadState:'loaded',ActiveState:'active',SubState:'running',MainPID:'123',ControlGroup:'/user.slice/user-1000.slice/user@1000.service/app.slice/'+unit,
 KillMode:'control-group',Type:'exec',Transient:'yes',InvocationID:'a'.repeat(32),ExecMainStartTimestampMonotonic:'123456789',Result:'success',ExecMainCode:'0',ExecMainStatus:'0',NoNewPrivileges:'yes'};
const body=v=>Object.entries(v).map(([k,v])=>k+'='+v).join('\n');
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
