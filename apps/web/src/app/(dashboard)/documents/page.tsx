'use client';

import { Button } from '@heroui/react';
import { useDocumentTitle } from '@/lib/use-title';
import { evidencePackItems } from '@/lib/regulator-guidance';
import { AppPage, AppSection } from '@/components/ui/app-page';
import { EvidenceChip, StatusChip } from '@/components/ui/status';
import { DocumentDeleteModal } from './document-delete-modal';
import { DocumentListPanel } from './document-list-panel';
import { DocumentLinkModal } from './document-link-modal';
import { DocumentProfilePromptsPanel } from './document-profile-prompts';
import { DocumentUploadModal } from './document-upload-modal';
import { useDocumentsWorkflow } from './use-documents-workflow';

export default function DocumentsPage() {
  useDocumentTitle('Documents');
  const {
    categoryOptions,
    conditionalObligationPrompts,
    conditionalProfile,
    confirmDelete,
    deleteModal,
    deleting,
    documentCounts,
    documents,
    downloadDocId,
    fetchDocuments,
    fetchOrganisationProfile,
    handleDelete,
    handleDownload,
    handleLinkStandard,
    handleUnlinkStandard,
    handleUpload,
    linkDisabledReason,
    linkModal,
    linkedStandardsCount,
    linkingStandard,
    linkStandardId,
    loadError,
    loading,
    missingConditionalEvidenceCount,
    missingEvidenceCount,
    missingSignalCount,
    openLinkModal,
    organisationProfileError,
    resetUploadForm,
    selectedDeleteDoc,
    selectedLinkDoc,
    setLinkStandardId,
    setUploadApprovedDate,
    setUploadCategory,
    setUploadDescription,
    setUploadError,
    setUploadFile,
    setUploadMinuteReference,
    setUploadName,
    setUploadNextReviewDate,
    setUploadOwner,
    signalCoverage,
    standards,
    standardsError,
    unlinkingStandard,
    uploadApprovedDate,
    uploadCategory,
    uploadDescription,
    uploadDisabledReason,
    uploadError,
    uploadFile,
    uploading,
    uploadMinuteReference,
    uploadModal,
    uploadName,
    uploadNextReviewDate,
    uploadOwner,
  } = useDocumentsWorkflow();

  return (
    <AppPage
      eyebrow="Evidence vault"
      title="Document Vault"
      description="Store governance files in private evidence storage, then link them to standards so trustee review packs are review-ready."
      actions={(
        <Button
          className="bg-teal-primary text-white hover:bg-teal-dark"
          onPress={uploadModal.onOpen}
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Upload document
        </Button>
      )}
    >
      <section className="rounded-lg border border-teal-primary/20 bg-white p-5 shadow-sm dark:border-teal-light/20 dark:bg-gray-900">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-3xl">
            <StatusChip tone="brand">Evidence-led governance</StatusChip>
            <h2 className="mt-3 text-lg font-semibold text-gray-950 dark:text-gray-50">
              Keep board evidence close to the standard it supports.
            </h2>
            <p className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">
              Uploaded files are kept as private evidence until a signed download URL is requested.
              Link documents to standards with plain names, owners, review dates, and minute references.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3 lg:min-w-80">
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-950">
              <p className="text-xs text-gray-500 dark:text-gray-400">Documents</p>
              <p className="text-xl font-bold text-gray-950 dark:text-gray-50">{documents.length}</p>
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-950">
              <p className="text-xs text-gray-500 dark:text-gray-400">Linked standards</p>
              <p className="text-xl font-bold text-gray-950 dark:text-gray-50">{linkedStandardsCount}</p>
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-950">
              <p className="text-xs text-gray-500 dark:text-gray-400">Evidence gaps</p>
              <p className="text-xl font-bold text-gray-950 dark:text-gray-50">{missingEvidenceCount}</p>
            </div>
          </div>
        </div>
      </section>

      <AppSection
        title="Evidence pack"
        description="Use these prompts as a practical checklist for the documents trustees usually expect to see before annual review."
        actions={(
          <StatusChip tone={missingEvidenceCount === 0 ? 'success' : 'warning'}>
            {missingEvidenceCount === 0 ? 'Checklist covered' : `${missingEvidenceCount} evidence areas missing`}
          </StatusChip>
        )}
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {evidencePackItems.map((item) => {
            const count = documentCounts[item.category] ?? 0;
            return (
              <div key={item.title} className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-gray-950 dark:text-gray-50">{item.title}</h3>
                    <p className="mt-1 text-xs text-teal-dark dark:text-teal-bright">Standards {item.standards}</p>
                  </div>
                  <EvidenceChip status={count > 0 ? 'ready' : 'missing'}>
                    {count > 0 ? `${count} file${count === 1 ? '' : 's'}` : 'Needed'}
                  </EvidenceChip>
                </div>
              </div>
            );
          })}
        </div>
      </AppSection>

      <DocumentProfilePromptsPanel
        conditionalProfile={conditionalProfile}
        prompts={conditionalObligationPrompts}
        missingCount={missingConditionalEvidenceCount}
        error={organisationProfileError}
        onRetry={fetchOrganisationProfile}
      />

      <AppSection
        title="Operational register signals"
        description="These checks look for named registers and policies in titles or descriptions, so upload names should be easy for trustees to scan."
        actions={(
          <StatusChip tone={missingSignalCount === 0 ? 'success' : 'warning'}>
            {missingSignalCount === 0 ? 'Signals covered' : `${missingSignalCount} signals missing`}
          </StatusChip>
        )}
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {signalCoverage.map((item) => (
            <div key={item.title} className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-gray-950 dark:text-gray-50">{item.title}</h3>
                  <p className="mt-1 text-xs leading-5 text-gray-600 dark:text-gray-300">{item.why}</p>
                  <p className="mt-1 text-xs text-teal-dark dark:text-teal-bright">Standards {item.standards}</p>
                </div>
                <EvidenceChip status={item.covered ? 'ready' : 'review'}>
                  {item.covered ? 'Found' : 'Review'}
                </EvidenceChip>
              </div>
            </div>
          ))}
        </div>
      </AppSection>

      <DocumentListPanel
        documents={documents}
        loading={loading}
        loadError={loadError}
        onRetry={() => fetchDocuments(true)}
        onUploadFirst={uploadModal.onOpen}
        handleDownload={handleDownload}
        downloadDocId={downloadDocId}
        deleting={deleting}
        openLinkModal={openLinkModal}
        linkingStandard={linkingStandard}
        unlinkingStandard={unlinkingStandard}
        handleUnlinkStandard={handleUnlinkStandard}
        confirmDelete={confirmDelete}
      />

      <DocumentUploadModal
        isOpen={uploadModal.isOpen}
        onOpenChange={uploadModal.onOpenChange}
        categoryOptions={categoryOptions}
        uploadName={uploadName}
        setUploadName={setUploadName}
        uploadCategory={uploadCategory}
        setUploadCategory={setUploadCategory}
        uploadDescription={uploadDescription}
        setUploadDescription={setUploadDescription}
        uploadOwner={uploadOwner}
        setUploadOwner={setUploadOwner}
        uploadApprovedDate={uploadApprovedDate}
        setUploadApprovedDate={setUploadApprovedDate}
        uploadNextReviewDate={uploadNextReviewDate}
        setUploadNextReviewDate={setUploadNextReviewDate}
        uploadMinuteReference={uploadMinuteReference}
        setUploadMinuteReference={setUploadMinuteReference}
        uploadFile={uploadFile}
        setUploadFile={setUploadFile}
        uploadError={uploadError}
        setUploadError={setUploadError}
        uploadDisabledReason={uploadDisabledReason}
        resetUploadForm={resetUploadForm}
        handleUpload={handleUpload}
        uploading={uploading}
      />

      <DocumentDeleteModal
        isOpen={deleteModal.isOpen}
        onOpenChange={deleteModal.onOpenChange}
        selectedDeleteDoc={selectedDeleteDoc}
        deleting={deleting}
        handleDelete={handleDelete}
      />

      <DocumentLinkModal
        isOpen={linkModal.isOpen}
        onOpenChange={linkModal.onOpenChange}
        selectedLinkDoc={selectedLinkDoc}
        standards={standards}
        standardsError={standardsError}
        linkStandardId={linkStandardId}
        setLinkStandardId={setLinkStandardId}
        linkDisabledReason={linkDisabledReason}
        handleLinkStandard={handleLinkStandard}
        linkingStandard={linkingStandard}
      />
    </AppPage>
  );
}
