import assert from 'node:assert/strict';
import test from 'node:test';
import { isPlanFeatureUnavailable, isSubscriptionLapseError } from './plan-feature';

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

test('identifies subscription/trial lapse API errors', () => {
  for (const code of ['TRIAL_EXPIRED', 'NO_SUBSCRIPTION', 'PAST_DUE_GRACE_EXPIRED', 'SUBSCRIPTION_INACTIVE']) {
    assert.equal(
      isSubscriptionLapseError({ response: { status: 403, data: { code } } }),
      true,
      `${code} should be a subscription lapse`,
    );
  }
});

test('does not treat other errors as subscription lapses', () => {
  // A plan-feature denial is a different concern (upgrade a feature, not reactivate billing).
  assert.equal(isSubscriptionLapseError({ response: { status: 403, data: { code: 'PLAN_FEATURE_UNAVAILABLE' } } }), false);
  assert.equal(isSubscriptionLapseError({ response: { status: 403, data: { code: 'FORBIDDEN' } } }), false);
  assert.equal(isSubscriptionLapseError({ response: { status: 401, data: { code: 'TRIAL_EXPIRED' } } }), false);
  assert.equal(isSubscriptionLapseError(new Error('network')), false);
});
