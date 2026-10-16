import { createHash } from 'node:crypto';
const fields = [
  'format',
  'provider',
  'region',
  'installationId',
  'ownerId',
  'environmentId',
  'sourceSha',
  'publicOrigin',
  'gatewayServiceId',
  'webServiceId',
  'apiServiceId',
  'schedulerServiceId',
  'apiServiceName',
  'apiOrigin',
  'webServiceName',
  'webOrigin',
  'issuerCertSha256',
  'apiCertSha256',
  'webCertSha256',
  'gatewayClientCertSha256',
  'webClientCertSha256',
];
const refused = () => new Error('Managed service mesh binding refused');
function address(origin, name, role, port) {
  if (
    typeof origin !== 'string' ||
    origin.length > 256 ||
    typeof name !== 'string' ||
    !new RegExp(`^charitypilot(?:-[a-z0-9]+)*-${role}$`).test(name)
  )
    throw refused();
  const url = new URL(origin),
    prefix = name + '-';
  if (
    url.protocol !== 'https:' ||
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.port !== String(port) ||
    url.hostname.length > 63 ||
    !url.hostname.startsWith(prefix) ||
    !/^[a-z0-9]{4,20}$/.test(url.hostname.slice(prefix.length)) ||
    url.hostname.endsWith('-discovery')
  )
    throw refused();
}
export function createManagedServiceMeshBinding(raw) {
  try {
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      Object.keys(raw).sort().join('|') !== [...fields].sort().join('|')
    )
      throw refused();
    const r = Object.fromEntries(fields.map((key) => [key, raw[key]]));
    if (r.format !== 2 || r.provider !== 'render' || r.region !== 'frankfurt')
      throw refused();
    const string = (key, pattern) => {
      if (typeof r[key] !== 'string' || !pattern.test(r[key])) throw refused();
    };
    string('installationId', /^[A-Za-z0-9_-]{1,120}$/);
    string('ownerId', /^[a-z][a-z0-9-]{1,99}$/);
    string('environmentId', /^[a-z][a-z0-9-]{1,99}$/);
    string('sourceSha', /^[a-f0-9]{40}$/);
    string('publicOrigin', /^.{1,512}$/);
    const front = new URL(r.publicOrigin);
    if (
      front.protocol !== 'https:' ||
      front.origin !== r.publicOrigin ||
      front.username ||
      front.password ||
      front.port ||
      !front.hostname.includes('.') ||
      !/^[a-z0-9.-]+$/.test(front.hostname) ||
      /^[\d.]+$/.test(front.hostname)
    )
      throw refused();
    const ids = [
      'gatewayServiceId',
      'webServiceId',
      'apiServiceId',
      'schedulerServiceId',
    ];
    for (const key of ids) string(key, /^srv-[a-z0-9]{20}$/);
    const fingerprints = [
      'issuerCertSha256',
      'apiCertSha256',
      'webCertSha256',
      'gatewayClientCertSha256',
      'webClientCertSha256',
    ];
    for (const key of fingerprints) string(key, /^[a-f0-9]{64}$/);
    if (
      new Set(ids.map((key) => r[key])).size !== 4 ||
      new Set(fingerprints.map((key) => r[key])).size !== 5
    )
      throw refused();
    address(r.apiOrigin, r.apiServiceName, 'api', 3002);
    address(r.webOrigin, r.webServiceName, 'web', 3003);
    const json = JSON.stringify(r);
    return {
      record: Object.freeze(r),
      json,
      sha256: createHash('sha256')
        .update('CHARITYPILOT_MANAGED_SERVICE_MESH_V2\n' + json)
        .digest('hex'),
    };
  } catch {
    throw refused();
  }
}
