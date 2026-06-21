import assert from 'node:assert/strict';
import test from 'node:test';
import { apiErrorMessage } from './errors';

// Concern: graceful degradation / input validation — a server error must render a
// SAFE, SPECIFIC message (never a raw exception or stack), and the renderer must never
// throw on a malformed/odd error shape.

test('apiErrorMessage surfaces the server error field first', () => {
  assert.equal(
    apiErrorMessage({ response: { data: { error: 'Password must contain at least one uppercase letter' } } }, 'fallback'),
    'Password must contain at least one uppercase letter',
  );
});

test('apiErrorMessage falls back to the server message field', () => {
  assert.equal(
    apiErrorMessage({ response: { data: { message: 'Organisation name is required' } } }, 'fallback'),
    'Organisation name is required',
  );
});

test('apiErrorMessage uses the safe fallback when the server gives no message', () => {
  assert.equal(apiErrorMessage({ response: { data: {} } }, 'Something went wrong.'), 'Something went wrong.');
  assert.equal(apiErrorMessage({}, 'Something went wrong.'), 'Something went wrong.');
});

test('apiErrorMessage never throws or leaks on odd/hostile error shapes', () => {
  for (const odd of [null, undefined, 'a string', 42, new Error('boom'), { response: null }, { response: { data: null } }]) {
    const out = apiErrorMessage(odd, 'Safe fallback.');
    assert.equal(typeof out, 'string');
    // A raw Error's .message must NOT be surfaced — only the curated server fields or the fallback.
    assert.equal(out, 'Safe fallback.');
  }
});
