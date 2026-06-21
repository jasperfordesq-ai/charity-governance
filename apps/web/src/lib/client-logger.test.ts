import assert from 'node:assert/strict';
import test from 'node:test';
import { logClientError } from './client-logger';

// Concern: graceful degradation — when the error boundary logs a failure in production,
// it must record ONLY a redacted summary (status / code / digest / name) and never the
// raw error message or stack (which can carry tokens, emails, or internal details).

function captureConsoleError(fn: () => void): string[] {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  const prevEnv = process.env.NODE_ENV;
  try {
    fn();
  } finally {
    console.error = original;
    process.env.NODE_ENV = prevEnv;
  }
  return lines;
}

test('in production logClientError records only a redacted summary, never the raw message or stack', () => {
  process.env.NODE_ENV = 'production';
  const secret = 'super-secret-refresh-token-abc123';
  const error = Object.assign(new Error(`leaky message containing ${secret}`), {
    stack: `Error: leaky\n  at secretFunction (${secret})`,
    digest: 'DG-9',
    code: 'ECONN',
    response: { status: 503, data: { code: 'PLAN_FEATURE_UNAVAILABLE' } },
  });

  const lines = captureConsoleError(() => logClientError('[Dashboard Error]', error));
  const out = lines.join('\n');

  assert.ok(!out.includes(secret), 'the raw secret-bearing message/stack must never be logged in production');
  assert.ok(!out.includes('leaky message'), 'the raw error message must never be logged in production');
  // It DOES keep the safe, curated diagnostics.
  assert.match(out, /status=503/);
  assert.match(out, /code=PLAN_FEATURE_UNAVAILABLE/);
  assert.match(out, /digest=DG-9/);
});

test('logClientError summarises an unknown/primitive error without throwing', () => {
  process.env.NODE_ENV = 'production';
  for (const odd of [null, undefined, 'oops', 7]) {
    const lines = captureConsoleError(() => logClientError('boom', odd));
    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith('boom:'));
  }
});
