import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { webTenancyIsMulti } from '@/lib/deployment-profile';

/**
 * The platform console exists only on a deployment that hosts several
 * charities.
 *
 * The API has always been the authority here: `ownerRoutes` returns without
 * registering anything when the deployment is single-tenant, so every path
 * under `/api/v1/owner` answers 404. The pages did not know that, so on a
 * single-tenant deployment they rendered a console, a login form and a tenant
 * table that could only ever fail against endpoints which were not there.
 *
 * Failing the same way the API does — not found, rather than a broken screen —
 * means the two agree about whether this console exists.
 */
export default function OwnerTenancyGate({ children }: { children: ReactNode }) {
  if (!webTenancyIsMulti()) notFound();
  return <>{children}</>;
}
