import assert from 'node:assert/strict';
import test from 'node:test';
import { runLocalAuthDeliveryOnce } from '../utils/cron.js';

test('local API cron advances durable authentication delivery with bounded settings', async () => {
  const calls: unknown[] = [];
  const messages: string[] = [];
  await runLocalAuthDeliveryOnce({
    async processDueDeliveries(input) {
      calls.push(input);
      return {
        processed: 1,
        accepted: 1,
        rejected: 0,
        uncertain: 0,
        keyUnavailable: 0,
        retryScheduled: 0,
        staleQuarantined: 0,
        cleaned: 0,
      };
    },
  }, {
    info(message) { messages.push(message); },
    error() { throw new Error('unexpected local auth-delivery error'); },
  });

  assert.deepEqual(calls, [{ limit: 25, cleanupLimit: 500, staleSendingMs: 60_000 }]);
  assert.match(messages.join('\n'), /processed 1 item/);
});

test('local API cron contains delivery failures and reports a sanitized error', async () => {
  const errors: Array<[string, unknown]> = [];
  await runLocalAuthDeliveryOnce({
    async processDueDeliveries() {
      throw new Error('local provider unavailable');
    },
  }, {
    info() {},
    error(message, error) { errors.push([message, error]); },
  });

  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], '[CRON] Local authentication delivery failed:');
  assert.equal((errors[0][1] as { stack?: unknown }).stack, '[redacted]');
  assert.doesNotMatch(JSON.stringify(errors[0][1]), /at runLocalAuthDeliveryOnce|\.ts:\d+/i);
});
