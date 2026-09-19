'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Button,
  Chip,
  Input,
  Select,
  SelectItem,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from '@heroui/react';
import { ownerApi, type TenantSummary } from '@/lib/owner-api';

const STATUS_COLOR = {
  ACTIVE: 'success',
  SUSPENDED: 'warning',
  CLOSED: 'danger',
} as const;

type StatusFilter = 'ALL' | keyof typeof STATUS_COLOR;

const STATUS_OPTIONS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'ALL', label: 'All statuses' },
  { key: 'ACTIVE', label: 'Active' },
  { key: 'SUSPENDED', label: 'Suspended' },
  { key: 'CLOSED', label: 'Closed' },
];

export default function OwnerTenantsPage() {
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('ALL');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The first page reloads whenever the search or the filter changes, and
  // replaces what is on screen. Later pages append. Without the distinction,
  // typing a letter after loading three pages would leave the earlier pages
  // showing results that no longer match.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      ownerApi
        .listTenants({ ...(q ? { q } : {}), ...(status === 'ALL' ? {} : { status }) })
        .then((result) => {
          if (cancelled) return;
          setTenants(result.tenants);
          setNextCursor(result.nextCursor);
          setError(null);
        })
        .catch(() => {
          if (!cancelled) setError('Could not load tenants.');
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, status]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await ownerApi.listTenants({
        ...(q ? { q } : {}),
        ...(status === 'ALL' ? {} : { status }),
        cursor: nextCursor,
      });
      setTenants((current) => [...current, ...result.tenants]);
      setNextCursor(result.nextCursor);
      setError(null);
    } catch {
      setError('Could not load more tenants.');
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, q, status]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Tenants</h1>
        <Button as={Link} href="/owner/tenants/new" color="primary">
          Provision tenant
        </Button>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Input
          className="sm:flex-1"
          placeholder="Search name, RCN, CRO or owner email"
          value={q}
          onValueChange={setQ}
        />
        <Select
          aria-label="Filter by status"
          className="sm:max-w-[220px]"
          selectedKeys={[status]}
          onSelectionChange={(keys) => {
            const next = Array.from(keys)[0];
            if (typeof next === 'string') setStatus(next as StatusFilter);
          }}
        >
          {STATUS_OPTIONS.map((option) => (
            <SelectItem key={option.key}>{option.label}</SelectItem>
          ))}
        </Select>
      </div>

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

      {/* Without this, every tenant past the first page is unreachable from the
          console: the API has always returned a cursor and nothing spent it. */}
      {nextCursor ? (
        <div className="flex justify-center">
          <Button variant="flat" onPress={loadMore} isLoading={loadingMore}>
            Load more
          </Button>
        </div>
      ) : (
        <p className="text-center text-sm text-gray-500">
          {tenants.length === 0 ? null : `${tenants.length} shown, and that is all of them.`}
        </p>
      )}
    </div>
  );
}
