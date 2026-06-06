'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useDocumentTitle } from '@/lib/use-title';
import {
  Card,
  Button,
  Input,
  Textarea,
  Select,
  SelectItem,
  Chip,
  Table,
  TableHeader,
  TableColumn,
  TableBody,
  TableRow,
  TableCell,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  useDisclosure,
} from '@heroui/react';
import { api } from '@/lib/api';
import { useToast } from '@/components/toast';
import { evidencePackItems, operationalEvidenceSignals } from '@/lib/regulator-guidance';
import { getTrustedDocumentDownloadUrl } from '@/lib/url-security';
import type {
  DocumentResponse,
  GovernanceStandardResponse,
} from '@charitypilot/shared';
import { DocumentCategory, DOCUMENT_CATEGORY_LABELS } from '@charitypilot/shared';

export default function DocumentsPage() {
  useDocumentTitle('Documents');
  const [documents, setDocuments] = useState<DocumentResponse[]>([]);
  const [standards, setStandards] = useState<GovernanceStandardResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  // Upload modal
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

  // Delete confirmation modal
  const deleteModal = useDisclosure();
  const [deleteDocId, setDeleteDocId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Link standards modal
  const linkModal = useDisclosure();
  const [linkDocId, setLinkDocId] = useState<string | null>(null);
  const [linkStandardId, setLinkStandardId] = useState<string>('');

  const fetchDocuments = useCallback(async () => {
    try {
      const res = await api.get('/documents');
      setDocuments(res.data?.data ?? res.data ?? []);
    } catch (err) {
      console.error('Failed to load documents', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchStandards = useCallback(async () => {
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
      console.error('Failed to load standards', err);
    }
  }, []);

  useEffect(() => {
    fetchDocuments();
    fetchStandards();
  }, [fetchDocuments, fetchStandards]);

  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

  /* ── Upload handler ── */
  const handleUpload = async () => {
    if (!uploadFile || !uploadName.trim()) return;

    if (uploadFile.size > MAX_FILE_SIZE) {
      setUploadError('File size exceeds the 10 MB limit. Please choose a smaller file.');
      return;
    }

    setUploadError('');
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', uploadFile);
      formData.append('name', uploadName.trim());
      formData.append('category', uploadCategory);
      if (uploadDescription.trim()) {
        formData.append('description', uploadDescription.trim());
      }
      if (uploadOwner.trim()) formData.append('owner', uploadOwner.trim());
      if (uploadApprovedDate) formData.append('approvedDate', uploadApprovedDate);
      if (uploadNextReviewDate) formData.append('nextReviewDate', uploadNextReviewDate);
      if (uploadMinuteReference.trim()) formData.append('boardMinuteReference', uploadMinuteReference.trim());

      await api.post('/documents', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      // Reset form
      setUploadName('');
      setUploadCategory(DocumentCategory.OTHER);
      setUploadDescription('');
      setUploadOwner('');
      setUploadApprovedDate('');
      setUploadNextReviewDate('');
      setUploadMinuteReference('');
      setUploadFile(null);
      uploadModal.onClose();
      fetchDocuments();
      toast('Document uploaded successfully');
    } catch (err) {
      console.error('Upload failed', err);
      setUploadError('Upload failed. Please try again.');
      toast('Upload failed', 'error');
    } finally {
      setUploading(false);
    }
  };

  /* ── Delete handler ── */
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
      console.error('Delete failed', err);
    } finally {
      setDeleting(false);
    }
  };

  /* ── Link standard handler ── */
  const handleLinkStandard = async () => {
    if (!linkDocId || !linkStandardId) return;

    try {
      await api.post(`/documents/${linkDocId}/standards`, { standardId: linkStandardId });
      linkModal.onClose();
      setLinkStandardId('');
      fetchDocuments();
    } catch (err) {
      console.error('Link failed', err);
    }
  };

  /* ── Unlink standard handler ── */
  const handleUnlinkStandard = async (docId: string, standardId: string) => {
    try {
      await api.delete(`/documents/${docId}/standards/${standardId}`);
      fetchDocuments();
    } catch (err) {
      console.error('Unlink failed', err);
    }
  };

  const handleDownload = async (doc: DocumentResponse) => {
    try {
      const { data } = await api.get(`/documents/${doc.id}/download`);
      const downloadUrl = getTrustedDocumentDownloadUrl(data?.url);
      if (downloadUrl) {
        window.open(downloadUrl, '_blank', 'noopener,noreferrer');
        return;
      }
      toast('Could not prepare this document download', 'error');
    } catch (err) {
      console.error('Download failed', err);
      toast('Could not prepare this document download', 'error');
    }
  };

  const categoryOptions = Object.entries(DOCUMENT_CATEGORY_LABELS);
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

  const missingEvidenceCount = evidencePackItems.filter((item) => !documentCounts[item.category]).length;
  const missingSignalCount = signalCoverage.filter((item) => !item.covered).length;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Document Vault</h1>
          <p className="text-sm text-gray-500 mt-1">
            Upload and manage governance documents. Link them to compliance standards as evidence.
          </p>
        </div>
        <Button
          className="bg-teal-primary text-white hover:bg-teal-dark"
          onPress={uploadModal.onOpen}
        >
          <svg className="w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Upload Document
        </Button>
      </div>

      <section className="rounded-lg border border-teal-primary/20 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <Chip size="sm" variant="flat" className="mb-2 bg-teal-primary/10 text-teal-primary">
              Evidence pack
            </Chip>
            <h2 className="text-lg font-semibold text-gray-900">Board-ready governance evidence</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-gray-600">
              Keep the core documents close to the standards they support: governing document,
              board conduct, policies, minutes, accounts, annual report, risk, insurance, and planning.
            </p>
          </div>
          <Chip size="sm" color={missingEvidenceCount === 0 ? 'success' : 'warning'} variant="flat">
            {missingEvidenceCount === 0 ? 'Checklist covered' : `${missingEvidenceCount} evidence areas missing`}
          </Chip>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-3">
          {evidencePackItems.map((item) => {
            const count = documentCounts[item.category] ?? 0;
            return (
              <div key={item.title} className="rounded-lg border border-gray-200 bg-gray-50/60 p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-semibold text-gray-800">{item.title}</p>
                  <Chip size="sm" color={count > 0 ? 'success' : 'default'} variant="flat">
                    {count > 0 ? `${count} file${count > 1 ? 's' : ''}` : 'Needed'}
                  </Chip>
                </div>
                <p className="mt-1 text-xs text-teal-primary">Standards {item.standards}</p>
              </div>
            );
          })}
        </div>
        <div className="mt-5 border-t border-gray-200 pt-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">Operational register signals</h3>
              <p className="mt-0.5 text-xs leading-5 text-gray-500">
                These checks look for named registers and policies in document titles or descriptions, so name uploads plainly.
              </p>
            </div>
            <Chip size="sm" color={missingSignalCount === 0 ? 'success' : 'warning'} variant="flat">
              {missingSignalCount === 0 ? 'Signals covered' : `${missingSignalCount} signals missing`}
            </Chip>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
            {signalCoverage.map((item) => (
              <div key={item.title} className="rounded-lg border border-gray-200 bg-white p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-gray-800">{item.title}</p>
                    <p className="mt-1 text-xs text-gray-500">{item.why}</p>
                    <p className="mt-1 text-xs text-teal-primary">Standards {item.standards}</p>
                  </div>
                  <Chip size="sm" color={item.covered ? 'success' : 'default'} variant="flat">
                    {item.covered ? 'Found' : 'Needed'}
                  </Chip>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Documents table */}
      {loading ? (
        <Card className="p-6 animate-pulse">
          <div className="h-4 bg-gray-200 rounded w-1/3 mb-5" />
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex gap-4 mb-3">
              <div className="h-3 bg-gray-200 rounded w-1/4" />
              <div className="h-3 bg-gray-200 rounded w-1/6" />
              <div className="h-3 bg-gray-200 rounded w-1/4" />
              <div className="h-3 bg-gray-200 rounded w-1/6" />
            </div>
          ))}
        </Card>
      ) : documents.length === 0 ? (
        <Card className="p-12 border border-gray-200 text-center">
          <div className="text-gray-400 mb-3">
            <svg className="w-12 h-12 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
          </div>
          <p className="text-gray-500 mb-2">No documents uploaded yet.</p>
          <p className="text-sm text-gray-400">Upload your governance documents to link them as evidence for compliance standards.</p>
        </Card>
      ) : (
        <Card className="border border-gray-200 shadow-sm overflow-hidden">
          <Table aria-label="Documents" removeWrapper>
            <TableHeader>
              <TableColumn>NAME</TableColumn>
              <TableColumn>CATEGORY</TableColumn>
              <TableColumn className="hidden lg:table-cell">REVIEW</TableColumn>
              <TableColumn className="hidden md:table-cell">LINKED STANDARDS</TableColumn>
              <TableColumn className="hidden sm:table-cell">DATE</TableColumn>
              <TableColumn>ACTIONS</TableColumn>
            </TableHeader>
            <TableBody>
              {documents.map((doc) => (
                <TableRow key={doc.id}>
                  <TableCell>
                    <div>
                      <button
                        type="button"
                        onClick={() => handleDownload(doc)}
                        className="text-sm font-medium text-teal-primary hover:underline"
                      >
                        {doc.name}
                      </button>
                      {doc.description && (
                        <p className="text-xs text-gray-400 mt-0.5 line-clamp-1">{doc.description}</p>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Chip size="sm" variant="flat">
                      {DOCUMENT_CATEGORY_LABELS[doc.category] ?? doc.category}
                    </Chip>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <div className="text-xs text-gray-500">
                      <p>{doc.owner ? `Owner: ${doc.owner}` : 'No owner'}</p>
                      <p>
                        {doc.nextReviewDate
                          ? `Review: ${new Date(doc.nextReviewDate).toLocaleDateString('en-IE', {
                              day: 'numeric',
                              month: 'short',
                              year: 'numeric',
                            })}`
                          : 'No review date'}
                      </p>
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {(doc.standardLinks ?? []).map((link) => (
                        <Chip
                          key={link.standardId}
                          size="sm"
                          variant="flat"
                          color="primary"
                          onClose={() => handleUnlinkStandard(doc.id, link.standardId)}
                          className="font-mono text-xs"
                        >
                          {link.standardCode}
                        </Chip>
                      ))}
                      <Button
                        size="sm"
                        variant="flat"
                        isIconOnly
                        aria-label="Link a standard to this document"
                        className="h-6 w-6 min-w-6"
                        onPress={() => {
                          setLinkDocId(doc.id);
                          linkModal.onOpen();
                        }}
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                        </svg>
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <span className="text-xs text-gray-500">
                      {new Date(doc.createdAt).toLocaleDateString('en-IE', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="flat"
                      color="danger"
                      onPress={() => confirmDelete(doc.id)}
                    >
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* ── Upload Modal ── */}
      <Modal isOpen={uploadModal.isOpen} onOpenChange={uploadModal.onOpenChange} size="lg">
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>Upload Document</ModalHeader>
              <ModalBody className="space-y-4">
                {uploadError && (
                  <div role="alert" className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
                    {uploadError}
                  </div>
                )}
                <Input
                  label="Document Name"
                  placeholder="e.g. Board Code of Conduct 2026"
                  value={uploadName}
                  onValueChange={setUploadName}
                  isRequired
                />
                <Select
                  label="Category"
                  selectedKeys={new Set([uploadCategory])}
                  onSelectionChange={(keys) => {
                    const val = Array.from(keys)[0] as DocumentCategory;
                    if (val) setUploadCategory(val);
                  }}
                >
                  {categoryOptions.map(([key, label]) => (
                    <SelectItem key={key}>{label}</SelectItem>
                  ))}
                </Select>
                <Textarea
                  label="Description (optional)"
                  placeholder="Brief description of this document..."
                  value={uploadDescription}
                  onValueChange={setUploadDescription}
                  minRows={2}
                />
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Input
                    label="Owner"
                    placeholder="e.g. Secretary, Treasurer, Chair"
                    value={uploadOwner}
                    onValueChange={setUploadOwner}
                  />
                  <Input
                    label="Board minute reference"
                    placeholder="e.g. Board minutes 24 Oct, item 5"
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
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    File
                  </label>
                  <input
                    type="file"
                    onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
                    className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-teal-primary/10 file:text-teal-primary hover:file:bg-teal-primary/20"
                    accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.png,.jpg,.jpeg"
                  />
                  {uploadFile && (
                    <p className={`text-xs mt-1 ${uploadFile.size > MAX_FILE_SIZE ? 'text-red-500 font-medium' : 'text-gray-400'}`}>
                      {uploadFile.name} ({uploadFile.size > 1024 * 1024 ? `${(uploadFile.size / (1024 * 1024)).toFixed(1)} MB` : `${(uploadFile.size / 1024).toFixed(1)} KB`})
                      {uploadFile.size > MAX_FILE_SIZE && ' — exceeds 10 MB limit'}
                    </p>
                  )}
                </div>
              </ModalBody>
              <ModalFooter>
                <Button variant="flat" onPress={onClose}>
                  Cancel
                </Button>
                <Button
                  className="bg-teal-primary text-white hover:bg-teal-dark"
                  onPress={handleUpload}
                  isLoading={uploading}
                  isDisabled={!uploadFile || !uploadName.trim()}
                >
                  Upload
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      {/* ── Delete Confirmation Modal ── */}
      <Modal isOpen={deleteModal.isOpen} onOpenChange={deleteModal.onOpenChange} size="sm">
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>Delete Document</ModalHeader>
              <ModalBody>
                <p className="text-sm text-gray-600">
                  Are you sure you want to delete this document? This action cannot be undone.
                </p>
              </ModalBody>
              <ModalFooter>
                <Button variant="flat" onPress={onClose}>
                  Cancel
                </Button>
                <Button
                  color="danger"
                  onPress={handleDelete}
                  isLoading={deleting}
                >
                  Delete
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      {/* ── Link Standard Modal ── */}
      <Modal isOpen={linkModal.isOpen} onOpenChange={linkModal.onOpenChange}>
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>Link Standard to Document</ModalHeader>
              <ModalBody>
                <Select
                  label="Select Standard"
                  selectedKeys={linkStandardId ? new Set([linkStandardId]) : new Set()}
                  onSelectionChange={(keys) => {
                    const val = Array.from(keys)[0] as string;
                    if (val) setLinkStandardId(val);
                  }}
                >
                  {standards.map((s) => (
                    <SelectItem key={s.id} textValue={`${s.code} - ${s.title}`}>
                      <div>
                        <span className="font-mono font-semibold text-sm">{s.code}</span>
                        <span className="text-sm text-gray-600 ml-2 line-clamp-1">{s.title}</span>
                      </div>
                    </SelectItem>
                  ))}
                </Select>
              </ModalBody>
              <ModalFooter>
                <Button variant="flat" onPress={onClose}>
                  Cancel
                </Button>
                <Button
                  className="bg-teal-primary text-white hover:bg-teal-dark"
                  onPress={handleLinkStandard}
                  isDisabled={!linkStandardId}
                >
                  Link
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </div>
  );
}
