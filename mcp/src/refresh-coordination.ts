import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { homedir } from 'node:os';
import type { Realm } from './config.js';

const HOST = '127.0.0.1';
const FIRST_PORT = 20_000;
const PORT_COUNT = 20_000;
const WAIT_MS = 10_000;

export class ConnectorRefreshLockUnavailableError extends Error {
  constructor() {
    super('Could not safely coordinate session renewal with another connector. The stored credential was not used; try again.');
    this.name = 'ConnectorRefreshLockUnavailableError';
  }
}

/** A fixed, user-scoped loopback port is an OS-owned cross-process mutex.
 * The listener accepts no data and disappears if its process exits, unlike a
 * stale lock file. Occupation by an unrelated service fails closed.
 */
export function connectorRefreshLockPort(baseUrl: string, realm: Realm): number {
  const key = `${homedir().toLowerCase()}\0${new URL(baseUrl).origin.toLowerCase()}\0${realm}`;
  const hash = createHash('sha256').update(key).digest();
  return FIRST_PORT + hash.readUInt32BE(0) % PORT_COUNT;
}

function tryListen(port: number): Promise<Server | null> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve(null);
      else reject(new ConnectorRefreshLockUnavailableError());
    });
    server.listen({ host: HOST, port, exclusive: true }, () => resolve(server));
  });
}

export async function withConnectorRefreshLock<T>(
  baseUrl: string,
  realm: Realm,
  action: () => Promise<T>,
  waitMs = WAIT_MS,
): Promise<T> {
  const port = connectorRefreshLockPort(baseUrl, realm);
  const deadline = Date.now() + waitMs;
  let server: Server | null = null;
  while (server === null) {
    server = await tryListen(port);
    if (server) break;
    if (Date.now() >= deadline) throw new ConnectorRefreshLockUnavailableError();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    return await action();
  } finally {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
}
