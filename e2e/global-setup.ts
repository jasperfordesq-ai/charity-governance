import type { FullConfig } from '@playwright/test';
import { API_BASE_URL, WEB_BASE_URL } from './playwright.config';
import { resetDb } from './helpers/db';

const STARTUP_HINT =
  'CharityPilot E2E expects the local Docker stack to be running:\n' +
  '  docker compose -f compose.yml -f compose.local.yml up\n' +
  'Then the web app is at http://localhost:3003 and the API at http://localhost:3002.';

async function waitForOk(url: string, label: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'manual' });
      // Any non-5xx response means the service is up and serving.
      if (res.status < 500) return;
      lastErr = new Error(`${label} responded ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Timed out waiting for ${label} at ${url} (${String(lastErr)}).\n\n${STARTUP_HINT}`);
}

/**
 * Pre-compile the public routes the suite navigates to. Next runs in DEV mode on the
 * local stack and compiles each route on its first request; doing it once here (instead
 * of inside a 90s-bounded test navigation) keeps the per-test cold-compile from flaking
 * under host load. Best-effort: failures are ignored — the tests still gate correctness.
 */
async function warmFetch(url: string, init: RequestInit = {}): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 150_000);
    await fetch(url, { redirect: 'manual', signal: controller.signal, ...init });
    clearTimeout(timer);
  } catch {
    // Ignore — warming is an optimisation, not a gate.
  }
}

async function warmRoutes(): Promise<void> {
  // Compile the public routes the suite navigates to (login/register/etc.) without a
  // session. Protected pages are left to compile on their first authenticated hit, under
  // the generous per-navigation timeout — warming them here (an authenticated render of
  // every dashboard page) proved to spike host load and destabilise the browser, so we
  // keep warm-up light and lean on the navigation timeout instead.
  for (const route of ['/', '/login', '/register', '/forgot-password', '/reset-password', '/verify-email', '/accept-invite', '/pricing']) {
    await warmFetch(`${WEB_BASE_URL}${route}`);
  }
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  // 1. The stack must be reachable. Fail fast with an actionable message.
  await waitForOk(`${API_BASE_URL}/api/v1/health`, 'API health');
  await waitForOk(`${WEB_BASE_URL}/`, 'Web app');

  // 2. The DB must be reachable and resettable (also validates the DSN/port).
  try {
    await resetDb();
  } catch (err) {
    throw new Error(
      `Could not reset the database. Is Postgres published on host port 5434?\n${String(err)}\n\n${STARTUP_HINT}`,
    );
  }

  // 3. Warm the public routes so the first real navigation isn't a cold dev compile.
  await warmRoutes();

  // eslint-disable-next-line no-console
  console.log('[e2e] Stack reachable, database reset, routes warmed — starting tests.');
}
