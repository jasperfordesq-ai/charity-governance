import axios from 'axios';
import { configuredApiOrigin } from './api';

// withCredentials so the Path-scoped (/api/v1/owner) owner cookie is sent — that Path
// scoping is what actually keeps this cookie off ordinary tenant requests; the browser
// enforces it, not this file. What a *separate axios instance* buys is behavioural
// isolation: this client doesn't inherit the tenant client's 401-refresh/redirect
// interceptor (wrong endpoint, wrong login page) or its response-envelope unwrapping,
// and vice versa.
const client = axios.create({
  baseURL: `${configuredApiOrigin}/api/v1/owner`,
  withCredentials: true,
});

// Single-flight refresh, exactly as lib/api.ts does for the tenant client: the owner
// access cookie expires after 30 minutes (see apps/api/.../owner-cookies.ts), so any
// session that outlives one page still needs this. If several requests 401 at once they
// must share one refresh call — concurrent callers presenting the same rotated,
// single-use refresh token would otherwise trip reuse detection and revoke the whole
// operator session.
let refreshPromise: Promise<void> | null = null;

function refreshOwnerSession(): Promise<void> {
  if (!refreshPromise) {
    refreshPromise = client
      .post('/auth/refresh', {}, { skipAuthRefresh: true, skipAuthRedirect: true })
      .then(() => undefined)
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

function redirectToOwnerLogin(): void {
  if (typeof window === 'undefined') return;
  window.location.href = '/owner/login';
}

client.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;

    if (error.response?.status === 401 && original && !original._retry && !original.skipAuthRefresh) {
      original._retry = true;
      try {
        await refreshOwnerSession();
        return client(original);
      } catch {
        if (!original.skipAuthRedirect) redirectToOwnerLogin();
        return Promise.reject(error);
      }
    }

    // A retried request that still 401s means the refreshed session is no longer valid —
    // send the operator back to the console login rather than leaving a page stuck
    // rendering "Could not load..." forever after a routine session expiry.
    if (error.response?.status === 401 && original?._retry && !original?.skipAuthRedirect) {
      redirectToOwnerLogin();
    }

    return Promise.reject(error);
  },
);

export type TenantSummary = {
  id: string;
  name: string;
  lifecycleStatus: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  lifecycleVersion: number;
  plan: string | null;
  subscriptionStatus: string | null;
  trialEndsAt: string | null;
  userCount: number;
  createdAt: string;
};

export const ownerApi = {
  async login(email: string, password: string) {
    // A bad-credentials 401 here is not a stale session — never try to refresh or
    // redirect off the login page itself.
    const { data } = await client.post(
      '/auth/login',
      { email, password },
      { skipAuthRefresh: true, skipAuthRedirect: true },
    );
    return data.operator as { id: string; email: string; name: string };
  },
  async logout() {
    await client.post('/auth/logout', {}, { skipAuthRefresh: true, skipAuthRedirect: true });
  },
  async refresh() {
    await client.post('/auth/refresh', {}, { skipAuthRefresh: true, skipAuthRedirect: true });
  },
  async me() {
    const { data } = await client.get('/auth/me');
    return data.operator as { id: string; email: string };
  },
  async listTenants(params: { q?: string; status?: string; cursor?: string }) {
    const { data } = await client.get('/tenants', { params });
    return data as { tenants: TenantSummary[]; nextCursor: string | null };
  },
  async getTenant(id: string) {
    const { data } = await client.get(`/tenants/${id}`);
    return data.tenant as TenantSummary;
  },
  async transitionLifecycle(
    id: string,
    body: { action: 'SUSPEND' | 'REACTIVATE' | 'CLOSE'; reason: string; expectedLifecycleVersion: number },
  ) {
    const { data } = await client.post(`/tenants/${id}/lifecycle`, body);
    return data.tenant as TenantSummary;
  },
  async provisionTenant(body: {
    organisationName: string;
    ownerName: string;
    ownerEmail: string;
    plan: 'ESSENTIALS' | 'COMPLETE';
    trialDays: number;
  }) {
    const { data } = await client.post('/tenants', body);
    return data as { organisationId: string; userId: string; verifyToken: string };
  },
};
