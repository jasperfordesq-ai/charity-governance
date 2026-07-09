'use client';

import { primaryActionButtonClassName } from '@/components/ui/action-button';
import { ConfirmActionModal } from '@/components/ui/confirm-action-modal';

export function PrincipleNavigationConfirmModal({
  isOpen,
  isSaving,
  saveError,
  onKeepEditing,
  onLeaveWithoutSaving,
  onSaveAndContinue,
}: {
  isOpen: boolean;
  isSaving: boolean;
  saveError: string;
  onKeepEditing: () => void;
  onLeaveWithoutSaving: () => void;
  onSaveAndContinue: () => void | Promise<void>;
}) {
  return (
    <ConfirmActionModal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onKeepEditing();
      }}
      title="Compliance edits are still saving"
      cancelLabel="Keep editing"
      secondaryLabel="Leave without waiting"
      confirmLabel="Save now and leave"
      confirmColor="primary"
      confirmClassName={primaryActionButtonClassName}
      confirming={isSaving}
      onCancel={onKeepEditing}
      onSecondary={onLeaveWithoutSaving}
      onConfirm={onSaveAndContinue}
    >
      <p>
        Some standard updates have not finished saving yet. You can stay on this page, save the pending edits now, or leave without
        waiting. Any save already underway may still finish; queued edits that have not started will be left behind.
      </p>
      {saveError ? (
        <p role="alert" className="mt-3 text-rose-700 dark:text-rose-300">
          {saveError}
        </p>
      ) : null}
    </ConfirmActionModal>
  );
}
