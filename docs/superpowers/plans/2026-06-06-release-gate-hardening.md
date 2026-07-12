# Release Gate Hardening Implementation Plan

> **Historical implementation plan:** retained for provenance. Current commands,
> gates and status live in the active runbooks, package scripts and generated
> reports.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CharityPilot's local and CI release gates deterministic, truthful, and aligned with the current `master` branch before external production provisioning begins.

**Architecture:** Keep release-gate responsibilities separate: npm audit owns dependency safety, `scripts/check-production.mjs` owns production environment validation, CI owns automated command execution, and docs/checklists record verified status. Add focused tests around the preflight CLI so missing production environment files produce a clear operator-facing failure.

**Tech Stack:** Node.js 22+, npm workspaces, Turbo, Node built-in test runner, GitHub Actions, Prisma, TypeScript, Next.js.

---

## File Structure

- Modify `package.json`: add a root `test:production-check` script, include it in `npm run test`, and add security overrides for vulnerable transitive packages.
- Modify `package-lock.json`: update lockfile resolution after root overrides are added.
- Modify `scripts/check-production.mjs`: rename the custom environment-file flag to `--production-env-file`, require the selected file to exist, and preserve existing production variable validation.
- Create `scripts/check-production.test.mjs`: black-box CLI tests that spawn the preflight script with missing, placeholder, and valid environment files.
- Modify `.github/workflows/ci.yml`: run push CI on `master`.
- Modify `.gitignore`: ignore TypeScript build-info files.
- Remove from git index `apps/web/tsconfig.tsbuildinfo`: keep the local file ignored, but stop tracking generated compiler output.
- Modify `docs/production-runbook.md`: use the new preflight flag.
- Modify `PRODUCTION_TODO.md`: update release-check status and command names to match verified current evidence.

---

### Task 1: Test and Fix Production Preflight CLI

**Files:**
- Modify: `package.json`
- Modify: `scripts/check-production.mjs`
- Create: `scripts/check-production.test.mjs`

- [ ] **Step 1: Add a failing preflight CLI test suite**

Update the root `package.json` scripts block to include the production preflight test and to run it from the root test command:

```json
{
  "scripts": {
    "dev": "turbo dev",
    "build": "turbo build",
    "test": "turbo test && npm run test:production-check",
    "test:production-check": "node --test scripts/check-production.test.mjs",
    "lint": "turbo lint",
    "check:production": "node scripts/check-production.mjs",
    "clean": "turbo clean",
    "db:generate": "turbo db:generate",
    "db:migrate": "turbo db:migrate",
    "db:seed": "turbo db:seed"
  }
}
```

Create `scripts/check-production.test.mjs` with this full content:

