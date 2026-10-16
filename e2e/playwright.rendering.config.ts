import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Pure synthetic renderer checks: no application, database, login or live origin.
// Keep separate from the fenced, authenticated application end-to-end suite.
export default defineConfig({
  testDir: './rendering',
  outputDir: join(tmpdir(), `charitypilot-renderer-tests-${process.pid}`),
  workers: 1,
  use: { browserName: 'chromium', headless: true },
});
