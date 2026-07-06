const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'image/jpeg',
  'image/png',
]);

export const DOCUMENT_UPLOAD_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
export const DOCUMENT_UPLOAD_MULTIPART_LIMITS = {
  fileSize: DOCUMENT_UPLOAD_MAX_FILE_SIZE,
  files: 1,
  fields: 7,
  parts: 8,
  fieldNameSize: 64,
  fieldSize: 4 * 1024,
  headerPairs: 50,
} as const;

const MIME_EXTENSIONS: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
  'text/plain': ['.txt'],
  'text/csv': ['.csv'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
};

function hasZipSignature(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
}

function hasTextSignature(buffer: Buffer): boolean {
  return !buffer.includes(0);
}

export function hasAllowedMimeType(mimeType: string): boolean {
  return ALLOWED_MIME_TYPES.has(mimeType);
}

export function hasValidSignature(mimeType: string, buffer: Buffer): boolean {
  switch (mimeType) {
    case 'application/pdf':
      return buffer.subarray(0, 5).toString('utf8') === '%PDF-';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return hasZipSignature(buffer);
    case 'image/jpeg':
      return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case 'image/png':
      return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'text/plain':
    case 'text/csv':
      return hasTextSignature(buffer);
    default:
      return false;
  }
}

export function hasAllowedExtension(filename: string, mimeType: string): boolean {
  const lowerFilename = filename.toLowerCase();
  return (MIME_EXTENSIONS[mimeType] ?? []).some((extension) => lowerFilename.endsWith(extension));
}

export function isFileTooLargeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  const message = error instanceof Error ? error.message : '';
  return code === 'FST_REQ_FILE_TOO_LARGE' || /file.*too large|request file too large/i.test(message);
}

export function isMultipartLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'FST_PARTS_LIMIT' || code === 'FST_FIELDS_LIMIT' || code === 'FST_FILES_LIMIT';
}
