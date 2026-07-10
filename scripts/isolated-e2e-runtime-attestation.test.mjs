import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ISOLATED_E2E_RUNTIME_SERVICES,
  attestBuiltImages,
  attestRunningContainers,
} from './isolated-e2e-runtime-attestation.mjs';

const PROJECT = 'charitypilot-e2e-9d9899dc9bea45caa916';
const TAGS = Object.freeze({
  app: `${PROJECT}-app:local`,
  database: `${PROJECT}-database:local`,
  gateway: `${PROJECT}-gateway:local`,
});
const IMAGE_IDS = Object.freeze({
  app: `sha256:${'a'.repeat(64)}`,
  database: `sha256:${'b'.repeat(64)}`,
  gateway: `sha256:${'c'.repeat(64)}`,
});
const CONTAINER_IDS = Object.freeze({
  api: 'd'.repeat(64),
  db: 'e'.repeat(64),
  gateway: 'f'.repeat(64),
  web: '1'.repeat(64),
});
const NETWORK_IDS = Object.freeze({ e2e: '2'.repeat(64), edge: '3'.repeat(64) });
const ENDPOINT_IDS = Object.freeze({
  api: '4'.repeat(64),
  db: '5'.repeat(64),
  gateway: '6'.repeat(64),
  gatewayEdge: '7'.repeat(64),
  web: '8'.repeat(64),
});
const IPS = Object.freeze({
  api: '172.30.0.10',
  db: '172.30.0.11',
  gateway: '172.30.0.12',
  gatewayEdge: '172.31.0.2',
  web: '172.30.0.13',
});
const GATEWAY_ENV = Object.freeze([
  'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  'NODE_VERSION=22.17.0',
  'YARN_VERSION=1.22.22',
]);
const API_ENV = Object.freeze([
  ...GATEWAY_ENV,
  'NODE_ENV=development',
  'NEXT_TELEMETRY_DISABLED=1',
  'APP_VALUE=test',
]);
const WEB_ENV = Object.freeze([
  ...GATEWAY_ENV,
  'CHARITYPILOT_INTERNAL_API_URL=http://api:3302',
  'HOST=0.0.0.0',
  'NEXT_PUBLIC_API_URL=http://127.0.0.1:3302',
  'NEXT_PUBLIC_CHARITYPILOT_E2E_MODE=local-disposable',
  'NEXT_TELEMETRY_DISABLED=1',
  'NODE_ENV=production',
  'PORT=3303',
]);
const API_COMMAND = Object.freeze([
  'sh',
  '-lc',
  'set -eu\n' +
    './node_modules/.bin/prisma migrate deploy --schema apps/api/prisma/schema.prisma\n' +
    './node_modules/.bin/tsx apps/api/prisma/seed.ts\n' +
    'exec node --import tsx apps/api/src/server.ts\n',
]);
const WEB_COMMAND = Object.freeze(['node', 'apps/web/server.mjs']);
const PORTS = Object.freeze({
  '3302/tcp': Object.freeze([{ HostIp: '127.0.0.1', HostPort: '3302' }]),
  '3303/tcp': Object.freeze([{ HostIp: '127.0.0.1', HostPort: '3303' }]),
  '55434/tcp': Object.freeze([{ HostIp: '127.0.0.1', HostPort: '55434' }]),
});
const TMPFS = Object.freeze({
  api: Object.freeze({
    '/tmp': 'rw,nosuid,nodev,noexec,size=128m,mode=1777',
    '/var/lib/charitypilot-e2e-documents':
      'rw,nosuid,nodev,noexec,size=256m,mode=0700,uid=1000,gid=1000',
  }),
  db: Object.freeze({
    '/tmp': 'rw,nosuid,nodev,noexec,size=32m,mode=1777',
    '/var/lib/postgresql/data': 'rw,nosuid,nodev,size=1024m,mode=0700',
    '/var/run/postgresql': 'rw,nosuid,nodev,noexec,size=16m,mode=0775',
  }),
  gateway: Object.freeze({}),
  web: Object.freeze({
    '/tmp': 'rw,nosuid,nodev,noexec,size=128m,mode=1777',
  }),
});

function imageRecords() {
  return [
    { Id: IMAGE_IDS.app, RepoTags: [TAGS.app, 'unrelated-cache-tag:local'] },
    { Id: IMAGE_IDS.database, RepoTags: [TAGS.database] },
    { Id: IMAGE_IDS.gateway, RepoTags: [TAGS.gateway] },
  ];
}

