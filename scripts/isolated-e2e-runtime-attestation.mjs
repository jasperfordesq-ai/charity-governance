import { isIP } from 'node:net';

const PROJECT_PATTERN = /^charitypilot-e2e-[0-9a-f]{20}$/u;
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const OBJECT_ID_PATTERN = /^[0-9a-f]{64}$/u;

const PROJECT_LABEL = 'com.docker.compose.project';
const SERVICE_LABEL = 'com.docker.compose.service';
const CONTAINER_NUMBER_LABEL = 'com.docker.compose.container-number';
const ONEOFF_LABEL = 'com.docker.compose.oneoff';

const IMAGE_ROLES = Object.freeze(['app', 'database', 'gateway']);
const SERVICE_NAMES = Object.freeze(['api', 'db', 'gateway', 'web']);

const NODE_BASE_ENV_KEYS = Object.freeze(['NODE_VERSION', 'PATH', 'YARN_VERSION']);
const NODE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

const API_RUNTIME_COMMAND = Object.freeze([
  'sh',
  '-lc',
  'set -eu\n' +
    './node_modules/.bin/prisma migrate deploy --schema apps/api/prisma/schema.prisma\n' +
    './node_modules/.bin/tsx apps/api/prisma/seed.ts\n' +
    'exec node --import tsx apps/api/src/server.ts\n',
]);
const WEB_RUNTIME_COMMAND = Object.freeze(['node', 'apps/web/server.mjs']);
const WEB_RUNTIME_ENVIRONMENT = Object.freeze({
  CHARITYPILOT_INTERNAL_API_URL: 'http://api:3302',
  HOST: '0.0.0.0',
  NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3302',
  NEXT_PUBLIC_CHARITYPILOT_E2E_MODE: 'local-disposable',
  NEXT_TELEMETRY_DISABLED: '1',
  NODE_ENV: 'production',
  PORT: '3303',
});

const GATEWAY_PORTS = Object.freeze({
  '3302/tcp': '3302',
  '3303/tcp': '3303',
  '55434/tcp': '55434',
});

const EMPTY_HOST_COUPLING_FIELDS = Object.freeze([
  'Binds',
  'DeviceCgroupRules',
  'DeviceRequests',
  'Devices',
  'Dns',
  'DnsOptions',
  'DnsSearch',
  'ExtraHosts',
  'GroupAdd',
  'Links',
  'VolumesFrom',
]);

const SERVICE_CONTRACT = Object.freeze({
  api: Object.freeze({
    imageRole: 'app',
    healthy: true,
    hardenedUser: true,
    networks: Object.freeze(['e2e']),
    tmpfs: Object.freeze({
      '/tmp': 'rw,nosuid,nodev,noexec,size=128m,mode=1777',
      '/var/lib/charitypilot-e2e-documents':
        'rw,nosuid,nodev,noexec,size=256m,mode=0700,uid=1000,gid=1000',
    }),
  }),
  db: Object.freeze({
    imageRole: 'database',
    healthy: true,
    hardenedUser: false,
    networks: Object.freeze(['e2e']),
    tmpfs: Object.freeze({
      '/tmp': 'rw,nosuid,nodev,noexec,size=32m,mode=1777',
      '/var/lib/postgresql/data': 'rw,nosuid,nodev,size=1024m,mode=0700',
      '/var/run/postgresql': 'rw,nosuid,nodev,noexec,size=16m,mode=0775',
    }),
  }),
  gateway: Object.freeze({
    imageRole: 'gateway',
    healthy: true,
    hardenedUser: true,
    networks: Object.freeze(['e2e', 'edge']),
    tmpfs: Object.freeze({}),
  }),
  web: Object.freeze({
    imageRole: 'app',
    healthy: true,
    hardenedUser: true,
    networks: Object.freeze(['e2e']),
    tmpfs: Object.freeze({
      '/tmp': 'rw,nosuid,nodev,noexec,size=128m,mode=1777',
    }),
  }),
});

