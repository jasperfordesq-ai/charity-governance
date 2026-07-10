import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  REQUIRED_GITHUB_PRODUCTION_VARIABLES,
  runProductionGitHubEnvironmentCheckFromArgs,
} from './check-production-github-env.mjs';

const repository = 'jasperfordesq-ai/charity-governance';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(repoRoot, 'scripts', 'check-production-github-env.mjs');

function okGh(payload) {
  return {
    status: 0,
    stdout: `${JSON.stringify(payload)}\n`,
    stderr: '',
  };
}

test('production GitHub environment check passes with canonical release variables', () => {
  const calls = [];
  const runGh = (args) => {
    calls.push(args);
    assert.deepEqual(args, [
      'variable',
      'list',
      '--env',
      'production',
      '--repo',
      repository,
      '--json',
      'name,value,updatedAt',
    ]);

    return okGh([
      { name: 'NEXT_PUBLIC_API_URL', value: 'https://api.charitypilot.ie', updatedAt: '2026-07-09T00:00:00Z' },
      {
        name: 'NEXT_PUBLIC_SUPABASE_URL',
        value: 'https://xjvdkmqbtczrnlqpswfa.supabase.co',
        updatedAt: '2026-07-09T00:00:00Z',
      },
    ]);
  };

  const result = runProductionGitHubEnvironmentCheckFromArgs([], { runGh });

  assert.equal(result.status, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(REQUIRED_GITHUB_PRODUCTION_VARIABLES.map((item) => item.name), [
    'NEXT_PUBLIC_API_URL',
    'NEXT_PUBLIC_SUPABASE_URL',
  ]);
  assert.match(result.stdout, /Production GitHub environment check passed/);
  assert.match(result.stdout, /secret values were not read/);
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, /xjvdkmqbtczrnlqpswfa/);
});

test('production GitHub environment check rejects sample Supabase project refs', () => {
  for (const projectRef of ['configured-project', 'example', 'ci-project']) {
    const result = runProductionGitHubEnvironmentCheckFromArgs([], {
      runGh: () =>
        okGh([
          { name: 'NEXT_PUBLIC_API_URL', value: 'https://api.charitypilot.ie', updatedAt: '2026-07-09T00:00:00Z' },
          {
            name: 'NEXT_PUBLIC_SUPABASE_URL',
            value: `https://${projectRef}.supabase.co`,
            updatedAt: '2026-07-09T00:00:00Z',
          },
        ]),
    });

    assert.equal(result.status, 1, `${projectRef} must be rejected`);
    assert.match(
      result.stderr,
      /GitHub production variable NEXT_PUBLIC_SUPABASE_URL must not use a sample Supabase project ref/,
    );
    assert.doesNotMatch(result.stderr, new RegExp(projectRef));
  }
});