function portBindings() {
  return structuredClone(PORTS);
}

function labels(serviceName) {
  return {
    'com.docker.compose.project': PROJECT,
    'com.docker.compose.service': serviceName,
    'com.docker.compose.container-number': '1',
    'com.docker.compose.oneoff': 'False',
    'com.docker.compose.version': '2.38.0',
  };
}

function endpoint(networkId, endpointId, ipAddress, aliases) {
  return { NetworkID: networkId, EndpointID: endpointId, IPAddress: ipAddress, Aliases: aliases };
}

function hostConfig(serviceName) {
  const hardened = serviceName !== 'db';
  const networkMode = `${PROJECT}_e2e`;
  return {
    AutoRemove: false,
    Binds: null,
    CapAdd: null,
    CapDrop: hardened ? ['ALL'] : null,
    CgroupParent: '',
    CgroupnsMode: 'private',
    DeviceCgroupRules: null,
    DeviceRequests: null,
    Devices: [],
    Dns: [],
    DnsOptions: [],
    DnsSearch: [],
    ExtraHosts: [],
    GroupAdd: null,
    Init: hardened ? true : null,
    IpcMode: 'private',
    Isolation: '',
    Links: null,
    Mounts: [],
    NetworkMode: networkMode,
    PidMode: '',
    PortBindings: serviceName === 'gateway' ? portBindings() : {},
    Privileged: false,
    PublishAllPorts: false,
    ReadonlyRootfs: true,
    RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
    Runtime: 'runc',
    SecurityOpt: hardened ? ['no-new-privileges:true'] : null,
    Sysctls: null,
    Tmpfs: structuredClone(TMPFS[serviceName]),
    UTSMode: '',
    UsernsMode: '',
    VolumesFrom: null,
  };
}

function state() {
  return {
    Status: 'running',
    Running: true,
    Paused: false,
    Restarting: false,
    OOMKilled: false,
    Dead: false,
    Pid: 4242,
    ExitCode: 0,
    Error: '',
    Health: { Status: 'healthy', FailingStreak: 0 },
  };
}

function containerRecord(serviceName) {
  const imageRole = serviceName === 'db' ? 'database' : serviceName === 'gateway' ? 'gateway' : 'app';
  const networks = {
    [`${PROJECT}_e2e`]: endpoint(
      NETWORK_IDS.e2e,
      ENDPOINT_IDS[serviceName],
      IPS[serviceName],
      serviceName === 'gateway'
        ? [`${PROJECT}-gateway-1`, 'gateway']
        : [`${PROJECT}-${serviceName}-1`, serviceName, `${serviceName}.charitypilot-e2e.invalid`],
    ),
  };
  if (serviceName === 'gateway') {
    networks[`${PROJECT}_edge`] = endpoint(
      NETWORK_IDS.edge,
      ENDPOINT_IDS.gatewayEdge,
      IPS.gatewayEdge,
      [`${PROJECT}-gateway-1`, 'gateway'],
    );
  }
  return {
    Id: CONTAINER_IDS[serviceName],
    Image: IMAGE_IDS[imageRole],
    Config: {
      Cmd: serviceName === 'api' ? [...API_COMMAND] : serviceName === 'web' ? [...WEB_COMMAND] : null,
      Image: TAGS[imageRole],
      User: serviceName === 'db' ? '' : '1000:1000',
      Labels: labels(serviceName),
      Env: serviceName === 'gateway'
        ? [...GATEWAY_ENV]
        : serviceName === 'api'
          ? [...API_ENV]
          : serviceName === 'web'
            ? [...WEB_ENV]
            : ['PATH=/usr/bin', 'APP_VALUE=test'],
    },
    State: state(),
    HostConfig: hostConfig(serviceName),
    Mounts: [],
    NetworkSettings: {
      Networks: networks,
      Ports: serviceName === 'gateway'
        ? portBindings()
        : serviceName === 'db'
          ? { '5432/tcp': null }
          : {},
    },
  };
}

function containerRecords() {
  return ISOLATED_E2E_RUNTIME_SERVICES.map(containerRecord);
}

function service(records, serviceName) {
  return records.find((record) =>
    record.Config.Labels['com.docker.compose.service'] === serviceName);
}

function builtAttestation() {
  return attestBuiltImages(imageRecords(), PROJECT);
}

