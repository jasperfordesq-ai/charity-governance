'use client';

import type { DocumentResponse } from '@charitypilot/shared';
import { ConfirmActionModal } from '@/components/ui/confirm-action-modal';

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
    <ConfirmActionModal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title="Delete document"
      confirmLabel="Delete"
      confirming={deleting}
      onConfirm={handleDelete}
    >
      Delete {selectedDeleteDoc ? <strong>{selectedDeleteDoc.name}</strong> : 'this document'} from the evidence vault? This removes the file and its standard links.
    </ConfirmActionModal>
  );
}
