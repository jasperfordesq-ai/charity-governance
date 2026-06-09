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
