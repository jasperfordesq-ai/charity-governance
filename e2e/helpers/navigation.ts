import type { Page } from '@playwright/test';
import { IS_DEPLOYED_QA } from '../env';
import { WEB_BASE_URL } from '../playwright.config';

type GotoOptions = Parameters<Page['goto']>[1];
type GotoResponse = Awaited<ReturnType<Page['goto']>>;

const LOCAL_WEB_RECOVERY_WAIT_MS = 20_000;
const LOCAL_WEB_POLL_MS = 2_000;
const LOCAL_WEB_FETCH_MS = 5_000;
const MAX_NAVIGATION_ATTEMPTS = 2;
const PAGE_FAILURE_SNIPPET_LENGTH = 700;
const COMPLIANCE_DETAIL_LINK_TIMEOUT_MS = 180_000;
const COMPLIANCE_DETAIL_LINK_POLL_MS = 1_000;
const LOCAL_WEB_TRANSPORT_ERROR_PATTERNS = [
  'net::ERR_EMPTY_RESPONSE',
  'net::ERR_CONNECTION_RESET',
  'net::ERR_CONNECTION_REFUSED',
  'net::ERR_SOCKET_NOT_CONNECTED',
];

function isLocalWebTransportError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return LOCAL_WEB_TRANSPORT_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
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

function navigationPath(url: string): string {
  try {
    return new URL(url, WEB_BASE_URL).pathname;
  } catch {
    return '[invalid-path]';
  }
}

function navigationTimeoutMs(options: GotoOptions): number | null {
  return typeof options?.timeout === 'number' && Number.isFinite(options.timeout)
    ? options.timeout
    : null;
}

function isNavigationTimeoutError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('page.goto: Timeout');
}

async function fetchWebRoot(timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(WEB_BASE_URL, { redirect: 'manual', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function waitForLocalWebServer(): Promise<void> {
  const deadline = Date.now() + LOCAL_WEB_RECOVERY_WAIT_MS;
  let lastObservedState = 'no readiness response received';

  while (Date.now() < deadline) {
    const remainingBeforeFetchMs = deadline - Date.now();
    if (remainingBeforeFetchMs <= 0) break;

    try {
      const response = await fetchWebRoot(
        Math.min(LOCAL_WEB_FETCH_MS, remainingBeforeFetchMs),
      );
      if (response.status < 500) return;
      lastObservedState = `web root responded HTTP ${response.status}`;
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      lastObservedState = cleanSnippet(message) || 'readiness request failed';
    }

    const remainingBeforeSleepMs = deadline - Date.now();
    if (remainingBeforeSleepMs <= 0) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(LOCAL_WEB_POLL_MS, remainingBeforeSleepMs)),
    );
  }

  throw new Error(
    `E2E_LOCAL_WEB_RECOVERY_TIMEOUT: local web server did not recover within ${LOCAL_WEB_RECOVERY_WAIT_MS}ms. Last observed state: ${lastObservedState}`,
  );
}

export async function gotoWithDevServerRetry(
  page: Page,
  url: string,
  options?: GotoOptions,
): Promise<GotoResponse> {
  const gotoOptions = { waitUntil: 'domcontentloaded' as const, ...options };

  for (let attempt = 0; attempt < MAX_NAVIGATION_ATTEMPTS; attempt += 1) {
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
      if (isNavigationTimeoutError(err)) {
        const configuredTimeoutMs = navigationTimeoutMs(gotoOptions);
        throw new Error(
          `E2E_NAVIGATION_TIMEOUT: ${navigationPath(url)} did not reach ${gotoOptions.waitUntil} within ${configuredTimeoutMs === null ? 'the configured navigation timeout' : `${configuredTimeoutMs}ms`}.`,
        );
      }

      if (
        IS_DEPLOYED_QA ||
        !isLocalWebTransportError(err) ||
        attempt === MAX_NAVIGATION_ATTEMPTS - 1
      ) {
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
