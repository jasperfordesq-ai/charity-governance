/**
 * The in-process fake Atlassian, served over HTTP for the end-to-end stack.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * A TEST FIXTURE. IT MUST NEVER RUN ANYWHERE A REAL CHARITY CAN REACH IT.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * `createFakeAtlassian` is a `fetch`-shaped double, which is all the unit tests
 * need. A browser-driven test cannot inject a `fetch`, so the same routing is
 * wrapped in an HTTP server here and the API is pointed at it through the
 * fenced override in `atlassian-endpoints.ts`.
 *
 * It refuses to start under `NODE_ENV=production`, and it binds whatever host
 * it is told to — inside a compose network with no published port, so nothing
 * outside the stack can reach it. It issues tokens to anybody: that is the
 * point of it, and precisely why it must not be reachable.
 *
 * WHY NOT A MOCK SERVER LIBRARY. Because then the end-to-end test would be
 * exercising a second, differently-written fake, and the five Atlassian
 * behaviours this one models — v2 status distinguishing trash from purge,
 * the removed v1 endpoint, purge refused unless already trashed, PUT requiring version + 1, refresh-token
 * rotation, per-space title uniqueness — would have to be reimplemented and
 * kept in step. One fake, two transports.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createFakeAtlassian } from './fake-atlassian.js';

if ((process.env.NODE_ENV ?? 'production') === 'production') {
  // eslint-disable-next-line no-console
  console.error('fake-atlassian-server refuses to run with NODE_ENV=production.');
  process.exit(1);
}

const port = Number.parseInt(process.env.FAKE_ATLASSIAN_PORT ?? '4000', 10);
const host = process.env.FAKE_ATLASSIAN_HOST ?? '0.0.0.0';
const cloudId = process.env.FAKE_ATLASSIAN_CLOUD_ID ?? 'fake-cloud-id';
const siteUrl = process.env.FAKE_ATLASSIAN_SITE_URL ?? 'https://charity-e2e.atlassian.net';

const site = createFakeAtlassian({ cloudId, siteUrl, siteName: 'Charity E2E' });

// Seeded so the space picker has something to offer. A test that needs more
// can add them through the control endpoint below.
site.addSpace({ id: 'space-gov', key: 'GOV', name: 'Governance' });
site.addSpace({ id: 'space-fin', key: 'FIN', name: 'Finance' });

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return chunks.length === 0 ? undefined : Buffer.concat(chunks).toString('utf8');
}

/**
 * The control surface the browser test drives the fixture through.
 *
 * Kept under one obvious prefix so it can never be mistaken for something
 * Atlassian serves, and so a reader of a request log can see immediately which
 * calls were the test arranging the world and which were the product.
 */
async function handleControl(
  pathname: string,
  body: string | undefined,
  res: ServerResponse,
): Promise<boolean> {
  if (!pathname.startsWith('/__control/')) return false;

  const payload = body === undefined ? {} : (JSON.parse(body) as Record<string, unknown>);

  if (pathname === '/__control/spaces') {
    site.addSpace(payload as unknown as { id: string; key: string; name: string });
    res.writeHead(204).end();
    return true;
  }
  if (pathname === '/__control/pages') {
    // Everything the reconcile assertions need to see: which pages exist, what
    // state each is in, and what the product actually called.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ pages: site.allPages() }));
    return true;
  }
  if (pathname === '/__control/calls') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ calls: site.calls }));
    return true;
  }
  if (pathname === '/__control/rate-limit') {
    site.rateLimit(payload as never);
    res.writeHead(204).end();
    return true;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'unknown control endpoint' }));
  return true;
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'fake-atlassian'}`);
      const body = await readBody(req);

      if (await handleControl(url.pathname, body, res)) return;

      // The fake routes on the real Atlassian hostnames, so the request is
      // re-addressed to whichever of the two this path belongs to before being
      // handed over. This is the only translation between the two transports.
      const isAuthPath = url.pathname.startsWith('/oauth/token') && !url.pathname.includes('accessible-resources');
      const target = isAuthPath
        ? `https://auth.atlassian.com${url.pathname}${url.search}`
        : `https://api.atlassian.com${url.pathname}${url.search}`;

      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(key, value);
      }

      const response = await site.fetch(target, {
        method: req.method,
        headers,
        ...(body === undefined ? {} : { body }),
      });

      const text = await response.text();
      const outHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        outHeaders[key] = value;
      });
      res.writeHead(response.status, outHeaders);
      res.end(text);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'fake failure' }));
    }
  })();
});

server.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`fake-atlassian listening on ${host}:${port} as cloud ${cloudId}`);
});
