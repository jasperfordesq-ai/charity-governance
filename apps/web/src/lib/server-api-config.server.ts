import { createHash } from 'node:crypto';
import {
  getApiBaseUrl,
  getServerApiBaseUrl as legacyServerApiBaseUrl,
  type ApiEnv,
} from './api-config';

const refusal =
  'Managed web API binding is unavailable or does not match this deployment';
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
];
export type ManagedPublicBuild = {
  apiOrigin?: string;
  canonicalApiOrigin?: string;
  deploymentMode?: string;
  bindingSha256?: string;
};
export type ManagedServerEnv = ApiEnv & {
  CHARITYPILOT_BUILD_COMMIT?: string;
  CHARITYPILOT_DEPLOYMENT_MODE?: string;
  RENDER_SERVICE_ID?: string;
  RENDER_SERVICE_TYPE?: string;
};

function parseRecord(raw: unknown) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join('|') !== [...fields].sort().join('|')
  )
    throw new Error();
  const value = raw as Record<string, unknown>;
  const string = (key: string, pattern: RegExp) => {
    const v = value[key];
    if (typeof v !== 'string' || !pattern.test(v)) throw new Error();
    return v;
  };
  if (
    value.format !== 1 ||
    value.provider !== 'render' ||
    value.region !== 'frankfurt'
  )
    throw new Error();
  const id = /^srv-[a-z0-9]{20}$/;
  const record = {
    format: 1,
    provider: 'render',
    region: 'frankfurt',
    installationId: string('installationId', /^[A-Za-z0-9_-]{1,120}$/),
    ownerId: string('ownerId', /^[a-z][a-z0-9-]{1,99}$/),
    environmentId: string('environmentId', /^[a-z][a-z0-9-]{1,99}$/),
    sourceSha: string('sourceSha', /^[a-f0-9]{40}$/),
    publicOrigin: string('publicOrigin', /^.{1,512}$/),
    gatewayServiceId: string('gatewayServiceId', id),
    webServiceId: string('webServiceId', id),
    apiServiceId: string('apiServiceId', id),
    schedulerServiceId: string('schedulerServiceId', id),
    apiServiceName: string(
      'apiServiceName',
      /^charitypilot(?:-[a-z0-9]+)*-api$/,
    ),
    apiOrigin: string('apiOrigin', /^.{1,256}$/),
  };
  if (
    new Set([
      record.gatewayServiceId,
      record.webServiceId,
      record.apiServiceId,
      record.schedulerServiceId,
    ]).size !== 4
  )
    throw new Error();
  const front = new URL(record.publicOrigin),
    api = new URL(record.apiOrigin);
  if (
    front.protocol !== 'https:' ||
    front.origin !== record.publicOrigin ||
    front.username ||
    front.password ||
    front.port ||
    !front.hostname.includes('.') ||
    /^[\d.]+$/.test(front.hostname) ||
    front.hostname === 'localhost'
  )
    throw new Error();
  const prefix = record.apiServiceName + '-';
  if (
    api.protocol !== 'http:' ||
    api.origin !== record.apiOrigin ||
    api.username ||
    api.password ||
    api.port !== '3002' ||
    api.hostname.length > 63 ||
    !api.hostname.startsWith(prefix) ||
    !/^[a-z0-9]{4,20}$/.test(api.hostname.slice(prefix.length)) ||
    api.hostname.endsWith('-discovery')
  )
    throw new Error();
  return record;
}

/** Preparation helper for a trusted deployment controller, not provider attestation.
 * Contains no secret. The fingerprint is baked into the web image; publish only
 * that fingerprint to NEXT_PUBLIC, never this internal registry JSON. */
export function createManagedWebApiBinding(raw: unknown) {
  try {
    const record = parseRecord(raw),
      json = JSON.stringify(record);
    return {
      record,
      json,
      sha256: createHash('sha256').update(json).digest('hex'),
    };
  } catch {
    throw new Error(refusal);
  }
}

export function hasManagedWebApiSettings(
  env: ManagedServerEnv,
  built?: ManagedPublicBuild,
) {
  return (
    env.CHARITYPILOT_MANAGED_PROVIDER !== undefined ||
    env.CHARITYPILOT_MANAGED_WEB_BINDING !== undefined ||
    Boolean(env.NEXT_PUBLIC_CHARITYPILOT_MANAGED_WEB_BINDING_SHA256) ||
    Boolean(built?.bindingSha256)
  );
}

/** Node-server boundary, imported only by proxy.ts. A build-pinned record proves
 * configuration consistency, not DNS ownership, source provenance, network peer
 * authentication, provider custody, caller permission or application readiness. */
export function getManagedWebApiContext(
  env: ManagedServerEnv = process.env,
  built?: ManagedPublicBuild,
) {
  if (!hasManagedWebApiSettings(env, built)) return null;
  try {
    if (
      env.NODE_ENV !== 'production' ||
      env.NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE !== 'public-production' ||
      env.NEXT_PUBLIC_CHARITYPILOT_E2E_MODE ||
      env.CHARITYPILOT_MANAGED_PROVIDER !== 'render' ||
      (env.CHARITYPILOT_DEPLOYMENT_MODE &&
        env.CHARITYPILOT_DEPLOYMENT_MODE !== 'production') ||
      !built ||
      built.deploymentMode !== 'public-production' ||
      !built.bindingSha256 ||
      !/^[a-f0-9]{64}$/.test(built.bindingSha256)
    )
      throw new Error();
    const raw = env.CHARITYPILOT_MANAGED_WEB_BINDING;
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4096)
      throw new Error();
    const binding = createManagedWebApiBinding(JSON.parse(raw)),
      record = binding.record;
    if (
      binding.json !== raw ||
      binding.sha256 !== built.bindingSha256 ||
      env.NEXT_PUBLIC_CHARITYPILOT_MANAGED_WEB_BINDING_SHA256 !==
        built.bindingSha256 ||
      env.RENDER_SERVICE_ID !== record.webServiceId ||
      env.RENDER_SERVICE_TYPE !== 'pserv' ||
      env.CHARITYPILOT_BUILD_COMMIT !== record.sourceSha ||
      env.CHARITYPILOT_INTERNAL_API_URL !== record.apiOrigin ||
      env.NEXT_PUBLIC_API_URL !== record.publicOrigin ||
      env.NEXT_PUBLIC_CHARITYPILOT_CANONICAL_API_ORIGIN !==
        record.publicOrigin ||
      built.apiOrigin !== record.publicOrigin ||
      built.canonicalApiOrigin !== record.publicOrigin ||
      getApiBaseUrl(env) !== record.publicOrigin
    )
      throw new Error();
    return record;
  } catch {
    throw new Error(refusal);
  }
}

export function getServerApiBaseUrl(
  env: ManagedServerEnv = process.env,
  built?: ManagedPublicBuild,
) {
  return (
    getManagedWebApiContext(env, built)?.apiOrigin ??
    legacyServerApiBaseUrl(env)
  );
}
