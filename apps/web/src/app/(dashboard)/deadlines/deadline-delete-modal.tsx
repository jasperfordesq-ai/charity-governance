'use client';

import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@heroui/react';
import type { DeadlineResponse } from '@charitypilot/shared';

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
  selectedDeadline: DeadlineResponse | null;
  deleting: boolean;
  deleteDisabled: boolean;
  onCancel: () => void;
  onDelete: () => void | Promise<void>;
}) {
  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="sm">
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader>Delete deadline</ModalHeader>
            <ModalBody>
              <p className="text-sm leading-6 text-gray-600 dark:text-gray-300">
                Remove {selectedDeadline ? <strong>{selectedDeadline.title}</strong> : 'this deadline'} from the governance calendar?
                This cannot be undone.
              </p>
            </ModalBody>
            <ModalFooter>
              <Button
                variant="flat"
                onPress={() => {
                  onCancel();
                  onClose();
                }}
                isDisabled={deleting}
              >
                Cancel
              </Button>
              <Button color="danger" onPress={onDelete} isLoading={deleting} isDisabled={deleteDisabled}>
                Delete deadline
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
