const LOCAL_DOCKER_ENDPOINTS = new Set([
  'npipe:////./pipe/dockerdesktoplinuxengine',
  'npipe:////./pipe/docker_engine',
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
  if (
    dangerousDockerOverrides(environment).length ||
    !LOCAL_DOCKER_ENDPOINTS.has(String(endpoint ?? '').trim().toLowerCase()) ||
    String(skipTlsVerify).trim().toLowerCase() !== 'false'
  ) {
    throw new Error('Personal-server lifecycle requires the local Windows Docker Desktop Linux named pipe with Engine API 1.48 or later and no remote-daemon overrides');
  }
  return true;
}

export function validateLocalDockerDesktopRuntime({
  endpoint,
  skipTlsVerify,
  operatingSystem,
  serverOs,
  apiVersion,
}, environment = {}) {
  validateLocalDockerDesktopEndpoint({ endpoint, skipTlsVerify }, environment);
  const apiMatch = /^(\d+)\.(\d+)$/u.exec(String(apiVersion ?? '').trim());
  const apiSupported = apiMatch && (
    Number(apiMatch[1]) > 1 || (Number(apiMatch[1]) === 1 && Number(apiMatch[2]) >= 48)
  );
  if (
    !/docker desktop/iu.test(String(operatingSystem ?? '')) ||
    String(serverOs ?? '').trim().toLowerCase() !== 'linux' ||
    !apiSupported
  ) {
    throw new Error('Personal-server lifecycle requires the local Windows Docker Desktop Linux named pipe with Engine API 1.48 or later and no remote-daemon overrides');
  }
  return true;
}
