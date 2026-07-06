import type { FullConfig } from '@playwright/test';
import { API_BASE_URL, WEB_BASE_URL } from './playwright.config';
import { IS_DEPLOYED_QA } from './env';
import { resetDb } from './helpers/db';

const LOCAL_STARTUP_HINT =
  'CharityPilot E2E expects the local Docker stack to be running:\n' +
  '  docker compose -f compose.yml -f compose.local.yml up\n' +
  'Then the web app is at http://localhost:3003 and the API at http://localhost:3002.';
const DEPLOYED_STARTUP_HINT =
  'CharityPilot deployed QA expects E2E_DEPLOYED_QA=true plus E2E_WEB_URL, E2E_API_URL, E2E_OWNER_EMAIL, and E2E_OWNER_PASSWORD for an approved non-sensitive test workspace.';
const STACK_READINESS_TIMEOUT_MS = 180_000;
const WEB_READINESS_TIMEOUT_MS = 600_000;
const ROUTE_WARM_TIMEOUT_MS = 60_000;
const ROUTE_WARM_BUDGET_MS = 240_000;
const PUBLIC_ROUTES_TO_WARM = [
  '/',
  '/features',
  '/pricing',
  '/blog',
  '/blog/understanding-the-charities-governance-code',
  '/privacy',
  '/terms',
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/accept-invite',
  '/verify-email',
] as const;

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { redirect: 'manual', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function waitForOk(url: string, label: string, timeoutMs = STACK_READINESS_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const remainingMs = Math.max(1, deadline - Date.now());
      const res = await fetchWithTimeout(url, remainingMs);
      // Any non-5xx response means the service is up and serving.
      if (res.status < 500) return;
      lastErr = new Error(`${label} responded ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    `Timed out waiting for ${label} at ${url} (${String(lastErr)}).\n\n${
      IS_DEPLOYED_QA ? DEPLOYED_STARTUP_HINT : LOCAL_STARTUP_HINT
    }`,
  );
}

/**
 * Pre-compile the public routes the suite navigates to. Next runs in DEV mode on the
 * local stack and compiles each route on its first request; doing it once here (instead
 * of inside a bounded test navigation) keeps the per-test cold-compile from flaking
 * under host load. Best-effort: failures are ignored - the tests still gate correctness.
 */
async function warmFetch(url: string, timeoutMs: number): Promise<void> {
  try {
    await fetchWithTimeout(url, timeoutMs);
  } catch {
    // Ignore - warming is an optimisation, not a gate.
  }
}

async function warmRoutes(): Promise<void> {
  // Compile the public routes the suite navigates to (login/register/etc.) without a
  // session. Protected pages are left to compile on their first authenticated hit, under
  // the generous per-navigation timeout - warming them here (an authenticated render of
  // every dashboard page) proved to spike host load and destabilise the browser, so we
  // keep warm-up light and lean on the navigation timeout instead.
  const deadline = Date.now() + ROUTE_WARM_BUDGET_MS;
  for (const route of PUBLIC_ROUTES_TO_WARM) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return;
    const timeoutMs = Math.min(ROUTE_WARM_TIMEOUT_MS, remainingMs);
    await warmFetch(`${WEB_BASE_URL}${route}`, timeoutMs);
  }
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  // 1. The stack must be reachable. Fail fast with an actionable message.
  await waitForOk(`${API_BASE_URL}/api/v1/health`, 'API health');
  await waitForOk(`${WEB_BASE_URL}/`, 'Web app', WEB_READINESS_TIMEOUT_MS);

  if (IS_DEPLOYED_QA) {
    // eslint-disable-next-line no-console
    console.log('[e2e] Deployed QA mode: endpoints reachable; database reset and route warming skipped.');
    return;
  }

  // 2. The DB must be reachable and resettable (also validates the DSN/port).
  try {
    await resetDb();
  } catch (err) {
    throw new Error(
      `Could not reset the database. Is Postgres published on host port 5434?\n${String(err)}\n\n${LOCAL_STARTUP_HINT}`,
    );
  }

  // 3. Warm the public routes so the first real navigation isn't a cold dev compile.
  await warmRoutes();

  // eslint-disable-next-line no-console
  console.log('[e2e] Stack reachable, database reset, routes warmed - starting tests.');
}
