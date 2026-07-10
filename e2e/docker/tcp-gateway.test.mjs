import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import test from 'node:test';

import {
  FIXED_ROUTES,
  GATEWAY_LIMITS,
  createLoopbackGatewayForTests,
} from './tcp-gateway.mjs';

const TEST_TIMEOUT_MS = 2_000;

function withTimeout(promise, label, timeoutMs = TEST_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out.`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function listen(server) {
  return withTimeout(
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0 }, resolve);
    }),
    'test server listen',
  );
}

function closeServer(server) {
  return withTimeout(
    new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    }),
    'test server close',
  );
}

function serverPort(server) {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

function testRoute(upstreamPort) {
  return {
    name: 'test',
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamHost: '127.0.0.1',
    upstreamPort,
  };
}

function connect(port, options = {}) {
  const socket = createConnection({ host: '127.0.0.1', port, ...options });
  socket.on('error', () => {});
  return socket;
}

function readBytes(socket, expectedLength) {
  return withTimeout(
    new Promise((resolve, reject) => {
      const chunks = [];
      let length = 0;
      const cleanup = () => {
        socket.removeListener('data', onData);
        socket.removeListener('close', onClose);
      };
      const onData = (chunk) => {
        chunks.push(chunk);
        length += chunk.length;
        if (length >= expectedLength) {
          cleanup();
          resolve(Buffer.concat(chunks, length).subarray(0, expectedLength));
        }
      };
      const onClose = () => {
        cleanup();
        reject(new Error('Socket closed before the expected bytes arrived.'));
      };

      socket.on('data', onData);
      socket.once('close', onClose);
    }),
    'socket read',
  );
}

function waitForClose(socket) {
  if (socket.closed || socket.destroyed) {
    return Promise.resolve();
  }

  return withTimeout(new Promise((resolve) => socket.once('close', resolve)), 'socket close');
}

function waitForCondition(predicate, label) {
  return withTimeout(
    new Promise((resolve) => {
      const check = () => {
        if (predicate()) {
          resolve();
          return;
        }
        setTimeout(check, 5);
      };
      check();
    }),
    label,
  );
}

test('fixed production routes and limits are immutable and exact', () => {
  assert.deepEqual(FIXED_ROUTES, [
    {
      name: 'database',
      listenHost: '0.0.0.0',
      listenPort: 55434,
      upstreamHost: 'db.charitypilot-e2e.invalid.',
      upstreamPort: 5432,
    },
    {
      name: 'api',
      listenHost: '0.0.0.0',
      listenPort: 3302,
      upstreamHost: 'api.charitypilot-e2e.invalid.',
      upstreamPort: 3302,
    },
    {
      name: 'web',
      listenHost: '0.0.0.0',
      listenPort: 3303,
      upstreamHost: 'web.charitypilot-e2e.invalid.',
      upstreamPort: 3303,
    },
  ]);
  assert.equal(Object.isFrozen(FIXED_ROUTES), true);
  assert.equal(FIXED_ROUTES.every(Object.isFrozen), true);
  assert.equal(
    FIXED_ROUTES.every((route) => route.upstreamHost.endsWith('.charitypilot-e2e.invalid.')),
    true,
  );
  assert.equal(Object.isFrozen(GATEWAY_LIMITS), true);
  assert.equal(GATEWAY_LIMITS.maxConnections, 128);
});

test('proxies opaque bytes in both directions', async (t) => {
  const fromClient = Buffer.from([0x00, 0xff, 0x41, 0x0a, 0x7f, 0x80]);
  const fromUpstream = Buffer.from([0xde, 0xad, 0x00, 0xbe, 0xef]);
  let resolveUpstreamSocket;
  const upstreamSocketPromise = new Promise((resolve) => {
    resolveUpstreamSocket = resolve;
  });
  const upstream = createServer((socket) => {
    socket.on('error', () => {});
    resolveUpstreamSocket(socket);
    socket.write(fromUpstream);
  });
  let gateway;
  let client;
  t.after(async () => {
    client?.destroy();
    await gateway?.shutdown();
    await closeServer(upstream);
  });
  await listen(upstream);

  gateway = createLoopbackGatewayForTests({ routes: [testRoute(serverPort(upstream))] });
  await gateway.start();

  client = connect(gateway.addresses()[0].port);
  await withTimeout(once(client, 'connect'), 'gateway client connect');
  const upstreamSocket = await withTimeout(upstreamSocketPromise, 'upstream accept');
  const receivedByUpstream = readBytes(upstreamSocket, fromClient.length);
  const receivedByClient = readBytes(client, fromUpstream.length);

  client.write(fromClient);

  assert.deepEqual(await receivedByUpstream, fromClient);
  assert.deepEqual(await receivedByClient, fromUpstream);
});

test('an upstream refusal closes the downstream connection without a response', async (t) => {
  const reservation = createServer();
  await listen(reservation);
  const refusedPort = serverPort(reservation);
  await closeServer(reservation);

  const gateway = createLoopbackGatewayForTests({
    routes: [testRoute(refusedPort)],
    limits: { upstreamConnectTimeoutMs: 250 },
  });
  t.after(() => gateway.shutdown());
  await gateway.start();

  const client = connect(gateway.addresses()[0].port);
  let receivedBytes = 0;
  client.on('data', (chunk) => {
    receivedBytes += chunk.length;
  });
  await waitForClose(client);

  assert.equal(receivedBytes, 0);
  await waitForCondition(() => gateway.activeConnectionCount() === 0, 'refused session cleanup');
  assert.equal(gateway.activeConnectionCount(), 0);
});

test('the global connection cap rejects excess clients while retaining an active session', async (t) => {
  let resolveAccepted;
  const accepted = new Promise((resolve) => {
    resolveAccepted = resolve;
  });
  const upstream = createServer((socket) => {
    socket.on('error', () => {});
    resolveAccepted(socket);
  });
  let gateway;
  let first;
  t.after(async () => {
    first?.destroy();
    await gateway?.shutdown();
    await closeServer(upstream);
  });
  await listen(upstream);

  gateway = createLoopbackGatewayForTests({
    routes: [testRoute(serverPort(upstream))],
    limits: { maxConnections: 1 },
  });
  await gateway.start();

  first = connect(gateway.addresses()[0].port);
  await withTimeout(once(first, 'connect'), 'first client connect');
  const upstreamSocket = await withTimeout(accepted, 'first upstream accept');
  const second = connect(gateway.addresses()[0].port);
  await waitForClose(second);

  const payload = Buffer.from('still-open');
  const received = readBytes(upstreamSocket, payload.length);
  first.write(payload);

  assert.deepEqual(await received, payload);
  assert.equal(gateway.activeConnectionCount(), 1);
});

test('shutdown is idempotent, force-closes half-open sessions, and completes within its bound', async (t) => {
  let resolveAccepted;
  const accepted = new Promise((resolve) => {
    resolveAccepted = resolve;
  });
  const upstream = createServer({ allowHalfOpen: true }, (socket) => {
    socket.on('error', () => {});
    resolveAccepted(socket);
  });
  let gateway;
  let client;
  let upstreamSocket;
  t.after(async () => {
    client?.destroy();
    upstreamSocket?.destroy();
    await gateway?.shutdown();
    await closeServer(upstream);
  });
  await listen(upstream);

  gateway = createLoopbackGatewayForTests({
    routes: [testRoute(serverPort(upstream))],
    limits: { shutdownGraceMs: 100 },
  });
  await gateway.start();

  client = connect(gateway.addresses()[0].port, { allowHalfOpen: true });
  await withTimeout(once(client, 'connect'), 'shutdown client connect');
  client.resume();
  upstreamSocket = await withTimeout(accepted, 'shutdown upstream accept');
  assert.equal(gateway.activeConnectionCount(), 1);
  const startedAt = Date.now();
  const firstShutdown = gateway.shutdown();
  const secondShutdown = gateway.shutdown();

  assert.strictEqual(secondShutdown, firstShutdown);
  await withTimeout(firstShutdown, 'gateway shutdown');
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(gateway.activeConnectionCount(), 0);
  assert.equal(gateway.addresses()[0].port, undefined);
});

test('production source has no runtime destination, inspection, logging, or privileged side channel', async () => {
  const source = await readFile(new URL('./tcp-gateway.mjs', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /process\.env/);
  assert.doesNotMatch(source, /node:(?:fs|http|https|child_process|worker_threads)/);
  assert.doesNotMatch(source, /\b(?:spawn|spawnSync|exec|execFile|fork)\s*\(/);
  assert.doesNotMatch(source, /\bconsole\s*\./);
  assert.doesNotMatch(source, /process\.(?:stdout|stderr)/);
  assert.doesNotMatch(source, /['\"]data['\"]/);
  assert.doesNotMatch(source, /createServer\s*\([^)]*(?:request|response)/);
  assert.match(source, /process\.on\('SIGINT', onSigint\)/);
  assert.match(source, /process\.on\('SIGTERM', onSigterm\)/);
  assert.match(source, /client\.pause\(\)/);
  assert.match(source, /client\.pipe\(upstream\)/);
  assert.match(source, /upstream\.pipe\(client\)/);
  assert.match(source, /sessions\.size >= limits\.maxConnections/);
  assert.match(source, /createFixedGateway\(\)/);
  assert.equal(source.match(/process\.argv/g)?.length, 1);
});

test('the exported test seam refuses non-loopback routes', () => {
  assert.throws(
    () =>
      createLoopbackGatewayForTests({
        routes: [
          {
            name: 'unsafe',
            listenHost: '0.0.0.0',
            listenPort: 0,
            upstreamHost: 'db',
            upstreamPort: 5432,
          },
        ],
      }),
    /restricted to loopback/,
  );
});
