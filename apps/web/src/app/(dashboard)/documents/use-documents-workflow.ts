'use client';

import { logClientError } from '@/lib/client-logger';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDisclosure } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage, isApiNotFoundError } from '@/lib/errors';
import { useToast } from '@/components/toast';
import { evidencePackItems, operationalEvidenceSignals } from '@/lib/regulator-guidance';
import { getTrustedDocumentDownloadUrl } from '@/lib/url-security';
import { buildDocumentProfilePrompts } from './document-profile-prompts';
import { MAX_FILE_SIZE } from './document-upload-modal';
import type {
  DocumentResponse,
  GovernanceStandardResponse,
  OrganisationResponse,
} from '@charitypilot/shared';
import {
  DocumentCategory,
  DOCUMENT_CATEGORY_LABELS,
} from '@charitypilot/shared';

export function useDocumentsWorkflow() {
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
      if (isApiNotFoundError(err)) {
        setOrganisation(null);
        return;
      }
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

  return {
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
  };
}
