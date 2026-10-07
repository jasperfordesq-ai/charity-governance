import { AppError } from '../utils/errors.js';

const OPERATION_ID = /^[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Provider-visible correlation text for one upload. It contains no document
 * title, person, organisation name, token or source bytes. A matching message
 * is only a candidate: exact site, version bytes and local authority still
 * require separate checks before any retry, release or erasure.
 */
export function confluenceUploadOperationMarker(operationId: string, sha256: string): string {
  if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)
    || typeof sha256 !== 'string' || !SHA256.test(sha256)) {
    throw new AppError(400, 'CONFLUENCE_UPLOAD_OPERATION_INVALID',
      'An upload operation marker requires an exact random identifier and byte digest.');
  }
  return `CharityPilot upload v1 ${operationId} sha256 ${sha256}`;
}
