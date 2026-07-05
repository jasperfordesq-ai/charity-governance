'use client';

import { Button } from '@heroui/react';
import { Plus } from 'lucide-react';
import { useDocumentTitle } from '@/lib/use-title';
import { primaryActionButtonClassName } from '@/components/ui/action-button';
import { AppPage } from '@/components/ui/app-page';
import { StatusChip, statusPanelClassName } from '@/components/ui/status';
import { DocumentDeleteModal } from './document-delete-modal';
import { DocumentEvidencePackPanel } from './document-evidence-pack-panel';
import { DocumentListPanel } from './document-list-panel';
import { DocumentLinkModal } from './document-link-modal';
import { DocumentOperationalSignalsPanel } from './document-operational-signals-panel';
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
  const documentDataReady = !loading && !loadError;

  return (
    <AppPage
      eyebrow="Evidence vault"
      title="Document Vault"
      description="Store governance files in private evidence storage, then link them to standards so trustee review packs are review-ready."
      actions={(
        <Button
          className={primaryActionButtonClassName}
          onPress={uploadModal.onOpen}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Upload document
        </Button>
      )}
    >
      {documentDataReady && (
        <section className={statusPanelClassName('brand', 'p-5 shadow-sm')}>
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
              <div className={statusPanelClassName('neutral', 'p-3')}>
                <p className="text-xs text-gray-500 dark:text-gray-400">Documents</p>
                <p className="text-xl font-bold text-gray-950 dark:text-gray-50">{documents.length}</p>
              </div>
              <div className={statusPanelClassName('neutral', 'p-3')}>
                <p className="text-xs text-gray-500 dark:text-gray-400">Linked standards</p>
                <p className="text-xl font-bold text-gray-950 dark:text-gray-50">{linkedStandardsCount}</p>
              </div>
              <div className={statusPanelClassName('neutral', 'p-3')}>
                <p className="text-xs text-gray-500 dark:text-gray-400">Evidence gaps</p>
                <p className="text-xl font-bold text-gray-950 dark:text-gray-50">{missingEvidenceCount}</p>
              </div>
            </div>
          </div>
        </section>
      )}

      {documentDataReady && (
        <DocumentEvidencePackPanel
          documentCounts={documentCounts}
          missingEvidenceCount={missingEvidenceCount}
        />
      )}

      {documentDataReady && (
        <DocumentProfilePromptsPanel
          conditionalProfile={conditionalProfile}
          prompts={conditionalObligationPrompts}
          missingCount={missingConditionalEvidenceCount}
          error={organisationProfileError}
          onRetry={fetchOrganisationProfile}
        />
      )}

      {documentDataReady && (
        <DocumentOperationalSignalsPanel
          missingSignalCount={missingSignalCount}
          signalCoverage={signalCoverage}
        />
      )}

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
