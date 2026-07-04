'use client';

import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@heroui/react';
import type { DocumentResponse } from '@charitypilot/shared';

export function DocumentDeleteModal({
  isOpen,
  onOpenChange,
  selectedDeleteDoc,
  deleting,
  handleDelete,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  selectedDeleteDoc: DocumentResponse | undefined;
  deleting: boolean;
  handleDelete: () => void | Promise<void>;
}) {
  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="sm">
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader>Delete document</ModalHeader>
            <ModalBody>
              <p className="text-sm leading-6 text-gray-600 dark:text-gray-300">
                Delete {selectedDeleteDoc ? <strong>{selectedDeleteDoc.name}</strong> : 'this document'} from the evidence vault?
                This removes the file and its standard links.
              </p>
            </ModalBody>
            <ModalFooter>
              <Button variant="flat" onPress={onClose} isDisabled={deleting}>
                Cancel
              </Button>
              <Button color="danger" onPress={handleDelete} isLoading={deleting}>
                Delete
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
