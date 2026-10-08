import { AppError } from '../utils/errors.js';

const OPERATION_ID = /^[0-9a-f]{32}$/;

/** The exact storage-format paragraph sent in a synthetic page-create probe. */
export function confluencePageCreateOperationMarker(operationId: string): string {
  if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)) {
    throw new AppError(400, 'CONFLUENCE_PAGE_OPERATION_INVALID',
      'A page-create operation marker requires an exact random identifier.');
  }
  return `<p>CharityPilot page-create operation v1: ${operationId}</p>`;
}
