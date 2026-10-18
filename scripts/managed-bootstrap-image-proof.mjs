import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { bootstrapBinding, roles } from '../deploy/managed-bootstrap/binding.mjs';
import { compileBootstrapPlan } from './managed-bootstrap-plan.mjs';

// Explicit opt-in native fixture: synthetic data; local daemon; no publication.
const run = (program, args, timeout = 30000) => execFileSync(program, args,
  { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const docker = (args, timeout) => run('docker', ['--host', 'unix:///var/run/docker.sock', ...args], timeout);
const logs = id => {
  const result = spawnSync('docker', ['--host', 'unix:///var/run/docker.sock', 'logs', id],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 16384 });
  assert.equal(result.status, 0);
  return (result.stdout + result.stderr).trim();
};
let image; const owned = new Set(), job = randomUUID();
const inspect = id => JSON.parse(docker(['inspect', id]))[0];
const ownContainer = id => {
  assert.match(id, /^[a-f0-9]{64}$/);
  const info = inspect(id);
  assert.equal(info.Id, id); assert.equal(info.Image, image);
  assert.equal(info.Config.Labels['org.charitypilot.bootstrap-proof'], job);
  assert.equal(info.HostConfig.NetworkMode, 'none'); assert.equal(info.HostConfig.ReadonlyRootfs, true);
  assert.equal(info.Config.User, 'node'); assert.equal(info.Mounts.length, 0);
  assert.equal(Object.keys(info.HostConfig.PortBindings ?? {}).length, 0);
  return info;
};
try {
  assert.equal(process.platform, 'linux'); assert.notEqual(process.getuid(), 0);
  assert.equal(process.argv.length, 3); const sourceSha = process.argv[2];
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  assert.equal(run('git', ['rev-parse', 'HEAD']), sourceSha);
  assert.equal(run('git', ['status', '--porcelain=v1', '--untracked-files=all']), '');
  assert.equal(run('git', ['remote', 'get-url', 'origin']), 'https://github.com/jasperfordesq-ai/charity-governance.git');
  for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_CONFIG', 'DOCKER_API_VERSION']) assert.ok(!process.env[name]);
  assert.ok(existsSync('/var/run/docker.sock'));
  assert.equal(run('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']), 'unix:///var/run/docker.sock');
  const binding = { format: 1, provider: 'render', region: 'frankfurt', purpose: 'SYNTHETIC_IDENTITY_ONLY',
    bootstrapId: job, installationId: 'synthetic', ownerId: 'tea-synthetic', environmentId: 'env-synthetic',
    sourceSha, expiresAt: new Date(Date.now() + 600000).toISOString(),
    names: Object.fromEntries(roles.map(role => [role, 'charitypilot-proof-' + role])) };
  const pin = bootstrapBinding(binding);
  image = docker(['build', '--quiet', '--network', 'none', '--platform', 'linux/amd64',
    '--label', 'org.charitypilot.bootstrap-proof=' + job, '--build-arg', 'CHARITYPILOT_BUILD_COMMIT=' + sourceSha,
    '--build-arg', 'CHARITYPILOT_MANAGED_BOOTSTRAP_BINDING_SHA256=' + pin.sha256,
    '-f', 'deploy/managed-bootstrap/Dockerfile', '.'], 180000);
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const plan = compileBootstrapPlan({ format: 1, binding, image: {
    url: 'ghcr.io/jasperfordesq-ai/charitypilot-bootstrap@' + image,
    sourceSha, bindingSha256: pin.sha256, platform: 'linux/amd64' } });
  const create = (role, extra = []) => {
    const body = plan.requests.find(v => v.role === role).body;
    const values = [...body.envVars, { key: 'RENDER_SERVICE_ID', value: 'srv-' + 'a'.repeat(20) },
      { key: 'RENDER_SERVICE_TYPE', value: ({ gateway: 'web', web: 'pserv', api: 'pserv', scheduler: 'worker' })[role] }, ...extra];
    const id = docker(['create', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '128m',
      '--label', 'org.charitypilot.bootstrap-proof=' + job,
      ...values.flatMap(({ key, value }) => ['--env', key + '=' + value]), image]);
    // Only an original returned ID can enter cleanup authority; never label adoption.
    owned.add(id); ownContainer(id); docker(['start', id]); return id;
  };
  for (const role of roles) {
    const id = create(role), port = { gateway: 10000, web: 3003, api: 3002 }[role];
    if (port) {
      docker(['exec', id, 'node', '--input-type=module', '-e', `
        import assert from 'node:assert/strict'; import fs from 'node:fs';
        const pin='/opt/charitypilot/managed-bootstrap-build.json',stat=fs.statSync(pin);
        assert.equal(stat.uid,0);assert.equal(stat.mode&0o777,0o444);assert.equal(stat.nlink,1);
        assert.throws(()=>fs.accessSync(pin,fs.constants.W_OK));
        for(const [path,status] of [['/bootstrap-health',200],['/api/v1/health',503],['/login',503],['/documents',503]]){
          let response;for(let i=0;i<30;i++){try{response=await fetch('http://127.0.0.1:${port}'+path);break;}catch{await new Promise(r=>setTimeout(r,50));}}
          assert.equal(response?.status,status);assert.equal(response.headers.get('set-cookie'),null);
          assert.equal((await response.json()).applicationReady,false);
        }
        assert.equal(fs.existsSync('/app/apps'),false);assert.equal(fs.existsSync('/app/node_modules'),false);
      `]);
    } else {
      docker(['exec', id, 'node', '--input-type=module', '-e', String.raw`
        import fs from 'node:fs';import assert from 'node:assert/strict';
        for(const file of ['/proc/net/tcp','/proc/net/tcp6']) assert.ok(!fs.readFileSync(file,'utf8').split('\n').some(line=>line.trim().split(/\s+/)[3]==='0A'));
      `]);
    }
    assert.equal(logs(id), '');
    ownContainer(id); docker(['rm', '--force', id]); owned.delete(id);
  }
  for (const extra of [[{ key: 'JWT_SECRET', value: 'SYNTHETIC_DO_NOT_ECHO' }],
    [{ key: 'NODE_OPTIONS', value: '--require=/DO_NOT_LOAD' }],
    [{ key: 'CHARITYPILOT_BUILD_COMMIT', value: '2'.repeat(40) }],
    [{ key: 'CHARITYPILOT_MANAGED_BOOTSTRAP_BINDING', value: pin.json.replace('tea-synthetic', 'tea-other') }]]) {
    const id = create('api', extra);
    assert.equal(docker(['wait', id]), '1');
    assert.equal(logs(id), 'Managed identity bootstrap refused');
    ownContainer(id); docker(['rm', id]); owned.delete(id);
  }
  console.log(JSON.stringify({ sourceSha, rolesTested: 4, refusalsTested: 4,
    immutablePinVerified: true, mounts: 0, publishedPorts: 0, providerCompatibilityVerified: false,
    imagePublished: false, applicationReady: false }));
} finally {
  for (const id of owned) { ownContainer(id); docker(['rm', '--force', id]); }
  if (image) {
    const info = inspect(image);
    assert.equal(info.Id, image); assert.equal(info.Config.Labels['org.charitypilot.bootstrap-proof'], job);
    docker(['image', 'rm', image]);
  }
}
