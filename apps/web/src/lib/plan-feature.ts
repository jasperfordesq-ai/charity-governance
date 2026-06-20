type ApiErrorShape = {
  response?: {
    status?: unknown;
    data?: {
      code?: unknown;
    };
  };
};

export function isPlanFeatureUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const response = (error as ApiErrorShape).response;
  return response?.status === 403 && response.data?.code === 'PLAN_FEATURE_UNAVAILABLE';
}

const SUBSCRIPTION_LAPSE_CODES = new Set([
  'TRIAL_EXPIRED',
  'NO_SUBSCRIPTION',
  'PAST_DUE_GRACE_EXPIRED',
  'SUBSCRIPTION_INACTIVE',
]);

/**
 * True when a request failed because the organisation's subscription/trial has
 * lapsed (an expected billing lifecycle), as opposed to a generic/network
 * failure. Lets the UI show "your subscription lapsed — manage billing" instead
 * of a misleading connection error.
 */
export function isSubscriptionLapseError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const response = (error as ApiErrorShape).response;
  if (response?.status !== 403) return false;
  const code = response.data?.code;
  return typeof code === 'string' && SUBSCRIPTION_LAPSE_CODES.has(code);
}