function rejectsRuntime(mutate, label) {
  const records = containerRecords();
  mutate(records);
  assert.throws(
    () => attestRunningContainers(records, builtAttestation()),
    /Isolated E2E runtime attestation failed/,
    label,
  );
}

test('attests exactly three runner-owned built image tags and immutable IDs', () => {
  const result = builtAttestation();
  assert.deepEqual(result, { projectName: PROJECT, tags: TAGS, imageIds: IMAGE_IDS });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.imageIds), true);

  const mutations = [
    ['malformed project', (records) => attestBuiltImages(records, 'charitypilot-e2e-main')],
    ['missing record', (records) => attestBuiltImages(records.slice(1), PROJECT)],
    ['extra record', (records) => attestBuiltImages([...records, structuredClone(records[0])], PROJECT)],
    ['missing tag', (records) => { records[0].RepoTags = ['other:local']; return attestBuiltImages(records, PROJECT); }],
    ['duplicate role tag', (records) => { records[1].RepoTags.push(TAGS.app); return attestBuiltImages(records, PROJECT); }],
    ['malformed image id', (records) => { records[2].Id = 'sha256:short'; return attestBuiltImages(records, PROJECT); }],
    ['shared image id', (records) => { records[2].Id = records[0].Id; return attestBuiltImages(records, PROJECT); }],
  ];
  for (const [label, invoke] of mutations) {
    assert.throws(() => invoke(imageRecords()), /runtime attestation failed/, label);
  }
});

test('accepts one clean running container per exact Compose service', () => {
  const result = attestRunningContainers(containerRecords(), builtAttestation());
  assert.equal(result.projectName, PROJECT);
  assert.deepEqual(result.imageIds, IMAGE_IDS);
  assert.deepEqual(result.containerIds, CONTAINER_IDS);
  assert.deepEqual(result.networkIds, NETWORK_IDS);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.containerIds), true);

  const withoutOptionalHostMounts = containerRecords();
  for (const record of withoutOptionalHostMounts) delete record.HostConfig.Mounts;
  assert.doesNotThrow(() => attestRunningContainers(withoutOptionalHostMounts, builtAttestation()));

  const withoutEmptyGatewayTmpfs = containerRecords();
  delete service(withoutEmptyGatewayTmpfs, 'gateway').HostConfig.Tmpfs;
  assert.doesNotThrow(() => attestRunningContainers(withoutEmptyGatewayTmpfs, builtAttestation()));

  const withReportedTmpfs = containerRecords();
  const api = service(withReportedTmpfs, 'api');
  api.Mounts = Object.keys(TMPFS.api).map((Destination) => ({
    Type: 'tmpfs', Source: '', Destination, RW: true,
  }));
  assert.doesNotThrow(() => attestRunningContainers(withReportedTmpfs, builtAttestation()));
});

test('rejects missing, extra, duplicate, one-off, mislabeled, or wrong-image containers', () => {
  rejectsRuntime((records) => records.pop(), 'missing container');
  rejectsRuntime((records) => records.push(structuredClone(records[0])), 'extra container');
  rejectsRuntime((records) => {
    service(records, 'web').Config.Labels['com.docker.compose.service'] = 'api';
  }, 'duplicate service');
  rejectsRuntime((records) => {
    service(records, 'web').Config.Labels['com.docker.compose.service'] = 'attacker';
  }, 'unexpected service');
  rejectsRuntime((records) => {
    service(records, 'api').Config.Labels['com.docker.compose.project'] = 'other-project';
  }, 'wrong project');
  rejectsRuntime((records) => {
    service(records, 'api').Config.Labels['com.docker.compose.container-number'] = '2';
  }, 'scaled service');
  rejectsRuntime((records) => {
    service(records, 'api').Config.Labels['com.docker.compose.oneoff'] = 'True';
  }, 'oneoff');
  rejectsRuntime((records) => { service(records, 'api').Id = 'short'; }, 'bad container id');
  rejectsRuntime((records) => { service(records, 'api').Image = IMAGE_IDS.gateway; }, 'wrong image id');
  rejectsRuntime((records) => { service(records, 'api').Config.Image = TAGS.gateway; }, 'wrong image tag');

  const forged = structuredClone(builtAttestation());
  forged.imageIds.gateway = forged.imageIds.app;
  assert.throws(
    () => attestRunningContainers(containerRecords(), forged),
    /runtime attestation failed/,
  );
});