function fail(message) {
  throw new Error(`Isolated E2E runtime attestation failed: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) fail(`${label} must be an object.`);
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  return value;
}

function requireOwn(record, key, label) {
  if (!Object.hasOwn(record, key)) fail(`${label} is missing ${key}.`);
  return record[key];
}

function requireProjectName(projectName) {
  if (typeof projectName !== 'string' || !PROJECT_PATTERN.test(projectName)) {
    fail('the runner project name is malformed.');
  }
  return projectName;
}

function expectedTags(projectName) {
  return Object.freeze({
    app: `${projectName}-app:local`,
    database: `${projectName}-database:local`,
    gateway: `${projectName}-gateway:local`,
  });
}

function freezeRecord(record) {
  for (const value of Object.values(record)) {
    if (isRecord(value) || Array.isArray(value)) freezeRecord(value);
  }
  return Object.freeze(record);
}

function emptyCollection(value) {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.keys(value).length === 0;
  return false;
}

function sortedKeys(value) {
  return Object.keys(value).sort((left, right) => left.localeCompare(right));
}

function assertExactKeys(actual, expected, label) {
  if (JSON.stringify(sortedKeys(actual)) !== JSON.stringify([...expected].sort())) {
    fail(`${label} does not match the exact contract.`);
  }
}

function parseEnvironment(entries, label) {
  const environment = {};
  for (const entry of requireArray(entries, label)) {
    if (typeof entry !== 'string') fail(`${label} contains a non-string value.`);
    const separator = entry.indexOf('=');
    if (separator <= 0) fail(`${label} contains a malformed value.`);
    const key = entry.slice(0, separator);
    if (Object.hasOwn(environment, key)) fail(`${label} contains a duplicate key.`);
    environment[key] = entry.slice(separator + 1);
  }
  return environment;
}

function parseByteSize(value, label) {
  const match = /^(\d+)([kmgt]i?b?|b)?$/iu.exec(value);
  if (!match) fail(`${label} has a malformed size.`);
  const amount = Number.parseInt(match[1], 10);
  const suffix = (match[2] ?? '').toLowerCase();
  const powers = {
    '': 0,
    b: 0,
    k: 1,
    ki: 1,
    kb: 1,
    kib: 1,
    m: 2,
    mi: 2,
    mb: 2,
    mib: 2,
    g: 3,
    gi: 3,
    gb: 3,
    gib: 3,
    t: 4,
    ti: 4,
    tb: 4,
    tib: 4,
  };
  const bytes = amount * (1024 ** powers[suffix]);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) fail(`${label} has an unsafe size.`);
  return bytes;
}

function parseTmpfsOptions(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} is malformed.`);
  const options = value.split(',');
  if (options.some((option) => option.length === 0) || new Set(options).size !== options.length) {
    fail(`${label} is malformed.`);
  }
  const parsed = { flags: [], size: null, mode: null, uid: null, gid: null };
  const seenKeys = new Set();
  for (const option of options) {
    const separator = option.indexOf('=');
    if (separator === -1) {
      if (!['rw', 'nosuid', 'nodev', 'noexec'].includes(option) || parsed.flags.includes(option)) {
        fail(`${label} contains an unexpected or duplicate mount flag.`);
      }
      parsed.flags.push(option);
      continue;
    }
    const key = option.slice(0, separator);
    const raw = option.slice(separator + 1);
    if (!['size', 'mode', 'uid', 'gid'].includes(key) || seenKeys.has(key) || raw.length === 0) {
      fail(`${label} contains an unexpected or duplicate key.`);
    }
    seenKeys.add(key);
    if (key === 'size') parsed.size = parseByteSize(raw, label);
    if (key === 'mode') {
      if (!/^(?:0o[0-7]{3,4}|0?[0-7]{3,4})$/iu.test(raw)) fail(`${label} has a malformed mode.`);
      parsed.mode = Number.parseInt(raw.replace(/^0o/iu, ''), 8);
    }
    if (key === 'uid' || key === 'gid') {
      if (!/^\d+$/u.test(raw)) fail(`${label} has a malformed ${key}.`);
      parsed[key] = Number.parseInt(raw, 10);
    }
  }
  parsed.flags.sort();
  return parsed;
}

