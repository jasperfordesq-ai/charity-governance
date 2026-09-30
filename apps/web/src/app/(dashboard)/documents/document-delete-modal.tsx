'use client';

import type { DocumentResponse } from '@charitypilot/shared';
import { Textarea } from '@heroui/react';
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
  handleDelete: () => void | Promise<void>;
}) {
  return (
    <ConfirmActionModal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      ariaLabel="Confirm destructive action"
      title="Remove document from vault"
      confirmLabel="Remove from vault"
      confirming={deleting}
      confirmDisabled={Array.from(reason.trim()).length < 10 || Array.from(reason.trim()).length > 500}
      onConfirm={handleDelete}
    >
      <p>Remove {selectedDeleteDoc ? <strong>{selectedDeleteDoc.name}</strong> : 'this document'} from the evidence vault? Linked standards and cited Confluence pages must be reviewed and unlinked first. CharityPilot cannot restore a deleted item. File cleanup is tracked separately and may need retries. Any Confluence copy remains until reviewed through its separate erasure workflow.</p>
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
