'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Button, Card, CardBody, Input, Textarea } from '@heroui/react';
import { ownerApi, type TenantSummary } from '@/lib/owner-api';
import { apiErrorMessage } from '@/lib/errors';

type Action = 'SUSPEND' | 'REACTIVATE' | 'CLOSE';

function isConflictError(error: unknown): boolean {
  return (error as { response?: { status?: unknown } })?.response?.status === 409;
}

export default function OwnerTenantDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [tenant, setTenant] = useState<TenantSummary | null>(null);
  const [reason, setReason] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ownerApi.getTenant(id).then(setTenant).catch(() => setError('Could not load this tenant.'));
  }, [id]);

  async function run(action: Action) {
    if (!tenant) return;
    setError(null);
    try {
      // expectedLifecycleVersion is what makes a stale tab fail loudly with a
      // 409 instead of silently overwriting someone else's change.
      setTenant(
        await ownerApi.transitionLifecycle(tenant.id, {
          action,
          reason,
          expectedLifecycleVersion: tenant.lifecycleVersion,
        }),
      );
      setReason('');
      setConfirmName('');
    } catch (err) {
      // A 409 means someone else changed this tenant since we loaded it — the
      // version we sent is stale. Never present that as a generic failure: the
      // operator needs to know to reload before trying again, or they will keep
      // retrying against data that no longer matches what's on screen.
      if (isConflictError(err)) {
        setError('This tenant was changed by another operator since you loaded this page. Reload the page and try again.');
      } else {
        setError(apiErrorMessage(err, 'That change could not be applied.'));
      }
    }
  }

  if (!tenant) return <p>{error ?? 'Loading…'}</p>;

  const closeArmed = confirmName === tenant.name;

  return (
    <Card>
      <CardBody className="gap-4">
        <h1 className="text-2xl font-semibold">{tenant.name}</h1>
        <p>
          Status: {tenant.lifecycleStatus} · Plan: {tenant.plan ?? '—'} · Users: {tenant.userCount}
        </p>
        {error ? <p className="text-danger">{error}</p> : null}

        <Textarea label="Reason (recorded in the audit trail)" value={reason} onValueChange={setReason} />

        <div className="flex flex-wrap gap-2">
          {tenant.lifecycleStatus === 'ACTIVE' ? (
            <Button color="warning" isDisabled={!reason.trim()} onPress={() => run('SUSPEND')}>
              Suspend
            </Button>
          ) : null}
          {tenant.lifecycleStatus === 'SUSPENDED' ? (
            <Button color="success" isDisabled={!reason.trim()} onPress={() => run('REACTIVATE')}>
              Reactivate
            </Button>
          ) : null}
        </div>

        {tenant.lifecycleStatus !== 'CLOSED' ? (
          <div className="flex flex-col gap-2 rounded border border-danger p-4">
            <p className="text-sm">Closing is permanent from this console. Type the organisation name to confirm.</p>
            <Input label="Organisation name" value={confirmName} onValueChange={setConfirmName} />
            <Button color="danger" isDisabled={!closeArmed || !reason.trim()} onPress={() => run('CLOSE')}>
              Close this organisation
            </Button>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
