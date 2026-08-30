import axios from 'axios';
import { configuredApiOrigin } from './api';

// withCredentials so the Path-scoped owner cookie is sent; the tenant client is
// deliberately a separate instance so neither can carry the other's cookies.
const client = axios.create({
  baseURL: `${configuredApiOrigin}/api/v1/owner`,
  withCredentials: true,
});

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
    const { data } = await client.post('/auth/login', { email, password });
    return data.operator as { id: string; email: string; name: string };
  },
  async logout() {
    await client.post('/auth/logout');
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