test('production GitHub environment check fails for missing and placeholder variables', () => {
  const result = runProductionGitHubEnvironmentCheckFromArgs([], {
    runGh: () =>
      okGh([
        { name: 'NEXT_PUBLIC_API_URL', value: 'https://api.charitypilot.ie', updatedAt: '2026-07-09T00:00:00Z' },
        {
          name: 'NEXT_PUBLIC_SUPABASE_URL',
          value: 'https://REAL_SUPABASE_PROJECT_REF.supabase.co',
          updatedAt: '2026-07-09T00:00:00Z',
        },
      ]),
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Production GitHub environment check failed \(1 issue/);
  assert.match(
    result.stderr,
    /GitHub production variable NEXT_PUBLIC_SUPABASE_URL must not contain placeholder text/,
  );
  assert.match(
    result.stderr,
    /gh variable set NEXT_PUBLIC_SUPABASE_URL --env production --repo jasperfordesq-ai\/charity-governance --body "https:\/\/<project-ref>\.supabase\.co"/,
  );
  assert.doesNotMatch(result.stderr, /REAL_SUPABASE_PROJECT_REF/);
});

test('production GitHub environment check validates canonical API and Supabase origins', () => {
  const result = runProductionGitHubEnvironmentCheckFromArgs([], {
    runGh: () =>
      okGh([
        { name: 'NEXT_PUBLIC_API_URL', value: 'https://charitypilot.ie', updatedAt: '2026-07-09T00:00:00Z' },
        {
          name: 'NEXT_PUBLIC_SUPABASE_URL',
          value: 'https://documents.charitypilot.ie',
          updatedAt: '2026-07-09T00:00:00Z',
        },
      ]),
  });

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /GitHub production variable NEXT_PUBLIC_API_URL must equal https:\/\/api\.charitypilot\.ie/,
  );
  assert.match(
    result.stderr,
    /GitHub production variable NEXT_PUBLIC_SUPABASE_URL must be an origin-only HTTPS Supabase project URL/,
  );
});

test('production GitHub environment check renders redacted JSON for automation', () => {
  const result = runProductionGitHubEnvironmentCheckFromArgs(['--json'], {
    runGh: () =>
      okGh([
        { name: 'NEXT_PUBLIC_API_URL', value: 'https://api.charitypilot.ie', updatedAt: '2026-07-09T00:00:00Z' },
        {
          name: 'NEXT_PUBLIC_SUPABASE_URL',
          value: 'https://REAL_SUPABASE_PROJECT_REF.supabase.co',
          updatedAt: '2026-07-09T00:00:00Z',
        },
      ]),
  });

  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.environment, 'production');
  assert.deepEqual(payload.requiredVariableNames, ['NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_SUPABASE_URL']);
  assert.deepEqual(payload.missingVariableNames, []);
  assert.equal(payload.issueCount, 1);
  assert.match(payload.issues.join('\n'), /NEXT_PUBLIC_SUPABASE_URL must not contain placeholder text/);
  assert.equal(payload.secretValuesRead, false);
  assert.equal(payload.valuesRead, true);
  assert.doesNotMatch(result.stdout, /REAL_SUPABASE_PROJECT_REF/);
});

test('production GitHub environment check rejects unknown options', () => {
  const result = runProductionGitHubEnvironmentCheckFromArgs(['--surprise']);

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Unknown option: --surprise/);
  assert.match(result.stderr, /Usage: node scripts\/check-production-github-env\.mjs/);
});

test('production GitHub environment check rejects empty inline options before gh calls', () => {
  for (const args of [
    ['--environment='],
    ['--repo='],
    ['--repository='],
  ]) {
    let called = false;
    const result = runProductionGitHubEnvironmentCheckFromArgs(args, {
      runGh: () => {
        called = true;
        return okGh([]);
      },
    });

    assert.equal(result.status, 2, `${args.join(' ')} should be rejected as usage`);
    assert.equal(called, false);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /requires a value/);
    assert.match(result.stderr, /Usage: node scripts\/check-production-github-env\.mjs/);
  }
});

test('production GitHub environment check CLI prints usage', () => {
  const result = spawnSync(process.execPath, [scriptPath, '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: node scripts\/check-production-github-env\.mjs/);
  assert.equal(result.stderr, '');
});

test('production GitHub environment check redacts gh failure transcripts', () => {
  const result = runProductionGitHubEnvironmentCheckFromArgs([], {
    runGh: () => ({
      status: 1,
      stdout: 'DATABASE_URL=postgresql://user:pass@db.charitypilot.ie:5432/app\n',
      stderr:
        'failed with STRIPE_SECRET_KEY=sk_live_secret123 and https://example.test/hook?token=ghp_secret123',
    }),
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /gh variable list failed/);
  assert.doesNotMatch(result.stderr, /postgresql:\/\/user:pass/);
  assert.doesNotMatch(result.stderr, /sk_live_secret123/);
  assert.doesNotMatch(result.stderr, /ghp_secret123/);
  assert.match(result.stderr, /DATABASE_URL=\[redacted\]/);
  assert.match(result.stderr, /STRIPE_SECRET_KEY=\[redacted\]/);
});
