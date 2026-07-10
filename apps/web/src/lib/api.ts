import axios from 'axios';
import { getApiBaseUrl } from './api-config';
import { isProtectedAppPath } from './protected-routes';

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
  NEXT_PUBLIC_CHARITYPILOT_E2E_MODE: process.env.NEXT_PUBLIC_CHARITYPILOT_E2E_MODE,
});

function redirectToLoginOnProtectedRoute() {
  if (typeof window === 'undefined' || !isProtectedAppPath(window.location.pathname)) {
    return;
  }

  const loginUrl = new URL('/login', window.location.origin);
  loginUrl.searchParams.set('next', `${window.location.pathname}${window.location.search}`);
  window.location.href = `${loginUrl.pathname}${loginUrl.search}`;
}

// Single-flight token refresh. When several requests 401 at once (e.g. a page
// firing parallel GETs after the access token expires) they must share ONE
// refresh call — otherwise the concurrent calls present the same rotated,
// single-use refresh token, trip the backend's reuse detection, and get the
// whole session revoked (forced logout). Reused while a refresh is in flight,
// then cleared so a later expiry starts a fresh one.
let refreshPromise: Promise<void> | null = null;

function refreshSession(): Promise<void> {
  if (!refreshPromise) {
    refreshPromise = axios
      .post(`${API_URL}/api/v1/auth/refresh`, {}, { withCredentials: true })
      .then(() => undefined)
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

api.interceptors.response.use(
  (response) => {
    if (
      response.data &&
      typeof response.data === 'object' &&
      'data' in response.data &&
      !('total' in response.data) &&
      !('page' in response.data)
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
        await refreshSession();
        return api(original);
      } catch {
        if (!original.skipAuthRedirect) {
          redirectToLoginOnProtectedRoute();
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
