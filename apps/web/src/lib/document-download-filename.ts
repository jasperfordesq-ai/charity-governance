import type { DocumentResponse } from '@charitypilot/shared';

const DOCUMENT_EXTENSIONS_BY_MIME: Record<string, readonly string[]> = {
  'application/pdf': ['.pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
  'text/plain': ['.txt'],
  'text/csv': ['.csv'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
};

export function documentDownloadFilename(doc: Pick<DocumentResponse, 'name' | 'mimeType'>): string {
  const safeName = doc.name
    .replace(/[\u0000-\u001f\u007f<>:"\\/|?*]/g, '-')
    .replace(/-{2,}/g, '-')
    .trim()
    .slice(0, 160)
    .replace(/^[. ]+/g, '')
    .replace(/[. ]+$/g, '') || 'document';
  const extensions = DOCUMENT_EXTENSIONS_BY_MIME[doc.mimeType] ?? [];
  const lowerName = safeName.toLowerCase();
  return extensions.length > 0 && !extensions.some((extension) => lowerName.endsWith(extension))
    ? `${safeName}${extensions[0]}`
    : safeName;
}
