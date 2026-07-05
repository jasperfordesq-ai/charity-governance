import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * CharityPilot end-to-end tests.
 *
 * These drive a real Chromium browser against the LOCAL Docker stack:
 *   docker compose -f compose.yml -f compose.local.yml up
 *
 * They use NO external providers — document storage is the local filesystem
 * driver, Stripe/Resend are unconfigured (test mode / no-op), and one-time
 * tokens are read or injected via the database rather than a real mailbox.
 *
 * Determinism: the suite runs single-worker and resets the database between
 * tests (see fixtures.ts), preserving only the seeded governance reference
 * data. Override endpoints/DSN with E2E_WEB_URL / E2E_API_URL / E2E_DATABASE_URL.
 */

export const WEB_BASE_URL = process.env.E2E_WEB_URL ?? 'http://localhost:3003';
export const API_BASE_URL = process.env.E2E_API_URL ?? 'http://localhost:3002';
const ARTIFACT_ROOT = resolve(
  process.cwd(),
  process.env.E2E_ARTIFACT_DIR ?? join(tmpdir(), 'charitypilot-e2e-artifacts'),
);

export default defineConfig({
  testDir: './tests',
  outputDir: join(ARTIFACT_ROOT, 'test-results'),
  globalSetup: require.resolve('./global-setup'),
  // The suite shares one database and resets between tests, so it must not run
  // tests concurrently.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 600_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: join(ARTIFACT_ROOT, 'html-report') }], ['github']]
    : [['list'], ['html', { open: 'never', outputFolder: join(ARTIFACT_ROOT, 'html-report') }]],
  use: {
    baseURL: WEB_BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 20_000,
    // The local stack runs Next in DEV mode and compiles each route on first hit, which
    // can exceed 100s for protected pages when the host is under container load. Give cold
    // compiles generous headroom; warm hits are still fast (see global-setup warm-up).
    navigationTimeout: 150_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
