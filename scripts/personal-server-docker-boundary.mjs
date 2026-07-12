const WINDOWS_LOCAL_DOCKER_ENDPOINTS = new Set([
  'npipe:////./pipe/dockerdesktoplinuxengine',
  'npipe:////./pipe/docker_engine',
]);
const LINUX_LOCAL_DOCKER_ENDPOINTS = new Set([
  'unix:///var/run/docker.sock',
]);

const DANGEROUS_DOCKER_CONTROLS = new Set([
  'DOCKER_HOST', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH',
  'DOCKER_API_VERSION', 'DOCKER_BUILDKIT', 'DOCKER_DEFAULT_PLATFORM',
  'DOCKER_CONFIG',
]);

function dangerousDockerOverrides(environment = {}) {
  return Object.entries(environment).filter(([name, value]) => {
    const normalized = name.toUpperCase();
    return (
      DANGEROUS_DOCKER_CONTROLS.has(normalized) ||
      normalized.startsWith('BUILDKIT_') ||
      normalized.startsWith('BUILDX_')
    ) && String(value ?? '').trim();
  });
}

function localDockerError(platform) {
  return platform === 'linux'
    ? 'Personal-server lifecycle requires the local Linux Docker Engine Unix socket with Engine API 1.48 or later and no remote-daemon overrides'
    : 'Personal-server lifecycle requires the local Windows Docker Desktop Linux named pipe with Engine API 1.48 or later and no remote-daemon overrides';
}

export function validateLocalDockerEndpoint({
  endpoint,
  skipTlsVerify,
  platform = process.platform,
}, environment = {}) {
  const normalizedEndpoint = String(endpoint ?? '').trim().toLowerCase();
  const allowedEndpoints = platform === 'win32'
    ? WINDOWS_LOCAL_DOCKER_ENDPOINTS
    : platform === 'linux'
      ? LINUX_LOCAL_DOCKER_ENDPOINTS
      : new Set();
  if (
    dangerousDockerOverrides(environment).length ||
    !allowedEndpoints.has(normalizedEndpoint) ||
    String(skipTlsVerify).trim().toLowerCase() !== 'false'
  ) {
    throw new Error(localDockerError(platform));
  }
  return true;
}

export function validateLocalDockerRuntime({
  endpoint,
  skipTlsVerify,
  operatingSystem,
  serverOs,
  apiVersion,
  platform = process.platform,
}, environment = {}) {
  validateLocalDockerEndpoint({ endpoint, skipTlsVerify, platform }, environment);
  const apiMatch = /^(\d+)\.(\d+)$/u.exec(String(apiVersion ?? '').trim());
  const apiSupported = apiMatch && (
    Number(apiMatch[1]) > 1 || (Number(apiMatch[1]) === 1 && Number(apiMatch[2]) >= 48)
  );
  const runtimeIdentityValid = platform === 'win32'
    ? /docker desktop/iu.test(String(operatingSystem ?? ''))
    : platform === 'linux' && String(operatingSystem ?? '').trim().length > 0;
  if (
    !runtimeIdentityValid ||
    String(serverOs ?? '').trim().toLowerCase() !== 'linux' ||
    !apiSupported
  ) {
    throw new Error(localDockerError(platform));
  }
  return true;
}

export function composeSafeEnvironment(environment = {}) {
  const safe = { ...environment };
  for (const name of Object.keys(safe)) {
    if (name.toUpperCase().startsWith('COMPOSE_')) delete safe[name];
  }
  return safe;
}

export function pinnedLocalDockerEnvironment(environment = {}, endpoint) {
  const safe = { ...environment };
  const controls = new Set([
    'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH', 'DOCKER_API_VERSION', 'DOCKER_BUILDKIT',
    'DOCKER_DEFAULT_PLATFORM', 'DOCKER_CONFIG',
  ]);
  for (const name of Object.keys(safe)) {
    const normalized = name.toUpperCase();
    if (
      controls.has(normalized) || normalized.startsWith('BUILDKIT_') ||
      normalized.startsWith('BUILDX_')
    ) delete safe[name];
  }
  safe.DOCKER_HOST = String(endpoint);
  return safe;
}

export function validateLocalDockerDesktopEndpoint({
  endpoint,
  skipTlsVerify,
}, environment = {}) {
  return validateLocalDockerEndpoint({ endpoint, skipTlsVerify, platform: 'win32' }, environment);
}

export function validateLocalDockerDesktopRuntime({
  endpoint,
  skipTlsVerify,
  operatingSystem,
  serverOs,
  apiVersion,
}, environment = {}) {
  return validateLocalDockerRuntime({
    endpoint,
    skipTlsVerify,
    operatingSystem,
    serverOs,
    apiVersion,
    platform: 'win32',
  }, environment);
}
