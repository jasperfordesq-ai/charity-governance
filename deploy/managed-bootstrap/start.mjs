import { constants, lstatSync, realpathSync, openSync, fstatSync, closeSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { bootstrapContext } from './binding.mjs';
import { parseManagedServiceImagePin } from '../../packages/shared/runtime/managed-service-image-pin.mjs';
import { readBoundedRegularDescriptor } from '../../packages/shared/runtime/protected-tls-material.mjs';

export function readBootstrapPin() {
  const file = '/opt/charitypilot/managed-bootstrap-build.json';
  if (process.platform !== 'linux' || process.getuid() === 0 || realpathSync(file) !== file) throw new Error('Bootstrap pin refused');
  const directory = lstatSync('/opt/charitypilot');
  if (!directory.isDirectory() || directory.uid !== 0 || (directory.mode & 0o022)) throw new Error('Bootstrap pin refused');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (info.uid !== 0 || (info.mode & 0o777) !== 0o444) throw new Error('Bootstrap pin refused');
    return parseManagedServiceImagePin(readBoundedRegularDescriptor(fd, 512), true);
  } finally { closeSync(fd); }
}

// No application imports, outbound clients, proxying, persistence or job execution.
export async function startBootstrap(env, pin) {
  const context = bootstrapContext(env, pin);
  let server, timer, stopped = false;
  const stop = async () => {
    stopped = true;
    clearTimeout(timer);
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  };
  if (context.port !== null) {
    server = createServer({ maxHeaderSize: 4096, requestTimeout: 5000, headersTimeout: 5000,
      keepAliveTimeout: 1, connectionsCheckingInterval: 1000 }, (request, response) => {
      const healthy = !stopped && Date.now() < Date.parse(context.binding.record.expiresAt)
        && request.method === 'GET' && request.url === '/bootstrap-health';
      response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json',
        'cache-control': 'no-store', connection: 'close', 'x-content-type-options': 'nosniff' });
      response.end(JSON.stringify({ kind: 'CHARITYPILOT_INERT_BOOTSTRAP', applicationReady: false }));
    });
    server.maxConnections = 16;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(context.port, '0.0.0.0', resolve);
    });
    server.on('error', () => { void stop(); });
  }
  // A fixed timer prevents wall-clock rollback from extending this process's life.
  // Provider restart/billing is not controlled by this timer.
  timer = setTimeout(() => { void stop(); }, context.lifetimeMs);
  return Object.freeze({ stop });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const runtime = await startBootstrap(process.env, readBootstrapPin());
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void runtime.stop(); });
  } catch {
    console.error('Managed identity bootstrap refused');
    process.exitCode = 1;
  }
}
