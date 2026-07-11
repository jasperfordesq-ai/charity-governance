'use client';

import type { DeadlineView } from '@/lib/deadline-contract';
import { ConfirmActionModal } from '@/components/ui/confirm-action-modal';

export function DeadlineCompletionModal({
  isOpen,
  onOpenChange,
  deadline,
  confirming,
  onCancel,
  onConfirm,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  deadline: DeadlineView | null;
  confirming: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <ConfirmActionModal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      ariaLabel="Confirm irreversible generated deadline completion"
      title="Mark generated deadline complete?"
      confirmLabel="Mark complete permanently"
      confirming={confirming}
      confirmDisabled={!deadline}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <p>
        This permanently records {deadline ? <strong>{deadline.title}</strong> : 'this generated occurrence'} as
        complete. Generated occurrences cannot be reopened, edited, or deleted.
      </p>
      <p className="mt-3 font-semibold text-rose-700 dark:text-rose-200">
        Confirm only after checking the underlying filing, meeting, or member action actually occurred.
      </p>
    </ConfirmActionModal>
  );
}
