'use client';

import type { DeadlineView } from '@/lib/deadline-contract';
import { ConfirmActionModal } from '@/components/ui/confirm-action-modal';

export function DeadlineDeleteModal({
  isOpen,
  onOpenChange,
  selectedDeadline,
  deleting,
  deleteDisabled,
  onCancel,
  onDelete,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  selectedDeadline: DeadlineView | null;
  deleting: boolean;
  deleteDisabled: boolean;
  onCancel: () => void;
  onDelete: () => void | Promise<void>;
}) {
  return (
    <ConfirmActionModal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      ariaLabel="Confirm destructive action"
      title="Delete deadline"
      confirmLabel="Delete deadline"
      confirming={deleting}
      confirmDisabled={deleteDisabled}
      onCancel={onCancel}
      onConfirm={onDelete}
    >
      Remove {selectedDeadline ? <strong>{selectedDeadline.title}</strong> : 'this deadline'} from the governance calendar? This cannot be undone.
    </ConfirmActionModal>
  );
}
