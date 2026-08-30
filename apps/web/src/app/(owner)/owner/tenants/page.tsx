'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Chip, Input, Table, TableBody, TableCell, TableColumn, TableHeader, TableRow } from '@heroui/react';
import { ownerApi, type TenantSummary } from '@/lib/owner-api';

const STATUS_COLOR = {
  ACTIVE: 'success',
  SUSPENDED: 'warning',
  CLOSED: 'danger',
} as const;

export default function OwnerTenantsPage() {
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      ownerApi
        .listTenants(q ? { q } : {})
        .then((result) => {
          if (!cancelled) setTenants(result.tenants);
        })
        .catch(() => {
          if (!cancelled) setError('Could not load tenants.');
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q]);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Tenants</h1>
      <Input placeholder="Search name, RCN, CRO or owner email" value={q} onValueChange={setQ} />
      {error ? <p className="text-danger">{error}</p> : null}
      <Table aria-label="Tenants">
        <TableHeader>
          <TableColumn>Name</TableColumn>
          <TableColumn>Status</TableColumn>
          <TableColumn>Plan</TableColumn>
          <TableColumn>Users</TableColumn>
        </TableHeader>
        <TableBody emptyContent="No tenants found.">
          {tenants.map((tenant) => (
            <TableRow key={tenant.id}>
              <TableCell>
                <Link href={`/owner/tenants/${tenant.id}`}>{tenant.name}</Link>
              </TableCell>
              <TableCell>
                <Chip color={STATUS_COLOR[tenant.lifecycleStatus]} size="sm">
                  {tenant.lifecycleStatus}
                </Chip>
              </TableCell>
              <TableCell>{tenant.plan ?? '—'}</TableCell>
              <TableCell>{tenant.userCount}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
