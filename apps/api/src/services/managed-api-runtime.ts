import {
  readManagedServiceImagePin,
  parseManagedServiceImagePin,
} from '../../../../packages/shared/runtime/managed-service-image-pin.mjs';
import { readProtectedTlsMaterial } from '../../../../packages/shared/runtime/protected-tls-material.mjs';
import {
  createManagedApiPeerBinding,
  createManagedApiPeerServer,
} from './managed-api-peer-transport.js';
import type { FastifyServerOptions } from 'fastify';

type Environment = Record<string, string | undefined>;
type ImagePin = { format: 1; sourceSha: string; bindingSha256: string };
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
    return parseManagedServiceImagePin(raw, true)!;
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
  try {
    const pin = readManagedServiceImagePin(
      'api',
      hasManagedApiRuntimeSettings(env),
    );
    if (!pin) return null;
    const material = readManagedApiTlsMaterial(
      env.CHARITYPILOT_MANAGED_API_TLS_DIRECTORY ?? '',
    );
    return createConfiguredManagedApiServer(env, pin, material, logger);
  } catch {
    throw refused();
  }
}
