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

const API_URL = getApiBaseUrl();

function redirectToLoginOnProtectedRoute() {
  if (typeof window === 'undefined' || !isProtectedAppPath(window.location.pathname)) {
    return;
  }

  const loginUrl = new URL('/login', window.location.origin);
  loginUrl.searchParams.set('next', `${window.location.pathname}${window.location.search}`);
  window.location.href = `${loginUrl.pathname}${loginUrl.search}`;
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
        await axios.post(`${API_URL}/api/v1/auth/refresh`, {}, { withCredentials: true });
        return api(original);
      } catch {
        if (!original.skipAuthRedirect) {
          redirectToLoginOnProtectedRoute();
        }
      }
    }

    return Promise.reject(error);
  },
);
