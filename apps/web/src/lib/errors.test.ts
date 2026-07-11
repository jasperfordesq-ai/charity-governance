import assert from 'node:assert/strict';
import test from 'node:test';
import { apiErrorMessage, isApiForbiddenError, isApiNotFoundError } from './errors';

// Concern: graceful degradation / input validation — a server error must render a
// SAFE, SPECIFIC message (never a raw exception or stack), and the renderer must never
// throw on a malformed/odd error shape.

test('apiErrorMessage surfaces the server error field first', () => {
  assert.equal(
    apiErrorMessage({ response: { data: { error: 'Password must contain at least one uppercase letter' } } }, 'fallback'),
    'Password must contain at least one uppercase letter',
  );
});

test('isApiNotFoundError recognises axios-style 404 responses only', () => {
  assert.equal(isApiNotFoundError({ response: { status: 404, data: { code: 'ORG_NOT_FOUND' } } }), true);
  assert.equal(isApiNotFoundError({ response: { status: 403, data: { code: 'FORBIDDEN' } } }), false);
  assert.equal(isApiNotFoundError({ response: { status: '404' } }), false);
  assert.equal(isApiNotFoundError(new Error('not found')), false);
  assert.equal(isApiNotFoundError(null), false);
});

test('isApiForbiddenError recognises only the exact role-denial contract', () => {
  assert.equal(isApiForbiddenError({ response: { status: 403, data: { code: 'FORBIDDEN' } } }), true);
  assert.equal(isApiForbiddenError({ response: { status: 403, data: { code: 'PLAN_FEATURE_UNAVAILABLE' } } }), false);
  assert.equal(isApiForbiddenError({ response: { status: 403, data: { code: 'TRIAL_EXPIRED' } } }), false);
  assert.equal(isApiForbiddenError({ response: { status: 403, data: {} } }), false);
  assert.equal(isApiForbiddenError({ response: { status: 401, data: { code: 'FORBIDDEN' } } }), false);
  assert.equal(isApiForbiddenError({ response: { status: '403', data: { code: 'FORBIDDEN' } } }), false);
  assert.equal(isApiForbiddenError({ response: null }), false);
  assert.equal(isApiForbiddenError(null), false);
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
