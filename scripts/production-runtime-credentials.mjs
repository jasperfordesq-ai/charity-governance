import { isIP } from 'node:net';
import { createHash, X509Certificate } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { toStrictPrismaTlsUrl } from '../packages/shared/runtime/prisma-database-url.mjs';

/** SECRET environment for explicit Prisma CLI consumers only. Keep the original
 * bound environment for libpq backups/restores and non-Prisma operations.
 */
export function productionPrismaMaintenanceEnvironment(environment) {
  return { ...environment, DATABASE_URL:toStrictPrismaTlsUrl(environment.DATABASE_URL) };
}

const refusal = 'Production database credentials must use distinct roles for the same verified-TLS database.';
const allowedOptions = new Set(['sslmode', 'sslrootcert', 'target_session_attrs', 'connect_timeout', 'application_name']);
const controls = /[\x00-\x1f\x7f]/u;

function connection(raw) {
  if (typeof raw !== 'string' || raw.length > 4096 || raw !== raw.trim() || controls.test(raw)) throw new Error();
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || raw.includes('#')) throw new Error();
  // WHATWG's special-host parser also resolves numeric/octal/short IPv4 forms;
  // checking only the literal PostgreSQL hostname misses loopback spellings.
  const hostname = new URL(`https://${url.host}`).hostname.toLowerCase();
  const address = hostname.replace(/^\[|\]$/g, '');
  if (!hostname || hostname.endsWith('.') || hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname === 'localhost.localdomain' || /^127\./u.test(address)
    || address === '0.0.0.0' || address === '::' || address === '::1'
    || /^::ffff:(?:127\.|7f[0-9a-f]{2}:)/u.test(address)
    || (!isIP(address) && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(hostname))) throw new Error();
  const port = String(Number(url.port || '5432'));
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error();
  const database = decodeURIComponent(url.pathname.slice(1));
  const role = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
  if (!database || /[/\\\s]/u.test(database) || controls.test(database)
    || !role || controls.test(role) || !password || password.length > 1024 || controls.test(password)) throw new Error();
  const seen = new Set();
  for (const [name] of url.searchParams) {
    if (!allowedOptions.has(name) || seen.has(name)) throw new Error();
    seen.add(name);
  }
  if (url.searchParams.get('sslmode') !== 'verify-full'
    || url.searchParams.get('target_session_attrs') !== 'read-write') throw new Error();
  const ca = url.searchParams.get('sslrootcert') ?? 'system';
  if (ca.length > 2048 || controls.test(ca) || ca.includes('%')
    || (ca !== 'system' && !/^(?:\/|[A-Za-z]:[\\/])/u.test(ca))) throw new Error();
  const timeout = url.searchParams.get('connect_timeout');
  if (timeout !== null && (!/^[1-9][0-9]?$/u.test(timeout) || Number(timeout) > 30)) throw new Error();
  const application = url.searchParams.get('application_name');
  if (application !== null && !/^[A-Za-z0-9_.-]{1,63}$/u.test(application)) throw new Error();
  return { hostname, port, database, role, password, ca };
}

/** Input identity boundary only. Distinct credentials do not prove a restricted
 * database role, an actual TLS connection or protected environment transport.
 * Deployment integration and live catalogue/password proof remain separate.
 */
export function validateProductionRuntimeDatabasePair(maintenanceUrl, runtimeUrl) {
  try {
    const owner = connection(maintenanceUrl), runtime = connection(runtimeUrl);
    if (owner.hostname !== runtime.hostname || owner.port !== runtime.port || owner.database !== runtime.database
      || owner.ca !== runtime.ca || owner.role === runtime.role || owner.password === runtime.password
      || !/^[a-z_][a-z0-9_]{0,62}$/u.test(runtime.role)) throw new Error();
    return { hostname: runtime.hostname, port: runtime.port, database: runtime.database,
      maintenanceRole: owner.role, runtimeRole: runtime.role };
  } catch {
    // URL parsing errors can contain passwords. No original input/cause escapes.
    throw new Error(refusal);
  }
}

