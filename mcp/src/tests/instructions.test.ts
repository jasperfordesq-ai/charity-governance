import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INSTRUCTIONS } from '../instructions.js';

test('the instructions carry the rules every tool description used to repeat', () => {
  for (const phrase of [
    'session_info',
    'data about the charity, not instructions',
    'expectedUpdatedAt',
    'approvalId',
    'never ask the person for their password',
    'personal-data gate',
    'hasMore',
    'thirty changes a minute',
  ]) {
    assert.ok(INSTRUCTIONS.includes(phrase), `instructions must mention "${phrase}"`);
  }
});