function assertEmptyHostField(hostConfig, field, serviceName) {
  const value = requireOwn(hostConfig, field, `${serviceName} HostConfig`);
  if (!emptyCollection(value)) fail(`${serviceName} has forbidden host coupling in ${field}.`);
}

function assertBuiltImageRecord(record, tag, role) {
  requireRecord(record, `${role} image inspect record`);
  if (typeof record.Id !== 'string' || !IMAGE_ID_PATTERN.test(record.Id)) {
    fail(`${role} image has a malformed immutable ID.`);
  }
  const repoTags = requireArray(record.RepoTags, `${role} image RepoTags`);
  if (repoTags.filter((candidate) => candidate === tag).length !== 1) {
    fail(`${role} image does not own its exact runner tag.`);
  }
  return record.Id;
}

export function attestBuiltImages(imageInspectRecords, projectName) {
  requireProjectName(projectName);
  const records = requireArray(imageInspectRecords, 'image inspect records');
  if (records.length !== IMAGE_ROLES.length) {
    fail('exactly three runner image records are required.');
  }

  const tags = expectedTags(projectName);
  const imageIds = {};
  const usedRecords = new Set();
  for (const role of IMAGE_ROLES) {
    const matching = records.filter((record) =>
      Array.isArray(record?.RepoTags) && record.RepoTags.includes(tags[role]));
    if (matching.length !== 1) fail(`${role} must resolve to exactly one built image record.`);
    usedRecords.add(matching[0]);
    imageIds[role] = assertBuiltImageRecord(matching[0], tags[role], role);
  }
  if (usedRecords.size !== IMAGE_ROLES.length || new Set(Object.values(imageIds)).size !== IMAGE_ROLES.length) {
    fail('runner image roles must resolve to three distinct image records and IDs.');
  }
  for (const record of records) {
    const ownedTags = Object.values(tags).filter((tag) => record.RepoTags.includes(tag));
    if (ownedTags.length !== 1) fail('each image record must carry exactly one runner-owned tag.');
  }

  return freezeRecord({ projectName, tags: { ...tags }, imageIds });
}

function assertContainerLabels(container, projectName) {
  const labels = requireRecord(container.Config.Labels, 'container Compose labels');
  if (labels[PROJECT_LABEL] !== projectName) fail('container project label is not runner-owned.');
  const serviceName = labels[SERVICE_LABEL];
  if (!SERVICE_NAMES.includes(serviceName)) fail('container service label is unexpected.');
  if (labels[CONTAINER_NUMBER_LABEL] !== '1') fail(`${serviceName} is not the sole service replica.`);
  if (labels[ONEOFF_LABEL] !== 'False') fail(`${serviceName} is an unexpected one-off container.`);
  return serviceName;
}

function assertRunningState(serviceName, state, healthy) {
  requireRecord(state, `${serviceName} State`);
  if (
    state.Status !== 'running' ||
    state.Running !== true ||
    state.Paused !== false ||
    state.Restarting !== false ||
    state.OOMKilled !== false ||
    state.Dead !== false ||
    state.ExitCode !== 0 ||
    !Number.isSafeInteger(state.Pid) ||
    state.Pid <= 0 ||
    (state.Error !== undefined && state.Error !== '')
  ) {
    fail(`${serviceName} is not a clean running container.`);
  }
  if (healthy) {
    if (!isRecord(state.Health) || state.Health.Status !== 'healthy') {
      fail(`${serviceName} is not healthy.`);
    }
  } else if (state.Health !== undefined && state.Health !== null) {
    fail(`${serviceName} unexpectedly has a health contract.`);
  }
}

