'use client';

import type { ChangeEvent, ReactNode } from 'react';
import { useRef } from 'react';
import { Button } from '@heroui/react';
import { CheckCircle2, FileUp, X } from 'lucide-react';
import { FormHint } from '@/components/ui/forms';

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

export function formatFileSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function FileUploadField({
  id,
  label,
  accept,
  file,
  helperText,
  disabledReason,
  maxSizeBytes,
  oversizeMessage,
  onFileChange,
  onValidationError,
}: {
  id: string;
  label: string;
  accept?: string;
  file: File | null;
  helperText: ReactNode;
  disabledReason?: string;
  maxSizeBytes?: number;
  oversizeMessage?: string;
  onFileChange: (file: File | null) => void;
  onValidationError?: (message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const hintTone = disabledReason ? 'warning' : 'neutral';
  const fileIsOversize = Boolean(file && maxSizeBytes && file.size > maxSizeBytes);
  const selectedFileText = file
    ? `${file.name} (${formatFileSize(file.size)}). ${disabledReason || 'Ready to upload.'}`
    : helperText;

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0] ?? null;
    onFileChange(nextFile);

    if (nextFile && maxSizeBytes && nextFile.size > maxSizeBytes) {
      onValidationError?.(oversizeMessage ?? `File size exceeds the ${formatFileSize(maxSizeBytes)} limit. Please choose a smaller file.`);
      return;
    }

    onValidationError?.('');
  };

  const clearFile = () => {
    if (inputRef.current) inputRef.current.value = '';
    onFileChange(null);
    onValidationError?.('');
  };

  return (
    <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4 transition-colors dark:border-gray-700 dark:bg-gray-900/60">
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept={accept}
        onChange={handleChange}
        className="sr-only"
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className={classes(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
              fileIsOversize
                ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-200'
                : 'bg-teal-primary/10 text-teal-primary dark:bg-teal-light/10 dark:text-teal-bright',
            )}
            aria-hidden="true"
          >
            {file ? <CheckCircle2 className="h-5 w-5" strokeWidth={1.75} /> : <FileUp className="h-5 w-5" strokeWidth={1.75} />}
          </div>
          <div className="min-w-0">
            <label htmlFor={id} className="block text-sm font-semibold text-gray-950 dark:text-gray-50">
              {label}
            </label>
            <FormHint id={`${id}-hint`} tone={hintTone}>
              {selectedFileText}
            </FormHint>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <Button
            type="button"
            size="sm"
            variant="flat"
            className="font-semibold text-teal-primary dark:text-teal-bright"
            onPress={() => inputRef.current?.click()}
            aria-describedby={`${id}-hint`}
          >
            {file ? 'Replace file' : 'Choose file'}
          </Button>
          {file ? (
            <Button
              type="button"
              size="sm"
              variant="light"
              className="font-semibold text-gray-600 dark:text-gray-300"
              onPress={clearFile}
              startContent={<X className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />}
            >
              Remove
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
