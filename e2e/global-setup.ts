import type { FullConfig } from '@playwright/test';
import { API_BASE_URL, WEB_BASE_URL } from './playwright.config';
import { resetDb, markEmailVerified } from './helpers/db';

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
  // Public routes compile without a session.
  for (const route of ['/', '/login', '/register', '/forgot-password', '/reset-password', '/verify-email', '/accept-invite', '/pricing']) {
    await warmFetch(`${WEB_BASE_URL}${route}`);
  }

  // Protected routes only compile under an authenticated render, so log a throwaway owner
  // in and hit each once — moving the (slow, one-off) dev compile OUT of a per-test
  // navigation, where host load can blow past the navigation timeout. Best-effort.
  try {
    const email = `e2e-warmup-${Date.now()}@example.com`;
    const headers = { 'content-type': 'application/json', origin: WEB_BASE_URL };
    await fetch(`${API_BASE_URL}/api/v1/auth/register`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, password: 'TestPass123', name: 'Warmup Owner', organisationName: 'Warmup Charity' }),
    });
    await markEmailVerified(email);
    const login = await fetch(`${API_BASE_URL}/api/v1/auth/login`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, password: 'TestPass123' }),
    });
    const setCookies = (login.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
    if (cookie) {
      for (const route of ['/dashboard', '/compliance', '/board', '/documents', '/deadlines', '/registers', '/organisation', '/team', '/billing', '/export', '/regulator']) {
        await warmFetch(`${WEB_BASE_URL}${route}`, { headers: { Cookie: cookie } });
      }
    }
  } catch {
    // Ignore — the suite still gates correctness; this only avoids cold-compile flakes.
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
