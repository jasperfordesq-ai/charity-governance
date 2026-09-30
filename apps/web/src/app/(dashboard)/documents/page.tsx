'use client';

import { Button } from '@heroui/react';
import { Plus } from 'lucide-react';
import { useDocumentTitle } from '@/lib/use-title';
import { primaryActionButtonClassName } from '@/components/ui/action-button';
import { AppPage } from '@/components/ui/app-page';
import { SaveStatusIndicator } from '@/components/ui/states';
import { DocumentDeleteModal } from './document-delete-modal';
import { DocumentStorageProviderModal } from './document-storage-provider-modal';
import { DocumentVisibilityModal } from './document-visibility-modal';
import { DocumentControlModal } from './document-control-modal';
import { DocumentControlHistory } from './document-control-history';
import { DocumentDeletedItems } from './document-deleted-items';
import { DocumentStorageDeletionReview } from './document-storage-deletion-review';
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
    canManage,
    conditionalObligationPrompts,
    conditionalProfile,
    confirmDelete,
    confirmVisibility,
    confirmDocumentControl,
    controlModal,
    controlKind,
    controlTarget,
    controlReason,
    publicationReviewMirror,
    publicationReviewLoading,
    publicationReviewError,
    replacementDocumentId,
    replacementSearch,
    replacementCandidates,
    replacementHasMore,
    replacementLoading,
    replacementError,
    setReplacementDocumentId,
    setReplacementSearch,
    searchReplacementCandidates,
    loadMoreReplacementCandidates,
    controlError,
    savingControl,
    selectedControlDoc,
    setControlTarget,
    setControlReason,
    openDocumentControl,
    documentLifecycleNext,
    deleteModal,
    deleting,
    deleteReason,
    setDeleteReason,
    providerModal,
    selectedProviderDoc,
    verifyingProvider,
    openProviderReview,
    verifyProvider,
    documentCounts,
    documents,
    documentTotal,
    documentHasMore,
    documentListChanged,
    downloadDocId,
    mirrors,
    retryMirrorPublication,
    retryingMirror,
    fetchDocuments,
    loadMoreDocuments,
    loadingMoreDocuments,
    loadMoreDocumentsError,
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
    openVisibilityModal,
    organisationProfileError,
    resetUploadForm,
    selectedDeleteDoc,
    selectedVisibilityDoc,
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
    setVisibilityReason,
    signalCoverage,
    standards,
    standardsError,
    savingVisibility,
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
    visibilityError,
    visibilityModal,
    visibilityReason,
    visibilityAssessment,
    setVisibilityAssessment,
  } = useDocumentsWorkflow();
  const documentDataReady = !loading && !loadError;
  const documentMutationStatus: 'idle' | 'saving' | 'saved' | 'error' =
    uploading || deleting || verifyingProvider || linkingStandard || Boolean(unlinkingStandard) ? 'saving' : 'idle';

  return (
    <AppPage
      eyebrow="Evidence vault"
      title="Document Vault"
      description={canManage
        ? 'Store governance files in private evidence storage, then link them to standards so trustee review packs are review-ready.'
        : 'Review and download governance files from the private evidence vault. Uploads and evidence links are managed by owners and administrators.'}
      actions={canManage ? (
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
      ) : undefined}
    >
      {documentDataReady && (
        <DocumentSummaryPanel
          documentsCount={documents.length}
          documentTotal={documentTotal}
          partial={documentHasMore || documentListChanged}
          linkedStandardsCount={linkedStandardsCount}
          missingEvidenceCount={missingEvidenceCount}
        />
      )}

      {documentDataReady && (
        <DocumentEvidencePackPanel
          documentCounts={documentCounts}
          missingEvidenceCount={missingEvidenceCount}
          partial={documentHasMore || documentListChanged}
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
          partial={documentHasMore || documentListChanged}
        />
      )}

      <DocumentListPanel
        canManage={canManage}
        documents={documents}
        documentTotal={documentTotal}
        hasMore={documentHasMore}
        listChanged={documentListChanged}
        loadingMore={loadingMoreDocuments}
        loadMoreError={loadMoreDocumentsError}
        onLoadMore={loadMoreDocuments}
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
        openVisibilityModal={openVisibilityModal}
        openDocumentControl={openDocumentControl}
        openProviderReview={openProviderReview}
        mirrors={mirrors}
        retryMirrorPublication={retryMirrorPublication}
        retryingMirror={retryingMirror}
      />

      {canManage ? <DocumentControlHistory /> : null}
      {canManage ? <DocumentDeletedItems onRestored={() => fetchDocuments(true)} /> : null}
      {canManage ? <DocumentStorageDeletionReview /> : null}

      <DocumentUploadModal
        isOpen={canManage && uploadModal.isOpen}
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
        isOpen={canManage && deleteModal.isOpen}
        onOpenChange={deleteModal.onOpenChange}
        selectedDeleteDoc={selectedDeleteDoc}
        deleting={deleting}
        reason={deleteReason}
        onReasonChange={setDeleteReason}
        handleDelete={handleDelete}
      />

      <DocumentStorageProviderModal
        isOpen={canManage && providerModal.isOpen}
        onOpenChange={providerModal.onOpenChange}
        document={selectedProviderDoc}
        verifying={verifyingProvider}
        onConfirm={verifyProvider}
      />

      <DocumentVisibilityModal
        isOpen={canManage && visibilityModal.isOpen}
        onOpenChange={visibilityModal.onOpenChange}
        document={selectedVisibilityDoc}
        reason={visibilityReason}
        setReason={setVisibilityReason}
        assessment={visibilityAssessment}
        setAssessment={setVisibilityAssessment}
        error={visibilityError}
        saving={savingVisibility}
        onConfirm={confirmVisibility}
      />

      <DocumentControlModal
        isOpen={canManage && controlModal.isOpen}
        onOpenChange={controlModal.onOpenChange}
        document={selectedControlDoc}
        approvalNeedsReview={Boolean(selectedControlDoc?.externalPublicationApproved &&
          publicationReviewMirror?.approvalDestinationCurrent === false &&
          publicationReviewMirror.pageRecorded === false)}
        publicationMirror={publicationReviewMirror}
        publicationReviewLoading={publicationReviewLoading}
        publicationReviewError={publicationReviewError}
        kind={controlKind}
        target={controlTarget}
        setTarget={setControlTarget}
        nextStatuses={documentLifecycleNext[selectedControlDoc?.lifecycleStatus ?? ''] ?? []}
        reason={controlReason}
        replacementDocumentId={replacementDocumentId}
        setReplacementDocumentId={setReplacementDocumentId}
        replacementSearch={replacementSearch}
        setReplacementSearch={setReplacementSearch}
        replacementCandidates={replacementCandidates}
        replacementHasMore={replacementHasMore}
        replacementLoading={replacementLoading}
        replacementError={replacementError}
        onSearchReplacements={searchReplacementCandidates}
        onLoadMoreReplacements={loadMoreReplacementCandidates}
        setReason={setControlReason}
        error={controlError}
        saving={savingControl}
        onConfirm={confirmDocumentControl}
      />

      <DocumentLinkModal
        isOpen={canManage && linkModal.isOpen}
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