const fileRefusal = 'Production requires a separate protected runtime configuration.';
const MAX_ENV_BYTES = 256 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fileWitness(path, parseText = envValues) {
  if (typeof path !== 'string' || !isAbsolute(path) || lstatSync(path).isSymbolicLink()) throw new Error();
  const canonical = realpathSync(path);
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(MAX_ENV_BYTES)) throw new Error();
    const permissionsVerified = process.platform !== 'win32';
    if (permissionsVerified && ((before.mode & 0o077n) !== 0n
      || (before.uid !== BigInt(process.geteuid()) && process.geteuid() !== 0))) throw new Error();
    const buffer = Buffer.alloc(MAX_ENV_BYTES + 1);
    let length = 0;
    while (length <= MAX_ENV_BYTES) {
      const amount = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (amount === 0) break;
      length += amount;
    }
    const after = fstatSync(descriptor, { bigint: true }), selected = statSync(path, { bigint: true });
    if (length > MAX_ENV_BYTES || BigInt(length) !== before.size || canonical !== realpathSync(path)
      || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
      || selected.dev !== before.dev || selected.ino !== before.ino) throw new Error();
    const bytes = buffer.subarray(0, length);
    return { path: canonical, device: String(before.dev), inode: String(before.ino),
      sha256: hash(bytes), values: parseText(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), permissionsVerified };
  } finally { closeSync(descriptor); }
}

// An explicit trust anchor is security configuration, even though its public
// certificate bytes are not a secret. Never accept keys or trailing material.
function certificateValues(text) {
  const pattern=/-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/gu;
  const blocks=[...text.matchAll(pattern)].map(match=>match[0]);
  if(!blocks.length || blocks.length>32 || text.replace(pattern,'').trim()!=='') throw new Error();
  const now=Date.now();
  for(const pem of blocks) {
    const certificate=new X509Certificate(pem);
    if(!certificate.ca || !(Date.parse(certificate.validFrom)<=now)
      || !(Date.parse(certificate.validTo)>now)) throw new Error();
  }
  return null;
}

function envValues(text) {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(text.replaceAll('\r\n', '\n'))) throw new Error();
  const values = Object.create(null);
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/u.exec(trimmed);
    if (!match || Object.hasOwn(values, match[1])) throw new Error();
    let value = match[2].trim();
    // A deliberately literal dotenv subset prevents Compose interpolation or
    // escape interpretation from changing the reviewed value at startup.
    if (value.includes('$')) throw new Error();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      if (value.length < 2 || !value.endsWith(quote)) throw new Error();
      value = value.slice(1, -1);
      if (value.includes(quote) || (quote === '"' && value.includes('\\'))) throw new Error();
    } else if (/['"#]/u.test(value)) throw new Error();
    values[match[1]] = value;
  }
  return values;
}

/** Confidential loader for future deployment integration. appEnvironment has
 * runtime secrets: pass only to trusted deployment code, never print/serialize.
 * Windows file identity is checked but ACLs are NOT certified here; callers
 * must not treat privatePermissionsVerified=false as protected transport proof.
 */
