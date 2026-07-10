import { createConnection, createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

export const FIXED_ROUTES = Object.freeze([
  Object.freeze({
    name: 'database',
    listenHost: '0.0.0.0',
    listenPort: 55434,
    upstreamHost: 'db.charitypilot-e2e.invalid.',
    upstreamPort: 5432,
  }),
  Object.freeze({
    name: 'api',
    listenHost: '0.0.0.0',
    listenPort: 3302,
    upstreamHost: 'api.charitypilot-e2e.invalid.',
    upstreamPort: 3302,
  }),
  Object.freeze({
    name: 'web',
    listenHost: '0.0.0.0',
    listenPort: 3303,
    upstreamHost: 'web.charitypilot-e2e.invalid.',
    upstreamPort: 3303,
  }),
]);

export const GATEWAY_LIMITS = Object.freeze({
  maxConnections: 128,
  upstreamConnectTimeoutMs: 5_000,
  closePropagationTimeoutMs: 1_000,
  shutdownGraceMs: 3_000,
});

const GENERIC_START_FAILURE = 'Gateway unavailable.';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);

function ignoreError() {}

function clearTimer(timer) {
  if (timer !== undefined) {
    clearTimeout(timer);
  }
}

function safeDestroy(socket) {
  if (!socket.destroyed) {
    try {
      socket.destroy();
    } catch {
      // Socket teardown is best-effort and must never prevent peer cleanup.
    }
  }
}

function safeReset(socket) {
  if (!socket.destroyed) {
    try {
      socket.resetAndDestroy();
    } catch {
      safeDestroy(socket);
    }
  }
}

function safeEnd(socket) {
  if (!socket.destroyed && !socket.writableEnded) {
    try {
      socket.end();
    } catch {
      safeDestroy(socket);
    }
  }
}

function requirePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer.`);
  }

  return value;
}

function requirePort(value, field, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > 65_535) {
    throw new TypeError(`${field} must be a valid TCP port.`);
  }

  return value;
}

function requireHost(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty host.`);
  }

  return value;
}

function copyRoutes(routes, { loopbackOnly = false } = {}) {
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new TypeError('At least one gateway route is required.');
  }

  const names = new Set();
  const listeners = new Set();
  const copied = routes.map((route, index) => {
    if (route === null || typeof route !== 'object' || Array.isArray(route)) {
      throw new TypeError(`routes[${index}] must be an object.`);
    }

    const name = requireHost(route.name, `routes[${index}].name`);
    const listenHost = requireHost(route.listenHost, `routes[${index}].listenHost`);
    const listenPort = requirePort(route.listenPort, `routes[${index}].listenPort`, loopbackOnly);
    const upstreamHost = requireHost(route.upstreamHost, `routes[${index}].upstreamHost`);
    const upstreamPort = requirePort(route.upstreamPort, `routes[${index}].upstreamPort`);

    if (names.has(name)) {
      throw new TypeError('Gateway route names must be unique.');
    }

    const listener = `${listenHost}\u0000${listenPort}`;
    if (listeners.has(listener)) {
      throw new TypeError('Gateway listener addresses must be unique.');
    }

    if (loopbackOnly && (!LOOPBACK_HOSTS.has(listenHost) || !LOOPBACK_HOSTS.has(upstreamHost))) {
      throw new TypeError('The test gateway is restricted to loopback routes.');
    }

    names.add(name);
    listeners.add(listener);
    return Object.freeze({ name, listenHost, listenPort, upstreamHost, upstreamPort });
  });

  return Object.freeze(copied);
}

function copyLimits(limits) {
  return Object.freeze({
    maxConnections: requirePositiveInteger(limits.maxConnections, 'maxConnections'),
    upstreamConnectTimeoutMs: requirePositiveInteger(
      limits.upstreamConnectTimeoutMs,
      'upstreamConnectTimeoutMs',
    ),
    closePropagationTimeoutMs: requirePositiveInteger(
      limits.closePropagationTimeoutMs,
      'closePropagationTimeoutMs',
    ),
    shutdownGraceMs: requirePositiveInteger(limits.shutdownGraceMs, 'shutdownGraceMs'),
  });
}

