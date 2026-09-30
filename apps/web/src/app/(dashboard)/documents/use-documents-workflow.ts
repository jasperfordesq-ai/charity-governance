'use client';

import { logClientError } from '@/lib/client-logger';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDisclosure } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage, isApiForbiddenError, isApiNotFoundError } from '@/lib/errors';
import { canManageGovernance } from '@/lib/governance-permissions';
import { useAuth } from '@/lib/auth-context';
import { useToast } from '@/components/toast';
import { evidencePackItems, operationalEvidenceSignals } from '@/lib/regulator-guidance';
import { getTrustedDocumentDownloadUrl } from '@/lib/url-security';
import { documentDownloadFilename } from '@/lib/document-download-filename';
import { loadDocumentMirrors } from '@/lib/document-mirrors';
import type { ConfluenceMirror } from '@/lib/integration-status';
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

const DOCUMENT_OBJECT_URL_REVOKE_DELAY_MS = 30_000;
const DOCUMENT_PAGE_SIZE = 50;
const DOCUMENT_LIFECYCLE_NEXT: Record<string, string[]> = {
  UNREVIEWED: ['DRAFT', 'CURRENT', 'SUPERSEDED', 'RETIRED', 'HISTORICAL'],
  DRAFT: ['CURRENT', 'RETIRED'],
  CURRENT: ['SUPERSEDED', 'RETIRED'],
  SUPERSEDED: ['HISTORICAL'],
  RETIRED: ['HISTORICAL'],
  HISTORICAL: [],
};

