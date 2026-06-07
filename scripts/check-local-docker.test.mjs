import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');

function readRepoFile(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('base compose remains database-only for local development', () => {
  const compose = readRepoFile('compose.yml');

  assert.match(compose, /\nservices:\s*\n\s+db:/);
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
  assert.match(compose, /NODE_ENV:\s+development/);
  assert.match(compose, /DATABASE_URL:\s+postgresql:\/\/charitypilot:charitypilot_dev@db:5432\/charitypilot/);
  assert.match(compose, /FRONTEND_URL:\s+http:\/\/localhost:3003/);
  assert.match(compose, /NEXT_PUBLIC_API_URL:\s+http:\/\/localhost:3002/);
  assert.match(compose, /3002:3002/);
  assert.match(compose, /3003:3003/);
  assert.match(compose, /prisma migrate deploy --schema apps\/api\/prisma\/schema\.prisma/);
  assert.match(compose, /\/api\/v1\/health/);
  assert.match(compose, /api:[\s\S]*deps:[\s\S]*condition:\s+service_completed_successfully/);
  assert.match(compose, /web:[\s\S]*deps:[\s\S]*condition:\s+service_completed_successfully/);
  assert.doesNotMatch(compose, /api:[\s\S]*command:[\s\S]*npm\s+(ci|install)/);
  assert.doesNotMatch(compose, /web:[\s\S]*command:[\s\S]*npm\s+(ci|install)/);
});

test('local Docker overlay does not weaken production image gates', () => {
  const localCompose = readRepoFile('compose.local.yml');
  const apiDockerfile = readRepoFile('apps/api/Dockerfile');
  const webDockerfile = readRepoFile('apps/web/Dockerfile');

  assert.doesNotMatch(localCompose, /\n\s+build:/);
  assert.match(localCompose, /image:\s+node:22-alpine/);
  assert.match(apiDockerfile, /ENV\s+NODE_ENV=production/);
  assert.match(apiDockerfile, /CMD\s+\["node",\s*"dist\/start\.js"\]/);
  assert.match(webDockerfile, /NEXT_PUBLIC_API_URL must be set to a production https:\/\/ URL/);
  assert.match(webDockerfile, /CMD\s+\["node",\s*"server\.mjs"\]/);
});

test('local Docker compose overlay renders as a valid effective model', () => {
  const result = spawnSync(
    'docker',
    ['compose', '-f', 'compose.yml', '-f', 'compose.local.yml', 'config', '--quiet'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: process.env,
      timeout: 30_000,
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
});
