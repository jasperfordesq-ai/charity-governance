import type { Page } from '@playwright/test';
import { IS_DEPLOYED_QA } from '../env';
import { WEB_BASE_URL } from '../playwright.config';

type GotoOptions = Parameters<Page['goto']>[1];
type GotoResponse = Awaited<ReturnType<Page['goto']>>;

const DEV_SERVER_RESTART_WAIT_MS = 480_000;
const DEV_SERVER_POLL_MS = 2_000;
const DEV_SERVER_FETCH_MS = 5_000;
const PAGE_FAILURE_SNIPPET_LENGTH = 700;
const COMPLIANCE_DETAIL_LINK_TIMEOUT_MS = 180_000;
const COMPLIANCE_DETAIL_LINK_POLL_MS = 1_000;
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

function cleanSnippet(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, PAGE_FAILURE_SNIPPET_LENGTH);
}

async function bodySnippet(page: Page): Promise<string> {
  return cleanSnippet(await page.locator('body').innerText({ timeout: 1_000 }).catch(() => ''));
}

async function nextDevOverlaySnippet(page: Page): Promise<string | null> {
  const snippet = await bodySnippet(page);
  if (
    /Runtime (?:Syntax)?Error|Build Error|Unhandled Runtime Error|Unexpected end of JSON input/i.test(snippet)
  ) {
    return snippet;
  }

  return null;
}

function observePageErrors(page: Page): { latest: () => string | null; dispose: () => void } {
  const errors: string[] = [];
  const onPageError = (err: Error) => {
    errors.push(`${err.name}: ${err.message}`);
  };
  page.on('pageerror', onPageError);
  return {
    latest: () => errors.at(-1) ?? null,
    dispose: () => page.off('pageerror', onPageError),
  };
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
      const response = await page.goto(url, gotoOptions);
      const status = response?.status();
      if (status && status >= 500) {
        const snippet = (await nextDevOverlaySnippet(page)) ?? (await bodySnippet(page));
        throw new Error(
          `Navigation to ${url} returned HTTP ${status}${snippet ? `: ${snippet}` : ''}`,
        );
      }
      return response;
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
  const pageErrors = observePageErrors(page);
  try {
    await gotoWithDevServerRetry(page, '/compliance', options);
    const deadline = Date.now() + COMPLIANCE_DETAIL_LINK_TIMEOUT_MS;
    const link = page.locator('a[href^="/compliance/"]').first();
    let lastObservedState = 'compliance overview loaded, but no principle detail link was visible yet';
    let href: string | null = null;

    while (Date.now() < deadline) {
      const pageError = pageErrors.latest();
      if (pageError) {
        throw new Error(
          `Compliance overview raised a browser JavaScript error before principle links rendered: ${pageError}`,
        );
      }

      href = await link.getAttribute('href', { timeout: 500 }).catch(() => null);
      if (href) break;

      const overlay = await nextDevOverlaySnippet(page);
      if (overlay) {
        throw new Error(`Compliance overview hit a Next.js/runtime error before principle links rendered: ${overlay}`);
      }

      if (/\/login(?:\?|$)/.test(new URL(page.url()).pathname + new URL(page.url()).search)) {
        throw new Error(
          `Compliance overview redirected to login while resolving a principle detail route: ${page.url()}`,
        );
      }

      const loadingDashboard = await page
        .getByRole('heading', { name: 'Loading dashboard' })
        .isVisible({ timeout: 250 })
        .catch(() => false);
      if (loadingDashboard) {
        lastObservedState = 'still showing "Loading dashboard" while checking the secure session';
      } else {
        lastObservedState = (await bodySnippet(page)) || lastObservedState;
      }

      await page.waitForTimeout(COMPLIANCE_DETAIL_LINK_POLL_MS);
    }

    if (!href) {
      throw new Error(
        `Unable to resolve a compliance principle detail route from the compliance overview after ${COMPLIANCE_DETAIL_LINK_TIMEOUT_MS}ms. Last observed state: ${lastObservedState}`,
      );
    }

    const resolved = new URL(href, WEB_BASE_URL);
    if (!resolved.pathname.startsWith('/compliance/') || resolved.pathname === '/compliance/') {
      throw new Error(`Resolved compliance detail href is not a principle detail route: ${resolved.pathname}`);
    }

    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } finally {
    pageErrors.dispose();
  }
}