function assertRuntimeHardening(serviceName, container, contract) {
  const config = requireRecord(container.Config, `${serviceName} Config`);
  const hostConfig = requireRecord(container.HostConfig, `${serviceName} HostConfig`);

  if (hostConfig.ReadonlyRootfs !== true) fail(`${serviceName} root filesystem is writable.`);
  if (hostConfig.Privileged !== false) fail(`${serviceName} is privileged.`);
  if (!emptyCollection(hostConfig.CapAdd)) fail(`${serviceName} adds Linux capabilities.`);

  if (contract.hardenedUser) {
    if (config.User !== '1000:1000' || hostConfig.Init !== true) {
      fail(`${serviceName} is not using the exact non-root init contract.`);
    }
    if (JSON.stringify(hostConfig.CapDrop) !== JSON.stringify(['ALL'])) {
      fail(`${serviceName} does not drop every Linux capability.`);
    }
    if (
      !Array.isArray(hostConfig.SecurityOpt) ||
      hostConfig.SecurityOpt.length !== 1 ||
      !['no-new-privileges', 'no-new-privileges:true'].includes(hostConfig.SecurityOpt[0])
    ) {
      fail(`${serviceName} does not enforce no-new-privileges.`);
    }
  } else {
    if (config.User !== '') fail(`${serviceName} image user differs from the pinned database runtime.`);
    if (!emptyCollection(hostConfig.CapDrop) || !emptyCollection(hostConfig.SecurityOpt)) {
      fail(`${serviceName} has an unexpected capability or security-opt override.`);
    }
  }

  if (hostConfig.AutoRemove !== false || hostConfig.PublishAllPorts !== false) {
    fail(`${serviceName} enables an unexpected lifecycle or publication override.`);
  }
  const restartPolicy = requireRecord(hostConfig.RestartPolicy, `${serviceName} RestartPolicy`);
  if (restartPolicy.Name !== 'no' || restartPolicy.MaximumRetryCount !== 0) {
    fail(`${serviceName} has an unexpected restart policy.`);
  }
}

function assertHostIsolation(serviceName, hostConfig, expectedNetworkNames) {
  for (const field of EMPTY_HOST_COUPLING_FIELDS) assertEmptyHostField(hostConfig, field, serviceName);
  // Engine versions differ on whether the optional HostConfig.Mounts key is
  // emitted. Top-level container.Mounts is validated separately; if this
  // duplicate key is present it must still be empty.
  if (Object.hasOwn(hostConfig, 'Mounts') && !emptyCollection(hostConfig.Mounts)) {
    fail(`${serviceName} has forbidden host coupling in Mounts.`);
  }

  if (!expectedNetworkNames.includes(hostConfig.NetworkMode)) {
    fail(`${serviceName} has an unexpected primary network mode.`);
  }
  if (hostConfig.PidMode !== '' || hostConfig.UTSMode !== '' || hostConfig.UsernsMode !== '') {
    fail(`${serviceName} shares a forbidden host namespace.`);
  }
  if (!['', 'private'].includes(hostConfig.IpcMode)) fail(`${serviceName} has an unsafe IPC mode.`);
  if (!['', 'private'].includes(hostConfig.CgroupnsMode)) fail(`${serviceName} has an unsafe cgroup namespace.`);
  if (hostConfig.CgroupParent !== '') fail(`${serviceName} has an unexpected cgroup parent.`);
  if (!['', 'default'].includes(hostConfig.Isolation)) fail(`${serviceName} has an unexpected isolation mode.`);
  if (!['', 'runc'].includes(hostConfig.Runtime)) fail(`${serviceName} has an unexpected container runtime.`);

  const sysctls = hostConfig.Sysctls;
  if (sysctls !== null && sysctls !== undefined) {
    const record = requireRecord(sysctls, `${serviceName} Sysctls`);
    if (serviceName !== 'gateway' && Object.keys(record).length !== 0) {
      fail(`${serviceName} has unexpected runtime sysctls.`);
    }
    if (serviceName === 'gateway') {
      const allowed = new Set(['net.ipv4.ip_forward', 'net.ipv6.conf.all.forwarding']);
      for (const [name, value] of Object.entries(record)) {
        if (!allowed.has(name) || String(value) !== '0') {
          fail('gateway has an unsafe forwarding sysctl.');
        }
      }
    }
  }
}

