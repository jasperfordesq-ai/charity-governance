'use client';

import { Button } from '@heroui/react';
import { DataList, DataListItems } from '@/components/ui/data-list';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { EvidenceChip, StatusChip } from '@/components/ui/status';
import type { DocumentResponse } from '@charitypilot/shared';
import { DOCUMENT_CATEGORY_LABELS } from '@charitypilot/shared';

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

export function DocumentListPanel({
  documents,
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
}: {
  documents: DocumentResponse[];
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
}) {
  return (
    <DataList
      title="Uploaded documents"
      description="Download links are generated only when requested. Link each file to the standards it supports."
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
          description="Upload the governing document, board conduct records, minutes, accounts, policies, and other evidence before the annual review."
          action={(
            <Button size="sm" className="bg-teal-primary text-white hover:bg-teal-dark" onPress={onUploadFirst}>
              Upload first document
            </Button>
          )}
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
                      </div>
                      {doc.description ? (
                        <p className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">{doc.description}</p>
                      ) : (
                        <p className="mt-1 text-sm leading-6 text-gray-500 dark:text-gray-400">
                          No description added yet.
                        </p>
                      )}
                      <dl className="mt-3 grid grid-cols-1 gap-2 text-xs text-gray-600 dark:text-gray-300 sm:grid-cols-2 lg:grid-cols-4">
                        <div>
                          <dt className="font-medium text-gray-500 dark:text-gray-400">Owner</dt>
                          <dd>{doc.owner || 'Unassigned'}</dd>
                        </div>
                        <div>
                          <dt className="font-medium text-gray-500 dark:text-gray-400">Review date</dt>
                          <dd>{formatDate(doc.nextReviewDate)}</dd>
                        </div>
                        <div>
                          <dt className="font-medium text-gray-500 dark:text-gray-400">Minute reference</dt>
                          <dd>{doc.boardMinuteReference || 'Not recorded'}</dd>
                        </div>
                        <div>
                          <dt className="font-medium text-gray-500 dark:text-gray-400">Uploaded</dt>
                          <dd>{formatDate(doc.createdAt)} ({formatFileSize(doc.fileSize)})</dd>
                        </div>
                      </dl>
                      <div className="mt-3 flex flex-wrap gap-2" aria-live="polite">
                        {(doc.standardLinks ?? []).length > 0 ? (
                          (doc.standardLinks ?? []).map((link) => {
                            const linkKey = `${doc.id}:${link.standardId}`;
                            return (
                              <span key={link.standardId} className="inline-flex items-center gap-1">
                                <StatusChip tone="brand" ariaLabel={`Linked standard ${link.standardCode}`}>
                                  {link.standardCode}
                                </StatusChip>
                                <Button
                                  size="sm"
                                  variant="light"
                                  isIconOnly
                                  aria-label={`Remove link to standard ${link.standardCode}`}
                                  isLoading={unlinkingStandard === linkKey}
                                  isDisabled={Boolean(unlinkingStandard) || linkingStandard}
                                  onPress={() => handleUnlinkStandard(doc.id, link.standardId)}
                                  className="h-7 w-7 min-w-7"
                                >
                                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                                  </svg>
                                </Button>
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
                        onPress={() => handleDownload(doc)}
                        isLoading={downloadDocId === doc.id}
                        isDisabled={Boolean(downloadDocId) || deleting}
                      >
                        Download
                      </Button>
                      <Button
                        size="sm"
                        variant="flat"
                        onPress={() => openLinkModal(doc.id)}
                        isDisabled={linkingStandard || Boolean(unlinkingStandard)}
                      >
                        Link standard
                      </Button>
                      <Button
                        size="sm"
                        variant="flat"
                        color="danger"
                        onPress={() => confirmDelete(doc.id)}
                        isDisabled={deleting || Boolean(downloadDocId)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </DataListItems>
        </div>
      )}
    </DataList>
  );
}