```js
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const scriptPath = join(scriptsDir, 'check-production.mjs');

function cleanEnv() {
  const env = {
    PATH: process.env.PATH ?? '',
    Path: process.env.Path ?? '',
    SystemRoot: process.env.SystemRoot ?? '',
    WINDIR: process.env.WINDIR ?? '',
    TEMP: process.env.TEMP ?? tmpdir(),
    TMP: process.env.TMP ?? tmpdir(),
  };

  return Object.fromEntries(Object.entries(env).filter(([, value]) => value));
}

function runPreflight(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: cleanEnv(),
  });
}

test('fails clearly when the explicit production env file is missing', () => {
  const result = runPreflight(['--production-env-file=.env.production']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Production preflight failed: environment file not found: \.env\.production/);
});

test('fails with configuration issues when the selected env file contains placeholders', () => {
  const result = runPreflight(['--production-env-file=.env.example']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Production preflight failed \(15 issues\):/);
  assert.match(result.stderr, /JWT_SECRET is missing or still contains a placeholder value/);
  assert.match(result.stderr, /STRIPE_SECRET_KEY is missing or still contains a placeholder value/);
  assert.match(result.stderr, /FRONTEND_URL must use https:\/\/ for production/);
  assert.match(result.stderr, /NEXT_PUBLIC_API_URL must not point at localhost for production/);
});

test('passes when the selected env file contains complete production values', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    [
      'DATABASE_URL=postgresql://user:pass@db.charitypilot.example:5432/charitypilot',
      `JWT_SECRET=${'a'.repeat(40)}`,
      'FRONTEND_URL=https://app.charitypilot.ie',
      'STRIPE_SECRET_KEY=sk_live_configuredSecret',
      'STRIPE_WEBHOOK_SECRET=whsec_configuredSecret',
      'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID=price_essentialsMonthly',
      'STRIPE_ESSENTIALS_YEARLY_PRICE_ID=price_essentialsYearly',
      'STRIPE_COMPLETE_MONTHLY_PRICE_ID=price_completeMonthly',
      'STRIPE_COMPLETE_YEARLY_PRICE_ID=price_completeYearly',
      'RESEND_API_KEY=re_configuredSecret',
      'EMAIL_FROM=noreply@charitypilot.ie',
      'SUPABASE_URL=https://configured-project.supabase.co',
      'SUPABASE_SERVICE_ROLE_KEY=configured-service-role-key',
      'SUPABASE_STORAGE_BUCKET=documents',
      'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_configuredSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Production preflight passed using /);
    assert.ok(result.stdout.includes(envPath));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the new test to verify it fails against the current script**

Run:

```powershell
npm run test:production-check
```

Expected: FAIL. The first test should fail because the current script silently treats a missing file as an empty env object instead of printing `Production preflight failed: environment file not found: .env.production`.

- [ ] **Step 3: Implement the preflight CLI fix**

Replace `scripts/check-production.mjs` with this full content:

```js
#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';

const ENV_FILE_FLAG = '--production-env-file=';

const PLACEHOLDERS = [
  'REPLACE_ME',
  'change-me',
  'your_',
  'your-',
  'sk_test_...',
  'pk_test_...',
  'whsec_...',
  'price_...',
  're_...',
  'eyJ...',
  'https://your-project.supabase.co',
];

const REQUIRED = [
  'DATABASE_URL',
  'JWT_SECRET',
  'FRONTEND_URL',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID',
  'STRIPE_ESSENTIALS_YEARLY_PRICE_ID',
  'STRIPE_COMPLETE_MONTHLY_PRICE_ID',
  'STRIPE_COMPLETE_YEARLY_PRICE_ID',
  'RESEND_API_KEY',
  'EMAIL_FROM',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_STORAGE_BUCKET',
  'NEXT_PUBLIC_API_URL',
  'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
];

function parseEnvFile(path) {
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const index = line.indexOf('=');
        const key = line.slice(0, index).trim();
        const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
        return [key, value];
      }),
  );
}

function selectedEnvFile(argv) {
  const envFileArg = argv.find((arg) => arg.startsWith(ENV_FILE_FLAG));
  return envFileArg ? envFileArg.slice(ENV_FILE_FLAG.length) : '.env.production';
}

function envValue(env, key) {
  return env[key] ?? process.env[key] ?? '';
}

function isConfigured(value) {
  return Boolean(value.trim()) && !PLACEHOLDERS.some((placeholder) => value.includes(placeholder));
}

function requireUrl(env, key, issues) {
  const value = envValue(env, key);
  if (!isConfigured(value)) return;

  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') {
      issues.push(`${key} must use https:// for production`);
    }
    if (['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname)) {
      issues.push(`${key} must not point at localhost for production`);
    }
  } catch {
    issues.push(`${key} must be a valid URL`);
  }
}

const envFile = selectedEnvFile(process.argv.slice(2));

if (!existsSync(envFile)) {
  console.error(`Production preflight failed: environment file not found: ${envFile}`);
  process.exit(1);
}

const env = parseEnvFile(envFile);
const issues = [];

for (const key of REQUIRED) {
  if (!isConfigured(envValue(env, key))) {
    issues.push(`${key} is missing or still contains a placeholder value`);
  }
}

