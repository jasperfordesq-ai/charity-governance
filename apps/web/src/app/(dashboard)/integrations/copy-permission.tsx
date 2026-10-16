'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Input, Textarea } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage, isApiNotFoundError } from '@/lib/errors';
import { buildCopyPermission, COPY_PERMISSION_FIELDS, type CopyPermissionReview } from '@/lib/copy-permission';
import { PermissionWithdrawal } from './review-withdrawal';

type Permission = { id: string; reviewId: string; scopeId: string; snapshotSha256: string;
  issuedAt: string; expiresAt: string; withdrawal: { occurredAt: string } | null;
  review: { withdrawal: { occurredAt: string } | null } };
type Response = { permission: Permission; currentSourceChecked: false; providerIOAuthorised: false };
type Props = { review: CopyPermissionReview; role: string; busy: boolean;
  run: (action: () => Promise<void>) => Promise<void> };

/** Explicit synthetic decision recording and receipt reconciliation only. */
export function CopyPermission({ review, role, busy, run }: Props) {
  const [open, setOpen] = useState(false), [loaded, setLoaded] = useState(false);
  const [permission, setPermission] = useState<Permission | null>(null), [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({}), [confirmed, setConfirmed] = useState(false);
  const [outcome, setOutcome] = useState<'READY' | 'SAVING' | 'RECORDED' | 'UNKNOWN'>('READY');
  const [attemptedRef, setAttemptedRef] = useState('');
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const base = '/integrations/confluence/retained-copy-reviews';
  const lookup = async () => {
    setError('');
    try {
      const { data } = await api.get<Response>(`${base}/${review.id}/permission`);
      if (!active.current) return;
      if (data.currentSourceChecked !== false || data.providerIOAuthorised !== false
        || data.permission.reviewId !== review.id || data.permission.snapshotSha256 !== review.snapshotSha256) {
        throw new Error('Permission receipt does not match this review.');
      }
      setPermission(data.permission); setLoaded(true);
    } catch (cause) {
      if (!active.current) return;
      const code = (cause as { response?: { data?: { code?: string } } })?.response?.data?.code;
      if (isApiNotFoundError(cause) && code === 'CONFLUENCE_COPY_PERMISSION_NOT_FOUND') {
        setPermission(null); setLoaded(true);
      } else { setLoaded(false); setError(apiErrorMessage(cause, 'Permission receipts could not be verified.')); }
    }
  };
  let valid = false;
  try { buildCopyPermission({ role, review, fields, confirmed }); valid = true; } catch { /* The explicit form remains incomplete. */ }
  const issue = async () => {
    if (!loaded || permission || outcome !== 'READY') return;
    const body = buildCopyPermission({ role, review, fields, confirmed });
    setAttemptedRef(body.evidenceRef); setOutcome('SAVING'); setError('');
    try {
      const { data } = await api.post<{ permission: { id: string }; providerIOAuthorised: false }>(`${base}/${review.id}/permission`, body);
      if (!active.current) return;
      if (data.providerIOAuthorised !== false || !data.permission.id) throw new Error('The permission response could not be verified.');
      setOutcome('RECORDED');
    } catch (cause) {
      if (active.current) { setOutcome('UNKNOWN'); setError(apiErrorMessage(cause, 'The permission response could not be verified.')); }
      return;
    }
    await lookup();
  };
  if (!open) return <Button className="ml-2 mt-2" size="sm" variant="flat" isDisabled={busy}
    onPress={() => { setOpen(true); void run(lookup); }}>Review synthetic permission</Button>;
  const frozen = busy || outcome !== 'READY' || permission !== null || review.withdrawnAt !== null;
  return <section aria-label="Synthetic copy permission" className="mt-3 space-y-3 rounded border border-gray-300 p-3 break-normal dark:border-gray-600">
    <h6 className="font-medium">Synthetic copy disposal permission</h6>
    <p>This records a separate permission decision for the exact review. It does not execute erasure.
      A registered maintenance scope is required; use its receipt for the scope and policy references and expiry.</p>
    <p className="break-words">Review: {review.id} · snapshot digest: {review.snapshotSha256}</p>
    <Button size="sm" variant="flat" isDisabled={busy} onPress={() => void run(lookup)}>Refresh permission receipt</Button>
    {error ? <p role="alert" className="text-red-700 dark:text-red-300">{error}</p> : null}
    {outcome === 'UNKNOWN' ? <p role="status" className="text-amber-800 dark:text-amber-300">
      Permission outcome needs reconciliation. Refresh its receipt; absence does not prove a pending decision failed.
      Another issuance is blocked in this panel. Attempted reference: {attemptedRef}.
    </p> : null}
    {loaded && !permission ? <p>No permission receipt is listed. This does not prove an earlier in-flight issuance failed.</p> : null}
    {permission && loaded ? <div className="space-y-2">
      <p className="break-words">Recorded permission: {permission.id} · scope: {permission.scopeId}</p>
      <p>Issued {new Date(permission.issuedAt).toLocaleString('en-IE')} · expires {new Date(permission.expiresAt).toLocaleString('en-IE')}
        {permission.withdrawal ? ' · permission withdrawn' : ''}{permission.review.withdrawal ? ' · review withdrawn' : ''}</p>
      <p>This is a historical receipt. Current source and provider authority have not been verified by this lookup.</p>
      <PermissionWithdrawal review={{ id: permission.id, evidenceRef: null, withdrawnAt: permission.withdrawal?.occurredAt ?? null }}
        busy={busy} run={run} refresh={lookup} />
    </div> : null}
    {loaded && !permission && !review.withdrawnAt ? <form className="space-y-3" onSubmit={event => { event.preventDefault(); void run(issue); }}>
      {COPY_PERMISSION_FIELDS.map(({ key, label }) => <Input key={key} label={label} value={fields[key] ?? ''}
        onValueChange={value => setFields(previous => ({ ...previous, [key]: value }))} isRequired isDisabled={busy} isReadOnly={frozen}
        classNames={{ label: 'text-gray-700 dark:text-gray-200', description: 'text-gray-600 dark:text-gray-300' }}
        description={key === 'expiresAt' ? 'Exact UTC time, e.g. YYYY-MM-DDTHH:mm:ss.sssZ; no later than the review or registered scope expiry.' : undefined} />)}
      <Textarea label="Permission reason" value={fields.reason ?? ''} onValueChange={reason => setFields(previous => ({ ...previous, reason }))}
        isRequired isDisabled={busy} isReadOnly={frozen} classNames={{ label: 'text-gray-700 dark:text-gray-200', description: 'text-gray-600 dark:text-gray-300' }}
        description="Use 10–500 characters without control characters; avoid unnecessary personal details." />
      <Checkbox isSelected={confirmed} onValueChange={setConfirmed} isDisabled={frozen}>
        I authorise purge of this exact synthetic Confluence copy while retaining the primary, under the registered scope and disposal decision.
      </Checkbox>
      <Button type="submit" size="sm" color="warning" isLoading={outcome === 'SAVING'}
        isDisabled={frozen || !valid}>Record synthetic permission</Button>
    </form> : null}
  </section>;
}
