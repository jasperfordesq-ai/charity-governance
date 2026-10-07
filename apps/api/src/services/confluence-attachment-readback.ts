import { createHash } from 'node:crypto';
import { atlassianEndpoints } from './atlassian-endpoints.js';
import { AppError } from '../utils/errors.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CLOUD_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const MAX_REDIRECT_URL_CHARS = 8192;
const MAX_READ_BYTES = 50 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export type AttachmentVersionReadback = {
  attachmentId: string;
  versionNumber: number;
  byteLength: number;
  sha256: string;
};

export type AttachmentVersionReadbackInput = {
  cloudId: string;
  pageId: string;
  attachmentId: string;
  versionNumber: number;
  /** Exact approved tenant host, e.g. charity.atlassian.net. */
  siteHostname: string;
  getAccessToken: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
  maxBytes?: number;
};

function invalidReadbackInput(): AppError {
  return new AppError(400, 'CONFLUENCE_READBACK_INPUT_INVALID', 'A Confluence attachment version readback requires valid identifiers and limits.');
}

function invalidProviderResponse(): AppError {
  return new AppError(502, 'CONFLUENCE_READBACK_RESPONSE_INVALID', 'Confluence did not return a verifiable attachment version download.');
}

function allowedRedirect(location: string | null, siteHostname: string): URL {
  if (location === null || location.length === 0 || location.length > MAX_REDIRECT_URL_CHARS) {
    throw invalidProviderResponse();
  }
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    throw invalidProviderResponse();
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== ''
    || url.port !== '' || url.hash !== ''
    || (url.hostname !== 'api.media.atlassian.com' && url.hostname !== siteHostname)) {
    throw invalidProviderResponse();
  }
  return url;
}

/**
 * Read one explicit historical attachment version by hash. The documented v1
 * API answers with a redirect to binary content. The bearer token goes only
 * to the fixed Atlassian API origin; no token is forwarded to the signed
 * download URL. Unknown redirect hosts and second redirects fail closed.
 *
 * This result is one observation, not an operation binding, current-repeat
 * read, complete copy inventory, or authority to retry/purge. There is no
 * production caller until the separate test site and custody gates pass.
 */
export async function readAttachmentVersionBytes(
  input: AttachmentVersionReadbackInput,
): Promise<AttachmentVersionReadback> {
  const maxBytes = input.maxBytes ?? MAX_READ_BYTES;
  if (!CLOUD_ID.test(input.cloudId) || !ID.test(input.pageId) || !ID.test(input.attachmentId)
    || !Number.isSafeInteger(input.versionNumber) || input.versionNumber <= 0
    || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_READ_BYTES
    || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.atlassian\.net$/.test(input.siteHostname)) {
    throw invalidReadbackInput();
  }

  const fetchImpl = input.fetch ?? globalThis.fetch;
  const token = await input.getAccessToken();
  if (typeof token !== 'string' || token.length === 0) throw invalidProviderResponse();
  const apiBase = atlassianEndpoints().apiBase;
  const requestUrl = `${apiBase}/${input.cloudId}/wiki/rest/api/content/${input.pageId}`
    + `/child/attachment/${input.attachmentId}/download?version=${input.versionNumber}`;
  let redirect: Response;
  try {
    redirect = await fetchImpl(requestUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw invalidProviderResponse();
  }
  if (redirect.status !== 302) throw invalidProviderResponse();
  const target = allowedRedirect(redirect.headers.get('Location'), input.siteHostname);

  let response: Response;
  try {
    response = await fetchImpl(target, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw invalidProviderResponse();
  }
  if (response.status !== 200 || response.body === null) throw invalidProviderResponse();
  const declaredLength = response.headers.get('Content-Length');
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    await response.body.cancel();
    throw new AppError(502, 'CONFLUENCE_READBACK_TOO_LARGE', 'The attachment version exceeds the approved readback size limit.');
  }

  const digest = createHash('sha256');
  const reader = response.body.getReader();
  let byteLength = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      byteLength += part.value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        throw new AppError(502, 'CONFLUENCE_READBACK_TOO_LARGE', 'The attachment version exceeds the approved readback size limit.');
      }
      digest.update(part.value);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalidProviderResponse();
  } finally {
    reader.releaseLock();
  }
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) !== byteLength) {
    throw invalidProviderResponse();
  }
  return {
    attachmentId: input.attachmentId,
    versionNumber: input.versionNumber,
    byteLength,
    sha256: digest.digest('hex'),
  };
}
