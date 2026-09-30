'use client';

import { Button } from '@heroui/react';
import { DataList, DataListItems } from '@/components/ui/data-list';
import { primaryActionButtonClassName } from '@/components/ui/action-button';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { EvidenceChip, StatusChip } from '@/components/ui/status';
import type { DocumentResponse } from '@charitypilot/shared';
import { DOCUMENT_CATEGORY_LABELS } from '@charitypilot/shared';
import { X } from 'lucide-react';
import { ConfluenceMirrorChip } from '@/components/governance/confluence-mirror-chip';
import type { ConfluenceMirror } from '@/lib/integration-status';

const formatDate = (value: string | null | undefined) => {
  if (!value) return 'Not set';
  return new Date(value).toLocaleDateString('en-IE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
};

const formatFileSize = (bytes: number) => {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
};

const memberCanRead = (doc: DocumentResponse) =>
  doc.visibility === 'MEMBER_VISIBLE' && doc.contentAccessClass === 'MEMBER_SUITABLE' &&
  doc.memberByteReviewVerified === true && doc.storageProviderVerified === true &&
  doc.lifecycleStatus !== 'UNREVIEWED' && doc.lifecycleStatus !== 'DRAFT';

export function DocumentListPanel({
  canManage,
  documents,
  documentTotal,
  hasMore,
  listChanged,
  loadingMore,
  loadMoreError,
  onLoadMore,
  loading,
  loadError,
  onRetry,
  onUploadFirst,
  handleDownload,
  downloadDocId,
  deleting,
  openLinkModal,
  linkingStandard,
  unlinkingStandard,
  handleUnlinkStandard,
  confirmDelete,
  openVisibilityModal,
  openDocumentControl,
  openProviderReview,
  mirrors,
  retryMirrorPublication,
  retryingMirror,
}: {
  canManage: boolean;
  documents: DocumentResponse[];
  documentTotal: number;
  hasMore: boolean;
  listChanged: boolean;
  loadingMore: boolean;
  loadMoreError: string;
  onLoadMore: () => void | Promise<void>;
  loading: boolean;
  loadError: string;
  onRetry: () => void | Promise<void>;
  onUploadFirst: () => void;
  handleDownload: (doc: DocumentResponse) => void | Promise<void>;
  downloadDocId: string | null;
  deleting: boolean;
  openLinkModal: (docId: string) => void;
  linkingStandard: boolean;
  unlinkingStandard: string | null;
  handleUnlinkStandard: (docId: string, standardId: string) => void | Promise<void>;
  confirmDelete: (docId: string) => void;
  openVisibilityModal: (docId: string) => void;
  openDocumentControl: (docId: string, kind: 'lifecycle' | 'publication' | 'deletion-hold') => void;
  openProviderReview: (docId: string) => void;
  /** Absent for a document whose mirror could not be read; the chip renders nothing. */
  mirrors: Map<string, ConfluenceMirror>;
  retryMirrorPublication: (docId: string) => void | Promise<void>;
  retryingMirror: string | null;
}) {
  return (
    <DataList
      title="Uploaded documents"
      description={canManage
        ? 'Download links are generated only when requested. Link each file to the standards it supports.'
        : 'Download links are generated only when requested. Evidence-link and document changes are available to owners and administrators.'}
    >
      {loading ? (
        <LoadingState title="Loading documents" description="Checking the private evidence vault." />
      ) : loadError && documents.length === 0 ? (
        <ErrorState
          title="Documents could not be loaded"
          description={loadError}
          action={(
            <Button size="sm" variant="flat" onPress={onRetry}>
              Try again
            </Button>
          )}
        />
      ) : documents.length === 0 ? (
        <EmptyState
          title="No documents uploaded yet"
          description={canManage
            ? 'Upload the governing document, board conduct records, minutes, accounts, policies, and other evidence before the annual review.'
            : 'No governance documents are available to review or download yet.'}
          action={canManage ? (
            <Button size="sm" className={primaryActionButtonClassName} onPress={onUploadFirst}>
              Upload first document
            </Button>
          ) : undefined}
        />
      ) : (
        <div className="space-y-3">
          {loadError ? (
            <ErrorState
              title="Some document data may be out of date"
              description={loadError}
              action={(
                <Button size="sm" variant="flat" onPress={onRetry}>
                  Refresh
                </Button>
              )}
            />
          ) : null}
          <DataListItems divided={false}>
            <div className="divide-y divide-gray-200 dark:divide-gray-800">
              {documents.map((doc) => (
                <article key={doc.id} className="p-4 sm:p-5">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="break-words text-sm font-semibold text-gray-950 dark:text-gray-50">
                          {doc.name}
                        </h3>
                        <StatusChip tone="neutral">
                          {DOCUMENT_CATEGORY_LABELS[doc.category] ?? doc.category}
                        </StatusChip>
                        {canManage ? <StatusChip tone={memberCanRead(doc) ? 'success' : 'warning'}>
                          {memberCanRead(doc) ? 'Member release configured' : 'Restricted'}
                        </StatusChip> : null}
                        {canManage ? <StatusChip tone={doc.contentAccessClass === 'MEMBER_SUITABLE' && doc.memberByteReviewVerified === true ? 'success' : 'warning'}>
                          {doc.contentAccessClass === 'MEMBER_SUITABLE' && doc.memberByteReviewVerified === true ? 'Content reviewed for Members' :
                            doc.contentAccessClass === 'MEMBER_SUITABLE' ? 'Byte review required' :
                            doc.contentAccessClass === 'RESTRICTED_SENSITIVE' ? 'Sensitive content' : 'Content unassessed'}
                        </StatusChip> : null}
                        <StatusChip tone={doc.lifecycleStatus === 'CURRENT' ? 'success' : 'neutral'}>{doc.lifecycleStatus}</StatusChip>
                        {canManage && (doc.lifecycleStatus === 'SUPERSEDED' || (doc.lifecycleStatus === 'HISTORICAL' && doc.supersededByDocumentId)) ? <span className="text-xs text-default-600">
                          {doc.supersededByDocumentId
                            ? `Replaced by ${documents.find((candidate) => candidate.id === doc.supersededByDocumentId)?.name ?? doc.supersededByDocumentId}`
                            : 'Replacement not recorded (legacy classification)'}
                        </span> : null}
                        {canManage && doc.externalPublicationApproved ? <StatusChip tone="warning">Confluence approved</StatusChip> : null}
                        {canManage && doc.deletionHold ? <StatusChip tone="warning">Deletion hold</StatusChip> : null}
                        {canManage && doc.storageProviderVerified === false ? <StatusChip tone="warning">Storage provider unverified</StatusChip> : null}
                      </div>
                      {!canManage ? (
                        <p className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">Additional document details are available to owners and administrators.</p>
                      ) : doc.description ? (
                        <p className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">{doc.description}</p>
                      ) : (
                        <p className="mt-1 text-sm leading-6 text-gray-500 dark:text-gray-400">
                          No description added yet.
                        </p>
                      )}
                      <dl className="mt-3 grid grid-cols-1 gap-2 text-xs text-gray-600 dark:text-gray-300 sm:grid-cols-2 lg:grid-cols-4">
                        {canManage ? <div>
                          <dt className="font-medium text-gray-500 dark:text-gray-400">Vault record ID</dt>
                          <dd className="break-all font-mono">{doc.id}</dd>
                        </div> : null}
                        {canManage ? <div>
                          <dt className="font-medium text-gray-500 dark:text-gray-400">Owner</dt>
                          <dd>{doc.owner || 'Unassigned'}</dd>
                        </div> : null}
                        <div>
                          <dt className="font-medium text-gray-500 dark:text-gray-400">Review date</dt>
                          <dd>{formatDate(doc.nextReviewDate)}</dd>
                        </div>
                        {canManage ? <div>
                          <dt className="font-medium text-gray-500 dark:text-gray-400">Minute reference</dt>
                          <dd>{doc.boardMinuteReference || 'Not recorded'}</dd>
                        </div> : null}
                        <div>
                          <dt className="font-medium text-gray-500 dark:text-gray-400">Uploaded</dt>
                          <dd>{formatDate(doc.createdAt)} ({formatFileSize(doc.fileSize)})</dd>
                        </div>
                      </dl>
                      <ConfluenceMirrorChip
                        mirror={mirrors.get(doc.id)}
                        isCurrentDocument={doc.lifecycleStatus === 'CURRENT'}
                        approvalNeedsReview={doc.externalPublicationApproved && mirrors.get(doc.id)?.approvalDestinationCurrent === false}
                        approvalWithdrawnWithCopy={!doc.externalPublicationApproved &&
                          (mirrors.get(doc.id)?.pageRecorded === true || mirrors.get(doc.id)?.publication === 'PUBLISHED')}
                        canManage={canManage}
                        retrying={retryingMirror === doc.id}
                        onRetry={() => retryMirrorPublication(doc.id)}
                      />
                      {canManage && doc.lifecycleStatus !== 'DRAFT' ? <p className="mt-2 text-xs text-gray-600 dark:text-gray-300">
                        Ordinary Vault deletion is limited to drafts. Classify unreviewed files first; retained evidence needs a separate retention and erasure decision.
                      </p> : null}
                      <div className="mt-3 flex flex-wrap gap-2" aria-live="polite">
                        {(doc.standardLinks ?? []).length > 0 ? (
                          (doc.standardLinks ?? []).map((link) => {
                            const linkKey = `${doc.id}:${link.standardId}`;
                            return (
                              <span key={link.standardId} className="inline-flex items-center gap-1">
                                <StatusChip tone="brand" ariaLabel={`Linked standard ${link.standardCode}`}>
                                  {link.standardCode}
                                </StatusChip>
                                {canManage ? <Button
                                  size="sm"
                                  variant="light"
                                  isIconOnly
                                  aria-label={`Remove link to standard ${link.standardCode}`}
                                  isLoading={unlinkingStandard === linkKey}
                                  isDisabled={Boolean(unlinkingStandard) || linkingStandard}
                                  onPress={() => handleUnlinkStandard(doc.id, link.standardId)}
                                  className="h-7 w-7 min-w-7"
                                >
                                  <X className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                                </Button> : null}
                              </span>
                            );
                          })
                        ) : (
                          <EvidenceChip status="partial">No linked standards</EvidenceChip>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="flat"
                        aria-label={`Download ${doc.name}`}
                        onPress={() => handleDownload(doc)}
                        isLoading={downloadDocId === doc.id}
                        isDisabled={Boolean(downloadDocId) || deleting}
                      >
                        Download
                      </Button>
                      {canManage ? <Button
                        size="sm"
                        variant="flat"
                        aria-label={`Review access for ${doc.name}`}
                        onPress={() => openVisibilityModal(doc.id)}
                      >
                        Access
                      </Button> : null}
                      {canManage && doc.lifecycleStatus !== 'HISTORICAL' ? <Button size="sm" variant="flat" aria-label={`Classify ${doc.name}`} onPress={() => openDocumentControl(doc.id, 'lifecycle')}>
                        Lifecycle
                      </Button> : null}
                      {canManage && (doc.lifecycleStatus === 'CURRENT' || doc.externalPublicationApproved) ? <Button size="sm" variant="flat" aria-label={`Review Confluence publication for ${doc.name}`} onPress={() => openDocumentControl(doc.id, 'publication')}>
                        {doc.externalPublicationApproved
                          ? mirrors.get(doc.id)?.approvalDestinationCurrent === false && mirrors.get(doc.id)?.pageRecorded === false
                            ? 'Reapprove destination' : 'Withdraw publication'
                          : 'Approve publication'}
                      </Button> : null}
                      {canManage ? <Button size="sm" variant="flat" aria-label={`Review deletion hold for ${doc.name}`} onPress={() => openDocumentControl(doc.id, 'deletion-hold')}>
                        {doc.deletionHold ? 'Release deletion hold' : 'Place deletion hold'}
                      </Button> : null}
                      {canManage && doc.storageProviderVerified === false ? <Button size="sm" variant="flat" aria-label={`Verify file storage for ${doc.name}`} onPress={() => openProviderReview(doc.id)}>
                        Verify storage
                      </Button> : null}
                      {canManage && doc.lifecycleStatus === 'CURRENT' ? <Button
                        size="sm"
                        variant="flat"
                        aria-label={`Link ${doc.name} to a standard`}
                        onPress={() => openLinkModal(doc.id)}
                        isDisabled={linkingStandard || Boolean(unlinkingStandard)}
                      >
                        Link standard
                      </Button> : null}
                      {canManage ? <Button
                        size="sm"
                        variant="flat"
                        color="danger"
                        aria-label={`Delete ${doc.name}`}
                        onPress={() => confirmDelete(doc.id)}
                        isDisabled={deleting || Boolean(downloadDocId) || Boolean(doc.deletionHold) || doc.storageProviderVerified === false || doc.lifecycleStatus !== 'DRAFT'}
                      >
                        Delete
                      </Button> : null}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </DataListItems>
          <div className="space-y-2 border-t border-gray-200 px-4 py-3 text-sm dark:border-gray-800">
            <p className="text-gray-600 dark:text-gray-300">
              Showing {documents.length} of {documentTotal} documents.
              {hasMore ? ' Load older files to continue the Vault review.' : ''}
            </p>
            {listChanged ? <ErrorState title="Vault changed during review" description="The loaded list no longer matches the current file count. Refresh before concluding that all files were reviewed." action={(
              <Button size="sm" variant="flat" onPress={onRetry}>Refresh documents</Button>
            )} /> : null}
            {loadMoreError ? <ErrorState title="Older documents could not be loaded" description={loadMoreError} action={(
              <Button size="sm" variant="flat" onPress={onLoadMore}>Try again</Button>
            )} /> : null}
            {hasMore ? <Button size="sm" variant="flat" onPress={onLoadMore} isLoading={loadingMore} isDisabled={loadingMore}>
              Load older documents
            </Button> : null}
          </div>
        </div>
      )}
    </DataList>
  );
}