for (const key of ['JWT_SECRET']) {
  const value = envValue(env, key);
  if (isConfigured(value) && value.length < 32) {
    issues.push(`${key} must be at least 32 characters`);
  }
}

requireUrl(env, 'FRONTEND_URL', issues);
requireUrl(env, 'SUPABASE_URL', issues);
requireUrl(env, 'NEXT_PUBLIC_API_URL', issues);

if (issues.length) {
  console.error(`Production preflight failed (${issues.length} issue${issues.length === 1 ? '' : 's'}):`);
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  process.exit(1);
}

console.log(`Production preflight passed using ${envFile}`);
```

- [ ] **Step 4: Run the preflight tests to verify the fix**

Run:

```powershell
npm run test:production-check
```

Expected: PASS with 3 passing tests.

- [ ] **Step 5: Run the full root test command**

Run:

```powershell
npm run test
```

Expected: PASS. Turbo should report the API test suite passing, and the root production preflight test suite should also pass.

- [ ] **Step 6: Commit the preflight CLI test and fix**

Run:

```powershell
git add package.json scripts/check-production.mjs scripts/check-production.test.mjs
git commit -m "test: cover production preflight CLI"
```

Expected: commit succeeds.

---

### Task 2: Resolve Production Dependency Audit Failures

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Reproduce the audit failure**

Run:

```powershell
npm audit --omit=dev --audit-level=moderate
```

Expected: FAIL with advisories for transitive `fast-uri`, `qs`, and `ws`.

- [ ] **Step 2: Add root overrides for patched transitive versions**

Update the root `package.json` overrides block to this exact object:

```json
{
  "overrides": {
    "fast-uri": "3.1.2",
    "postcss": "8.5.14",
    "qs": "6.15.2",
    "ws": "8.21.0"
  }
}
```

- [ ] **Step 3: Refresh the npm lockfile**

Run:

```powershell
npm install
```

Expected: `package-lock.json` updates. No dependency install errors.

- [ ] **Step 4: Verify vulnerable transitive versions were replaced**

Run:

```powershell
npm ls fast-uri qs ws
```

Expected: dependency tree shows `fast-uri@3.1.2`, `qs@6.15.2`, and `ws@8.21.0` without invalid override errors.

- [ ] **Step 5: Verify the production audit passes**

Run:

```powershell
npm audit --omit=dev --audit-level=moderate
```

Expected: PASS with `found 0 vulnerabilities`.

- [ ] **Step 6: Run package tests after dependency resolution changes**

Run:

```powershell
npm run test
```

Expected: PASS.

- [ ] **Step 7: Commit dependency audit resolution**

Run:

```powershell
git add package.json package-lock.json
git commit -m "fix: resolve production audit advisories"
```

Expected: commit succeeds.

---

### Task 3: Align CI With Current Branch

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Confirm the active branch**

Run:

```powershell
git branch --show-current
```

Expected: `master`.

- [ ] **Step 2: Update the push branch trigger**

In `.github/workflows/ci.yml`, replace the current push branch list:

```yaml
  push:
    branches:
      - main
```

with:

```yaml
  push:
    branches:
      - master