function listen(server, route) {
  return new Promise((resolve, reject) => {
    const onError = () => {
      cleanup();
      reject(new Error(GENERIC_START_FAILURE));
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: route.listenHost, port: route.listenPort, exclusive: true });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }

    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function createGateway(routes, limits) {
  const sessions = new Set();
  const drainWaiters = new Set();
  let lifecycle = 'idle';
  let shutdownPromise;

  const notifyDrain = () => {
    if (sessions.size !== 0) {
      return;
    }

    for (const resolve of drainWaiters) {
      resolve();
    }
    drainWaiters.clear();
  };

  const waitForDrain = () => {
    if (sessions.size === 0) {
      return Promise.resolve();
    }

    return new Promise((resolve) => drainWaiters.add(resolve));
  };

  const accept = (client, route) => {
    client.pause();
    client.on('error', ignoreError);

    if (lifecycle !== 'running' || sessions.size >= limits.maxConnections) {
      safeDestroy(client);
      return;
    }

    const upstream = createConnection({
      host: route.upstreamHost,
      port: route.upstreamPort,
      allowHalfOpen: true,
    });
    upstream.pause();
    upstream.on('error', ignoreError);

    const session = {
      client,
      upstream,
      clientClosed: false,
      upstreamClosed: false,
      aborted: false,
      connectTimer: undefined,
      closeTimer: undefined,
    };
    sessions.add(session);

    const finish = () => {
      if (!session.clientClosed || !session.upstreamClosed) {
        return;
      }

      clearTimer(session.connectTimer);
      clearTimer(session.closeTimer);
      sessions.delete(session);
      notifyDrain();
    };

    const abort = () => {
      if (session.aborted) {
        return;
      }

      session.aborted = true;
      clearTimer(session.connectTimer);
      safeDestroy(client);
      safeDestroy(upstream);
    };

    const armCloseTimer = () => {
      if (session.closeTimer !== undefined || (session.clientClosed && session.upstreamClosed)) {
        return;
      }

      session.closeTimer = setTimeout(abort, limits.closePropagationTimeoutMs);
      session.closeTimer.unref();
    };

    client.on('error', abort);
    upstream.on('error', abort);

    client.once('close', () => {
      session.clientClosed = true;
      safeEnd(upstream);
      armCloseTimer();
      finish();
    });

    upstream.once('close', () => {
      session.upstreamClosed = true;
      safeEnd(client);
      armCloseTimer();
      finish();
    });

    upstream.once('connect', () => {
      clearTimer(session.connectTimer);

      if (session.aborted || lifecycle !== 'running' || client.destroyed) {
        abort();
        return;
      }

      client.pipe(upstream);
      upstream.pipe(client);
      upstream.resume();
      client.resume();
    });

    session.connectTimer = setTimeout(abort, limits.upstreamConnectTimeoutMs);
    session.connectTimer.unref();
  };

  const servers = routes.map((route) => {
    const server = createServer({ allowHalfOpen: true }, (client) => accept(client, route));
    server.on('error', ignoreError);
    return server;
  });

  const start = async () => {
    if (lifecycle !== 'idle') {
      throw new Error(GENERIC_START_FAILURE);
    }

    lifecycle = 'starting';
    try {
      for (let index = 0; index < servers.length; index += 1) {
        await listen(servers[index], routes[index]);
        if (lifecycle !== 'starting') {
          throw new Error(GENERIC_START_FAILURE);
        }
      }
      lifecycle = 'running';
    } catch {
      lifecycle = 'stopping';
      await Promise.all(servers.map(closeServer));
      lifecycle = 'stopped';
      throw new Error(GENERIC_START_FAILURE);
    }
  };

  const shutdown = () => {
    if (shutdownPromise !== undefined) {
      return shutdownPromise;
    }

    lifecycle = 'stopping';
    shutdownPromise = new Promise((resolve) => {
      const forceTimer = setTimeout(() => {
        for (const session of sessions) {
          safeReset(session.client);
          safeReset(session.upstream);
        }
      }, limits.shutdownGraceMs);
      forceTimer.unref();

      Promise.all([Promise.all(servers.map(closeServer)), waitForDrain()]).then(() => {
        clearTimer(forceTimer);
        lifecycle = 'stopped';
        resolve();
      });
    });

    return shutdownPromise;
  };

  const addresses = () =>
    Object.freeze(
      routes.map((route, index) => {
        const address = servers[index].address();
        return Object.freeze({
          name: route.name,
          host: typeof address === 'object' && address !== null ? address.address : undefined,
          port: typeof address === 'object' && address !== null ? address.port : undefined,
        });
      }),
    );

  return Object.freeze({
    start,
    shutdown,
    addresses,
    activeConnectionCount: () => sessions.size,
  });
}

function createFixedGateway() {
  return createGateway(copyRoutes(FIXED_ROUTES), copyLimits(GATEWAY_LIMITS));
}

export function createLoopbackGatewayForTests({ routes, limits = {} }) {
  return createGateway(
    copyRoutes(routes, { loopbackOnly: true }),
    copyLimits({ ...GATEWAY_LIMITS, ...limits }),
  );
}

async function runFixedGateway() {
  const gateway = createFixedGateway();
  let requestedSignal;

  const requestShutdown = (signal) => {
    if (requestedSignal !== undefined) {
      return;
    }

    requestedSignal = signal;
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    void gateway.shutdown().finally(() => {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    });
  };
  const onSigint = () => requestShutdown('SIGINT');
  const onSigterm = () => requestShutdown('SIGTERM');

  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  try {
    await gateway.start();
  } catch {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    if (requestedSignal === undefined) {
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runFixedGateway();
}
