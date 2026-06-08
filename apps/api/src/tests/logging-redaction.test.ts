import assert from 'node:assert/strict';
import test from 'node:test';
import { apiLoggerOptionsForEnvironment, serializeErrorForLog } from '../utils/logger.js';
import { errorHandlerPlugin } from '../plugins/error-handler.js';

const { default: Fastify } = await import('fastify');

test('production logger redacts browser credentials, provider secrets, and auth tokens', () => {
  const loggerOptions = apiLoggerOptionsForEnvironment('production');
  assert.equal(typeof loggerOptions, 'object');
  assert.notEqual(loggerOptions, null);

  const redact = (loggerOptions as { redact?: { censor?: string; paths?: string[] } }).redact;
  assert.equal(redact?.censor, '[redacted]');
  assert.ok(redact?.paths?.includes('req.headers.authorization'));
  assert.ok(redact?.paths?.includes('req.headers.cookie'));
  assert.ok(redact?.paths?.includes('req.headers["stripe-signature"]'));
  assert.ok(redact?.paths?.includes('body.password'));
  assert.ok(redact?.paths?.includes('body.refreshToken'));
  assert.ok(redact?.paths?.includes('refreshToken'));
  assert.ok(redact?.paths?.includes('accessToken'));
  assert.ok(redact?.paths?.includes('env.SUPABASE_SERVICE_ROLE_KEY'));

  const serialized = JSON.stringify(serializeErrorForLog(
    new Error('Provider failed token=raw-token user@example.org org-1/private-policy.pdf'),
  ));
  assert.equal(serialized.includes('raw-token'), false);
  assert.equal(serialized.includes('user@example.org'), false);
  assert.equal(serialized.includes('org-1/private-policy.pdf'), false);
  assert.equal(serialized.includes('token=[redacted]'), true);
});

test('production error handler logs sanitized error metadata without raw provider details', async () => {
  const logLines: string[] = [];
  const loggerOptions = apiLoggerOptionsForEnvironment('production');
  assert.equal(typeof loggerOptions, 'object');
  assert.notEqual(loggerOptions, null);

  const app = Fastify({
    logger: {
      ...(loggerOptions as Record<string, unknown>),
      stream: {
        write(line: string) {
          logLines.push(line);
        },
      },
    },
  });
  await app.register(errorHandlerPlugin);
  app.get('/boom', async () => {
    throw new Error('Storage provider failed token=raw-token user@example.org org-1/private-policy.pdf');
  });

  try {
    const response = await app.inject({ method: 'GET', url: '/boom' });

    assert.equal(response.statusCode, 500);
    const serializedLogs = logLines.join('\n');
    assert.equal(serializedLogs.includes('raw-token'), false);
    assert.equal(serializedLogs.includes('user@example.org'), false);
    assert.equal(serializedLogs.includes('org-1/private-policy.pdf'), false);
    assert.equal(serializedLogs.includes('token=[redacted]'), true);
  } finally {
    await app.close();
  }
});
