'use client';

import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@heroui/react';
import { primaryActionButtonClassName } from '@/components/ui/action-button';

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
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onKeepEditing();
      }}
      size="md"
    >
      <ModalContent>
        <ModalHeader>Compliance edits are still saving</ModalHeader>
        <ModalBody>
          <p className="text-sm leading-6 text-gray-600 dark:text-gray-300">
            Some standard updates have not finished saving yet. You can stay on this page, save the pending edits now,
            or leave and rely on the last saved state.
          </p>
          {saveError ? (
            <p role="alert" className="text-sm leading-6 text-rose-700 dark:text-rose-300">
              {saveError}
            </p>
          ) : null}
        </ModalBody>
        <ModalFooter className="flex-col items-stretch gap-2 sm:flex-row sm:justify-end">
          <Button variant="flat" onPress={onKeepEditing} isDisabled={isSaving}>
            Keep editing
          </Button>
          <Button variant="light" color="danger" onPress={onLeaveWithoutSaving} isDisabled={isSaving}>
            Leave without waiting
          </Button>
          <Button className={primaryActionButtonClassName} onPress={onSaveAndContinue} isLoading={isSaving}>
            Save now and leave
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