function assertTmpfs(serviceName, hostConfig, mounts, expectedTmpfs) {
  const actual = hostConfig.Tmpfs === null || hostConfig.Tmpfs === undefined
    ? {}
    : requireRecord(hostConfig.Tmpfs, `${serviceName} Tmpfs`);
  assertExactKeys(actual, Object.keys(expectedTmpfs), `${serviceName} tmpfs targets`);
  for (const [target, expectedOptions] of Object.entries(expectedTmpfs)) {
    if (
      JSON.stringify(parseTmpfsOptions(actual[target], `${serviceName} tmpfs ${target}`)) !==
      JSON.stringify(parseTmpfsOptions(expectedOptions, `${serviceName} expected tmpfs ${target}`))
    ) {
      fail(`${serviceName} tmpfs options differ for ${target}.`);
    }
  }

  requireArray(mounts, `${serviceName} Mounts`);
  if (serviceName === 'gateway' && mounts.length !== 0) fail('gateway must have no runtime mounts.');
  if (mounts.length === 0) return;

  const destinations = [];
  for (const mount of mounts) {
    requireRecord(mount, `${serviceName} runtime mount`);
    if (mount.Type !== 'tmpfs' || mount.RW !== true || !Object.hasOwn(expectedTmpfs, mount.Destination)) {
      fail(`${serviceName} has a bind, persistent, read-only, or unexpected runtime mount.`);
    }
    if (mount.Source !== undefined && mount.Source !== '') {
      fail(`${serviceName} tmpfs unexpectedly has a host source.`);
    }
    destinations.push(mount.Destination);
  }
  if (new Set(destinations).size !== destinations.length) fail(`${serviceName} has duplicate tmpfs mounts.`);
  if (JSON.stringify(destinations.sort()) !== JSON.stringify(Object.keys(expectedTmpfs).sort())) {
    fail(`${serviceName} runtime tmpfs mounts are incomplete or excessive.`);
  }
}

function assertNoPublishedBindings(bindings, label) {
  if (bindings === null || bindings === undefined) return;
  const record = requireRecord(bindings, label);
  for (const value of Object.values(record)) {
    if (value !== null && (!Array.isArray(value) || value.length !== 0)) {
      fail(`${label} contains a host publication.`);
    }
  }
}

function assertGatewayBindings(bindings, label) {
  const record = requireRecord(bindings, label);
  assertExactKeys(record, Object.keys(GATEWAY_PORTS), label);
  for (const [target, hostPort] of Object.entries(GATEWAY_PORTS)) {
    const entries = requireArray(record[target], `${label} ${target}`);
    if (
      entries.length !== 1 ||
      !isRecord(entries[0]) ||
      entries[0].HostIp !== '127.0.0.1' ||
      entries[0].HostPort !== hostPort
    ) {
      fail(`${label} is not the exact IPv4-loopback binding for ${target}.`);
    }
  }
}

function assertPortBindings(serviceName, hostConfig, networkSettings) {
  const hostBindings = requireOwn(hostConfig, 'PortBindings', `${serviceName} HostConfig`);
  const runtimeBindings = requireOwn(networkSettings, 'Ports', `${serviceName} NetworkSettings`);
  if (serviceName === 'gateway') {
    assertGatewayBindings(hostBindings, 'gateway HostConfig.PortBindings');
    assertGatewayBindings(runtimeBindings, 'gateway NetworkSettings.Ports');
  } else {
    assertNoPublishedBindings(hostBindings, `${serviceName} HostConfig.PortBindings`);
    assertNoPublishedBindings(runtimeBindings, `${serviceName} NetworkSettings.Ports`);
  }
}

