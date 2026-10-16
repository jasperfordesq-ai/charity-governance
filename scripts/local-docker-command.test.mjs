import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnLocalDockerCommand } from './local-docker-command.mjs';

function fixture(overrides={}) {
  const calls=[];
  const endpoint=overrides.endpoint ?? 'unix:///var/run/docker.sock';
  const spawn=(binary,args,options)=>{
    calls.push({binary,args,options});
    if(args[0]==='context') return {status:0,stdout:JSON.stringify({Host:endpoint,SkipTLSVerify:overrides.skipTlsVerify??false})};
    if(args.includes('info')) return {status:0,stdout:JSON.stringify({OperatingSystem:overrides.operatingSystem??'Synthetic Linux',OSType:overrides.serverOs??'linux'})};
    if(args.includes('version')) return {status:0,stdout:overrides.apiVersion??'1.48'};
    return {status:0,stdout:'lifecycle-result',stderr:''};
  };
  return {calls,spawn};
}

test('verified local lifecycle pins every daemon child and preserves bounded stdin options',()=>{
  const f=fixture(); const options={input:'synthetic metadata',encoding:'utf8',timeout:12345};
  const result=spawnLocalDockerCommand(['docker','compose','down'],{PATH:'synthetic',compose_file:'wrong.yml'},options,{spawn:f.spawn,platform:'linux'});
  assert.equal(result.stdout,'lifecycle-result');assert.equal(f.calls.length,4);
  assert.deepEqual(f.calls[0].args,['context','inspect','--format','{{json .Endpoints.docker}}']);
  for(const call of f.calls.slice(1)) {
    assert.deepEqual(call.args.slice(0,2),['--host','unix:///var/run/docker.sock']);
    assert.equal(call.options.env.DOCKER_HOST,'unix:///var/run/docker.sock');
    assert.equal(call.options.env.compose_file,undefined);
  }
  assert.deepEqual(f.calls.at(-1).args,['--host','unix:///var/run/docker.sock','compose','down']);
  assert.equal(f.calls.at(-1).options.input,options.input);assert.equal(f.calls.at(-1).options.timeout,12345);
});

for(const override of [{endpoint:'tcp://remote:2375'},{endpoint:'ssh://remote'},
  {endpoint:'unix:///tmp/other.sock'},{skipTlsVerify:true},{serverOs:'windows'},{apiVersion:'1.47'}]) {
  test('invalid endpoint or engine cannot reach a lifecycle action '+JSON.stringify(override),()=>{
    const f=fixture(override);
    assert.throws(()=>spawnLocalDockerCommand(['docker','compose','down'],{}, {},{spawn:f.spawn,platform:'linux'}),/verified local Linux engine/);
    assert.ok(!f.calls.some(call=>call.args.includes('down')));
  });
}

for(const key of ['DOCKER_HOST','docker_context','DOCKER_CONFIG','BUILDX_BUILDER']) {
  test('ambient '+key+' is refused before context discovery',()=>{
    const f=fixture();assert.throws(()=>spawnLocalDockerCommand(['docker','compose','up'],{[key]:'unreviewed'}, {},{spawn:f.spawn,platform:'linux'}));
    assert.equal(f.calls.length,0);
  });
}

test('discovery failures expose no daemon diagnostics or inner cause',()=>{
  const error=new Error('synthetic-secret');
  assert.throws(()=>spawnLocalDockerCommand(['docker','compose','down'],{}, {},{platform:'linux',spawn:()=>{throw error;}}),value=>{
    assert.doesNotMatch(value.message,/synthetic-secret/);assert.equal(value.cause,undefined);return true;
  });
});

test('a command cannot override the verified target with Docker global flags',()=>{
  const f=fixture();assert.throws(()=>spawnLocalDockerCommand(['docker','--context','other','compose','down'],{}, {},{spawn:f.spawn,platform:'linux'}));
  assert.equal(f.calls.length,0);
});

test('Windows accepts only the local Docker Desktop Linux runtime',()=>{
  const f=fixture({endpoint:'npipe:////./pipe/dockerDesktopLinuxEngine',operatingSystem:'Docker Desktop'});
  spawnLocalDockerCommand(['docker','compose','config'],{}, {},{spawn:f.spawn,platform:'win32'});
  assert.equal(f.calls.at(-1).args[1],'npipe:////./pipe/dockerDesktopLinuxEngine');
  const wrong=fixture({endpoint:'npipe:////./pipe/dockerDesktopLinuxEngine'});
  assert.throws(()=>spawnLocalDockerCommand(['docker','compose','up'],{}, {},{spawn:wrong.spawn,platform:'win32'}));
  assert.ok(!wrong.calls.some(call=>call.args.includes('up')));
});
