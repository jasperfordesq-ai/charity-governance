'use client';

import { Button } from '@heroui/react';
import { Plus } from 'lucide-react';
import { useDocumentTitle } from '@/lib/use-title';
import { primaryActionButtonClassName } from '@/components/ui/action-button';
import { AppPage } from '@/components/ui/app-page';
import { SaveStatusIndicator } from '@/components/ui/states';
import { DocumentDeleteModal } from './document-delete-modal';
import { DocumentEvidencePackPanel } from './document-evidence-pack-panel';
import { DocumentListPanel } from './document-list-panel';
import { DocumentLinkModal } from './document-link-modal';
import { DocumentOperationalSignalsPanel } from './document-operational-signals-panel';
import { DocumentProfilePromptsPanel } from './document-profile-prompts';
import { DocumentSummaryPanel } from './document-summary-panel';
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
  const documentMutationStatus: 'idle' | 'saving' | 'saved' | 'error' =
    uploading || deleting || linkingStandard || Boolean(unlinkingStandard) ? 'saving' : 'idle';

  return (
    <AppPage
      eyebrow="Evidence vault"
      title="Document Vault"
      description="Store governance files in private evidence storage, then link them to standards so trustee review packs are review-ready."
      actions={(
        <>
          <SaveStatusIndicator status={documentMutationStatus} />
          <Button
            className={primaryActionButtonClassName}
            onPress={uploadModal.onOpen}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Upload document
          </Button>
        </>
      )}
    >
      {documentDataReady && (
        <DocumentSummaryPanel
          documentsCount={documents.length}
          linkedStandardsCount={linkedStandardsCount}
          missingEvidenceCount={missingEvidenceCount}
        />
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