function assertNetworks(serviceName, networkSettings, projectName, logicalNames) {
  const networks = requireRecord(networkSettings.Networks, `${serviceName} NetworkSettings.Networks`);
  const expectedNames = logicalNames.map((name) => `${projectName}_${name}`).sort();
  assertExactKeys(networks, expectedNames, `${serviceName} runtime networks`);

  const result = {};
  for (const name of expectedNames) {
    const endpoint = requireRecord(networks[name], `${serviceName} network endpoint`);
    if (!OBJECT_ID_PATTERN.test(endpoint.NetworkID ?? '') || !OBJECT_ID_PATTERN.test(endpoint.EndpointID ?? '')) {
      fail(`${serviceName} has a malformed network identity.`);
    }
    if (isIP(endpoint.IPAddress) !== 4 || endpoint.IPAddress === '0.0.0.0' || endpoint.IPAddress.startsWith('127.')) {
      fail(`${serviceName} has a malformed bridge IPv4 address.`);
    }
    const aliases = requireArray(endpoint.Aliases, `${serviceName} network aliases`);
    if (aliases.some((alias) => typeof alias !== 'string')) {
      fail(`${serviceName} has a malformed network alias.`);
    }
    const reservedAliases = aliases.filter((alias) =>
      alias.toLowerCase().endsWith('.charitypilot-e2e.invalid'));
    if (name === `${projectName}_e2e` && serviceName !== 'gateway') {
      const expectedAlias = `${serviceName}.charitypilot-e2e.invalid`;
      if (
        reservedAliases.length !== 1 ||
        reservedAliases[0] !== expectedAlias ||
        aliases.filter((alias) => alias === expectedAlias).length !== 1
      ) {
        fail(`${serviceName} does not own its one exact fail-closed internal DNS alias.`);
      }
    } else if (reservedAliases.length !== 0) {
      fail(`${serviceName} has an unexpected reserved internal DNS alias.`);
    }
    result[name] = { networkId: endpoint.NetworkID, ipAddress: endpoint.IPAddress };
  }
  return result;
}

function assertNodeBaseEnvironment(environment, label) {
  if (
    environment.PATH !== NODE_PATH ||
    !/^22\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(environment.NODE_VERSION) ||
    !/^1\.22\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(environment.YARN_VERSION)
  ) {
    fail(`${label} base-image environment differs from the pinned Node runtime.`);
  }
}

function assertGatewayEnvironment(config) {
  const environment = parseEnvironment(config.Env, 'gateway Config.Env');
  assertExactKeys(environment, NODE_BASE_ENV_KEYS, 'gateway base-image environment');
  assertNodeBaseEnvironment(environment, 'gateway');
}

function assertApplicationRuntime(serviceName, config) {
  const environment = parseEnvironment(config.Env, `${serviceName} Config.Env`);
  const expectedCommand = serviceName === 'api' ? API_RUNTIME_COMMAND : WEB_RUNTIME_COMMAND;
  if (JSON.stringify(config.Cmd) !== JSON.stringify(expectedCommand)) {
    fail(`${serviceName} is not using the exact audited application command.`);
  }

  if (serviceName === 'api') {
    if (environment.NODE_ENV !== 'development') {
      fail('api NODE_ENV must remain development for the TypeScript E2E server.');
    }
    return;
  }

  assertExactKeys(
    environment,
    [...NODE_BASE_ENV_KEYS, ...Object.keys(WEB_RUNTIME_ENVIRONMENT)],
    'web production environment',
  );
  assertNodeBaseEnvironment(environment, 'web');
  for (const [name, value] of Object.entries(WEB_RUNTIME_ENVIRONMENT)) {
    if (environment[name] !== value) {
      fail('web production environment differs from the exact isolated E2E contract.');
    }
  }
}