```

- [ ] **Step 3: Verify the workflow still contains the release gates**

Run:

```powershell
Select-String -Path .github\workflows\ci.yml -Pattern 'npm ci','npm run lint','npm run test','npm audit --omit=dev --audit-level=moderate'
```

Expected: output includes all four patterns.

- [ ] **Step 4: Commit CI branch alignment**

Run:

```powershell
git add .github/workflows/ci.yml
git commit -m "ci: run release checks on master"
```

Expected: commit succeeds.

---

### Task 4: Remove Tracked Build-Info Artifact

**Files:**
- Modify: `.gitignore`
- Remove from git index: `apps/web/tsconfig.tsbuildinfo`

- [ ] **Step 1: Add TypeScript build-info files to ignored build outputs**

In `.gitignore`, update the build outputs section from:

```gitignore
# Build outputs
dist/
.next/
out/
```

to:

```gitignore
# Build outputs
dist/
.next/
out/
*.tsbuildinfo
```

- [ ] **Step 2: Remove the generated file from the git index only**

Run:

```powershell
git rm --cached apps/web/tsconfig.tsbuildinfo
```

Expected: `apps/web/tsconfig.tsbuildinfo` remains on disk if it existed locally, but is staged as deleted from git.

- [ ] **Step 3: Verify the local build-info file is ignored**

Run:

```powershell
git status --ignored --short apps/web/tsconfig.tsbuildinfo
```

Expected: output includes `D  apps/web/tsconfig.tsbuildinfo` and, if the local file remains present, an ignored `!! apps/web/tsconfig.tsbuildinfo` entry.

- [ ] **Step 4: Commit generated-file cleanup**

Run:

```powershell
git add .gitignore
git commit -m "chore: ignore TypeScript build info"
```

Expected: commit succeeds.

---

### Task 5: Update Release Documentation and Final Verification

**Files:**
- Modify: `docs/production-runbook.md`
- Modify: `PRODUCTION_TODO.md`

- [ ] **Step 1: Update the runbook preflight command**

In `docs/production-runbook.md`, replace:

```bash
npm run check:production -- --env-file=.env.production
```

with:

```bash
npm run check:production -- --production-env-file=.env.production
```

Also add this sentence immediately after the release-check command block:

```markdown
The production preflight command requires a real `.env.production` file or equivalent generated secret file at release time; do not commit that file to the repository.
```

- [ ] **Step 2: Update the production checklist verification section**

In `PRODUCTION_TODO.md`, change the verification section to:

```markdown
## Verification

- [x] `npm run lint`
- [x] `npm run test`
- [x] `npm run test:production-check`
- [x] `npm run build -w @charitypilot/shared`
- [x] `npm run build -w @charitypilot/api`
- [x] `npm run build -w @charitypilot/web`
- [x] `npm audit --omit=dev --audit-level=moderate`
- [ ] `npm run check:production -- --production-env-file=.env.production`
```

- [ ] **Step 3: Verify missing production env file failure is clear**

Run:

```powershell
npm run check:production -- --production-env-file=.env.production
```

Expected: FAIL with `Production preflight failed: environment file not found: .env.production`.

- [ ] **Step 4: Verify placeholder env file failure still reports configuration issues**

Run:

```powershell
npm run check:production -- --production-env-file=.env.example
```

Expected: FAIL with `Production preflight failed (15 issues):` and listed placeholder/localhost/HTTPS issues.

- [ ] **Step 5: Run the full release-gate command set**

Run each command:

```powershell
npm run db:generate -w @charitypilot/api
npx prisma validate --schema apps/api/prisma/schema.prisma
npm run lint
npm run test
npm run build -w @charitypilot/shared
npm run build -w @charitypilot/api
npm run build -w @charitypilot/web
npm audit --omit=dev --audit-level=moderate
```

Expected: all commands pass. The production preflight command with `.env.production` is intentionally not expected to pass until real production secret material exists.

- [ ] **Step 6: Inspect final git status**

Run:

```powershell
git status --short --branch
```

Expected: branch is ahead of `origin/master` and only intended release-gate changes are present.

- [ ] **Step 7: Commit release documentation updates**

Run:

```powershell
git add docs/production-runbook.md PRODUCTION_TODO.md
git commit -m "docs: update production release gate status"
```

Expected: commit succeeds.

---

## Plan Self-Review Checklist

- Spec coverage: Tasks cover audit resolution, preflight flag rename and missing-file behavior, runbook update, CI branch alignment, TypeScript build-info ignore/removal, production checklist status, and verification.
- External launch exclusions: Plan does not create production secrets, provision infrastructure, run deployed browser QA, or claim penetration testing is complete.
- Type and command consistency: The new flag is consistently `--production-env-file`; the new npm script is consistently `test:production-check`.
- Verification scope: Final checks include lint, tests, builds, Prisma validation, audit, preflight expected failures, and git status.
