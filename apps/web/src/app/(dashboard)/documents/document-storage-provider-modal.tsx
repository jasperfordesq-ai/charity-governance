'use client';

import type { DocumentResponse } from '@charitypilot/shared';
import { ConfirmActionModal } from '@/components/ui/confirm-action-modal';

export function DocumentStorageProviderModal({
  isOpen, onOpenChange, document, verifying, onConfirm,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  document: DocumentResponse | undefined;
  verifying: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <ConfirmActionModal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      ariaLabel="Verify document storage provider"
      title="Verify file storage"
      confirmLabel="Check both providers"
      confirming={verifying}
      onConfirm={onConfirm}
    >
      Check the active file for {document ? <strong>{document.name}</strong> : 'this document'} in both supported storage providers. CharityPilot records a provider only if exactly one contains a file matching the recorded size. An unavailable provider or ambiguous result leaves the record unverified. This check does not prove copies, versions or backups have been removed.
    </ConfirmActionModal>
  );
}
