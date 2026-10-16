'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Input, Textarea } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';

type Decision = { id: string; evidenceRef: string | null; withdrawnAt: string | null };
type Props = { review: Decision; busy: boolean; run: (action: () => Promise<void>) => Promise<void>;
  refresh: () => Promise<void> };

/** Withdrawal preserves the immutable review. It never removes provider data. */
export function ReviewWithdrawal(props: Props) {
  return <DecisionWithdrawal {...props} kind="review" />;
}

export function PermissionWithdrawal(props: Props) {
  return <DecisionWithdrawal {...props} kind="permission" />;
}

function DecisionWithdrawal({ review, busy, run, refresh, kind }: Props & { kind: 'review' | 'permission' }) {
  const [open, setOpen] = useState(false), [reference, setReference] = useState('');
  const [reason, setReason] = useState(''), [confirmed, setConfirmed] = useState(false);
  const [outcome, setOutcome] = useState<'READY' | 'SAVING' | 'RECORDED' | 'UNKNOWN'>('READY');
  const [error, setError] = useState('');
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const valid = /^[A-Z0-9][A-Z0-9-]{2,119}$/.test(reference.trim())
    && Array.from(reason.trim()).length >= 10 && Array.from(reason.trim()).length <= 500
    && !/[\u0000-\u001f\u007f-\u009f]/.test(reason.trim());
  const frozen = busy || outcome !== 'READY' || review.withdrawnAt !== null;
  const withdraw = async () => {
    if (frozen || !confirmed || !valid) return;
    await run(async () => {
      setOutcome('SAVING'); setError('');
      try {
        await api.post(kind === 'review' ? `/integrations/confluence/retained-copy-reviews/${review.id}/withdraw`
          : `/integrations/confluence/retained-copy-reviews/permissions/${review.id}/withdraw`,
          { evidenceRef: reference.trim(), reason: reason.trim() });
        if (!active.current) return;
        setOutcome('RECORDED');
      } catch (cause) {
        if (active.current) {
          setOutcome('UNKNOWN');
          setError(apiErrorMessage(cause, 'The withdrawal response could not be verified.'));
        }
        return;
      }
      await refresh();
    });
  };
  if (!open) return review.withdrawnAt ? null : <Button className="mt-2" size="sm" variant="flat"
    isDisabled={busy} onPress={() => setOpen(true)}>{kind === 'review' ? 'Review withdrawal' : 'Review permission withdrawal'}</Button>;
  return <fieldset aria-label={`Withdraw this ${kind}`} className="mt-3 space-y-3 rounded border border-gray-300 p-3 dark:border-gray-600 break-normal">
    <legend className="font-medium">Withdraw this {kind}</legend>
    <p className="break-words">Exact {kind}: {review.evidenceRef ?? review.id} · {review.id}</p>
    <p>Withdrawal prevents future use of this {kind}. Its evidence and history remain available.
      It does not erase documents or reverse any completed provider action.</p>
    {error ? <p role="alert" className="text-red-700 dark:text-red-300">{error}</p> : null}
    {outcome === 'UNKNOWN' && !review.withdrawnAt ? <p role="status" className="text-amber-800 dark:text-amber-300">
      Withdrawal outcome needs reconciliation. Refresh {kind} receipts; an empty result does not prove failure.
      Another withdrawal submission is blocked here. Attempted evidence reference: {reference.trim()}.
    </p> : null}
    {review.withdrawnAt || outcome === 'RECORDED' ? <p role="status">Withdrawal recorded; original evidence retained.</p> : null}
    <Input label="Withdrawal evidence reference" value={reference} onValueChange={setReference} isRequired
      isDisabled={busy} isReadOnly={frozen} classNames={{ label: 'text-gray-700 dark:text-gray-200' }} />
    <Textarea label="Withdrawal reason" value={reason} onValueChange={setReason} isRequired
      isDisabled={busy} isReadOnly={frozen} classNames={{ label: 'text-gray-700 dark:text-gray-200', description: 'text-gray-600 dark:text-gray-300' }}
      description="Use 10–500 characters without control characters; avoid unnecessary personal details." />
    <Checkbox isSelected={confirmed} onValueChange={setConfirmed} isDisabled={frozen}>
      I confirm withdrawal of this exact {kind}, retaining its original evidence.
    </Checkbox>
    <Button size="sm" color="warning" isLoading={outcome === 'SAVING'}
      isDisabled={frozen || !confirmed || !valid} onPress={() => void withdraw()}>Withdraw {kind}</Button>
  </fieldset>;
}
