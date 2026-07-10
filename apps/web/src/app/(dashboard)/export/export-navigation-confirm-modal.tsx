'use client';

import { ConfirmActionModal } from '@/components/ui/confirm-action-modal';

export function ExportNavigationConfirmModal({
  isOpen,
  onKeepEditing,
  onDiscardAndLeave,
}: {
  isOpen: boolean;
  onKeepEditing: () => void;
  onDiscardAndLeave: () => void;
}) {
  return (
    <ConfirmActionModal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onKeepEditing();
      }}
      ariaLabel="Confirm leaving unsaved board sign-off"
      title="Board sign-off changes are not settled"
      cancelLabel="Keep editing"
      confirmLabel="Discard changes and leave"
      confirmColor="danger"
      onCancel={onKeepEditing}
      onConfirm={onDiscardAndLeave}
    >
      <p>
        This sign-off has unsaved changes or needs conflict review. Leaving now will discard the local draft; it will never overwrite
        the latest saved server version.
      </p>
    </ConfirmActionModal>
  );
}
