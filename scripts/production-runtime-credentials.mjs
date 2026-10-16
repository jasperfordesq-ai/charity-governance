import { isIP } from 'node:net';

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
