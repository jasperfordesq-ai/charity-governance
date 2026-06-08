import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const DOCKER_COMPOSE_CONFIG_TIMEOUT_MS = 120_000;

function readRepoFile(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function packageJson() {
  return JSON.parse(readRepoFile('package.json'));
}

test('base compose remains database-only for local development', () => {
  const compose = readRepoFile('compose.yml');

  assert.match(compose, /\nservices:\s*\n\s+db:/);
  assert.match(compose, /ports:[\s\S]*127\.0\.0\.1:5434:5432/);
  assert.doesNotMatch(compose, /\n\s+api:/);
  assert.doesNotMatch(compose, /\n\s+web:/);
});

test('local Docker overlay installs and runs API and web in development mode', () => {
  const localComposePath = join(repoRoot, 'compose.local.yml');
  assert.equal(existsSync(localComposePath), true, 'compose.local.yml must exist');

  const compose = readRepoFile('compose.local.yml');

  assert.match(compose, /\nservices:\s*\n\s+deps:/);
  assert.match(compose, /\n\s+api:/);
  assert.match(compose, /\n\s+web:/);
  assert.match(compose, /deps:[\s\S]*environment:[\s\S]*NODE_ENV:\s+development/);
  assert.match(compose, /deps:[\s\S]*user:\s+\$\{CHARITYPILOT_LOCAL_CONTAINER_USER:-root\}/);
  assert.match(compose, /deps:[\s\S]*npm ci --include=dev/);
  assert.match(compose, /api:[\s\S]*user:\s+\$\{CHARITYPILOT_LOCAL_CONTAINER_USER:-root\}/);
  assert.match(compose, /web:[\s\S]*user:\s+\$\{CHARITYPILOT_LOCAL_CONTAINER_USER:-root\}/);
  assert.match(compose, /NODE_ENV:\s+development/);
  assert.match(compose, /DATABASE_URL:\s+postgresql:\/\/charitypilot:charitypilot_dev@db:5432\/charitypilot/);
  assert.match(compose, /FRONTEND_URL:\s+http:\/\/localhost:3003/);
  assert.match(compose, /NEXT_PUBLIC_API_URL:\s+http:\/\/localhost:3002/);
  assert.match(compose, /127\.0\.0\.1:3002:3002/);
  assert.match(compose, /127\.0\.0\.1:3003:3003/);
  assert.match(compose, /prisma migrate deploy --schema apps\/api\/prisma\/schema\.prisma/);
  assert.match(compose, /\/api\/v1\/health/);
  assert.match(compose, /api:[\s\S]*deps:[\s\S]*condition:\s+service_completed_successfully/);
  assert.match(compose, /web:[\s\S]*deps:[\s\S]*condition:\s+service_completed_successfully/);
  assert.doesNotMatch(compose, /api:[\s\S]*command:[\s\S]*npm\s+(ci|install)/);
  assert.doesNotMatch(compose, /web:[\s\S]*command:[\s\S]*npm\s+(ci|install)/);
});

test('local development defaults use the documented API port', () => {
  const apiServer = readRepoFile('apps/api/src/server.ts');
  const webApiConfig = readRepoFile('apps/web/src/lib/api-config.ts');
  const rootEnvExample = readRepoFile('.env.example');

  assert.match(apiServer, /parsePort\(process\.env\.PORT,\s*3002\)/);
  assert.match(webApiConfig, /DEFAULT_DEVELOPMENT_API_URL\s*=\s*'http:\/\/localhost:3002'/);
  assert.match(rootEnvExample, /PORT=3002/);
});

test('web local env example matches the development CSP API origin', () => {
  const webEnvExample = readRepoFile('apps/web/.env.local.example');
  const contentSecurityPolicy = readRepoFile('apps/web/src/lib/content-security-policy.ts');
  const match = webEnvExample.match(/^NEXT_PUBLIC_API_URL=(.+)$/m);

  assert.ok(match, 'apps/web/.env.local.example must define NEXT_PUBLIC_API_URL');
  assert.match(contentSecurityPolicy, new RegExp(match[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('local Docker overlay does not weaken production image gates', () => {
  const localCompose = readRepoFile('compose.local.yml');
  const apiDockerfile = readRepoFile('apps/api/Dockerfile');
  const webDockerfile = readRepoFile('apps/web/Dockerfile');

  assert.doesNotMatch(localCompose, /\n\s+build:/);
  assert.match(localCompose, /image:\s+\$\{CHARITYPILOT_LOCAL_NODE_IMAGE:-node:22-alpine\}/);
  assert.match(apiDockerfile, /ENV\s+NODE_ENV=production/);
  assert.match(apiDockerfile, /CMD\s+\["node",\s*"dist\/start\.js"\]/);
  assert.match(webDockerfile, /NEXT_PUBLIC_API_URL must be an origin-only CharityPilot production URL/);
  assert.match(webDockerfile, /CMD\s+\["node",\s*"server\.mjs"\]/);
});

test('local Docker compose overlay renders as a valid effective model with loopback-bound ports', () => {
  const result = spawnSync(
    'docker',
    ['compose', '-f', 'compose.yml', '-f', 'compose.local.yml', 'config'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: process.env,
      timeout: DOCKER_COMPOSE_CONFIG_TIMEOUT_MS,
    },
  );

  if (result.error?.code === 'EPERM') {
    const baseCompose = readRepoFile('compose.yml');
    const localCompose = readRepoFile('compose.local.yml');

    assert.match(baseCompose, /127\.0\.0\.1:5434:5432/);
    assert.match(localCompose, /127\.0\.0\.1:3002:3002/);
    assert.match(localCompose, /127\.0\.0\.1:3003:3003/);
    return;
  }

  assert.equal(
    result.status,
    0,
    result.stderr ||
      result.error?.message ||
      `docker compose config did not complete within ${DOCKER_COMPOSE_CONFIG_TIMEOUT_MS}ms`,
  );
  assert.match(result.stdout, /host_ip:\s+127\.0\.0\.1[\s\S]*target:\s+3002[\s\S]*published:\s+"3002"/);
  assert.match(result.stdout, /host_ip:\s+127\.0\.0\.1[\s\S]*target:\s+3003[\s\S]*published:\s+"3003"/);
  assert.match(result.stdout, /host_ip:\s+127\.0\.0\.1[\s\S]*target:\s+5432[\s\S]*published:\s+"5434"/);
});

test('local Docker smoke script boots the stack and checks API plus web over loopback', () => {
  const rootPackage = packageJson();
  const smokeScriptPath = join(repoRoot, 'scripts', 'smoke-local-docker.mjs');
  assert.equal(rootPackage.scripts['test:local-docker:smoke'], 'node scripts/smoke-local-docker.mjs');
  assert.equal(existsSync(smokeScriptPath), true, 'scripts/smoke-local-docker.mjs must exist');

  const smokeScript = readRepoFile('scripts/smoke-local-docker.mjs');
  assert.match(smokeScript, /compose\.yml/);
  assert.match(smokeScript, /compose\.local\.yml/);
  assert.match(smokeScript, /mkdirSync\(join\(repoRoot, 'apps', 'web', '\.next'\), \{ recursive: true \}\)/);
  assert.match(smokeScript, /const nextEnvPath = join\(repoRoot, 'apps', 'web', 'next-env\.d\.ts'\)/);
  assert.match(smokeScript, /const nextEnvSnapshot = existsSync\(nextEnvPath\) \? readFileSync\(nextEnvPath, 'utf8'\) : null/);
  assert.match(smokeScript, /writeFileSync\(nextEnvPath, nextEnvSnapshot\)/);
  assert.match(smokeScript, /'up', '--wait', '--wait-timeout', '180', '-d'/);
  assert.match(smokeScript, /http:\/\/127\.0\.0\.1:3002\/api\/v1\/health/);
  assert.match(smokeScript, /http:\/\/127\.0\.0\.1:3002\/api\/v1\/health\/readiness/);
  assert.match(smokeScript, /x-charitypilot-readiness-key/);
  assert.match(smokeScript, /local-readiness-key-at-least-32-characters/);
  assert.match(smokeScript, /http:\/\/127\.0\.0\.1:3003\//);
  assert.match(smokeScript, /CharityPilot/);
  assert.doesNotMatch(smokeScript, /down', '-v'/);
});

test('local Docker migrations are a first-class command and are dry-runnable', () => {
  const rootPackage = packageJson();
  const migrationScriptPath = join(repoRoot, 'scripts', 'migrate-local-docker.mjs');

  assert.equal(rootPackage.scripts['db:migrate:local-docker'], 'node scripts/migrate-local-docker.mjs');
  assert.equal(existsSync(migrationScriptPath), true, 'scripts/migrate-local-docker.mjs must exist');

  const result = spawnSync('node', ['scripts/migrate-local-docker.mjs', '--dry-run'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  });

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /docker compose -f compose\.yml -f compose\.local\.yml up --wait --wait-timeout 180 -d db/);
  assert.match(result.stdout, /docker compose -f compose\.yml -f compose\.local\.yml run --rm --no-deps -T deps sh -lc "npm ci --include=dev && npm run build -w @charitypilot\/shared && npm run db:generate -w @charitypilot\/api"/);
  assert.match(result.stdout, /docker compose -f compose\.yml -f compose\.local\.yml run --rm --no-deps -T api npx prisma migrate deploy --schema apps\/api\/prisma\/schema\.prisma/);
  assert.match(result.stdout, /docker compose -f compose\.yml -f compose\.local\.yml run --rm --no-deps -T api npx prisma migrate status --schema apps\/api\/prisma\/schema\.prisma/);
});

test('local Docker smoke reapplies migrations even when services are already running', () => {
  const smokeScript = readRepoFile('scripts/smoke-local-docker.mjs');

  assert.match(smokeScript, /migrate-local-docker\.mjs/);
  assert.match(smokeScript, /await runLocalDockerMigrations\(\)/);
  assert.ok(
    smokeScript.indexOf('await runLocalDockerMigrations()') < smokeScript.indexOf('if (localServicesAreRunning())'),
    'local migrations must run before reusing or starting local app services',
  );
  assert.ok(
    smokeScript.indexOf('await runLocalDockerMigrations()') < smokeScript.indexOf("await waitForCheck('API health'"),
    'local migrations must run before API readiness assertions',
  );
});

test('CI runs the local Docker smoke before production Docker image gates', () => {
  const workflow = readRepoFile('.github/workflows/ci.yml');

  assert.match(workflow, /name:\s+Smoke local Docker app stack/);
  assert.match(workflow, /run:\s+npm run test:local-docker:smoke -- --cleanup --cleanup-volumes/);
  assert.ok(
    workflow.indexOf('name: Test') < workflow.indexOf('name: Smoke local Docker app stack'),
    'local Docker smoke must run after static tests',
  );
  assert.ok(
    workflow.indexOf('name: Smoke local Docker app stack') < workflow.indexOf('name: Build API Docker image'),
    'local Docker smoke must pass before production image gates',
  );
});
