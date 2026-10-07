import { AppError } from '../utils/errors.js';
import { createConfluenceClient, type ConfluenceClient } from './confluence-client.js';
import {
  listAttachments,
  listAttachmentVersions,
  type ConfluenceAttachment,
  type ConfluenceAttachmentVersion,
} from './confluence-attachments.js';
import {
  readAttachmentVersionBytes,
  type AttachmentVersionReadback,
  type AttachmentVersionReadbackInput,
} from './confluence-attachment-readback.js';
import { confluenceUploadOperationMarker } from './confluence-upload-operation-marker.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CLOUD_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const MAX_VERSIONS = 32;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_ONE_READ_BYTES = 50 * 1024 * 1024;

type ReadInput = AttachmentVersionReadbackInput;

export type AttachmentObservationOperations = {
  listAttachments(client: ConfluenceClient, pageId: string): Promise<ConfluenceAttachment[]>;
  listAttachmentVersions(client: ConfluenceClient, attachmentId: string, maxVersions: number): Promise<ConfluenceAttachmentVersion[]>;
  readAttachmentVersionBytes(input: ReadInput): Promise<AttachmentVersionReadback>;
};

export type AttachmentVersionObservation = {
  cloudId: string;
  siteHostname: string;
  pageId: string;
  attachmentId: string;
  title: string;
  currentVersionNumber: number;
  versions: Array<{ number: number; byteLength: number; sha256: string }>;
  /** A matching provider message and byte digest is a candidate, not authority. */
  uploadCandidateVersionNumber?: number | null;
  /** This observation alone never authorizes a publication retry or erasure. */
  actionAuthorized: false;
};

export type AttachmentVersionObservationInput = Omit<ReadInput, 'versionNumber' | 'maxBytes'> & {
  /** Bounds every download, including the second read of the current version. */
  maxTotalBytes?: number;
  expectedUpload?: { operationId: string; sha256: string };
  operations?: Partial<AttachmentObservationOperations>;
};

const DEFAULT_OPERATIONS: AttachmentObservationOperations = {
  listAttachments,
  listAttachmentVersions,
  readAttachmentVersionBytes,
};

function invalidObservation(): AppError {
  return new AppError(502, 'CONFLUENCE_ATTACHMENT_OBSERVATION_INVALID',
    'Confluence did not return a stable, bounded attachment-version observation.');
}

function oneAttachment(attachments: ConfluenceAttachment[], attachmentId: string): ConfluenceAttachment {
  if (!Array.isArray(attachments)) throw invalidObservation();
  const matches = attachments.filter((attachment) => attachment.id === attachmentId);
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0]?.versionNumber)
    || (matches[0]?.versionNumber ?? 0) <= 0) throw invalidObservation();
  return matches[0];
}

function versionNumbers(versions: ConfluenceAttachmentVersion[], attachmentId: string, current: number): number[] {
  if (!Array.isArray(versions) || versions.length === 0 || versions.length > MAX_VERSIONS) {
    throw invalidObservation();
  }
  const numbers = versions.map((version) => {
    if (version.attachmentId !== attachmentId || !Number.isSafeInteger(version.number)
      || version.number <= 0 || (version.message !== undefined
        && (typeof version.message !== 'string' || version.message.length > 1024))) throw invalidObservation();
    return version.number;
  }).sort((left, right) => left - right);
  if (new Set(numbers).size !== numbers.length || numbers[numbers.length - 1] !== current) {
    throw invalidObservation();
  }
  return numbers;
}

function versionMessages(versions: ConfluenceAttachmentVersion[]): string {
  return JSON.stringify(versions.map((version) => [version.number, version.message ?? null])
    .sort((left, right) => Number(left[0]) - Number(right[0])));
}

/**
 * Read the provider-listed bounded version history, then repeat the
 * current-version byte read with metadata checks on both sides. This detects a
 * changing attachment during observation without treating a single digest
 * as proof of a particular outbound operation. It does not enumerate other
 * copies, resolve a lost write response, or authorize retries/erasure.
 */