export function useDocumentsWorkflow() {
  const [documents, setDocuments] = useState<DocumentResponse[]>([]);
  const [documentCursor, setDocumentCursor] = useState<string | null>(null);
  const [documentTotal, setDocumentTotal] = useState(0);
  const [documentHasMore, setDocumentHasMore] = useState(false);
  const [documentListChanged, setDocumentListChanged] = useState(false);
  const [loadingMoreDocuments, setLoadingMoreDocuments] = useState(false);
  const [loadMoreDocumentsError, setLoadMoreDocumentsError] = useState('');
  const documentRequest = useRef(0);
  const [standards, setStandards] = useState<GovernanceStandardResponse[]>([]);
  const [organisation, setOrganisation] = useState<OrganisationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [standardsError, setStandardsError] = useState('');
  const [organisationProfileError, setOrganisationProfileError] = useState('');
  const { toast } = useToast();
  const { user, refreshUser } = useAuth();
  const [governanceAccessRevoked, setGovernanceAccessRevoked] = useState(false);
  const canManage = canManageGovernance(user?.role) && !governanceAccessRevoked;

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
  const visibilityModal = useDisclosure();
  const [visibilityDocId, setVisibilityDocId] = useState<string | null>(null);
  const [visibilityReason, setVisibilityReason] = useState('');
  const [visibilityAssessment, setVisibilityAssessment] = useState<'UNASSESSED' | 'MEMBER_SUITABLE' | 'RESTRICTED_SENSITIVE'>('UNASSESSED');
  const [visibilityError, setVisibilityError] = useState('');
  const [savingVisibility, setSavingVisibility] = useState(false);
  const controlModal = useDisclosure();
  const [controlDocId, setControlDocId] = useState<string | null>(null);
  const [controlKind, setControlKind] = useState<'lifecycle' | 'publication' | 'deletion-hold'>('lifecycle');
  const [controlTarget, setControlTarget] = useState('');
  const [controlReason, setControlReason] = useState('');
  const [publicationReviewMirror, setPublicationReviewMirror] = useState<ConfluenceMirror | null>(null);
  const [publicationReviewLoading, setPublicationReviewLoading] = useState(false);
  const [publicationReviewError, setPublicationReviewError] = useState('');
  const publicationReviewRequest = useRef(0);
  const [replacementDocumentId, setReplacementDocumentId] = useState('');
  const [replacementSearch, setReplacementSearch] = useState('');
  const [replacementCandidates, setReplacementCandidates] = useState<{ id: string; name: string }[]>([]);
  const [replacementPage, setReplacementPage] = useState(1);
  const [replacementHasMore, setReplacementHasMore] = useState(false);
  const [replacementLoading, setReplacementLoading] = useState(false);
  const [replacementError, setReplacementError] = useState('');
  const replacementRequest = useRef(0);
  const [controlError, setControlError] = useState('');
  const [savingControl, setSavingControl] = useState(false);
  const [deleteDocId, setDeleteDocId] = useState<string | null>(null);
  const [deleteReason, setDeleteReason] = useState('');
  const [deleting, setDeleting] = useState(false);
  const providerModal = useDisclosure();
  const [providerDocId, setProviderDocId] = useState<string | null>(null);
  const [verifyingProvider, setVerifyingProvider] = useState(false);

  const linkModal = useDisclosure();
  const [linkDocId, setLinkDocId] = useState<string | null>(null);
  const [linkStandardId, setLinkStandardId] = useState('');
  const [linkingStandard, setLinkingStandard] = useState(false);
  const [unlinkingStandard, setUnlinkingStandard] = useState<string | null>(null);
  const [downloadDocId, setDownloadDocId] = useState<string | null>(null);
  const [mirrors, setMirrors] = useState<Map<string, ConfluenceMirror>>(new Map());
  const [retryingMirror, setRetryingMirror] = useState<string | null>(null);

  const fetchDocuments = useCallback(async (showLoading = false) => {
    const requestId = ++documentRequest.current;
    if (showLoading) setLoading(true);
    setLoadError('');
    setLoadMoreDocumentsError('');
    setLoadingMoreDocuments(false);
    try {
      const res = await api.get('/documents', { params: { page: 1, pageSize: DOCUMENT_PAGE_SIZE } });
      if (requestId !== documentRequest.current) return;
      const loaded: DocumentResponse[] = res.data?.data ?? res.data ?? [];
      const nextCursor: string | null = res.data?.nextCursor ?? null;
      const nextTotal: number = res.data?.total ?? loaded.length;
      const more = Boolean(res.data?.hasMore);
      setDocuments(loaded);
      setDocumentCursor(nextCursor);
      setDocumentTotal(nextTotal);
      setDocumentHasMore(more && Boolean(nextCursor));
      setDocumentListChanged((!more && loaded.length !== nextTotal) || (more && !nextCursor));
      // After the documents, never instead of them, and never blocking them.
      // `loadDocumentMirrors` resolves to an empty map on any failure, so a
      // charity with no Confluence integration, an expired session or a 500 all
      // render the list with no mirror chips rather than an error. A document
      // with no entry shows nothing at all — "we could not ask" is not "there
      // is no page", and only one of those is safe to tell a trustee.
      const nextMirrors = canManage ? await loadDocumentMirrors(loaded.map((doc) => doc.id)) : new Map();
      if (requestId === documentRequest.current) setMirrors(nextMirrors);
    } catch (err) {
      if (requestId !== documentRequest.current) return;
      const message = apiErrorMessage(err, 'Documents could not be loaded. Please try again.');
      logClientError('Failed to load documents', err);
      setLoadError(message);
    } finally {
      if (requestId === documentRequest.current) setLoading(false);
    }
  }, [canManage]);

  const loadMoreDocuments = useCallback(async () => {
    if (loadingMoreDocuments || !documentHasMore || !documentCursor) return;
    const requestId = documentRequest.current;
    setLoadingMoreDocuments(true);
    setLoadMoreDocumentsError('');
    try {
      const res = await api.get('/documents', { params: { before: documentCursor, pageSize: DOCUMENT_PAGE_SIZE } });
      if (requestId !== documentRequest.current) return;
      const loaded: DocumentResponse[] = res.data?.data ?? res.data ?? [];
      const previousCount = documents.length;
      const seen = new Set(documents.map((doc) => doc.id));
      const fresh = loaded.filter((doc) => !seen.has(doc.id));
      const nextTotal = res.data?.total ?? previousCount + fresh.length;
      const nextCursor: string | null = res.data?.nextCursor ?? null;
      const more = Boolean(res.data?.hasMore);
      setDocuments((current) => {
        const currentIds = new Set(current.map((doc) => doc.id));
        return [...current, ...fresh.filter((doc) => !currentIds.has(doc.id))];
      });
      setDocumentCursor(nextCursor);
      setDocumentTotal(nextTotal);
      setDocumentHasMore(more && Boolean(nextCursor));
      if ((!more && previousCount + fresh.length !== nextTotal) || (more && !nextCursor)) {
        setDocumentListChanged(true);
      }
      if (canManage) {
        const nextMirrors = await loadDocumentMirrors(loaded.map((doc) => doc.id));
        if (requestId === documentRequest.current) {
          setMirrors((current) => new Map([...current, ...nextMirrors]));
        }
      }
    } catch (err) {
      if (requestId !== documentRequest.current) return;
      logClientError('Failed to load more documents', err);
      setLoadMoreDocumentsError(apiErrorMessage(err, 'Older documents could not be loaded. Please try again.'));
    } finally {
      if (requestId === documentRequest.current) setLoadingMoreDocuments(false);
    }
  }, [canManage, documentCursor, documentHasMore, documents, loadingMoreDocuments]);

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
      const res = await api.get('/organisation');
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
  const currentDocuments = useMemo(() => documents.filter((doc) => doc.lifecycleStatus === 'CURRENT'), [documents]);

  const documentCounts = useMemo(() => {
    return currentDocuments.reduce<Record<string, number>>((acc, doc) => {
      acc[doc.category] = (acc[doc.category] ?? 0) + 1;
      return acc;
    }, {});
  }, [currentDocuments]);

  const documentSearchText = useMemo(() => {
    return currentDocuments
      .map((doc) => `${doc.name} ${doc.description ?? ''} ${doc.category}`.toLowerCase())
      .join(' ');
  }, [currentDocuments]);

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
    return buildDocumentProfilePrompts(organisation?.conditionalObligationProfile, currentDocuments);
  }, [currentDocuments, organisation?.conditionalObligationProfile]);

  const missingEvidenceCount = evidencePackItems.filter((item) => !documentCounts[item.category]).length;
  const missingSignalCount = signalCoverage.filter((item) => !item.covered).length;
  const missingConditionalEvidenceCount = conditionalObligationPrompts.filter((item) => item.linkedEvidenceCount === 0).length;
  const linkedStandardsCount = currentDocuments.reduce((total, doc) => total + (doc.standardLinks?.length ?? 0), 0);
  const selectedLinkDoc = documents.find((doc) => doc.id === linkDocId);
  const selectedDeleteDoc = documents.find((doc) => doc.id === deleteDocId);
  const selectedProviderDoc = documents.find((doc) => doc.id === providerDocId);

  const uploadDisabledReason = useMemo(() => {
    if (!canManage) return 'Only organisation owners and administrators can upload documents.';
    if (!uploadName.trim()) return 'Add a document name before uploading.';
    if (!uploadFile) return 'Choose a file to upload.';
    if (uploadFile.size > MAX_FILE_SIZE) return 'Choose a file under the 10 MB upload limit.';
    return '';
  }, [canManage, uploadFile, uploadName]);

  const linkDisabledReason = useMemo(() => {
    if (!canManage) return 'Only organisation owners and administrators can change evidence links.';
    if (standardsError) return standardsError;
    if (standards.length === 0) return 'Compliance standards are still loading.';
    if (!linkStandardId) return 'Choose a standard to link this document as evidence.';
    return '';
  }, [canManage, linkStandardId, standards.length, standardsError]);

  const resetUploadForm = useCallback(() => {
    setUploadName('');
    setUploadCategory(DocumentCategory.OTHER);
    setUploadDescription('');
    setUploadOwner('');
    setUploadApprovedDate('');
    setUploadNextReviewDate('');
    setUploadMinuteReference('');
    setUploadFile(null);
    setUploadError('');
  }, []);

  useEffect(() => {
    setGovernanceAccessRevoked(false);
  }, [user?.id, user?.role]);

  useEffect(() => {
    if (canManage) return;
    uploadModal.onClose();
    deleteModal.onClose();
    visibilityModal.onClose();
    controlModal.onClose();
    linkModal.onClose();
    setDeleteDocId(null);
    setLinkDocId(null);
    setLinkStandardId('');
    setUnlinkingStandard(null);
    resetUploadForm();
  }, [canManage, controlModal, deleteModal, linkModal, resetUploadForm, uploadModal, visibilityModal]);

  const reconcileForbiddenMutation = async (error: unknown) => {
    if (!isApiForbiddenError(error)) return false;
    setGovernanceAccessRevoked(true);
    uploadModal.onClose();
    deleteModal.onClose();
    visibilityModal.onClose();
    controlModal.onClose();
    linkModal.onClose();
    setDeleteDocId(null);
    setLinkDocId(null);
    setLinkStandardId('');
    setUnlinkingStandard(null);
    resetUploadForm();
    toast('Your role no longer allows document changes. The evidence vault is now read-only.', 'error');
    await refreshUser();
    return true;
  };

  const handleUpload = async () => {
    if (!canManage) {
      setUploadError('Only organisation owners and administrators can upload documents.');
      return;
    }
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
      if (await reconcileForbiddenMutation(err)) return;
      const message = apiErrorMessage(err, 'Upload failed. Please try again.');
      logClientError('Upload failed', err);
      setUploadError(message);
      toast('Upload failed', 'error');
    } finally {
      setUploading(false);
    }
  };

  const confirmDelete = (docId: string) => {
    if (!canManage) return;
    const candidate = documents.find((doc) => doc.id === docId);
    if (!candidate || candidate.deletionHold || candidate.storageProviderVerified === false || candidate.lifecycleStatus !== 'DRAFT') return;
    setDeleteDocId(docId);
    setDeleteReason('');
    deleteModal.onOpen();
  };

  const openVisibilityModal = (docId: string) => {
    if (!canManage) return;
    setVisibilityDocId(docId);
    setVisibilityAssessment(documents.find((doc) => doc.id === docId)?.contentAccessClass ?? 'UNASSESSED');
    setVisibilityReason('');
    setVisibilityError('');
    visibilityModal.onOpen();
  };

  const selectedVisibilityDoc = documents.find((doc) => doc.id === visibilityDocId);
  const confirmVisibility = async () => {
    if (!canManage || !selectedVisibilityDoc || visibilityReason.trim().length < 10) return;
    const needsByteReview = selectedVisibilityDoc.contentAccessClass === 'MEMBER_SUITABLE' &&
      selectedVisibilityDoc.memberByteReviewVerified !== true;
    const granting = selectedVisibilityDoc.visibility !== 'MEMBER_VISIBLE' || needsByteReview;
    const assessmentChanged = granting && (visibilityAssessment !== selectedVisibilityDoc.contentAccessClass ||
      (visibilityAssessment === 'MEMBER_SUITABLE' && needsByteReview));
    const nextVisibility = granting && visibilityAssessment === 'MEMBER_SUITABLE' ? 'MEMBER_VISIBLE' : 'RESTRICTED';
    const visibilityChanged = nextVisibility !== selectedVisibilityDoc.visibility;
    if (!visibilityChanged && !assessmentChanged) return;
    setSavingVisibility(true);
    setVisibilityError('');
    try {
      await api.patch(`/documents/${encodeURIComponent(selectedVisibilityDoc.id)}`, {
        expectedUpdatedAt: selectedVisibilityDoc.updatedAt,
        ...(visibilityChanged ? { visibility: nextVisibility, visibilityReason: visibilityReason.trim() } : {}),
        ...(assessmentChanged ? { contentAccessClass: visibilityAssessment, contentAccessReason: visibilityReason.trim() } : {}),
      });
      visibilityModal.onClose();
      setVisibilityDocId(null);
      setVisibilityReason('');
      setVisibilityAssessment('UNASSESSED');
      await fetchDocuments();
      toast('Document visibility updated.');
    } catch (err) {
      if (await reconcileForbiddenMutation(err)) return;
      setVisibilityError(apiErrorMessage(err, 'Document visibility could not be changed. Refresh and try again.'));
    } finally {
      setSavingVisibility(false);
    }
  };

  const selectedControlDoc = documents.find((doc) => doc.id === controlDocId);
  const loadReplacementCandidates = useCallback(async (docId: string, page: number, q: string) => {
    const requestNumber = ++replacementRequest.current;
    setReplacementLoading(true);
    setReplacementError('');
    if (page === 1) {
      setReplacementCandidates([]);
      setReplacementHasMore(false);
    }
    try {
      const response = await api.get(`/documents/replacement-candidates/${encodeURIComponent(docId)}`, { params: { page, q } });
      if (requestNumber !== replacementRequest.current) return;
      const result = response.data;
      const entries = Array.isArray(result?.data) ? result.data as { id: string; name: string }[] : [];
      setReplacementCandidates((current) => page === 1 ? entries : [...current, ...entries]);
      setReplacementPage(page);
      setReplacementHasMore(Boolean(result?.hasMore));
    } catch (cause) {
      if (requestNumber !== replacementRequest.current) return;
      setReplacementError(apiErrorMessage(cause, 'Current replacement documents could not be loaded.'));
    } finally {
      if (requestNumber === replacementRequest.current) setReplacementLoading(false);
    }
  }, []);
  const openDocumentControl = (docId: string, kind: 'lifecycle' | 'publication' | 'deletion-hold') => {
    if (!canManage) return;
    const document = documents.find((doc) => doc.id === docId);
    if (!document) return;
    setControlDocId(docId);
    setControlKind(kind);
    setControlTarget(kind === 'lifecycle' ? DOCUMENT_LIFECYCLE_NEXT[document.lifecycleStatus]?.[0] ?? '' : '');
    setControlReason('');
    setPublicationReviewMirror(null);
    setPublicationReviewError('');
    const publicationRequest = ++publicationReviewRequest.current;
    setPublicationReviewLoading(kind === 'publication');
    if (kind === 'publication') {
      void loadDocumentMirrors([docId]).then((fresh) => {
        if (publicationRequest !== publicationReviewRequest.current) return;
        const mirror = fresh.get(docId) ?? null;
        setPublicationReviewMirror(mirror);
        if (!mirror) setPublicationReviewError('The current Confluence destination could not be loaded. Close and reopen this review.');
      }).finally(() => {
        if (publicationRequest === publicationReviewRequest.current) setPublicationReviewLoading(false);
      });
    }
    setReplacementDocumentId('');
    setReplacementSearch('');
    setReplacementCandidates([]);
    setReplacementHasMore(false);
    setReplacementError('');
    replacementRequest.current += 1;
    if (kind === 'lifecycle' && DOCUMENT_LIFECYCLE_NEXT[document.lifecycleStatus]?.[0] === 'SUPERSEDED') {
      void loadReplacementCandidates(docId, 1, '');
    }
    setControlError('');
    controlModal.onOpen();
  };
  const chooseControlTarget = (next: string) => {
    setControlTarget(next);
    setReplacementDocumentId('');
    if (next === 'SUPERSEDED' && controlDocId) void loadReplacementCandidates(controlDocId, 1, replacementSearch);
  };
  const searchReplacementCandidates = () => {
    if (!controlDocId) return;
    setReplacementDocumentId('');
    void loadReplacementCandidates(controlDocId, 1, replacementSearch);
  };
  const loadMoreReplacementCandidates = () => {
    if (!controlDocId || !replacementHasMore || replacementLoading) return;
    void loadReplacementCandidates(controlDocId, replacementPage + 1, replacementSearch);
  };
  const confirmDocumentControl = async () => {
    if (!canManage || !selectedControlDoc || controlReason.trim().length < 10) return;
    if (controlKind === 'lifecycle' && !DOCUMENT_LIFECYCLE_NEXT[selectedControlDoc.lifecycleStatus]?.includes(controlTarget)) return;
    if (controlKind === 'lifecycle' && controlTarget === 'SUPERSEDED' && !replacementDocumentId) {
      setControlError('Choose the current replacement document.');
      return;
    }
    const needsReapproval = selectedControlDoc.externalPublicationApproved &&
      publicationReviewMirror?.approvalDestinationCurrent === false && publicationReviewMirror.pageRecorded === false;
    const grantingPublication = controlKind === 'publication' &&
      (!selectedControlDoc.externalPublicationApproved || needsReapproval);
    if (controlKind === 'publication' && (publicationReviewLoading || !publicationReviewMirror)) {
      setControlError('The current Confluence state must load before this decision can be saved.');
      return;
    }
    if (grantingPublication && !publicationReviewMirror?.publishDestination) {
      setControlError('Choose a connected Confluence publishing space in Integrations before approving this file.');
      return;
    }
    if (grantingPublication && publicationReviewMirror?.recordedPageMatchesDestination === false) {
      setControlError('A recorded Confluence page belongs to another or unverified destination. Review that copy before approving publication here.');
      return;
    }
    setSavingControl(true);
    setControlError('');
    try {
      if (controlKind === 'deletion-hold') {
        await api.post(`/documents/${encodeURIComponent(selectedControlDoc.id)}/deletion-hold`, {
          expectedUpdatedAt: selectedControlDoc.updatedAt,
          held: !selectedControlDoc.deletionHold,
          reason: controlReason.trim(),
        });
      } else {
        await api.patch(`/documents/${encodeURIComponent(selectedControlDoc.id)}`, {
          expectedUpdatedAt: selectedControlDoc.updatedAt,
          ...(controlKind === 'lifecycle'
            ? { lifecycleStatus: controlTarget, lifecycleReason: controlReason.trim(),
                ...(controlTarget === 'SUPERSEDED' ? { replacementDocumentId } : {}) }
            : { externalPublicationApproved: grantingPublication,
                publicationApprovalReason: controlReason.trim(),
                ...(grantingPublication ? {
                  reviewedPublicationSiteId: publicationReviewMirror!.publishDestination!.siteId,
                  reviewedPublicationSpaceId: publicationReviewMirror!.publishDestination!.spaceId,
                } : {}) }),
        });
      }
      controlModal.onClose();
      setControlDocId(null);
      await fetchDocuments();
      toast('Document control updated.');
    } catch (err) {
      if (await reconcileForbiddenMutation(err)) return;
      setControlError(apiErrorMessage(err, 'Document control could not be changed. Refresh and try again.'));
    } finally {
      setSavingControl(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteDocId || !canManage || Array.from(deleteReason.trim()).length < 10) return;
    setDeleting(true);
    try {
      await api.delete(`/documents/${encodeURIComponent(deleteDocId)}`, { data: { reason: deleteReason.trim() } });
      setDocuments((prev) => prev.filter((d) => d.id !== deleteDocId));
      deleteModal.onClose();
      setDeleteDocId(null);
      setDeleteReason('');
      toast('Document removed from the vault. Storage cleanup is tracked separately.');
    } catch (err) {
      if (await reconcileForbiddenMutation(err)) return;
      logClientError('Delete failed', err);
      toast(apiErrorMessage(err, 'Failed to delete document'), 'error');
    } finally {
      setDeleting(false);
    }
  };

  const openProviderReview = (docId: string) => {
    if (!canManage) return;
    const doc = documents.find((item) => item.id === docId);
    if (!doc || doc.storageProviderVerified !== false) return;
    setProviderDocId(docId);
    providerModal.onOpen();
  };

  const verifyProvider = async () => {
    if (!selectedProviderDoc || !canManage || selectedProviderDoc.storageProviderVerified !== false) return;
    setVerifyingProvider(true);
    try {
      const response = await api.post(`/documents/${selectedProviderDoc.id}/verify-storage-provider`, {
        expectedUpdatedAt: selectedProviderDoc.updatedAt,
      });
      const verified = response.data?.data ?? response.data;
      setDocuments((prev) => prev.map((doc) => doc.id === selectedProviderDoc.id
        ? { ...doc, storageProviderVerified: true, updatedAt: verified.updatedAt }
        : doc));
      providerModal.onClose();
      setProviderDocId(null);
      toast('File storage provider verified. The change is recorded in document history.');
    } catch (err) {
      if (await reconcileForbiddenMutation(err)) return;
      logClientError('Storage provider review failed', err);
      toast(apiErrorMessage(err, 'File storage could not be verified. Review provider access and try again.'), 'error');
    } finally {
      setVerifyingProvider(false);
    }
  };

  const openLinkModal = (docId: string) => {
    if (!canManage) return;
    setLinkDocId(docId);
    setLinkStandardId('');
    linkModal.onOpen();
  };

  const handleLinkStandard = async () => {
    if (!linkDocId || linkDisabledReason || !canManage) return;

    setLinkingStandard(true);
    try {
      await api.post(`/documents/${linkDocId}/standards`, { standardId: linkStandardId });
      linkModal.onClose();
      setLinkDocId(null);
      setLinkStandardId('');
      await fetchDocuments();
      toast('Standard linked to document');
    } catch (err) {
      if (await reconcileForbiddenMutation(err)) return;
      logClientError('Link failed', err);
      toast(apiErrorMessage(err, 'Could not link this standard'), 'error');
    } finally {
      setLinkingStandard(false);
    }
  };

  const handleUnlinkStandard = async (docId: string, standardId: string) => {
    if (!canManage) return;
    const linkKey = `${docId}:${standardId}`;
    setUnlinkingStandard(linkKey);
    try {
      await api.delete(`/documents/${docId}/standards/${standardId}`);
      await fetchDocuments();
      toast('Standard link removed');
    } catch (err) {
      if (await reconcileForbiddenMutation(err)) return;
      logClientError('Unlink failed', err);
      toast(apiErrorMessage(err, 'Could not remove this standard link'), 'error');
    } finally {
      setUnlinkingStandard(null);
    }
  };

  const handleDownload = async (doc: DocumentResponse) => {
    setDownloadDocId(doc.id);
    try {
      const downloadUrl = getTrustedDocumentDownloadUrl(
        api.getUri({ url: `/documents/${encodeURIComponent(doc.id)}/download` }),
      );
      if (!downloadUrl) {
        toast('Could not prepare this document download', 'error');
        return;
      }

      const { data } = await api.get<Blob>(downloadUrl, { responseType: 'blob' });
      if (!(data instanceof Blob)) {
        throw new Error('Document download did not return a file');
      }

      const objectUrl = URL.createObjectURL(data);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = documentDownloadFilename(doc);
      anchor.rel = 'noopener noreferrer';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // WebKit can defer consuming a programmatically clicked blob URL. Keep it
      // alive for one bounded grace window, then release the browser memory.
      window.setTimeout(
        () => URL.revokeObjectURL(objectUrl),
        DOCUMENT_OBJECT_URL_REVOKE_DELAY_MS,
      );
    } catch (err) {
      logClientError('Download failed', err);
      toast(apiErrorMessage(err, 'Could not prepare this document download'), 'error');
    } finally {
      setDownloadDocId(null);
    }
  };

  /**
   * Asks the API to re-queue a failed publication, then re-reads the mirrors.
   *
   * Only a DEAD_LETTER row is eligible and the API enforces that, answering 409
   * otherwise — which is surfaced rather than swallowed, because an
   * administrator who pressed the button is entitled to know nothing was tried.
   */
  const retryMirrorPublication = async (documentId: string) => {
    setRetryingMirror(documentId);
    try {
      await api.post(`/documents/${documentId}/publication/retry`);
      toast('Queued for publishing to Confluence again', 'success');
      setMirrors(await loadDocumentMirrors(documents.map((doc) => doc.id)));
    } catch (err) {
      logClientError('Confluence publication retry failed', err);
      toast(apiErrorMessage(err, 'This publication could not be queued again'), 'error');
    } finally {
      setRetryingMirror(null);
    }
  };

  return {
    canManage,
    categoryOptions,
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
    controlError,
    savingControl,
    selectedControlDoc,
    setControlTarget: chooseControlTarget,
    setReplacementDocumentId,
    setReplacementSearch,
    searchReplacementCandidates,
    loadMoreReplacementCandidates,
    setControlReason,
    openDocumentControl,
    documentLifecycleNext: DOCUMENT_LIFECYCLE_NEXT,
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
    fetchDocuments,
    loadMoreDocuments,
    loadingMoreDocuments,
    loadMoreDocumentsError,
    mirrors,
    retryMirrorPublication,
    retryingMirror,
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
  };
}
