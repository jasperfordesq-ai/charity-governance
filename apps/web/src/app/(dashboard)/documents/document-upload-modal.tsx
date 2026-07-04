'use client';

import { Button, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Select, SelectItem, Textarea } from '@heroui/react';
import { FieldGroup, FormHint, ValidationSummary } from '@/components/ui/forms';
import { DocumentCategory } from '@charitypilot/shared';

export const MAX_FILE_SIZE = 10 * 1024 * 1024;

const formatUploadFileSize = (bytes: number) => {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
};

export function DocumentUploadModal({
  isOpen,
  onOpenChange,
  categoryOptions,
  uploadName,
  setUploadName,
  uploadCategory,
  setUploadCategory,
  uploadDescription,
  setUploadDescription,
  uploadOwner,
  setUploadOwner,
  uploadApprovedDate,
  setUploadApprovedDate,
  uploadNextReviewDate,
  setUploadNextReviewDate,
  uploadMinuteReference,
  setUploadMinuteReference,
  uploadFile,
  setUploadFile,
  uploadError,
  setUploadError,
  uploadDisabledReason,
  resetUploadForm,
  handleUpload,
  uploading,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  categoryOptions: Array<[string, string]>;
  uploadName: string;
  setUploadName: (value: string) => void;
  uploadCategory: DocumentCategory;
  setUploadCategory: (value: DocumentCategory) => void;
  uploadDescription: string;
  setUploadDescription: (value: string) => void;
  uploadOwner: string;
  setUploadOwner: (value: string) => void;
  uploadApprovedDate: string;
  setUploadApprovedDate: (value: string) => void;
  uploadNextReviewDate: string;
  setUploadNextReviewDate: (value: string) => void;
  uploadMinuteReference: string;
  setUploadMinuteReference: (value: string) => void;
  uploadFile: File | null;
  setUploadFile: (value: File | null) => void;
  uploadError: string;
  setUploadError: (value: string) => void;
  uploadDisabledReason: string;
  resetUploadForm: () => void;
  handleUpload: () => void;
  uploading: boolean;
}) {
  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="2xl" scrollBehavior="inside">
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
                      ? `${uploadFile.name} (${formatUploadFileSize(uploadFile.size)}). ${uploadDisabledReason || 'Ready to upload.'}`
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
  );
}
