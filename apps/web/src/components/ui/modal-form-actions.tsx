'use client';

import type { ReactNode } from 'react';
import { Button, ModalFooter } from '@heroui/react';
import { primaryActionButtonClassName } from '@/components/ui/action-button';

export function ModalFormActions({
  cancelLabel = 'Cancel',
  submitLabel,
  onCancel,
  onSubmit,
  submitting = false,
  submitDisabled = false,
  submitAriaDescribedBy,
}: {
  cancelLabel?: ReactNode;
  submitLabel: ReactNode;
  onCancel: () => void;
  onSubmit: () => void | Promise<void>;
  submitting?: boolean;
  submitDisabled?: boolean;
  submitAriaDescribedBy?: string;
}) {
  return (
    <ModalFooter className="flex-col items-stretch gap-2 sm:flex-row sm:justify-end">
      <Button variant="flat" onPress={onCancel} isDisabled={submitting}>
        {cancelLabel}
      </Button>
      <Button
        className={primaryActionButtonClassName}
        onPress={onSubmit}
        isLoading={submitting}
        isDisabled={submitDisabled}
        aria-describedby={submitAriaDescribedBy}
      >
        {submitLabel}
      </Button>
    </ModalFooter>
  );
}
