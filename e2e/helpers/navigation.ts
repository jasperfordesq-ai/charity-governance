import type { Page } from '@playwright/test';
import { IS_DEPLOYED_QA } from '../env';
import { WEB_BASE_URL } from '../playwright.config';

type GotoOptions = Parameters<Page['goto']>[1];
type GotoResponse = Awaited<ReturnType<Page['goto']>>;

const DEV_SERVER_RESTART_WAIT_MS = 480_000;
const DEV_SERVER_POLL_MS = 2_000;
const DEV_SERVER_FETCH_MS = 5_000;
const DEV_SERVER_RESTART_ERROR_PATTERNS = [
  'net::ERR_EMPTY_RESPONSE',
  'net::ERR_CONNECTION_RESET',
  'net::ERR_CONNECTION_REFUSED',
  'net::ERR_SOCKET_NOT_CONNECTED',
  'net::ERR_ABORTED; maybe frame was detached',
  'page.goto: Timeout',
];

function isDevServerRestartNavigationError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return DEV_SERVER_RESTART_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

async function fetchWebRoot(): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEV_SERVER_FETCH_MS);
  try {
    return await fetch(WEB_BASE_URL, { redirect: 'manual', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function waitForLocalWebServer(): Promise<void> {
  const deadline = Date.now() + DEV_SERVER_RESTART_WAIT_MS;
  let lastErr: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetchWebRoot();
      if (response.status < 500) return;
      lastErr = new Error(`web responded ${response.status}`);
    } catch (err) {
      lastErr = err;
    }

    await new Promise((resolve) => setTimeout(resolve, DEV_SERVER_POLL_MS));
  }

  throw new Error(`Timed out waiting for local web server after a dev-server restart (${String(lastErr)})`);
}

export async function gotoWithDevServerRetry(
  page: Page,
  url: string,
  options?: GotoOptions,
): Promise<GotoResponse> {
  const gotoOptions = { waitUntil: 'domcontentloaded' as const, ...options };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await page.goto(url, gotoOptions);
    } catch (err) {
      if (IS_DEPLOYED_QA || !isDevServerRestartNavigationError(err) || attempt === 2) {
        throw err;
      }

      await waitForLocalWebServer();
    }
  }

  throw new Error(`Unable to navigate to ${url}`);
}

export async function resolveFirstComplianceDetailPath(page: Page, options?: GotoOptions): Promise<string> {
  await gotoWithDevServerRetry(page, '/compliance', options);
  const href = await page.locator('a[href^="/compliance/"]').first().getAttribute('href', { timeout: 120_000 });

  if (!href) {
    throw new Error('Unable to resolve a compliance principle detail route from the compliance overview');
  }

  const resolved = new URL(href, WEB_BASE_URL);
  if (!resolved.pathname.startsWith('/compliance/') || resolved.pathname === '/compliance/') {
    throw new Error(`Resolved compliance detail href is not a principle detail route: ${resolved.pathname}`);
  }

  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}