export function readProductionRuntimeEnvironment(maintenanceEnvFile) {
  try {
    const maintenance = fileWitness(maintenanceEnvFile);
    const app = fileWitness(maintenance.values.CHARITYPILOT_PRODUCTION_APP_ENV_FILE);
    if (app.path === maintenance.path || (app.device === maintenance.device && app.inode === maintenance.inode)) throw new Error();
    const identity = validateProductionRuntimeDatabasePair(maintenance.values.DATABASE_URL, app.values.DATABASE_URL);
    const maintenanceConnection = connection(maintenance.values.DATABASE_URL);
    const maintenancePassword = maintenanceConnection.password;
    const ca = maintenanceConnection.ca === 'system' ? null
      : fileWitness(maintenanceConnection.ca, certificateValues);
    const databaseCa = ca ? Object.freeze({path:ca.path,device:ca.device,inode:ca.inode,sha256:ca.sha256}) : null;
    for (const [key, value] of Object.entries(app.values)) {
      if (/^(?:POSTGRES_|MIGRATION_|PG[A-Z0-9_]*$|BLUEGREEN_|CHARITYPILOT_PRODUCTION_|DOCKER_|COMPOSE_)/u.test(key)
        || ['NODE_OPTIONS','NODE_PATH','LD_PRELOAD','LD_LIBRARY_PATH','BASH_ENV','ENV'].includes(key)) throw new Error();
      if (key === 'DATABASE_URL') continue;
      if (!Object.hasOwn(maintenance.values, key) || value !== maintenance.values[key]
        || value.includes(maintenance.values.DATABASE_URL) || value === maintenancePassword) throw new Error();
    }
    return Object.freeze({ appEnvFile: app.path, appEnvironment: Object.freeze(app.values), identity: Object.freeze(identity),
      privatePermissionsVerified: maintenance.permissionsVerified && app.permissionsVerified && (!ca || ca.permissionsVerified),
      binding: Object.freeze({ maintenancePath: maintenance.path, appPath: app.path,
        maintenanceSha256: maintenance.sha256, appSha256: app.sha256,
        maintenanceDevice: maintenance.device, maintenanceInode: maintenance.inode,
        appDevice: app.device, appInode: app.inode, ...(databaseCa ? {databaseCa} : {}) }) });
  } catch { throw new Error(fileRefusal); }
}

export function assertProductionRuntimeEnvironmentUnchanged(binding) {
  try {
    const current = readProductionRuntimeEnvironment(binding.maintenancePath).binding;
    if (JSON.stringify(current) !== JSON.stringify(binding)) throw new Error();
  } catch { throw new Error('Production runtime configuration changed; repeat protected configuration review.'); }
}

/** Trusted Compose CLI transport, NOT container environment or a public result.
 * environment intentionally includes maintenance secrets for migration. Never
 * log it. Only the explicitly selected Compose service fields reach containers.
 */
export function buildProductionComposeEnvironment(maintenanceEnvFile, inherited = {}) {
  try {
    const runtime = readProductionRuntimeEnvironment(maintenanceEnvFile);
    const maintenance = fileWitness(runtime.binding.maintenancePath);
    if (maintenance.sha256 !== runtime.binding.maintenanceSha256
      || Object.keys(maintenance.values).some(key => /^(?:COMPOSE_|DOCKER_|BUILDX_)/u.test(key)
        || ['PATH','PATHEXT','NODE_OPTIONS','NODE_PATH','LD_PRELOAD','LD_LIBRARY_PATH','BASH_ENV','ENV'].includes(key))) throw new Error();
    const replaced = new Set([...Object.keys(maintenance.values), 'CHARITYPILOT_PRODUCTION_ENV_FILE',
      'CHARITYPILOT_PRODUCTION_APP_ENV_FILE', 'CHARITYPILOT_PRODUCTION_RUNTIME_DATABASE_URL'].map(key => key.toUpperCase()));
    const safeInherited = Object.fromEntries(Object.entries(inherited).filter(([key]) =>
      !replaced.has(key.toUpperCase()) && !/^(?:COMPOSE_|DOCKER_|BUILDX_)/iu.test(key)
      && !['NODE_OPTIONS','NODE_PATH','LD_PRELOAD','LD_LIBRARY_PATH','BASH_ENV','ENV'].includes(key.toUpperCase())));
    assertProductionRuntimeEnvironmentUnchanged(runtime.binding);
    return { environment: { ...safeInherited, ...maintenance.values,
      CHARITYPILOT_PRODUCTION_ENV_FILE: runtime.binding.maintenancePath,
      CHARITYPILOT_PRODUCTION_APP_ENV_FILE: runtime.appEnvFile,
      CHARITYPILOT_PRODUCTION_RUNTIME_DATABASE_URL: runtime.appEnvironment.DATABASE_URL },
    binding: runtime.binding, identity: runtime.identity, privatePermissionsVerified: runtime.privatePermissionsVerified };
  } catch { throw new Error(fileRefusal); }
}
