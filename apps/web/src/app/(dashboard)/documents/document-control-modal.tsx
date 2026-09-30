'use client';

import { Button, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Textarea } from '@heroui/react';
import type { DocumentResponse } from '@charitypilot/shared';
import type { ConfluenceMirror } from '@/lib/integration-status';

export function DocumentControlModal({
  isOpen, onOpenChange, document, approvalNeedsReview, publicationMirror, publicationReviewLoading,
  publicationReviewError, kind, target, setTarget, nextStatuses,
  reason, setReason, error, saving, onConfirm,
  replacementDocumentId, setReplacementDocumentId, replacementSearch, setReplacementSearch,
  replacementCandidates, replacementHasMore, replacementLoading, replacementError,
  onSearchReplacements, onLoadMoreReplacements,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  document: DocumentResponse | undefined;
  approvalNeedsReview: boolean;
  publicationMirror: ConfluenceMirror | null;
  publicationReviewLoading: boolean;
  publicationReviewError: string;
  kind: 'lifecycle' | 'publication' | 'deletion-hold';
  target: string;
  setTarget: (value: string) => void;
  nextStatuses: string[];
  reason: string;
  setReason: (value: string) => void;
  error: string;
  saving: boolean;
  onConfirm: () => void | Promise<void>;
  replacementDocumentId: string;
  setReplacementDocumentId: (value: string) => void;
  replacementSearch: string;
  setReplacementSearch: (value: string) => void;
  replacementCandidates: { id: string; name: string }[];
  replacementHasMore: boolean;
  replacementLoading: boolean;
  replacementError: string;
  onSearchReplacements: () => void;
  onLoadMoreReplacements: () => void;
}) {
  const grantingPublication = kind === 'publication' && (!document?.externalPublicationApproved || approvalNeedsReview);
  const placingDeletionHold = kind === 'deletion-hold' && !document?.deletionHold;
  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} aria-label="Review document control">
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader>{kind === 'lifecycle' ? 'Classify document lifecycle' : kind === 'deletion-hold'
              ? placingDeletionHold ? 'Place deletion hold' : 'Release deletion hold'
              : publicationReviewLoading ? 'Review Confluence publication'
                : approvalNeedsReview ? 'Reapprove Confluence destination'
                : grantingPublication ? 'Approve Confluence publication' : 'Withdraw publication approval'}</ModalHeader>
            <ModalBody>
              <p className="text-sm font-medium">{document?.name}</p>
              {kind === 'lifecycle' ? (
                <>
                  <p className="text-sm">Current status: {document?.lifecycleStatus}. Historical evidence remains available under its existing access rules. Leaving CURRENT also withdraws future publication approval.</p>
                  <label className="text-sm font-medium" htmlFor="document-lifecycle-target">New lifecycle status</label>
                  <select id="document-lifecycle-target" className="rounded-md border border-gray-300 bg-white p-2 text-sm text-gray-950" value={target} onChange={(event) => setTarget(event.target.value)}>
                    {nextStatuses.map((status) => <option value={status} key={status}>{status}</option>)}
                  </select>
                  {target === 'SUPERSEDED' ? <div className="space-y-2 rounded-md border border-default-300 p-3">
                    <p className="text-sm">Choose a CURRENT document in the same category. Its link will be retained with this historical record.</p>
                    <div className="flex gap-2">
                      <Input label="Find replacement by name" value={replacementSearch} onValueChange={setReplacementSearch} maxLength={100} />
                      <Button variant="flat" onPress={onSearchReplacements} isDisabled={replacementLoading}>Search</Button>
                    </div>
                    <label className="block text-sm font-medium" htmlFor="replacement-document">Replacement document</label>
                    <select id="replacement-document" className="w-full rounded-md border border-gray-300 bg-white p-2 text-sm text-gray-950" value={replacementDocumentId} onChange={(event) => setReplacementDocumentId(event.target.value)}>
                      <option value="">Choose a current document</option>
                      {replacementCandidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} ({candidate.id})</option>)}
                    </select>
                    {replacementLoading ? <p className="text-sm">Loading current documents…</p> : null}
                    {replacementError ? <p role="alert" className="text-sm text-danger">{replacementError}</p> : null}
                    {replacementHasMore ? <Button size="sm" variant="flat" onPress={onLoadMoreReplacements} isDisabled={replacementLoading}>Load more</Button> : null}
                    {!replacementLoading && !replacementHasMore && replacementCandidates.length === 0 ? <p className="text-sm">No current replacement found. Classify the new file as CURRENT first, or search another name.</p> : null}
                  </div> : null}
                </>
              ) : kind === 'deletion-hold' ? (
                <p className="text-sm">{placingDeletionHold
                  ? 'This blocks ordinary deletion of this document until an Owner or Admin releases the hold. It does not establish a retention period or legal decision.'
                  : 'Releasing this hold permits the existing separately approved deletion workflow. It does not delete the document.'}</p>
              ) : (
                <div className="space-y-2 text-sm">
                  <p>{grantingPublication
                    ? `Confirm this CURRENT file and the selected Confluence space are appropriate for that space’s audience. ${approvalNeedsReview ? 'The prior approval does not cover this destination. ' : ''}Member visibility is a separate decision.`
                    : 'This stops future publication attempts. An existing Confluence page remains until separately reviewed and erased through the authorised erasure workflow.'}</p>
                  {publicationReviewLoading ? <p>Loading the current Confluence destination…</p>
                    : publicationReviewError ? <p role="alert" className="text-danger">{publicationReviewError}</p>
                      : grantingPublication && publicationMirror?.publishDestination ? <p className="rounded-md border border-default-300 p-2">
                        Reviewed destination: <strong>{publicationMirror.publishDestination.spaceName || publicationMirror.publishDestination.spaceKey}</strong>
                        {' '}({publicationMirror.publishDestination.spaceKey}) on {publicationMirror.publishDestination.siteUrl || `site ${publicationMirror.publishDestination.siteId}`}.
                        {' '}The server checks this exact site and space when saving.
                      </p>
                        : grantingPublication ? <p role="alert" className="text-danger">Choose a connected Confluence publishing space in <a href="/integrations" className="underline">Integrations</a> before approval.</p>
                          : null}
                  {grantingPublication && publicationMirror?.pageRecorded === true ? <p className="text-amber-800 dark:text-amber-300">
                    A Confluence page is already recorded for this file. Review that copy and its audience before approving future publication.
                  </p> : null}
                  {grantingPublication && publicationMirror?.recordedPageMatchesDestination === false ? <p role="alert" className="text-danger">
                    The recorded page belongs to another or unverified site or space. Review that copy before approving this destination.
                  </p> : null}
                </div>
              )}
              <Textarea label="Reason for this decision" description="10–500 characters. The decision and acting user are retained in the document control audit." value={reason} onValueChange={setReason} minRows={2} maxLength={500} isInvalid={Boolean(error)} errorMessage={error} />
            </ModalBody>
            <ModalFooter>
              <Button variant="flat" onPress={onClose} isDisabled={saving}>Cancel</Button>
              <Button color={grantingPublication ? 'warning' : 'primary'} onPress={onConfirm} isLoading={saving} isDisabled={!document || (kind === 'lifecycle' && !target) || (kind === 'lifecycle' && target === 'SUPERSEDED' && !replacementDocumentId) ||
                (kind === 'publication' && (publicationReviewLoading || Boolean(publicationReviewError) || !publicationMirror ||
                  (grantingPublication && (!publicationMirror.publishDestination ||
                    publicationMirror.recordedPageMatchesDestination === false)))) || reason.trim().length < 10}>
                {kind === 'lifecycle' ? 'Save status' : kind === 'deletion-hold'
                  ? placingDeletionHold ? 'Place hold' : 'Release hold'
                  : approvalNeedsReview ? 'Reapprove destination'
                    : grantingPublication ? 'Approve publication' : 'Withdraw approval'}
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
