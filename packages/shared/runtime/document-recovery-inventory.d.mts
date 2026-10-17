export interface DocumentMetadataRow {
  id: string;
  organisationId: string;
  fileUrl: string;
  fileSize: number;
  mimeType: string;
}
export interface DocumentMetadataInventoryRow {
  documentIdentitySha256: string;
  metadataBindingSha256: string;
  objectKeySha256: string;
  fileSize: number;
}
export interface DocumentObjectInventoryRow {
  objectKeySha256: string;
  bytes: number;
  sha256: string;
}
export function canonicalDocumentIdentitySha256(id: string): string;
export function canonicalMetadataBindingSha256(
  row: DocumentMetadataRow,
): string;
export function canonicalObjectKeySha256(fileUrl: string): string;
export function canonicalDocumentMetadataRowsSha256(
  rows: DocumentMetadataInventoryRow[],
): string;
export function canonicalMetadataInventorySha256(
  rows: DocumentMetadataInventoryRow[],
  capturedAt: string,
  captureTransactionId: string,
): string;
export function canonicalObjectInventorySha256(
  rows: DocumentObjectInventoryRow[],
  capturedAt: string,
): string;
