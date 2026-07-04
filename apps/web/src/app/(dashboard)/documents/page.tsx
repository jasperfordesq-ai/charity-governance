'use client';

import { logClientError } from '@/lib/client-logger';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDocumentTitle } from '@/lib/use-title';
import {
  Button,
  useDisclosure,
} from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { useToast } from '@/components/toast';
import { evidencePackItems, operationalEvidenceSignals } from '@/lib/regulator-guidance';
import { getTrustedDocumentDownloadUrl } from '@/lib/url-security';
import { AppPage, AppSection } from '@/components/ui/app-page';
import { EvidenceChip, StatusChip } from '@/components/ui/status';
import { DocumentDeleteModal } from './document-delete-modal';
import { DocumentListPanel } from './document-list-panel';
import { DocumentLinkModal } from './document-link-modal';
import { DocumentProfilePromptsPanel, buildDocumentProfilePrompts } from './document-profile-prompts';
import { DocumentUploadModal, MAX_FILE_SIZE } from './document-upload-modal';
import type {
  DocumentResponse,
  GovernanceStandardResponse,
  OrganisationResponse,
} from '@charitypilot/shared';
import {
  DocumentCategory,
  DOCUMENT_CATEGORY_LABELS,
} from '@charitypilot/shared';

export default function DocumentsPage() {
  useDocumentTitle('Documents');
  const [documents, setDocuments] = useState<DocumentResponse[]>([]);
  const [standards, setStandards] = useState<GovernanceStandardResponse[]>([]);
  const [organisation, setOrganisation] = useState<OrganisationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [standardsError, setStandardsError] = useState('');
  const [organisationProfileError, setOrganisationProfileError] = useState('');
  const { toast } = useToast();

  const uploadModal = useDisclosure();
  const [uploadName, setUploadName] = useState('');
  const [uploadCategory, setUploadCategory] = useState<DocumentCategory>(DocumentCategory.OTHER);
  const [uploadDescription, setUploadDescription] = useState('');
  const [uploadOwner, setUploadOwner] = useState('');
  const [uploadApprovedDate, setUploadApprovedDate] = useState('');
  const [uploadNextReviewDate, setUploadNextReviewDate] = useState('');
  const [uploadMinuteReference, setUploadMinuteReference] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');

  const deleteModal = useDisclosure();
  const [deleteDocId, setDeleteDocId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const linkModal = useDisclosure();
  const [linkDocId, setLinkDocId] = useState<string | null>(null);
  const [linkStandardId, setLinkStandardId] = useState('');
  const [linkingStandard, setLinkingStandard] = useState(false);
  const [unlinkingStandard, setUnlinkingStandard] = useState<string | null>(null);
  const [downloadDocId, setDownloadDocId] = useState<string | null>(null);

  const fetchDocuments = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    setLoadError('');
    try {
      const res = await api.get('/documents');
      setDocuments(res.data?.data ?? res.data ?? []);
    } catch (err) {
      const message = apiErrorMessage(err, 'Documents could not be loaded. Please try again.');
      logClientError('Failed to load documents', err);
      setLoadError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchStandards = useCallback(async () => {
    setStandardsError('');
    try {
      const res = await api.get('/compliance/principles');
      const principles = res.data?.data ?? res.data ?? [];
      const allStandards: GovernanceStandardResponse[] = [];
      for (const p of principles) {
        for (const s of p.standards ?? []) {
          allStandards.push(s);
        }
      }
      setStandards(allStandards);
    } catch (err) {
      const message = apiErrorMessage(err, 'Standards could not be loaded for linking.');
      logClientError('Failed to load standards', err);
      setStandardsError(message);
    }
  }, []);

  const fetchOrganisationProfile = useCallback(async () => {
    setOrganisationProfileError('');
    try {
      const res = await api.get('/organisations');
      setOrganisation(res.data?.data ?? res.data ?? null);
    } catch (err) {
      const message = apiErrorMessage(err, 'Organisation profile could not be loaded for conditional evidence prompts.');
      logClientError('Failed to load organisation profile for document prompts', err);
      setOrganisationProfileError(message);
    }
  }, []);

  useEffect(() => {
    fetchDocuments(true);
    fetchStandards();
    fetchOrganisationProfile();
  }, [fetchDocuments, fetchOrganisationProfile, fetchStandards]);

  const categoryOptions = Object.entries(DOCUMENT_CATEGORY_LABELS);
  const conditionalProfile = organisation?.conditionalObligationProfile ?? null;

  const documentCounts = useMemo(() => {
    return documents.reduce<Record<string, number>>((acc, doc) => {
      acc[doc.category] = (acc[doc.category] ?? 0) + 1;
      return acc;
    }, {});
  }, [documents]);

  const documentSearchText = useMemo(() => {
    return documents
      .map((doc) => `${doc.name} ${doc.description ?? ''} ${doc.category}`.toLowerCase())
      .join(' ');
  }, [documents]);

  const signalCoverage = useMemo(() => {
    return operationalEvidenceSignals.map((signal) => {
      const hasCategory = signal.categories.some((category) => (documentCounts[category] ?? 0) > 0);
      const hasKeyword = signal.keywords.some((keyword) => documentSearchText.includes(keyword.toLowerCase()));
      return {
        ...signal,
        covered: hasCategory && hasKeyword,
      };
    });
  }, [documentCounts, documentSearchText]);

  const conditionalObligationPrompts = useMemo(() => {
    return buildDocumentProfilePrompts(organisation?.conditionalObligationProfile, documents);
  }, [documents, organisation?.conditionalObligationProfile]);

  const missingEvidenceCount = evidencePackItems.filter((item) => !documentCounts[item.category]).length;
  const missingSignalCount = signalCoverage.filter((item) => !item.covered).length;
  const missingConditionalEvidenceCount = conditionalObligationPrompts.filter((item) => item.linkedEvidenceCount === 0).length;
  const linkedStandardsCount = documents.reduce((total, doc) => total + (doc.standardLinks?.length ?? 0), 0);
  const selectedLinkDoc = documents.find((doc) => doc.id === linkDocId);
  const selectedDeleteDoc = documents.find((doc) => doc.id === deleteDocId);

  const uploadDisabledReason = useMemo(() => {
    if (!uploadName.trim()) return 'Add a document name before uploading.';
    if (!uploadFile) return 'Choose a file to upload.';
    if (uploadFile.size > MAX_FILE_SIZE) return 'Choose a file under the 10 MB upload limit.';
    return '';
  }, [uploadFile, uploadName]);

  const linkDisabledReason = useMemo(() => {
    if (standardsError) return standardsError;
    if (standards.length === 0) return 'Compliance standards are still loading.';
    if (!linkStandardId) return 'Choose a standard to link this document as evidence.';
    return '';
  }, [linkStandardId, standards.length, standardsError]);

  const resetUploadForm = () => {
    setUploadName('');
    setUploadCategory(DocumentCategory.OTHER);
    setUploadDescription('');
    setUploadOwner('');
    setUploadApprovedDate('');
    setUploadNextReviewDate('');
    setUploadMinuteReference('');
    setUploadFile(null);
    setUploadError('');
  };

  const handleUpload = async () => {
    if (uploadDisabledReason) {
      setUploadError(uploadDisabledReason);
      return;
    }

    if (!uploadFile) return;

    setUploadError('');
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', uploadFile);
      formData.append('name', uploadName.trim());
      formData.append('category', uploadCategory);
      if (uploadDescription.trim()) formData.append('description', uploadDescription.trim());
      if (uploadOwner.trim()) formData.append('owner', uploadOwner.trim());
      if (uploadApprovedDate) formData.append('approvedDate', uploadApprovedDate);
      if (uploadNextReviewDate) formData.append('nextReviewDate', uploadNextReviewDate);
      if (uploadMinuteReference.trim()) {
        formData.append('boardMinuteReference', uploadMinuteReference.trim());
      }

      await api.post('/documents', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      resetUploadForm();
      uploadModal.onClose();
      await fetchDocuments();
      toast('Document uploaded successfully');
    } catch (err) {
      const message = apiErrorMessage(err, 'Upload failed. Please try again.');
      logClientError('Upload failed', err);
      setUploadError(message);
      toast('Upload failed', 'error');
    } finally {
      setUploading(false);
    }
  };

  const confirmDelete = (docId: string) => {
    setDeleteDocId(docId);
    deleteModal.onOpen();
  };

  const handleDelete = async () => {
    if (!deleteDocId) return;
    setDeleting(true);
    try {
      await api.delete(`/documents/${deleteDocId}`);
      setDocuments((prev) => prev.filter((d) => d.id !== deleteDocId));
      deleteModal.onClose();
      setDeleteDocId(null);
      toast('Document deleted');
    } catch (err) {
      logClientError('Delete failed', err);
      toast(apiErrorMessage(err, 'Failed to delete document'), 'error');
    } finally {
      setDeleting(false);
    }
  };

  const openLinkModal = (docId: string) => {
    setLinkDocId(docId);
    setLinkStandardId('');
    linkModal.onOpen();
  };

  const handleLinkStandard = async () => {
    if (!linkDocId || linkDisabledReason) return;

    setLinkingStandard(true);
    try {
      await api.post(`/documents/${linkDocId}/standards`, { standardId: linkStandardId });
      linkModal.onClose();
      setLinkDocId(null);
      setLinkStandardId('');
      await fetchDocuments();
      toast('Standard linked to document');
    } catch (err) {
      logClientError('Link failed', err);
      toast(apiErrorMessage(err, 'Could not link this standard'), 'error');
    } finally {
      setLinkingStandard(false);
    }
  };

  const handleUnlinkStandard = async (docId: string, standardId: string) => {
    const linkKey = `${docId}:${standardId}`;
    setUnlinkingStandard(linkKey);
    try {
      await api.delete(`/documents/${docId}/standards/${standardId}`);
      await fetchDocuments();
      toast('Standard link removed');
    } catch (err) {
      logClientError('Unlink failed', err);
      toast(apiErrorMessage(err, 'Could not remove this standard link'), 'error');
    } finally {
      setUnlinkingStandard(null);
    }
  };

  const handleDownload = async (doc: DocumentResponse) => {
    setDownloadDocId(doc.id);
    try {
      const { data } = await api.get(`/documents/${doc.id}/download`);
      const downloadUrl = getTrustedDocumentDownloadUrl(data?.url);
      if (downloadUrl) {
        window.open(downloadUrl, '_blank', 'noopener,noreferrer');
        return;
      }
      toast('Could not prepare this document download', 'error');
    } catch (err) {
      logClientError('Download failed', err);
      toast(apiErrorMessage(err, 'Could not prepare this document download'), 'error');
    } finally {
      setDownloadDocId(null);
    }
  };

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
