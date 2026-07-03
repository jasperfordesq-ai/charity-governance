'use client';

import { logClientError } from '@/lib/client-logger';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDocumentTitle } from '@/lib/use-title';
import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
  Textarea,
  useDisclosure,
} from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { useToast } from '@/components/toast';
import { evidencePackItems, operationalEvidenceSignals } from '@/lib/regulator-guidance';
import { getTrustedDocumentDownloadUrl } from '@/lib/url-security';
import { AppPage, AppSection } from '@/components/ui/app-page';
import { DataList, DataListItems } from '@/components/ui/data-list';
import { FieldGroup, FormHint, ValidationSummary } from '@/components/ui/forms';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { EvidenceChip, StatusChip } from '@/components/ui/status';
import { DocumentProfilePromptsPanel, buildDocumentProfilePrompts } from './document-profile-prompts';
import type {
  DocumentResponse,
  GovernanceStandardResponse,
  OrganisationResponse,
} from '@charitypilot/shared';
import {
  DocumentCategory,
  DOCUMENT_CATEGORY_LABELS,
} from '@charitypilot/shared';

const MAX_FILE_SIZE = 10 * 1024 * 1024;

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
              <Button size="sm" variant="flat" onPress={() => fetchDocuments(true)}>
                Try again
              </Button>
            )}
          />
        ) : documents.length === 0 ? (
          <EmptyState
            title="No documents uploaded yet"
            description="Upload the governing document, board conduct records, minutes, accounts, policies, and other evidence before the annual review."
            action={(
              <Button size="sm" className="bg-teal-primary text-white hover:bg-teal-dark" onPress={uploadModal.onOpen}>
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
                  <Button size="sm" variant="flat" onPress={() => fetchDocuments(true)}>
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

      <Modal isOpen={uploadModal.isOpen} onOpenChange={uploadModal.onOpenChange} size="2xl" scrollBehavior="inside">
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>Upload document</ModalHeader>
              <ModalBody className="gap-5">
                <ValidationSummary errors={uploadError ? [uploadError] : []} />
                <FieldGroup
                  title="Document details"
                  description="Name the file in a way trustees can recognise in an evidence pack."
                >
                  <Input
                    label="Document name"
                    placeholder="Board Code of Conduct 2026"
                    value={uploadName}
                    onValueChange={setUploadName}
                    isRequired
                  />
                  <Select
                    label="Category"
                    selectedKeys={new Set([uploadCategory])}
                    onSelectionChange={(keys) => {
                      const value = Array.from(keys)[0] as DocumentCategory | undefined;
                      if (value) setUploadCategory(value);
                    }}
                  >
                    {categoryOptions.map(([key, label]) => (
                      <SelectItem key={key}>{label}</SelectItem>
                    ))}
                  </Select>
                  <Textarea
                    label="Description"
                    placeholder="Short note on what trustees should use this document for."
                    value={uploadDescription}
                    onValueChange={setUploadDescription}
                    minRows={2}
                  />
                </FieldGroup>

                <FieldGroup
                  title="Review metadata"
                  description="Owner, approval, and minute fields help make the evidence review-ready."
                >
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Input
                      label="Owner"
                      placeholder="Secretary, treasurer, chair"
                      value={uploadOwner}
                      onValueChange={setUploadOwner}
                    />
                    <Input
                      label="Board minute reference"
                      placeholder="Board minutes 24 Oct, item 5"
                      value={uploadMinuteReference}
                      onValueChange={setUploadMinuteReference}
                    />
                    <Input
                      label="Approved date"
                      type="date"
                      value={uploadApprovedDate}
                      onValueChange={setUploadApprovedDate}
                    />
                    <Input
                      label="Next review date"
                      type="date"
                      value={uploadNextReviewDate}
                      onValueChange={setUploadNextReviewDate}
                    />
                  </div>
                </FieldGroup>

                <FieldGroup title="File">
                  <div>
                    <label htmlFor="document-upload-file" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Choose file
                    </label>
                    <input
                      id="document-upload-file"
                      type="file"
                      onChange={(event) => {
                        const nextFile = event.target.files?.[0] ?? null;
                        setUploadFile(nextFile);
                        if (nextFile && nextFile.size > MAX_FILE_SIZE) {
                          setUploadError('File size exceeds the 10 MB limit. Please choose a smaller file.');
                        } else {
                          setUploadError('');
                        }
                      }}
                      className="mt-2 block w-full text-sm text-gray-700 file:mr-4 file:rounded-lg file:border-0 file:bg-teal-primary/10 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-teal-primary hover:file:bg-teal-primary/20 dark:text-gray-300 dark:file:bg-teal-light/10 dark:file:text-teal-bright dark:hover:file:bg-teal-light/20"
                      accept=".pdf,.docx,.xlsx,.pptx,.txt,.csv,.png,.jpg,.jpeg"
                    />
                    <FormHint id="upload-disabled-hint" tone={uploadDisabledReason ? 'warning' : 'neutral'}>
                      {uploadFile
                        ? `${uploadFile.name} (${formatFileSize(uploadFile.size)}). ${uploadDisabledReason || 'Ready to upload.'}`
                        : 'PDF, Office, text, spreadsheet, and image files are supported up to 10 MB.'}
                    </FormHint>
                  </div>
                </FieldGroup>
              </ModalBody>
              <ModalFooter>
                <Button variant="flat" onPress={() => { resetUploadForm(); onClose(); }}>
                  Cancel
                </Button>
                <Button
                  className="bg-teal-primary text-white hover:bg-teal-dark"
                  onPress={handleUpload}
                  isLoading={uploading}
                  isDisabled={Boolean(uploadDisabledReason) || uploading}
                  aria-describedby="upload-disabled-hint"
                >
                  Upload
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      <Modal isOpen={deleteModal.isOpen} onOpenChange={deleteModal.onOpenChange} size="sm">
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>Delete document</ModalHeader>
              <ModalBody>
                <p className="text-sm leading-6 text-gray-600 dark:text-gray-300">
                  Delete {selectedDeleteDoc ? <strong>{selectedDeleteDoc.name}</strong> : 'this document'} from the evidence vault?
                  This removes the file and its standard links.
                </p>
              </ModalBody>
              <ModalFooter>
                <Button variant="flat" onPress={onClose} isDisabled={deleting}>
                  Cancel
                </Button>
                <Button color="danger" onPress={handleDelete} isLoading={deleting}>
                  Delete
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      <Modal isOpen={linkModal.isOpen} onOpenChange={linkModal.onOpenChange}>
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>Link standard</ModalHeader>
              <ModalBody className="gap-4">
                <p className="text-sm leading-6 text-gray-600 dark:text-gray-300">
                  Link {selectedLinkDoc ? <strong>{selectedLinkDoc.name}</strong> : 'this document'} to the compliance standard it supports.
                </p>
                <Select
                  label="Standard"
                  selectedKeys={linkStandardId ? new Set([linkStandardId]) : new Set()}
                  onSelectionChange={(keys) => {
                    const value = Array.from(keys)[0] as string | undefined;
                    if (value) setLinkStandardId(value);
                  }}
                  isDisabled={Boolean(standardsError) || standards.length === 0}
                >
                  {standards.map((standard) => (
                    <SelectItem key={standard.id} textValue={`${standard.code} - ${standard.title}`}>
                      <span className="font-mono text-sm font-semibold">{standard.code}</span>
                      <span className="ml-2 text-sm text-gray-600 dark:text-gray-300">{standard.title}</span>
                    </SelectItem>
                  ))}
                </Select>
                <FormHint id="link-disabled-hint" tone={linkDisabledReason ? 'warning' : 'success'}>
                  {linkDisabledReason || 'This document will appear as evidence on the selected standard.'}
                </FormHint>
              </ModalBody>
              <ModalFooter>
                <Button variant="flat" onPress={() => { setLinkStandardId(''); onClose(); }} isDisabled={linkingStandard}>
                  Cancel
                </Button>
                <Button
                  className="bg-teal-primary text-white hover:bg-teal-dark"
                  onPress={handleLinkStandard}
                  isLoading={linkingStandard}
                  isDisabled={Boolean(linkDisabledReason) || linkingStandard}
                  aria-describedby="link-disabled-hint"
                >
                  Link
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </AppPage>
  );
}