test('rejects every non-running or unhealthy lifecycle state', () => {
  for (const [label, mutate] of [
    ['not running', (record) => { record.State.Running = false; }],
    ['wrong status', (record) => { record.State.Status = 'exited'; }],
    ['paused', (record) => { record.State.Paused = true; }],
    ['restarting', (record) => { record.State.Restarting = true; }],
    ['oom killed', (record) => { record.State.OOMKilled = true; }],
    ['dead', (record) => { record.State.Dead = true; }],
    ['bad exit code', (record) => { record.State.ExitCode = 17; }],
    ['no pid', (record) => { record.State.Pid = 0; }],
    ['runtime error', (record) => { record.State.Error = 'synthetic failure'; }],
    ['unhealthy', (record) => { record.State.Health.Status = 'unhealthy'; }],
    ['missing health', (record) => { delete record.State.Health; }],
  ]) {
    rejectsRuntime((records) => mutate(service(records, label === 'missing health' ? 'gateway' : 'api')), label);
  }
});

test('rejects writable, privileged, root, capability, NNP, and lifecycle drift', () => {
  for (const [label, mutate] of [
    ['writable root', (record) => { record.HostConfig.ReadonlyRootfs = false; }],
    ['privileged', (record) => { record.HostConfig.Privileged = true; }],
    ['root user', (record) => { record.Config.User = '0:0'; }],
    ['no init', (record) => { record.HostConfig.Init = false; }],
    ['cap add', (record) => { record.HostConfig.CapAdd = ['NET_ADMIN']; }],
    ['cap drop missing', (record) => { record.HostConfig.CapDrop = []; }],
    ['NNP missing', (record) => { record.HostConfig.SecurityOpt = []; }],
    ['extra security opt', (record) => { record.HostConfig.SecurityOpt.push('seccomp=unconfined'); }],
    ['auto remove', (record) => { record.HostConfig.AutoRemove = true; }],
    ['publish all', (record) => { record.HostConfig.PublishAllPorts = true; }],
    ['restart', (record) => { record.HostConfig.RestartPolicy.Name = 'always'; }],
  ]) {
    rejectsRuntime((records) => mutate(service(records, 'gateway')), label);
  }
  rejectsRuntime((records) => { service(records, 'db').Config.User = '70'; }, 'database image user');
  rejectsRuntime((records) => { service(records, 'db').HostConfig.CapDrop = ['ALL']; }, 'database cap override');
  rejectsRuntime((records) => {
    service(records, 'db').HostConfig.SecurityOpt = ['no-new-privileges:true'];
  }, 'database security option override');
});

test('attests the exact production web runtime while retaining the development API runtime', () => {
  rejectsRuntime((records) => {
    service(records, 'web').Config.Cmd = ['sh', '-lc', 'next dev'];
  }, 'web development command');
  rejectsRuntime((records) => {
    service(records, 'web').Config.Env = service(records, 'web').Config.Env
      .map((entry) => entry === 'NODE_ENV=production' ? 'NODE_ENV=development' : entry);
  }, 'web development environment');
  rejectsRuntime((records) => {
    service(records, 'web').Config.Env = service(records, 'web').Config.Env
      .map((entry) => entry.startsWith('CHARITYPILOT_INTERNAL_API_URL=')
        ? 'CHARITYPILOT_INTERNAL_API_URL=http://localhost:3002'
        : entry);
  }, 'web personal internal API');
  rejectsRuntime((records) => {
    service(records, 'web').Config.Env = service(records, 'web').Config.Env
      .filter((entry) => !entry.startsWith('NEXT_PUBLIC_CHARITYPILOT_E2E_MODE='));
  }, 'web missing isolated marker');
  rejectsRuntime((records) => {
    service(records, 'web').Config.Env.push('WATCHPACK_POLLING=true');
  }, 'web unexpected environment');
  rejectsRuntime((records) => {
    service(records, 'api').Config.Cmd = ['node', 'apps/api/dist/server.js'];
  }, 'api command');
  rejectsRuntime((records) => {
    service(records, 'api').Config.Env = service(records, 'api').Config.Env
      .map((entry) => entry === 'NODE_ENV=development' ? 'NODE_ENV=production' : entry);
  }, 'api production environment');
});

