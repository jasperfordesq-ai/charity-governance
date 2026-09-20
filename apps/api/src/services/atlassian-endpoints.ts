/**
 * Where Atlassian is.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * THIS FILE CAN REDIRECT WHERE A CHARITY'S OAUTH TOKENS ARE SENT. READ THE
 * FENCE BEFORE CHANGING ANYTHING IN IT.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The three URLs below were hard-coded constants, which is the safest thing a
 * URL that receives an authorization code can be. They are resolved through a
 * function now for exactly one reason: an end-to-end test needs the API to talk
 * to a fake Atlassian, and a browser-driven test cannot inject a `fetch` double
 * the way the unit tests do.
 *
 * That is a genuine hazard. An environment variable that repoints the token
 * endpoint is, if it ever took effect on a real deployment, a way to send a
 * charity's Atlassian authorization codes to somebody else. So the override is
 * fenced three times over, and each fence is independent:
 *
 *  1. **`CHARITYPILOT_FAKE_ATLASSIAN` must be exactly `1`.** A base URL alone
 *     does nothing. There is no way to trip this by setting one plausible-
 *     looking variable.
 *  2. **`NODE_ENV` must not be `production`.** Production servers set it, and
 *     `production-scheduler.ts` and `server.ts` both default it to
 *     `production` when it is unset — so the dangerous direction fails closed.
 *  3. **`validateProductionEnv` refuses to boot** when either variable is
 *     present on a production path, so a deployment that somehow acquired one
 *     stops rather than quietly redirecting.
 *
 * The override must also be a loopback or private address, checked here, so
 * even a test misconfiguration cannot point it at the open internet.
 *
 * `atlassian-endpoints.test.ts` pins all of it, including that production
 * ignores the variables entirely.
 */

const PRODUCTION_TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const PRODUCTION_ACCESSIBLE_RESOURCES_URL =
  'https://api.atlassian.com/oauth/token/accessible-resources';
const PRODUCTION_API_BASE = 'https://api.atlassian.com/ex/confluence';

/** The two variables the fence is built on. Named once so the guard and the resolver agree. */
export const FAKE_ATLASSIAN_FLAG = 'CHARITYPILOT_FAKE_ATLASSIAN';
export const FAKE_ATLASSIAN_BASE_URL = 'CHARITYPILOT_FAKE_ATLASSIAN_BASE_URL';

export type AtlassianEndpoints = {
  tokenUrl: string;
  accessibleResourcesUrl: string;
  apiBase: string;
};

/**
 * Whether the host part of a URL is a loopback or private address.
 *
 * Belt and braces on top of the two flags: a test stack misconfigured to point
 * at a public host would still be refused. Deliberately conservative — it
 * accepts loopback, the RFC1918 ranges, and Docker-style single-label service
 * names, and nothing else.
 */
export function isLocalOverrideHost(host: string): boolean {
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  // A compose service name: one label, no dots, so it cannot be a public
  // hostname and cannot carry a registrable domain.
  if (/^[a-z0-9][a-z0-9-]*$/i.test(host)) return true;
  return false;
}

/**
 * The override base URL, or `undefined` when every fence says no.
 *
 * Exported so the boot guard and the tests can ask the same question the
 * resolver asks, rather than reimplementing it and drifting.
 */
export function resolveFakeAtlassianBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (env[FAKE_ATLASSIAN_FLAG] !== '1') return undefined;
  // Fails closed when NODE_ENV is unset: the entry points default it to
  // 'production', and an unset value here is treated as production anyway.
  if ((env.NODE_ENV ?? 'production') === 'production') return undefined;

  const raw = env[FAKE_ATLASSIAN_BASE_URL];
  if (typeof raw !== 'string' || raw.length === 0) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  if (!isLocalOverrideHost(parsed.hostname)) return undefined;

  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/**
 * The endpoints this process should use.
 *
 * Resolved per call rather than cached at module load, because the tests need
 * to vary the environment and a cached value would make the fence untestable —
 * and an untestable fence is not a fence.
 */
export function atlassianEndpoints(
  env: Record<string, string | undefined> = process.env,
): AtlassianEndpoints {
  const base = resolveFakeAtlassianBaseUrl(env);
  if (base === undefined) {
    return {
      tokenUrl: PRODUCTION_TOKEN_URL,
      accessibleResourcesUrl: PRODUCTION_ACCESSIBLE_RESOURCES_URL,
      apiBase: PRODUCTION_API_BASE,
    };
  }

  return {
    tokenUrl: `${base}/oauth/token`,
    accessibleResourcesUrl: `${base}/oauth/token/accessible-resources`,
    apiBase: `${base}/ex/confluence`,
  };
}

/** The real endpoints, for a test that needs to assert what production uses. */
export const PRODUCTION_ATLASSIAN_ENDPOINTS: AtlassianEndpoints = {
  tokenUrl: PRODUCTION_TOKEN_URL,
  accessibleResourcesUrl: PRODUCTION_ACCESSIBLE_RESOURCES_URL,
  apiBase: PRODUCTION_API_BASE,
};
