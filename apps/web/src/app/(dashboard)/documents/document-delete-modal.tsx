'use client';

import type { DocumentResponse } from '@charitypilot/shared';
import { Input, Textarea } from '@heroui/react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { ConfirmActionModal } from '@/components/ui/confirm-action-modal';

export function DocumentDeleteModal({
  isOpen,
  onOpenChange,
  selectedDeleteDoc,
  deleting,
  reason,
  onReasonChange,
  handleDelete,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  selectedDeleteDoc: DocumentResponse | undefined;
  deleting: boolean;
  reason: string;
  onReasonChange: (reason: string) => void;
  handleDelete: (policyId: string, evidenceRef: string) => void | Promise<void>;
}) {
  const [policies, setPolicies] = useState<Array<{ id: string; revision: number; recoveryDays: number; approvalEvidenceRef: string }>>([]);
  const [policyId, setPolicyId] = useState('');
  const [evidenceRef, setEvidenceRef] = useState('');
  const [policyStatus, setPolicyStatus] = useState('');
  useEffect(() => {
    let active = true;
    setPolicyId(''); setEvidenceRef(''); setPolicies([]);
    if (!isOpen) return;
    setPolicyStatus('Loading approved policies…');
    void api.get('/documents/recovery-policies').then((response) => {
      if (!active) return;
      const rows = response.data?.data ?? response.data;
      setPolicies(rows);
      setPolicyStatus(rows.length ? '' : 'No draft-removal policy has been approved. Ask the charity Owner to arrange policy review.');
    }).catch(() => { if (active) setPolicyStatus('Approved policies could not be loaded. Close and reopen this dialog to retry.'); });
    return () => { active = false; };
  }, [isOpen, selectedDeleteDoc?.id]);
  return (
    <ConfirmActionModal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      ariaLabel="Confirm destructive action"
      title="Move document to Deleted Items"
      confirmLabel="Move to Deleted Items"
      confirming={deleting}
      confirmDisabled={!policyId || !/^[A-Z0-9][A-Z0-9-]{2,119}$/.test(evidenceRef) || Array.from(reason.trim()).length < 10 || Array.from(reason.trim()).length > 500}
      onConfirm={() => handleDelete(policyId, evidenceRef)}
    >
      <p>Move {selectedDeleteDoc ? <strong>{selectedDeleteDoc.name}</strong> : 'this document'} out of the evidence vault? The record and file remain recoverable for the approved window. Sharing approval is withdrawn. Holds and evidence links must be reviewed first. Confluence copies remain subject to their separate review.</p>
      <p role="status" className="mt-3">{policyStatus}</p>
      <label className="mt-3 block text-sm">Approved recovery policy
        <select className="mt-1 block w-full rounded border p-2" value={policyId} onChange={(event) => setPolicyId(event.target.value)} disabled={deleting || !policies.length}>
          <option value="">Choose a reviewed policy</option>
          {policies.map((policy) => <option key={policy.id} value={policy.id}>Revision {policy.revision} · {policy.recoveryDays} days · {policy.approvalEvidenceRef}</option>)}
        </select>
      </label>
      <Input className="mt-3" label="Removal authority reference" value={evidenceRef} onValueChange={setEvidenceRef}
        description="Reference to the reviewed removal decision, for example REMOVAL-001. Use capital letters, numbers and hyphens."
        maxLength={120} isRequired isDisabled={deleting} />
      <Textarea
        className="mt-3"
        label="Reason for removing this draft"
        description="10–500 characters. The reason is retained in the restricted document audit."
        value={reason}
        onValueChange={onReasonChange}
        maxLength={500}
        isRequired
      />
    </ConfirmActionModal>
  );
}