function assertContainer(container, serviceName, builtAttestation) {
  const contract = SERVICE_CONTRACT[serviceName];
  const config = requireRecord(container.Config, `${serviceName} Config`);
  const hostConfig = requireRecord(container.HostConfig, `${serviceName} HostConfig`);
  const networkSettings = requireRecord(container.NetworkSettings, `${serviceName} NetworkSettings`);

  if (!OBJECT_ID_PATTERN.test(container.Id ?? '')) fail(`${serviceName} has a malformed container ID.`);
  if (container.Image !== builtAttestation.imageIds[contract.imageRole]) {
    fail(`${serviceName} is not running the attested image ID.`);
  }
  if (config.Image !== builtAttestation.tags[contract.imageRole]) {
    fail(`${serviceName} is not configured with the exact runner image tag.`);
  }

  assertRunningState(serviceName, container.State, contract.healthy);
  assertRuntimeHardening(serviceName, container, contract);
  const expectedNetworkNames = contract.networks.map((name) => `${builtAttestation.projectName}_${name}`);
  assertHostIsolation(serviceName, hostConfig, expectedNetworkNames);
  assertTmpfs(serviceName, hostConfig, container.Mounts, contract.tmpfs);
  assertPortBindings(serviceName, hostConfig, networkSettings);
  const networks = assertNetworks(
    serviceName,
    networkSettings,
    builtAttestation.projectName,
    contract.networks,
  );
  if (serviceName === 'gateway') assertGatewayEnvironment(config);
  if (serviceName === 'api' || serviceName === 'web') {
    assertApplicationRuntime(serviceName, config);
  }
  return networks;
}

export function attestRunningContainers(containerInspectRecords, builtAttestation) {
  const built = requireRecord(builtAttestation, 'built image attestation');
  requireProjectName(built.projectName);
  requireRecord(built.tags, 'built image tags');
  requireRecord(built.imageIds, 'built image IDs');
  assertExactKeys(built.tags, IMAGE_ROLES, 'built image tags');
  assertExactKeys(built.imageIds, IMAGE_ROLES, 'built image IDs');
  const expected = expectedTags(built.projectName);
  for (const role of IMAGE_ROLES) {
    if (built.tags[role] !== expected[role] || !IMAGE_ID_PATTERN.test(built.imageIds[role] ?? '')) {
      fail('built image attestation is malformed or not runner-owned.');
    }
  }
  if (new Set(Object.values(built.imageIds)).size !== IMAGE_ROLES.length) {
    fail('built image attestation does not contain three distinct image IDs.');
  }

  const records = requireArray(containerInspectRecords, 'container inspect records');
  if (records.length !== SERVICE_NAMES.length) fail('exactly four project containers are required.');

  const byService = new Map();
  for (const container of records) {
    requireRecord(container, 'container inspect record');
    requireRecord(container.Config, 'container Config');
    const serviceName = assertContainerLabels(container, built.projectName);
    if (byService.has(serviceName)) fail(`${serviceName} has more than one container.`);
    byService.set(serviceName, container);
  }
  if (SERVICE_NAMES.some((serviceName) => !byService.has(serviceName))) {
    fail('one or more required project services are missing.');
  }

  const containerIds = {};
  const networkEvidence = {};
  for (const serviceName of SERVICE_NAMES) {
    const container = byService.get(serviceName);
    containerIds[serviceName] = container.Id;
    networkEvidence[serviceName] = assertContainer(container, serviceName, built);
  }

  const e2eName = `${built.projectName}_e2e`;
  const edgeName = `${built.projectName}_edge`;
  const e2eIds = new Set(SERVICE_NAMES.map((name) => networkEvidence[name][e2eName].networkId));
  if (e2eIds.size !== 1) fail('services do not share one exact internal network identity.');
  const edgeId = networkEvidence.gateway[edgeName].networkId;
  if (edgeId === [...e2eIds][0]) fail('edge and internal networks share an impossible identity.');

  const e2eAddresses = SERVICE_NAMES.map((name) => networkEvidence[name][e2eName].ipAddress);
  if (new Set(e2eAddresses).size !== e2eAddresses.length) {
    fail('internal service IPv4 addresses are not unique.');
  }

  return freezeRecord({
    projectName: built.projectName,
    imageIds: { ...built.imageIds },
    containerIds,
    networkIds: { e2e: [...e2eIds][0], edge: edgeId },
  });
}

export const ISOLATED_E2E_RUNTIME_SERVICES = SERVICE_NAMES;
