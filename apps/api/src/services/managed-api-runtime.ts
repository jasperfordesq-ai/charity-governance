import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  readProtectedTlsMaterial,
  readBoundedRegularDescriptor,
} from '../../../../packages/shared/runtime/protected-tls-material.mjs';
import {
  createManagedApiPeerBinding,
  createManagedApiPeerServer,
} from './managed-api-peer-transport.js';
import type { FastifyServerOptions } from 'fastify';

type Environment = Record<string, string | undefined>;
type ImagePin = { format: 1; sourceSha: string; bindingSha256: string };
const pinPath = '/opt/charitypilot/managed-api-build.json';
const selectors = [
  'CHARITYPILOT_MANAGED_API_PEER_BINDING',
  'CHARITYPILOT_MANAGED_API_TLS_DIRECTORY',
];
const snapshotKeys = [
  'NODE_ENV',
  'PORT',
  'CHARITYPILOT_MANAGED_PROVIDER',
  ...selectors,
  'CHARITYPILOT_BUILD_COMMIT',
  'CHARITYPILOT_DEPLOYMENT_MODE',
  'CHARITYPILOT_E2E_MODE',
  'RENDER_SERVICE_TYPE',
  'RENDER_SERVICE_ID',
  'FRONTEND_URL',
  'NEXT_PUBLIC_API_URL',
  'CHARITYPILOT_CANONICAL_WEB_ORIGIN',
  'CHARITYPILOT_CANONICAL_API_ORIGIN',
  'TRUSTED_PROXY_ADDRESSES',
];
const snapshot = (env: Environment) =>
  JSON.stringify(snapshotKeys.map((key) => [key, env[key] ?? null]));
const contexts = new WeakMap<
  object,
  Readonly<{ publicOrigin: string; snapshot: string }>
>();
const refused = () => new Error('Managed API runtime refused');

export function parseManagedApiImagePin(raw: string): ImagePin {
  try {
    if (Buffer.byteLength(raw) > 512) throw refused();
    const value = JSON.parse(raw);
    const pin = {
      format: 1 as const,
      sourceSha: value.sourceSha,
      bindingSha256: value.bindingSha256,
    };
    if (
      value.format !== 1 ||
      typeof pin.sourceSha !== 'string' ||
      !/^[a-f0-9]{40}$/.test(pin.sourceSha) ||
      typeof pin.bindingSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(pin.bindingSha256) ||
      JSON.stringify(pin) + '\n' !== raw
    )
      throw refused();
    return pin;
  } catch {
    throw refused();
  }
}

export function readManagedApiTlsMaterial(directory: string) {
  try {
    const files = readProtectedTlsMaterial(directory, [
      'issuer.pem',
      'server.pem',
      'server.key',
    ] as const);
    return {
      issuerCertPem: files['issuer.pem'],
      serverCertPem: files['server.pem'],
      serverKeyPem: files['server.key'],
    };
  } catch {
    throw refused();
  }
}

function imagePin() {
  if (
    process.platform !== 'linux' ||
    process.getuid!() === 0 ||
    realpathSync(pinPath) !== pinPath
  )
    throw refused();
  const parent = lstatSync(dirname(pinPath));
  if (!parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o022) !== 0)
    throw refused();
  const fd = openSync(
    pinPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const file = fstatSync(fd);
    if (file.uid !== 0 || (file.mode & 0o777) !== 0o444) throw refused();
    return parseManagedApiImagePin(readBoundedRegularDescriptor(fd, 512));
  } finally {
    closeSync(fd);
  }
}

/** Source-level configuration bridge for a trusted image pin and protected
 * material. Runtime entry calls this only after reading the fixed image path;
 * the pin is never accepted from an environment hash or a request. */
export function createConfiguredManagedApiServer(
  env: Environment,
  pin: ImagePin,
  material: ReturnType<typeof readManagedApiTlsMaterial>,
  logger: FastifyServerOptions['logger'] = false,
) {
  try {
    const binding = createManagedApiPeerBinding(
      JSON.parse(env.CHARITYPILOT_MANAGED_API_PEER_BINDING ?? ''),
    );
    for (const key of [
      'FRONTEND_URL',
      'NEXT_PUBLIC_API_URL',
      'CHARITYPILOT_CANONICAL_WEB_ORIGIN',
      'CHARITYPILOT_CANONICAL_API_ORIGIN',
    ]) {
      if (env[key] !== binding.record.publicOrigin) throw refused();
    }
    if (env.TRUSTED_PROXY_ADDRESSES) throw refused();
    const app = createManagedApiPeerServer(
      {
        recordJson: env.CHARITYPILOT_MANAGED_API_PEER_BINDING!,
        build: pin,
        runtime: {
          nodeEnv: env.NODE_ENV ?? '',
          provider: env.CHARITYPILOT_MANAGED_PROVIDER ?? '',
          deploymentMode: env.CHARITYPILOT_DEPLOYMENT_MODE ?? 'production',
          serviceType: env.RENDER_SERVICE_TYPE ?? '',
          serviceId: env.RENDER_SERVICE_ID ?? '',
          sourceSha: env.CHARITYPILOT_BUILD_COMMIT ?? '',
          port: env.PORT ?? '',
          e2eMode: env.CHARITYPILOT_E2E_MODE,
        },
        ...material,
      },
      logger,
    );
    contexts.set(
      app,
      Object.freeze({
        publicOrigin: binding.record.publicOrigin,
        snapshot: snapshot(env),
      }),
    );
    return app;
  } catch {
    throw refused();
  }
}

export function managedApiRuntimePolicy(
  server: unknown,
  env: Environment = process.env,
) {
  if (!server || typeof server !== 'object') return undefined;
  const policy = contexts.get(server);
  return policy && policy.snapshot === snapshot(env) ? policy : undefined;
}

export function hasManagedApiRuntimeSettings(env: Environment = process.env) {
  return (
    env.CHARITYPILOT_MANAGED_PROVIDER !== undefined ||
    selectors.some((key) => env[key] !== undefined)
  );
}

export function loadManagedApiRuntime(
  env: Environment = process.env,
  logger: FastifyServerOptions['logger'] = false,
) {
  if (!hasManagedApiRuntimeSettings(env)) return null;
  try {
    const pin = imagePin();
    const material = readManagedApiTlsMaterial(
      env.CHARITYPILOT_MANAGED_API_TLS_DIRECTORY ?? '',
    );
    return createConfiguredManagedApiServer(env, pin, material, logger);
  } catch {
    throw refused();
  }
}
