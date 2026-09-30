'use client';

import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Textarea } from '@heroui/react';
import type { DocumentResponse } from '@charitypilot/shared';

export function DocumentVisibilityModal({
  isOpen,
  onOpenChange,
  document,
  reason,
  setReason,
  assessment,
  setAssessment,
  error,
  saving,
  onConfirm,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  document: DocumentResponse | undefined;
  reason: string;
  setReason: (value: string) => void;
  assessment: 'UNASSESSED' | 'MEMBER_SUITABLE' | 'RESTRICTED_SENSITIVE';
  setAssessment: (value: 'UNASSESSED' | 'MEMBER_SUITABLE' | 'RESTRICTED_SENSITIVE') => void;
  error: string;
  saving: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  const needsByteReview = document?.contentAccessClass === 'MEMBER_SUITABLE' &&
    document.memberByteReviewVerified !== true;
  const granting = document?.visibility !== 'MEMBER_VISIBLE' || needsByteReview;
  const needsClassification = granting && document?.lifecycleStatus === 'UNREVIEWED';
  const isDraft = granting && document?.lifecycleStatus === 'DRAFT';
  const needsProviderReview = granting && document?.storageProviderVerified === false;
  const assessmentChanged = assessment !== (document?.contentAccessClass ?? 'UNASSESSED');
  const wouldChange = !granting || (assessment === 'MEMBER_SUITABLE' || assessmentChanged);
  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} aria-label="Review document visibility">
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader>{granting ? 'Review content and Member access' : 'Restrict Member access'}</ModalHeader>
            <ModalBody>
              <p className="text-sm">
                {granting
                  ? 'Review the full file and metadata before making this document visible and downloadable to every active Member of this charity.'
                  : 'Members will lose access to this document. Owners and administrators will keep access.'}
              </p>
              <p className="text-sm font-medium">{document?.name}</p>
              {needsClassification ? <p className="text-sm text-amber-800 dark:text-amber-200">
                This document is unreviewed. Classify its lifecycle before allowing Member access.
              </p> : null}
              {isDraft ? <p className="text-sm text-amber-800 dark:text-amber-200">
                This document is a working draft. Move it to a reviewed lifecycle state before allowing Member access.
              </p> : null}
              {needsProviderReview ? <p className="text-sm text-amber-800 dark:text-amber-200">
                Verify which storage provider holds this file before assessing it for Member access.
              </p> : null}
              {needsByteReview ? <p className="text-sm text-amber-800 dark:text-amber-200">
                This earlier Member assessment has no stored byte fingerprint. Review the full current file again before Members can download it.
              </p> : null}
              {granting ? <>
                <label className="text-sm font-medium" htmlFor="document-content-access-class">Content assessment</label>
                <select id="document-content-access-class" className="rounded-md border border-gray-300 bg-white p-2 text-sm text-gray-950"
                  value={assessment} onChange={(event) => setAssessment(event.target.value as typeof assessment)}>
                  <option value="UNASSESSED">Not assessed — Members cannot access</option>
                  <option value="MEMBER_SUITABLE">Full file and metadata reviewed as suitable for all active Members</option>
                  <option value="RESTRICTED_SENSITIVE">Sensitive content — keep restricted</option>
                </select>
                <p className="text-xs text-default-600">Use Download on this document with your own account, then inspect the full current file, including attachments and embedded particulars. The server checks that your download and this assessment concern the same document revision and bytes. This decision does not approve Confluence publication.</p>
              </> : null}
              <Textarea
                label="Reason for this access decision"
                description="10–500 characters. The decision and acting user are retained in restricted document history."
                value={reason}
                onValueChange={setReason}
                minRows={2}
                maxLength={500}
                isInvalid={Boolean(error)}
                errorMessage={error}
              />
            </ModalBody>
            <ModalFooter>
              <Button variant="flat" onPress={onClose} isDisabled={saving}>Cancel</Button>
              <Button color={granting && assessment === 'MEMBER_SUITABLE' ? 'warning' : 'primary'} onPress={onConfirm} isLoading={saving} isDisabled={reason.trim().length < 10 || !document ||
                (granting && (!wouldChange || (assessment === 'MEMBER_SUITABLE' && (needsClassification || isDraft || needsProviderReview))))}>
                {granting ? assessment === 'MEMBER_SUITABLE' ? 'Allow Members' : 'Save restricted assessment' : 'Restrict Members'}
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
