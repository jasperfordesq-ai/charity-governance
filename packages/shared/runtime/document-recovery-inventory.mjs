// The v1 offline recovery hash contract is shared with managed archive indexes.
// These hashes establish equality, not authentication or source completeness.
import { createHash } from 'node:crypto';
const digest = (domain, rows) =>
  createHash('sha256')
    .update(`${domain}\n${JSON.stringify(rows)}`)
    .digest('hex');
const string = (value, label) => {
  if (typeof value !== 'string' || value.length === 0)
    throw new TypeError(`${label} must be a non-empty string`);
  return value;
};
const timestamp = (value, label) => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(
      `${label} must be an ISO-8601 UTC timestamp with milliseconds`,
    );
  }
  return value;
};
const transaction = (value, label) => {
  if (
    typeof value !== 'string' ||
    !/^[1-9]\d{0,18}$/.test(value) ||
    BigInt(value) > 9_223_372_036_854_775_807n
  ) {
    throw new TypeError(
      `${label} must be a canonical bounded decimal transaction identifier`,
    );
  }
  return value;
};
export function canonicalDocumentIdentitySha256(id) {
  return digest('charitypilot:document-identity:v1', [
    [string(id, 'Document.id')],
  ]);
}
export function canonicalMetadataBindingSha256({
  id,
  organisationId,
  fileUrl,
  fileSize,
  mimeType,
}) {
  if (
    !Number.isSafeInteger(fileSize) ||
    fileSize < 0 ||
    fileSize > 10 * 1024 * 1024
  ) {
    throw new TypeError(
      'Document.fileSize must be a safe integer within the document byte limit',
    );
  }
  return digest('charitypilot:document-metadata-binding:v1', [
    [
      string(id, 'Document.id'),
      string(organisationId, 'Document.organisationId'),
      string(fileUrl, 'Document.fileUrl'),
      fileSize,
      string(mimeType, 'Document.mimeType'),
    ],
  ]);
}
export function canonicalObjectKeySha256(fileUrl) {
  return digest('charitypilot:document-object-key:v1', [
    [string(fileUrl, 'Document.fileUrl')],
  ]);
}
export function canonicalMetadataInventorySha256(
  entries,
  capturedAt,
  captureTransactionId,
) {
  const rows = entries
    .map((entry) => [
      entry.documentIdentitySha256,
      entry.metadataBindingSha256,
      entry.objectKeySha256,
      entry.fileSize,
    ])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return digest('charitypilot:document-metadata-inventory:v1', [
    [
      timestamp(capturedAt, 'metadata inventory capturedAt'),
      transaction(
        captureTransactionId,
        'metadata inventory captureTransactionId',
      ),
      rows,
    ],
  ]);
}
export function canonicalObjectInventorySha256(entries, capturedAt) {
  const rows = entries
    .map((entry) => [entry.objectKeySha256, entry.bytes, entry.sha256])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return digest('charitypilot:document-object-inventory:v1', [
    [timestamp(capturedAt, 'object inventory capturedAt'), rows],
  ]);
}
