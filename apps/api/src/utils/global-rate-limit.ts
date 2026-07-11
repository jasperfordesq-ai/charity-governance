const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const GLOBAL_API_RATE_LIMIT_MAX_PER_MINUTE = 100;
export const MANAGED_E2E_GLOBAL_API_RATE_LIMIT_MAX_PER_MINUTE = 10_000;

/**
 * The managed browser suite intentionally funnels every synthetic browser and
 * server-side request through one fixed gateway IP. Its UUID-bound,
 * non-production disposable runtime therefore needs a larger coarse bucket;
 * route-specific auth, token, and identity-probe limits still override it.
 */
export function globalApiRateLimitMax(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const disposableE2eRuntime =
    env.NODE_ENV !== 'production' &&
    env.E2E_DATABASE_IDENTITY_PROBE_ENABLED === 'true' &&
    typeof env.E2E_DATABASE_INSTANCE_ID === 'string' &&
    UUID_V4_PATTERN.test(env.E2E_DATABASE_INSTANCE_ID);

  return disposableE2eRuntime
    ? MANAGED_E2E_GLOBAL_API_RATE_LIMIT_MAX_PER_MINUTE
    : GLOBAL_API_RATE_LIMIT_MAX_PER_MINUTE;
}
