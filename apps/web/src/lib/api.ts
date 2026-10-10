import axios from 'axios';
import { getApiBaseUrl } from './api-config';
import { isProtectedAppPath, renewsItsOwnSession } from './protected-routes';
import { safeNextValue } from './url-security';
import { coordinateSessionEstablishment, coordinateSessionLogout, coordinateSessionRefresh,
  SessionRefreshLockUnavailableError } from './session-refresh-lock';

declare module 'axios' {
  export interface AxiosRequestConfig {
    _retry?: boolean;
    skipAuthRefresh?: boolean;
    skipAuthRedirect?: boolean;
  }

  export interface InternalAxiosRequestConfig {
    _retry?: boolean;
    skipAuthRefresh?: boolean;
    skipAuthRedirect?: boolean;
  }
}

// Next.js only substitutes NEXT_PUBLIC_* values into browser bundles when the
// property access is statically visible. Passing the ambient process.env object
// through getApiBaseUrl's default parameter makes the client silently fall back
// to the personal-development API even when an isolated URL was configured.
const API_URL = getApiBaseUrl({
  NODE_ENV: process.env.NODE_ENV,
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE:
    process.env.NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE,
  NEXT_PUBLIC_CHARITYPILOT_E2E_MODE: process.env.NEXT_PUBLIC_CHARITYPILOT_E2E_MODE,
  NEXT_PUBLIC_CHARITYPILOT_CANONICAL_API_ORIGIN:
    process.env.NEXT_PUBLIC_CHARITYPILOT_CANONICAL_API_ORIGIN,
});

// The exact origin this browser bundle was built to call. Auth screens compare it
// with the page origin so an origin rejection is not reported as a bad password.
export const configuredApiOrigin: string | undefined = (() => {
  try {
    return new URL(API_URL).origin;
  } catch {
    return undefined;
  }
})();

/**
 * The third and last place that sends a signed-out visitor to `/login?next=…`,
 * after `proxy.ts` (server-side) and `dashboard-session-gate.ts`
 * (the dashboard layout). All three answer the same two questions the same
 * way, from the same two helpers, because the alternative is what happened
 * twice already: a leak fixed at one door and left open at the next.
 *
 * `renewsItsOwnSession` — the Confluence callback page renews the session
 * itself, so redirecting it away abandons the connection AND carries
 * Atlassian's live `?code=…&state=…` into the `next` value.
 *
 * `safeNextValue` — for every other protected path, `next` is built with the
 * single-use secrets removed, because the reverse proxy's log filter deletes
 * only TOP-LEVEL `code`/`state` and cannot see one nested inside `next`.
 *
 * Both calls the Confluence flow makes today set `skipAuthRedirect`, so this
 * function does not fire on that path at all. That is a per-call-site
 * convention, not a guarantee: one future call added without the flag would
 * reopen the leak silently. The checks below are what makes it structural.
 */
function redirectToLoginOnProtectedRoute(renewalUnavailable = false) {
  if (typeof window === 'undefined' || !isProtectedAppPath(window.location.pathname)) {
    return;
  }

  if (renewsItsOwnSession(window.location.pathname)) return;

  const loginUrl = new URL('/login', window.location.origin);
  loginUrl.searchParams.set(
    'next',
    safeNextValue(window.location.pathname, window.location.search),
  );
  if (renewalUnavailable) loginUrl.searchParams.set('session', 'renewal-unavailable');
  window.location.href = `${loginUrl.pathname}${loginUrl.search}`;
}

// Single-flight token refresh. When several requests 401 at once (e.g. a page
// firing parallel GETs after the access token expires) they must share ONE
// refresh call — otherwise the concurrent calls present the same rotated,
// single-use refresh token, trip the backend's reuse detection, and get the
// whole session revoked (forced logout). Reused while a refresh is in flight,
// then cleared so a later expiry starts a fresh one.
let refreshPromise: Promise<void> | null = null;

// Exported so a caller that must control the ordering against its own request
// (see `confluence-callback.ts`) can renew the session *before* making that
// request, rather than relying on this module's own reactive 401 handling —
// which only refreshes after the first attempt has already been sent.
export function refreshSession(afterUnauthorised = false): Promise<void> {
  if (!refreshPromise) {
    let storage: Storage | undefined;
    try {
      storage = typeof window === 'undefined' ? undefined : window.localStorage;
    } catch {
      // Browser privacy settings can make localStorage unavailable.
    }
    refreshPromise = coordinateSessionRefresh(
      () => axios.post(`${API_URL}/api/v1/auth/refresh`, {}, { withCredentials: true }).then(() => undefined),
      typeof navigator === 'undefined' ? undefined : navigator.locks,
      storage,
      undefined,
      afterUnauthorised ? async () => {
        // Use raw Axios: the shared response interceptor would otherwise
        // recurse into refresh on the expected 401 from this probe.
        const response = await axios.get(`${API_URL}/api/v1/auth/me`, {
          withCredentials: true,
          validateStatus: (status) => status === 200 || status === 401,
        });
        return response.status === 200;
      } : undefined,
      (error) => axios.isAxiosError(error) && error.response?.status === 429,
    )
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

export const api = axios.create({
  baseURL: `${API_URL}/api/v1`,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
});

/** Keep every browser session-issuing request under the shared refresh lock.
 * Call this around login and invitation acceptance, not merely after them. */
export async function establishSession<T>(request: () => Promise<T>): Promise<T> {
  let storage: Storage | undefined;
  try {
    storage = typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    // The server remains responsible for cookies when storage is unavailable.
  }
  return coordinateSessionEstablishment(
    request,
    typeof navigator === 'undefined' ? undefined : navigator.locks,
    storage,
  );
}

// Logout must never renew the credential it is trying to revoke. Callers wait
// for this response (including cookie clearance) before leaving the page.
export async function logoutSession(): Promise<void> {
  let storage: Storage | undefined;
  try {
    storage = typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    // The shared Web Lock still serializes logout and refresh.
  }
  await coordinateSessionLogout(
    () => api.post('/auth/logout', {}, { skipAuthRefresh: true, skipAuthRedirect: true }).then(() => undefined),
    typeof navigator === 'undefined' ? undefined : navigator.locks,
    storage,
  );
}

api.interceptors.response.use(
  (response) => {
    // Only the single-field transport wrapper is unwrapped. Cursor and other
    // metadata belong to the response, even when a page also has a `data` field.
    if (
      response.data &&
      typeof response.data === 'object' &&
      Object.keys(response.data).length === 1 &&
      'data' in response.data
    ) {
      response.data = response.data.data;
    }
    return response;
  },
  async (error) => {
    const original = error.config;

    if (
      error.response?.status === 401 &&
      original &&
      !original._retry &&
      !original.skipAuthRefresh
    ) {
      original._retry = true;

      try {
        await refreshSession(true);
        return api(original);
      } catch (cause) {
        if (!original.skipAuthRedirect) {
          redirectToLoginOnProtectedRoute(cause instanceof SessionRefreshLockUnavailableError);
        }
        return Promise.reject(error);
      }
    }

    // A retried request that still 401s means the refreshed session is no longer
    // valid — send the user to login rather than leaving a broken protected page.
    if (error.response?.status === 401 && original?._retry && !original.skipAuthRedirect) {
      redirectToLoginOnProtectedRoute();
    }

    return Promise.reject(error);
  },
);
