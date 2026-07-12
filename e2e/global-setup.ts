import type { FullConfig } from '@playwright/test';
import { API_BASE_URL, WEB_BASE_URL } from './playwright.config';
import { IS_DEPLOYED_QA } from './env';
import {
  acquireRemoteDisposableSuiteLease,
  assertDisposableDatabaseConfiguration,
  resetDb,
  type RemoteDisposableSuiteLease,
  verifyDisposableDatabaseIdentity,
} from './helpers/db';

const LOCAL_STARTUP_HINT =
  'CharityPilot destructive E2E requires the managed isolated disposable runner. ' +
  'The fixed local endpoints are web http://127.0.0.1:3303, API http://127.0.0.1:3302, ' +
  'and PostgreSQL 127.0.0.1:55434; the personal development stack is never a valid reset target.';
const DEPLOYED_STARTUP_HINT =
  'CharityPilot deployed QA expects E2E_DEPLOYED_QA=true plus E2E_WEB_URL, E2E_API_URL, E2E_OWNER_EMAIL, and E2E_OWNER_PASSWORD for an approved non-sensitive test workspace.';
const STACK_READINESS_TIMEOUT_MS = 180_000;
const WEB_READINESS_TIMEOUT_MS = 600_000;
const ROUTE_WARM_TIMEOUT_MS = positiveIntEnv('E2E_ROUTE_WARM_TIMEOUT_MS', 60_000);
const ROUTE_WARM_BUDGET_MS = positiveIntEnv('E2E_ROUTE_WARM_BUDGET_MS', 240_000);
const SKIP_ROUTE_WARMING = process.env.E2E_SKIP_ROUTE_WARMING === 'true';
const PUBLIC_ROUTES_TO_WARM = [
  '/',
  '/about',
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

function assertDestructiveRuntimeSecrets(): void {
  for (const name of [
    'E2E_READINESS_API_KEY',
    'E2E_JWT_SECRET',
    'E2E_AUTH_RECOVERY_SECRET',
  ] as const) {
    const value = process.env[name];
    const minimumLength = name === 'E2E_AUTH_RECOVERY_SECRET' ? 43 : 32;
    if (typeof value !== 'string' || value.length < minimumLength) {
      throw new Error(`${name} must be an explicit high-entropy secret for destructive E2E.`);
    }
  }
  if (
    process.env.E2E_AUTH_RECOVERY_SECRET === process.env.E2E_JWT_SECRET ||
    process.env.E2E_AUTH_RECOVERY_SECRET === process.env.E2E_READINESS_API_KEY
  ) {
    throw new Error(
      'E2E_AUTH_RECOVERY_SECRET must be distinct from E2E_JWT_SECRET and E2E_READINESS_API_KEY.',
    );
  }
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

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

async function verifyApiDatabaseBinding(): Promise<void> {
  const readinessKey = process.env.E2E_READINESS_API_KEY;
  const instanceId = process.env.E2E_DATABASE_INSTANCE_ID;
  if (!readinessKey || !instanceId) {
    throw new Error('E2E API database-binding preflight is missing its runner-generated identity inputs.');
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/v1/health/e2e-database-identity`, {
      method: 'GET',
      redirect: 'error',
      headers: { 'x-charitypilot-readiness-key': readinessKey },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('E2E API database-binding preflight failed (details redacted).');
  }
  if (response.status !== 200) {
    throw new Error('E2E API database-binding preflight was not authorised or not bound.');
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('E2E API database-binding preflight returned an invalid response.');
  }
  const record = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
  if (
    !record ||
    JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(['instanceId', 'status']) ||
    record.status !== 'bound' ||
    record.instanceId !== instanceId
  ) {
    throw new Error('E2E API is not bound to the independently verified disposable database instance.');
  }
}

async function finalResetVerifyAndRelease(lease: RemoteDisposableSuiteLease): Promise<void> {
  const failures: unknown[] = [];
  try {
    await lease.reset();
  } catch (error) {
    failures.push(error);
  }
  try {
    await verifyApiDatabaseBinding();
  } catch (error) {
    failures.push(error);
  }
  try {
    await lease.release();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new Error('Remote E2E final reset, API binding verification, or lease release failed (details redacted).');
  }
}

/**
 * Make a bounded best-effort readiness sweep across the public routes used by
 * the suite. The isolated image is already compiled; browser assertions remain
 * the correctness gate, while this sweep primes ordinary server/runtime caches.
 */
async function warmFetch(url: string, timeoutMs: number): Promise<void> {
  try {
    await fetchWithTimeout(url, timeoutMs);
  } catch {
    // Ignore - warming is an optimisation, not a gate.
  }
}

async function warmRoutes(): Promise<void> {
  if (SKIP_ROUTE_WARMING) {
    // eslint-disable-next-line no-console
    console.log('[e2e] Public-route readiness sweep skipped because E2E_SKIP_ROUTE_WARMING=true.');
    return;
  }

  // Check the public routes without a session. Protected routes remain browser
  // assertions because this setup phase deliberately has no authenticated context.
  const deadline = Date.now() + ROUTE_WARM_BUDGET_MS;
  for (const route of PUBLIC_ROUTES_TO_WARM) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      // eslint-disable-next-line no-console
      console.log(`[e2e] Public-route readiness budget exhausted before ${route}; continuing to tests.`);
      return;
    }
    const timeoutMs = Math.min(ROUTE_WARM_TIMEOUT_MS, remainingMs);
    // eslint-disable-next-line no-console
    console.log(`[e2e] Checking ${route} during the public-route readiness sweep (${timeoutMs}ms timeout).`);
    await warmFetch(`${WEB_BASE_URL}${route}`, timeoutMs);
  }
}

export default async function globalSetup(
  _config: FullConfig,
): Promise<void | (() => Promise<void>)> {
  // Parse and validate the complete destructive-run contract before waiting on
  // any endpoint. This rejects the retired boolean opt-in and every implicit or
  // personal-development database target immediately.
  let disposableConfig: ReturnType<typeof assertDisposableDatabaseConfiguration> | null = null;
  if (!IS_DEPLOYED_QA) {
    assertDestructiveRuntimeSecrets();
    disposableConfig = assertDisposableDatabaseConfiguration();
  }

  // 1. The stack must be reachable. Fail fast with an actionable message.
  await waitForOk(`${API_BASE_URL}/api/v1/health`, 'API health');
  await waitForOk(`${WEB_BASE_URL}/`, 'Web app', WEB_READINESS_TIMEOUT_MS);

  if (IS_DEPLOYED_QA) {
    // eslint-disable-next-line no-console
    console.log('[e2e] Deployed QA mode: endpoints reachable; database reset and local readiness sweep skipped.');
    return;
  }

  let remoteLease: RemoteDisposableSuiteLease | null = null;
  let remoteDestructiveAuthorized = false;
  try {
    if (disposableConfig?.isRemote) {
      // One physical connection owns the remote suite lease from preflight
      // through returned teardown, so two destructive suites cannot overlap.
      remoteLease = await acquireRemoteDisposableSuiteLease();
      await verifyApiDatabaseBinding();
      remoteDestructiveAuthorized = true;
      await remoteLease.reset();
    } else {
      // Local fixed ports prevent concurrent managed stacks. Prove both direct
      // and API bindings before reset; resetDb re-proves identity under lock.
      await verifyDisposableDatabaseIdentity();
      await verifyApiDatabaseBinding();
      await resetDb();
    }
    // Re-prove the API binding after reset and before browser mutation.
    await verifyApiDatabaseBinding();
  } catch (err) {
    if (remoteLease) {
      try {
        if (remoteDestructiveAuthorized) {
          await finalResetVerifyAndRelease(remoteLease);
        } else {
          await remoteLease.release();
        }
      } catch {
        throw new Error(
          `Remote E2E setup failed and fail-closed final cleanup also failed.\n\n${LOCAL_STARTUP_HINT}`,
        );
      }
    }
    const safeMessage = err instanceof Error ? err.message : 'Unknown redacted database error.';
    throw new Error(
      `Could not prove and reset the isolated disposable database.\n${safeMessage}\n\n${LOCAL_STARTUP_HINT}`,
    );
  }

  // 4. Make a bounded best-effort public-route readiness sweep.
  await warmRoutes();

  // eslint-disable-next-line no-console
  console.log('[e2e] Stack reachable, database reset, public-route readiness sweep complete - starting tests.');

  // Playwright invokes the function returned by global setup after all tests,
  // including failed suites. Reset again so no known-password synthetic users,
  // sessions, documents, or tenant rows remain in a remote disposable target.
  return async () => {
    try {
      if (remoteLease) {
        await finalResetVerifyAndRelease(remoteLease);
      } else {
        await resetDb();
        await verifyApiDatabaseBinding();
      }
    } catch {
      throw new Error('E2E final database reset or binding verification failed (details redacted).');
    }
  };
}
