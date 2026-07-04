import type { Page } from '@playwright/test';
import { IS_DEPLOYED_QA } from '../env';
import { WEB_BASE_URL } from '../playwright.config';

type GotoOptions = Parameters<Page['goto']>[1];
type GotoResponse = Awaited<ReturnType<Page['goto']>>;

const DEV_SERVER_RESTART_WAIT_MS = 180_000;
const DEV_SERVER_POLL_MS = 2_000;
const DEV_SERVER_FETCH_MS = 5_000;
const DEV_SERVER_RESTART_ERROR_PATTERNS = [
  'net::ERR_EMPTY_RESPONSE',
  'net::ERR_CONNECTION_RESET',
  'net::ERR_CONNECTION_REFUSED',
  'net::ERR_ABORTED; maybe frame was detached',
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
  try {
    return await page.goto(url, options);
  } catch (err) {
    if (IS_DEPLOYED_QA || !isDevServerRestartNavigationError(err)) {
      throw err;
    }

    await waitForLocalWebServer();
    return page.goto(url, options);
  }
}
