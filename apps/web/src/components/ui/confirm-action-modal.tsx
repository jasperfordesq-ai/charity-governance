'use client';

import type { ReactNode } from 'react';
import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@heroui/react';

export function ConfirmActionModal({
  isOpen,
  onOpenChange,
  ariaLabel = 'Confirm action',
  title,
  children,
  cancelLabel = 'Cancel',
  secondaryLabel,
  secondaryColor = 'danger',
  confirmLabel,
  confirmColor = 'danger',
  confirmClassName,
  confirming = false,
  confirmDisabled = false,
  onCancel,
  onSecondary,
  onConfirm,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  ariaLabel?: string;
  title: ReactNode;
  children: ReactNode;
  cancelLabel?: string;
  secondaryLabel?: ReactNode;
  secondaryColor?: 'primary' | 'secondary' | 'success' | 'warning' | 'danger';
  confirmLabel: ReactNode;
  confirmColor?: 'primary' | 'secondary' | 'success' | 'warning' | 'danger';
  confirmClassName?: string;
  confirming?: boolean;
  confirmDisabled?: boolean;
  onCancel?: () => void;
  onSecondary?: () => void | Promise<void>;
  onConfirm: () => void | Promise<void>;
}) {
  function handleCancel(onClose: () => void) {
    onCancel?.();
    onClose();
  }

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="sm" aria-label={ariaLabel}>
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader>
              <h2 className="text-base font-semibold">{title}</h2>
            </ModalHeader>
            <ModalBody>
              <div className="min-w-0 break-words text-sm leading-6 text-gray-600 dark:text-gray-300">{children}</div>
            </ModalBody>
            <ModalFooter className="flex-col items-stretch gap-2 sm:flex-row sm:justify-end">
              <Button variant="flat" onPress={() => handleCancel(onClose)} isDisabled={confirming}>
                {cancelLabel}
              </Button>
              {secondaryLabel ? (
                <Button variant="light" color={secondaryColor} onPress={onSecondary} isDisabled={confirming}>
                  {secondaryLabel}
                </Button>
              ) : null}
              <Button
                color={confirmColor}
                className={confirmClassName}
                onPress={onConfirm}
                isLoading={confirming}
                isDisabled={confirmDisabled}
              >
                {confirmLabel}
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
