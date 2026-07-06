import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import next from 'next';

const dir = dirname(fileURLToPath(import.meta.url));
const portFlagIndex = process.argv.indexOf('--port');
const cliPort = portFlagIndex >= 0 ? process.argv[portFlagIndex + 1] : undefined;
const port = Number(process.env.PORT ?? process.env.WEB_PORT ?? cliPort ?? 3003);
const hostname = process.env.HOST ?? '0.0.0.0';

if (!Number.isFinite(port) || port <= 0) {
  throw new Error(`Invalid port: ${process.env.PORT ?? process.env.WEB_PORT ?? cliPort}`);
}

const app = next({ dev: false, dir, hostname, port });
const handle = app.getRequestHandler();

await app.prepare();

function redactLogText(value) {
  return String(value)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]')
    .replace(/\b(token|access_token|refresh_token|signature|secret)=([^&\s]+)/gi, '$1=[redacted]')
    .replace(/\b[a-z0-9_-]+\/[^\s'"<>]+/gi, '[redacted-path]');
}

function serializeErrorForWebLog(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactLogText(error.message),
    };
  }

  return {
    name: 'NonError',
    message: redactLogText(error),
  };
}

const server = createServer(async (request, response) => {
  try {
    await handle(request, response);
  } catch (error) {
    console.error('Next request handler failed:', serializeErrorForWebLog(error));
    if (!response.headersSent) {
      response.statusCode = 500;
      response.end('Internal Server Error');
      return;
    }
    response.destroy(error);
  }
});

server.listen(port, hostname, () => {
  console.log(`CharityPilot web running on http://${hostname}:${port}`);
});

let isShuttingDown = false;

function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`Received ${signal}, shutting down CharityPilot web`);
  server.close((error) => {
    if (error) {
      console.error('Graceful shutdown failed:', serializeErrorForWebLog(error));
      process.exit(1);
    }
    process.exit(0);
  });

  setTimeout(() => {
    console.error('Graceful shutdown timed out');
    process.exit(1);
  }, 10000).unref();
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
