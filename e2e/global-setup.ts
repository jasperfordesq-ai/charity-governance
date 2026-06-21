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

  // eslint-disable-next-line no-console
  console.log('[e2e] Stack reachable and database reset — starting tests.');
}
