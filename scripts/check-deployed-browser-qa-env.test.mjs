import assert from 'node:assert/strict';
import test from 'node:test';

async function loadRunner() {
  return import('./check-deployed-browser-qa-env.mjs');
}

const completeEnv = Object.freeze({
  E2E_DEPLOYED_QA: 'true',
  E2E_WEB_URL: 'https://app.charitypilot.ie',
  E2E_API_URL: 'https://api.charitypilot.ie',
  E2E_OWNER_EMAIL: 'launch-owner@example.com',
  E2E_OWNER_PASSWORD: 'correct horse battery staple',
});

test('deployed browser QA env preflight passes without printing credentials', async () => {
  const { runDeployedBrowserQaEnvCheckFromArgs } = await loadRunner();

  const result = runDeployedBrowserQaEnvCheckFromArgs(['--json'], { env: completeEnv });
  const payload = JSON.parse(result.stdout);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(payload.ok, true);
  assert.equal(payload.webUrl, 'https://app.charitypilot.ie');
  assert.equal(payload.apiUrl, 'https://api.charitypilot.ie');
  assert.equal(payload.credentialsPresent, true);
  assert.equal(payload.secretValuesPrinted, false);
  assert.doesNotMatch(result.stdout, /correct horse battery staple/);
  assert.doesNotMatch(result.stdout, /launch-owner@example\.com/);
});

test('deployed browser QA env preflight fails closed for local or incomplete configuration', async () => {
  const { runDeployedBrowserQaEnvCheckFromArgs } = await loadRunner();

  const result = runDeployedBrowserQaEnvCheckFromArgs(['--json'], {
    env: {
      E2E_DEPLOYED_QA: 'false',
      E2E_WEB_URL: 'http://localhost:3003',
      E2E_API_URL: 'https://api.charitypilot.ie',
      E2E_OWNER_EMAIL: '',
      E2E_OWNER_PASSWORD: 'secret',
    },
  });
  const payload = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.equal(payload.ok, false);
  assert.match(payload.issues.join('\n'), /E2E_DEPLOYED_QA must be true/);
  assert.match(payload.issues.join('\n'), /E2E_WEB_URL must be the canonical deployed web origin/);
  assert.match(payload.issues.join('\n'), /E2E_OWNER_EMAIL must be supplied/);
  assert.equal(payload.secretValuesPrinted, false);
  assert.doesNotMatch(result.stdout, /correct horse battery staple/);
});

test('deployed browser QA env preflight rejects copied credential placeholders', async () => {
  const { runDeployedBrowserQaEnvCheckFromArgs } = await loadRunner();

  const result = runDeployedBrowserQaEnvCheckFromArgs(['--json'], {
    env: {
      ...completeEnv,
      E2E_OWNER_EMAIL: 'SECRET_STORE_E2E_OWNER_EMAIL',
      E2E_OWNER_PASSWORD: 'SECRET_STORE_E2E_OWNER_PASSWORD',
    },
  });
  const payload = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.equal(payload.ok, false);
  assert.match(payload.issues.join('\n'), /E2E_OWNER_EMAIL must come from the approved non-sensitive test workspace secret store/);
  assert.match(payload.issues.join('\n'), /E2E_OWNER_PASSWORD must come from the approved non-sensitive test workspace secret store/);
  assert.equal(payload.credentialsPresent, false);
  assert.equal(payload.secretValuesPrinted, false);
  assert.doesNotMatch(result.stdout, /SECRET_STORE_E2E_OWNER_EMAIL/);
  assert.doesNotMatch(result.stdout, /SECRET_STORE_E2E_OWNER_PASSWORD/);
});

test('deployed browser QA env preflight renders operator-safe text guidance', async () => {
  const { runDeployedBrowserQaEnvCheckFromArgs } = await loadRunner();

  const result = runDeployedBrowserQaEnvCheckFromArgs([], { env: completeEnv });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Deployed browser QA environment preflight passed/);
  assert.match(result.stdout, /npm run test:e2e:responsive/);
  assert.match(result.stdout, /browserQa\.checks/);
  assert.doesNotMatch(result.stdout, /correct horse battery staple/);
});