test('rejects host, namespace, DNS, device, link, and volume coupling', () => {
  const hostileCollections = {
    Binds: ['/host:/container:ro'],
    DeviceCgroupRules: ['c 1:3 rwm'],
    DeviceRequests: [{ Driver: 'nvidia', Count: -1 }],
    Devices: [{ PathOnHost: '/dev/sda', PathInContainer: '/dev/sda' }],
    Dns: ['8.8.8.8'],
    DnsOptions: ['use-vc'],
    DnsSearch: ['corp.example'],
    ExtraHosts: ['host.docker.internal:host-gateway'],
    GroupAdd: ['0'],
    Links: ['/other:/stack/api/other'],
    Mounts: [{ Type: 'bind', Source: '/host', Target: '/container' }],
    VolumesFrom: ['personal-db:ro'],
  };
  for (const [field, value] of Object.entries(hostileCollections)) {
    rejectsRuntime((records) => { service(records, 'api').HostConfig[field] = value; }, field);
  }

  for (const [field, value] of [
    ['NetworkMode', 'host'],
    ['PidMode', 'host'],
    ['IpcMode', 'host'],
    ['UTSMode', 'host'],
    ['UsernsMode', 'host'],
    ['CgroupnsMode', 'host'],
    ['CgroupParent', '/host.slice'],
    ['Isolation', 'hyperv'],
    ['Runtime', 'kata'],
  ]) {
    rejectsRuntime((records) => { service(records, 'api').HostConfig[field] = value; }, field);
  }
  rejectsRuntime((records) => {
    service(records, 'db').HostConfig.Sysctls = { 'net.ipv4.ip_forward': '1' };
  }, 'non-gateway sysctl');
  rejectsRuntime((records) => {
    service(records, 'gateway').HostConfig.Sysctls = { 'net.ipv4.ip_forward': '1' };
  }, 'gateway forwarding sysctl');

  const forwardingDisabled = containerRecords();
  service(forwardingDisabled, 'gateway').HostConfig.Sysctls = {
    'net.ipv4.ip_forward': '0',
    'net.ipv6.conf.all.forwarding': '0',
  };
  assert.doesNotThrow(() => attestRunningContainers(forwardingDisabled, builtAttestation()));
});

test('rejects missing, extra, persistent, host-backed, or weakened tmpfs mounts', () => {
  rejectsRuntime((records) => {
    delete service(records, 'api').HostConfig.Tmpfs['/tmp'];
  }, 'missing tmpfs');
  rejectsRuntime((records) => {
    service(records, 'api').HostConfig.Tmpfs['/extra'] = 'rw,size=1m';
  }, 'extra tmpfs');
  rejectsRuntime((records) => {
    service(records, 'api').HostConfig.Tmpfs['/tmp'] = 'rw,exec,suid,size=4g';
  }, 'weak tmpfs options');
  const canonicalizedUnits = containerRecords();
  service(canonicalizedUnits, 'api').HostConfig.Tmpfs['/tmp'] =
    'mode=01777,size=134217728,rw,nodev,noexec,nosuid';
  assert.doesNotThrow(() => attestRunningContainers(canonicalizedUnits, builtAttestation()));
  rejectsRuntime((records) => {
    service(records, 'api').Mounts = [{
      Type: 'bind', Source: 'C:/private', Destination: '/tmp', RW: true,
    }];
  }, 'bind mount');
  rejectsRuntime((records) => {
    service(records, 'db').Mounts = [{
      Type: 'volume', Source: 'personal-db', Destination: '/var/lib/postgresql/data', RW: true,
    }];
  }, 'persistent volume');
  rejectsRuntime((records) => {
    service(records, 'gateway').Mounts = [{
      Type: 'tmpfs', Source: '', Destination: '/tmp', RW: true,
    }];
  }, 'gateway mount');
  rejectsRuntime((records) => {
    service(records, 'api').Mounts = [{
      Type: 'tmpfs', Source: '', Destination: '/tmp', RW: true,
    }];
  }, 'partial runtime tmpfs report');
});

