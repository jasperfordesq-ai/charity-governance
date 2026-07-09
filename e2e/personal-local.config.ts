import { defineConfig, devices } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const PERSONAL_LOCAL_WEB_BASE_URL = process.env.E2E_WEB_URL ?? 'http://localhost:3003';
export const PERSONAL_LOCAL_API_BASE_URL = process.env.E2E_API_URL ?? 'http://localhost:3002';

const ARTIFACT_ROOT = resolve(
  process.cwd(),
  process.env.E2E_ARTIFACT_DIR ?? join(tmpdir(), 'charitypilot-personal-local-artifacts'),
);

mkdirSync(join(ARTIFACT_ROOT, 'test-results'), { recursive: true });
mkdirSync(join(ARTIFACT_ROOT, 'html-report'), { recursive: true });

export default defineConfig({
  testDir: './tests',
  testMatch: /personal-local-readiness\.spec\.ts/,
  outputDir: join(ARTIFACT_ROOT, 'test-results'),
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 1_200_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: join(ARTIFACT_ROOT, 'html-report') }]],
  use: {
    baseURL: PERSONAL_LOCAL_WEB_BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 180_000,
  },
  projects: [
    {
      name: 'personal-local-chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
