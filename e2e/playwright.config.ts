import { defineConfig, devices } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadDisposableDatabaseConfig } from './helpers/database-safety.cjs';

/**
 * CharityPilot end-to-end tests.
 *
 * Destructive runs drive an explicitly isolated disposable stack. Local mode
 * uses the fixed 127.0.0.1:3302 / :3303 endpoints; the exceptional remote mode
 * is accepted only by the database safety contract.
 *
 * They use NO external providers - document storage is the local filesystem
 * driver, Stripe/Resend are unconfigured (test mode / no-op), and one-time
 * tokens are read or injected via the database rather than a real mailbox.
 *
 * Determinism: the suite runs single-worker, resets before browser work and
 * performs final cleanup after the suite, preserving only the seeded governance
 * reference data. Tests use unique records; there are no endpoint or database
 * fallbacks.
 */
const isDeployedQa = process.env.E2E_DEPLOYED_QA === 'true';
const disposableConfig = isDeployedQa
  ? null
  : loadDisposableDatabaseConfig(process.env);

function requiredDeployedQaUrl(name: 'E2E_WEB_URL' | 'E2E_API_URL'): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required when E2E_DEPLOYED_QA=true.`);
  return value;
}

export const WEB_BASE_URL =
  disposableConfig?.webUrl ?? requiredDeployedQaUrl('E2E_WEB_URL');
export const API_BASE_URL =
  disposableConfig?.apiUrl ?? requiredDeployedQaUrl('E2E_API_URL');
const ARTIFACT_ROOT = resolve(
  process.cwd(),
  process.env.E2E_ARTIFACT_DIR ?? join(tmpdir(), 'charitypilot-e2e-artifacts'),
);

mkdirSync(join(ARTIFACT_ROOT, 'test-results'), { recursive: true });
mkdirSync(join(ARTIFACT_ROOT, 'html-report'), { recursive: true });

export default defineConfig({
  testDir: './tests',
  // Personal-stack readiness has its own non-destructive config and must never
  // enter the managed disposable suite or bypass its origin fence.
  testIgnore: /personal-local-readiness\.spec\.ts/,
  outputDir: join(ARTIFACT_ROOT, 'test-results'),
  globalSetup: require.resolve('./global-setup'),
  // The suite shares one database and one owner fixture, so it must not run
  // tests concurrently.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 600_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [
        ['list'],
        [
          'html',
          { open: 'never', outputFolder: join(ARTIFACT_ROOT, 'html-report') },
        ],
        ['github'],
      ]
    : [
        ['list'],
        [
          'html',
          { open: 'never', outputFolder: join(ARTIFACT_ROOT, 'html-report') },
        ],
      ],
  use: {
    baseURL: WEB_BASE_URL,
    serviceWorkers: 'block',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 20_000,
    // Local runs serve a baked production build. Keep explicit headroom for a
    // constrained Docker host or approved remote QA network; the navigation helper
    // reports a named timeout and never misclassifies it as a restart.
    navigationTimeout: 150_000,
  },
  projects: isDeployedQa
    ? [
        {
          name: 'deployed-chromium-desktop',
          use: { ...devices['Desktop Chrome'] },
        },
        {
          name: 'deployed-chromium-mobile',
          use: { ...devices['Pixel 7'] },
        },
        {
          name: 'deployed-firefox-desktop',
          use: { ...devices['Desktop Firefox'] },
        },
        {
          name: 'deployed-webkit-desktop',
          use: { ...devices['Desktop Safari'] },
        },
      ]
    : [
        {
          name: 'chromium',
          use: { ...devices['Desktop Chrome'] },
        },
      ],
});
