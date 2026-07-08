'use client';

import type { ReactNode } from 'react';
import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@heroui/react';

export function ConfirmActionModal({
  isOpen,
  onOpenChange,
  title,
  children,
  cancelLabel = 'Cancel',
  confirmLabel,
  confirmColor = 'danger',
  confirming = false,
  confirmDisabled = false,
  onCancel,
  onConfirm,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  children: ReactNode;
  cancelLabel?: string;
  confirmLabel: ReactNode;
  confirmColor?: 'primary' | 'secondary' | 'success' | 'warning' | 'danger';
  confirming?: boolean;
  confirmDisabled?: boolean;
  onCancel?: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  function handleCancel(onClose: () => void) {
    onCancel?.();
    onClose();
  }

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="sm" aria-label="Confirm destructive action">
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader>{title}</ModalHeader>
            <ModalBody>
              <div className="min-w-0 break-words text-sm leading-6 text-gray-600 dark:text-gray-300">{children}</div>
            </ModalBody>
            <ModalFooter>
              <Button variant="flat" onPress={() => handleCancel(onClose)} isDisabled={confirming}>
                {cancelLabel}
              </Button>
              <Button color={confirmColor} onPress={onConfirm} isLoading={confirming} isDisabled={confirmDisabled}>
                {confirmLabel}
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
