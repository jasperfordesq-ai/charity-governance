import assert from 'node:assert/strict';
import test from 'node:test';
import { isPlanFeatureUnavailable } from './plan-feature';

test('identifies Complete-plan feature denial API errors', () => {
  assert.equal(isPlanFeatureUnavailable({
    response: {
      status: 403,
      data: { code: 'PLAN_FEATURE_UNAVAILABLE' },
    },
  }), true);
});

test('does not treat unrelated API errors as plan feature denials', () => {
  assert.equal(isPlanFeatureUnavailable({ response: { status: 403, data: { code: 'FORBIDDEN' } } }), false);
  assert.equal(isPlanFeatureUnavailable({ response: { status: 500, data: { code: 'PLAN_FEATURE_UNAVAILABLE' } } }), false);
  assert.equal(isPlanFeatureUnavailable(new Error('network')), false);
});
