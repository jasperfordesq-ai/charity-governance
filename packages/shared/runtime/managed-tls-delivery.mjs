import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createManagedServiceMeshBinding } from './managed-service-mesh.mjs';
import { readManagedServiceImagePin } from './managed-service-image-pin.mjs';
import {
  readBoundedRegularDescriptor,
  readProtectedTlsMaterial,
} from './protected-tls-material.mjs';
import { validateManagedTlsIdentity } from './managed-tls-identity.mjs';
const refused = () => new Error('Managed TLS delivery refused');
const services = {
  gateway: {
    binding: 'CHARITYPILOT_MANAGED_GATEWAY_BINDING',
    id: 'gatewayServiceId',
    type: 'web',
    port: '10000',
    client: 'gatewayClientCertSha256',
    clientDirectory: 'CHARITYPILOT_MANAGED_GATEWAY_TLS_DIRECTORY',
  },
  api: {
    binding: 'CHARITYPILOT_MANAGED_API_PEER_BINDING',
    id: 'apiServiceId',
    type: 'pserv',
    port: '3002',
    server: 'apiCertSha256',
    origin: 'apiOrigin',
    serverDirectory: 'CHARITYPILOT_MANAGED_API_TLS_DIRECTORY',
  },
  web: {
    binding: 'CHARITYPILOT_MANAGED_WEB_BINDING',
    id: 'webServiceId',
    type: 'pserv',
    port: '3003',
    server: 'webCertSha256',
    origin: 'webOrigin',
    client: 'webClientCertSha256',
    serverDirectory: 'CHARITYPILOT_MANAGED_WEB_TLS_DIRECTORY',
    clientDirectory: 'CHARITYPILOT_MANAGED_WEB_API_TLS_DIRECTORY',
  },
};
export function prepareManagedTlsBundle(raw, service, record) {
  try {
    const config = services[service];
    if (
      !Object.hasOwn(services, service) ||
      !config ||
      typeof raw !== 'string' ||
      Buffer.byteLength(raw) > 98304
    )
      throw refused();
    const binding = createManagedServiceMeshBinding(record),
      value = JSON.parse(raw);
    const expected = {
      format: 1,
      service,
      meshSha256: binding.sha256,
      issuerCertPem: value.issuerCertPem,
    };
    if (config.server)
      Object.assign(expected, {
        serverCertPem: value.serverCertPem,
        serverKeyPem: value.serverKeyPem,
      });
    if (config.client)
      Object.assign(expected, {
        clientCertPem: value.clientCertPem,
        clientKeyPem: value.clientKeyPem,
      });
    if (JSON.stringify(expected) + '\n' !== raw) throw refused();
    const material = {};
    if (config.server) {
      material.server = {
        issuerCertPem: value.issuerCertPem,
        certPem: value.serverCertPem,
        keyPem: value.serverKeyPem,
      };
      validateManagedTlsIdentity(
        material.server,
        record.issuerCertSha256,
        record[config.server],
        'server',
        new URL(record[config.origin]).hostname,
      );
    }
    if (config.client) {
      material.client = {
        issuerCertPem: value.issuerCertPem,
        certPem: value.clientCertPem,
        keyPem: value.clientKeyPem,
      };
      validateManagedTlsIdentity(
        material.client,
        record.issuerCertSha256,
        record[config.client],
        'client',
      );
    }
    return material;
  } catch {
    throw refused();
  }
}
function readProviderBundle(service) {
  const directory = '/etc/secrets',
    file = 'charitypilot-' + service + '-tls.json';
  let fd, rootFd;
  try {
    if (realpathSync(directory) !== directory) throw refused();
    const root = lstatSync(directory);
    if (!root.isDirectory() || root.uid !== 0 || (root.mode & 0o022) !== 0)
      throw refused();
    rootFd = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const opened = fstatSync(rootFd);
    if (opened.dev !== root.dev || opened.ino !== root.ino) throw refused();
    fd = openSync(
      '/proc/self/fd/' + rootFd + '/' + file,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    const stat = fstatSync(fd);
    if (
      stat.uid !== 0 ||
      stat.gid !== 1000 ||
      process.getgid() !== 1000 ||
      (stat.mode & 0o777) !== 0o440
    )
      throw refused();
    return readBoundedRegularDescriptor(fd, 98304);
  } catch {
    throw refused();
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (rootFd !== undefined) closeSync(rootFd);
  }
}
/** Optional startup conversion only. Does not issue, upload, rotate or revoke keys. */
export function stageManagedTlsDelivery(
  service,
  env = process.env,
  gatewayBuild,
) {
  if (env.CHARITYPILOT_MANAGED_TLS_DELIVERY === undefined) return null;
  let root, cleanup;
  try {
    if (
      !Object.hasOwn(services, service) ||
      process.platform !== 'linux' ||
      process.getuid() === 0 ||
      env.CHARITYPILOT_MANAGED_TLS_DELIVERY !== 'render-secret-file-v1'
    )
      throw refused();
    const config = services[service];
    for (const name of [config.serverDirectory, config.clientDirectory])
      if (name && env[name] !== undefined) throw refused();
    const pin =
      service === 'gateway'
        ? gatewayBuild
        : readManagedServiceImagePin(service, true);
    const binding = createManagedServiceMeshBinding(
        JSON.parse(env[config.binding] ?? ''),
      ),
      record = binding.record;
    if (
      !pin ||
      binding.json !== env[config.binding] ||
      pin.sourceSha !== record.sourceSha ||
      pin.bindingSha256 !== binding.sha256 ||
      env.CHARITYPILOT_BUILD_COMMIT !== record.sourceSha ||
      env.NODE_ENV !== 'production' ||
      env.CHARITYPILOT_MANAGED_PROVIDER !== 'render' ||
      env.RENDER_SERVICE_TYPE !== config.type ||
      env.RENDER_SERVICE_ID !== record[config.id] ||
      env.PORT !== config.port
    )
      throw refused();
    const material = prepareManagedTlsBundle(
      readProviderBundle(service),
      service,
      record,
    );
    root = mkdtempSync('/tmp/charitypilot-managed-tls-');
    const rootIdentity = lstatSync(root),
      files = [],
      directories = [];
    const same = (path, identity) => {
      try {
        const stat = lstatSync(path);
        return (
          stat.dev === identity.dev &&
          stat.ino === identity.ino &&
          stat.uid === process.getuid()
        );
      } catch {
        return false;
      }
    };
    cleanup = () => {
      process.removeListener('exit', cleanup);
      if (!same(root, rootIdentity)) return;
      for (const [path, identity] of files) {
        if (same(path, identity))
          try {
            unlinkSync(path);
          } catch {}
      }
      for (const [path, identity] of directories.reverse()) {
        if (same(path, identity))
          try {
            rmdirSync(path);
          } catch {}
      }
      try {
        rmdirSync(root);
      } catch {}
    };
    process.once('exit', cleanup);
    const environment = {};
    for (const [role, identity] of Object.entries(material)) {
      const directory = join(root, role);
      mkdirSync(directory, { mode: 0o700 });
      directories.push([directory, lstatSync(directory)]);
      const names =
        role === 'server'
          ? ['issuer.pem', 'server.pem', 'server.key']
          : ['issuer.pem', 'client.pem', 'client.key'];
      for (const [index, bytes] of [
        identity.issuerCertPem,
        identity.certPem,
        identity.keyPem,
      ].entries()) {
        const path = join(directory, names[index]),
          fd = openSync(
            path,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            0o400,
          );
        files.push([path, fstatSync(fd)]);
        try {
          writeFileSync(fd, bytes, { encoding: 'utf8' });
        } finally {
          closeSync(fd);
        }
      }
      readProtectedTlsMaterial(directory, names);
      environment[
        role === 'server' ? config.serverDirectory : config.clientDirectory
      ] = directory;
    }
    Object.assign(env, environment);
    return { directories: Object.freeze(environment), cleanup };
  } catch {
    cleanup?.();
    throw refused();
  }
}