test('rejects every host publication except the three exact gateway loopback TCP bindings', () => {
  rejectsRuntime((records) => {
    service(records, 'api').HostConfig.PortBindings = {
      '3302/tcp': [{ HostIp: '127.0.0.1', HostPort: '3302' }],
    };
  }, 'direct API host binding');
  rejectsRuntime((records) => {
    service(records, 'db').NetworkSettings.Ports['5432/tcp'] = [
      { HostIp: '127.0.0.1', HostPort: '5432' },
    ];
  }, 'runtime DB host binding');
  rejectsRuntime((records) => {
    service(records, 'gateway').HostConfig.PortBindings['3302/tcp'][0].HostIp = '0.0.0.0';
  }, 'wildcard host binding');
  rejectsRuntime((records) => {
    service(records, 'gateway').NetworkSettings.Ports['3303/tcp'][0].HostIp = '::';
  }, 'IPv6 wildcard binding');
  rejectsRuntime((records) => {
    service(records, 'gateway').HostConfig.PortBindings['55434/tcp'][0].HostPort = '5432';
  }, 'wrong host port');
  rejectsRuntime((records) => {
    delete service(records, 'gateway').NetworkSettings.Ports['3302/tcp'];
  }, 'missing gateway port');
  rejectsRuntime((records) => {
    service(records, 'gateway').HostConfig.PortBindings['9999/udp'] = [
      { HostIp: '127.0.0.1', HostPort: '9999' },
    ];
  }, 'extra UDP port');
  rejectsRuntime((records) => {
    service(records, 'gateway').HostConfig.PortBindings['3302/tcp'].push(
      { HostIp: '127.0.0.1', HostPort: '4302' },
    );
  }, 'duplicate host binding');
});

test('rejects missing, extra, inconsistent, duplicate, or host-mode network identities', () => {
  rejectsRuntime((records) => {
    service(records, 'api').NetworkSettings.Networks[`${PROJECT}_edge`] = endpoint(
      NETWORK_IDS.edge,
      '9'.repeat(64),
      '172.31.0.3',
      ['api'],
    );
  }, 'extra edge network');
  rejectsRuntime((records) => {
    delete service(records, 'gateway').NetworkSettings.Networks[`${PROJECT}_edge`];
  }, 'missing edge network');
  rejectsRuntime((records) => {
    service(records, 'web').NetworkSettings.Networks[`${PROJECT}_e2e`].NetworkID = '9'.repeat(64);
  }, 'split internal network');
  rejectsRuntime((records) => {
    service(records, 'gateway').NetworkSettings.Networks[`${PROJECT}_edge`].NetworkID = NETWORK_IDS.e2e;
  }, 'same edge and internal identity');
  rejectsRuntime((records) => {
    service(records, 'web').NetworkSettings.Networks[`${PROJECT}_e2e`].IPAddress = IPS.api;
  }, 'duplicate service IP');
  rejectsRuntime((records) => {
    service(records, 'api').NetworkSettings.Networks[`${PROJECT}_e2e`].IPAddress = '127.0.0.1';
  }, 'loopback endpoint');
  rejectsRuntime((records) => {
    service(records, 'api').NetworkSettings.Networks[`${PROJECT}_e2e`].EndpointID = 'short';
  }, 'malformed endpoint');
  rejectsRuntime((records) => {
    service(records, 'api').NetworkSettings.Networks[`${PROJECT}_e2e`].Aliases = ['api'];
  }, 'missing reserved alias');
  rejectsRuntime((records) => {
    service(records, 'api').NetworkSettings.Networks[`${PROJECT}_e2e`].Aliases.push(
      'db.charitypilot-e2e.invalid',
    );
  }, 'foreign reserved alias');
  rejectsRuntime((records) => {
    service(records, 'gateway').NetworkSettings.Networks[`${PROJECT}_e2e`].Aliases.push(
      'gateway.charitypilot-e2e.invalid',
    );
  }, 'gateway reserved alias');
});

test('allows only the pinned Node base environment in the secretless gateway', () => {
  rejectsRuntime((records) => {
    service(records, 'gateway').Config.Env.push('E2E_DATABASE_RUNNER_PASSWORD=secret');
  }, 'gateway generated secret');
  rejectsRuntime((records) => {
    service(records, 'gateway').Config.Env.push('NODE_OPTIONS=--require=/tmp/attacker.js');
  }, 'gateway Node injection');
  rejectsRuntime((records) => {
    service(records, 'gateway').Config.Env = service(records, 'gateway').Config.Env
      .filter((entry) => !entry.startsWith('YARN_VERSION='));
  }, 'missing base env');
  rejectsRuntime((records) => {
    service(records, 'gateway').Config.Env[1] = 'NODE_VERSION=20.0.0';
  }, 'wrong Node major');
  rejectsRuntime((records) => {
    service(records, 'gateway').Config.Env.push('PATH=/tmp');
  }, 'duplicate env key');
});