export async function observeAttachmentVersionBytes(
  input: AttachmentVersionObservationInput,
): Promise<AttachmentVersionObservation> {
  const maxTotalBytes = input.maxTotalBytes ?? MAX_TOTAL_BYTES;
  if (!CLOUD_ID.test(input.cloudId) || !ID.test(input.pageId) || !ID.test(input.attachmentId)
    || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.atlassian\.net$/.test(input.siteHostname)
    || !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes <= 0 || maxTotalBytes > MAX_TOTAL_BYTES
    || typeof input.getAccessToken !== 'function') {
    throw new AppError(400, 'CONFLUENCE_ATTACHMENT_OBSERVATION_INPUT_INVALID',
      'An attachment observation requires valid exact identifiers and limits.');
  }
  const marker = input.expectedUpload === undefined ? null
    : confluenceUploadOperationMarker(input.expectedUpload.operationId, input.expectedUpload.sha256);
  const operations = { ...DEFAULT_OPERATIONS, ...input.operations };
  const client = createConfluenceClient(
    { cloudId: input.cloudId, getAccessToken: input.getAccessToken },
    input.fetch === undefined ? {} : { fetch: input.fetch },
  );
  const firstAttachment = oneAttachment(
    await operations.listAttachments(client, input.pageId), input.attachmentId,
  );
  const firstCurrent = firstAttachment.versionNumber!;
  const firstListed = await operations.listAttachmentVersions(client, input.attachmentId, MAX_VERSIONS);
  const numbers = versionNumbers(firstListed, input.attachmentId, firstCurrent);
  const firstMessages = versionMessages(firstListed);

  let totalBytes = 0;
  const versions: AttachmentVersionObservation['versions'] = [];
  const readVersion = async (versionNumber: number): Promise<AttachmentVersionReadback> => {
    const remaining = maxTotalBytes - totalBytes;
    if (remaining <= 0) throw invalidObservation();
    const result = await operations.readAttachmentVersionBytes({
      cloudId: input.cloudId,
      pageId: input.pageId,
      attachmentId: input.attachmentId,
      versionNumber,
      siteHostname: input.siteHostname,
      getAccessToken: input.getAccessToken,
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      maxBytes: Math.min(MAX_ONE_READ_BYTES, remaining),
    });
    if (result.attachmentId !== input.attachmentId || result.versionNumber !== versionNumber
      || !Number.isSafeInteger(result.byteLength) || result.byteLength < 0
      || result.byteLength > remaining || !/^[0-9a-f]{64}$/.test(result.sha256)) {
      throw invalidObservation();
    }
    totalBytes += result.byteLength;
    return result;
  };

  for (const number of numbers) {
    const read = await readVersion(number);
    versions.push({ number, byteLength: read.byteLength, sha256: read.sha256 });
  }

  const secondAttachment = oneAttachment(
    await operations.listAttachments(client, input.pageId), input.attachmentId,
  );
  const secondCurrent = secondAttachment.versionNumber!;
  const secondListed = await operations.listAttachmentVersions(client, input.attachmentId, MAX_VERSIONS);
  const secondNumbers = versionNumbers(secondListed, input.attachmentId, secondCurrent);
  if (firstAttachment.title !== secondAttachment.title || firstCurrent !== secondCurrent
    || JSON.stringify(numbers) !== JSON.stringify(secondNumbers)
    || firstMessages !== versionMessages(secondListed)) throw invalidObservation();

  const repeatedCurrent = await readVersion(firstCurrent);
  const firstCurrentRead = versions[versions.length - 1];
  if (repeatedCurrent.byteLength !== firstCurrentRead?.byteLength
    || repeatedCurrent.sha256 !== firstCurrentRead.sha256) throw invalidObservation();

  const finalAttachment = oneAttachment(
    await operations.listAttachments(client, input.pageId), input.attachmentId,
  );
  const finalCurrent = finalAttachment.versionNumber!;
  const finalListed = await operations.listAttachmentVersions(client, input.attachmentId, MAX_VERSIONS);
  const finalNumbers = versionNumbers(finalListed, input.attachmentId, finalCurrent);
  if (firstAttachment.title !== finalAttachment.title || firstCurrent !== finalCurrent
    || JSON.stringify(numbers) !== JSON.stringify(finalNumbers)
    || firstMessages !== versionMessages(finalListed)) throw invalidObservation();

  let uploadCandidateVersionNumber: number | null = null;
  if (marker !== null) {
    const matches = firstListed.filter((version) => version.message === marker);
    if (matches.length > 1) throw invalidObservation();
    const match = matches[0];
    if (match !== undefined) {
      const observed = versions.find((version) => version.number === match.number);
      if (observed?.sha256 !== input.expectedUpload?.sha256) throw invalidObservation();
      uploadCandidateVersionNumber = match.number;
    }
  }

  return {
    cloudId: input.cloudId,
    siteHostname: input.siteHostname,
    pageId: input.pageId,
    attachmentId: input.attachmentId,
    title: firstAttachment.title,
    currentVersionNumber: firstCurrent,
    versions,
    ...(marker === null ? {} : { uploadCandidateVersionNumber }),
    actionAuthorized: false,
  };
}
