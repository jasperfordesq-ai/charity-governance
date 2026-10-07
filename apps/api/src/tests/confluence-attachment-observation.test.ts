import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { ConfluenceAttachment, ConfluenceAttachmentVersion } from '../services/confluence-attachments.js';
import {
  observeAttachmentVersionBytes,
  type AttachmentObservationOperations,
} from '../services/confluence-attachment-observation.js';
import { confluenceUploadOperationMarker } from '../services/confluence-upload-operation-marker.js';
import { AppError } from '../utils/errors.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const attachment: ConfluenceAttachment = {
  id: 'att456', title: 'governance.pdf', mediaType: 'application/pdf', fileSize: 3,
  downloadUrl: '', versionNumber: 2,
};
const versions: ConfluenceAttachmentVersion[] = [
  { number: 1, attachmentId: 'att456', createdAt: '2026-10-01' },
  { number: 2, attachmentId: 'att456', createdAt: '2026-10-02' },
];

function harness(overrides: Partial<AttachmentObservationOperations> = {}) {
  const calls: string[] = [];
  const operations: AttachmentObservationOperations = {
    listAttachments: async () => { calls.push('attachments'); return [attachment]; },
    listAttachmentVersions: async () => { calls.push('versions'); return versions; },
    readAttachmentVersionBytes: async ({ attachmentId, versionNumber, maxBytes }) => {
      calls.push(`bytes-${versionNumber}-${maxBytes}`);
      return { attachmentId, versionNumber, byteLength: 3, sha256: digest(String(versionNumber)) };
    },
    ...overrides,
  };
  return { calls, operations };
}

function input(operations: Partial<AttachmentObservationOperations>, extra: Record<string, unknown> = {}) {
  return {
    cloudId: 'cloud-123', pageId: 'page123', attachmentId: 'att456',
    siteHostname: 'charity.atlassian.net', getAccessToken: async () => 'private-token',
    operations, ...extra,
  };
}

async function rejected(action: () => Promise<unknown>, code: string) {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    assert.equal(error.message.includes('private-token'), false);
    return true;
  });
}

test('reads every listed version, repeats metadata and hashes the current version twice without authorizing action', async () => {
  const h = harness();
  const result = await observeAttachmentVersionBytes(input(h.operations));
  assert.deepEqual(result, {
    cloudId: 'cloud-123', siteHostname: 'charity.atlassian.net',
    pageId: 'page123', attachmentId: 'att456', title: 'governance.pdf',
    currentVersionNumber: 2,
    versions: [
      { number: 1, byteLength: 3, sha256: digest('1') },
      { number: 2, byteLength: 3, sha256: digest('2') },
    ],
    actionAuthorized: false,
  });
  assert.deepEqual(h.calls, [
    'attachments', 'versions', 'bytes-1-52428800', 'bytes-2-52428800',
    'attachments', 'versions', 'bytes-2-52428800',
    'attachments', 'versions',
  ]);
});

test('metadata requests and byte observations are bound to the same cloud id', async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const attachmentBody = { results: [{ id: 'att456', title: 'governance.pdf',
    mediaType: 'application/pdf', fileSize: 3, version: { number: 2 } }], _links: {} };
  const versionBody = { results: versions.map((version) => ({
    number: version.number, attachment: { id: 'att456' }, createdAt: version.createdAt,
  })), _links: {} };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), authorization: new Headers(init?.headers).get('Authorization') });
    const body = requests.length % 2 === 1 ? attachmentBody : versionBody;
    return new Response(JSON.stringify(body), { status: 200,
      headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const h = harness();
  const observed = await observeAttachmentVersionBytes(input({
    readAttachmentVersionBytes: h.operations.readAttachmentVersionBytes,
  }, { fetch: fetchImpl }));
  assert.equal(observed.actionAuthorized, false);
  assert.equal(requests.length, 6);
  assert.equal(requests.every((request) => request.url.startsWith(
    'https://api.atlassian.com/ex/confluence/cloud-123/wiki/api/v2/')), true);
  assert.equal(requests.every((request) => request.authorization === 'Bearer private-token'), true);
});

test('refuses metadata drift or duplicate attachment identity', async () => {
  let reads = 0;
  const drift = harness({ listAttachments: async () => {
    reads += 1;
    return [{ ...attachment, versionNumber: reads === 1 ? 2 : 3 }];
  } });
  await rejected(() => observeAttachmentVersionBytes(input(drift.operations)),
    'CONFLUENCE_ATTACHMENT_OBSERVATION_INVALID');

  const duplicate = harness({ listAttachments: async () => [attachment, attachment] });
  await rejected(() => observeAttachmentVersionBytes(input(duplicate.operations)),
    'CONFLUENCE_ATTACHMENT_OBSERVATION_INVALID');

  const changedVersions = harness({ listAttachmentVersions: async () => {
    reads += 1;
    return reads === 3 ? versions : [versions[1]];
  } });
  await rejected(() => observeAttachmentVersionBytes(input(changedVersions.operations)),
    'CONFLUENCE_ATTACHMENT_OBSERVATION_INVALID');

  let attachmentReads = 0;
  const lateDrift = harness({ listAttachments: async () => {
    attachmentReads += 1;
    return [{ ...attachment, versionNumber: attachmentReads === 3 ? 3 : 2 }];
  } });
  await rejected(() => observeAttachmentVersionBytes(input(lateDrift.operations)),
    'CONFLUENCE_ATTACHMENT_OBSERVATION_INVALID');
});

test('refuses a changed current-version digest after the second metadata read', async () => {
  let currentReads = 0;
  const h = harness({ readAttachmentVersionBytes: async ({ attachmentId, versionNumber }) => {
    if (versionNumber === 2) currentReads += 1;
    return { attachmentId, versionNumber, byteLength: 3,
      sha256: digest(currentReads === 2 ? 'changed' : String(versionNumber)) };
  } });
  await rejected(() => observeAttachmentVersionBytes(input(h.operations)),
    'CONFLUENCE_ATTACHMENT_OBSERVATION_INVALID');
});

test('bounds aggregate bytes including the repeated current read', async () => {
  const h = harness();
  await rejected(() => observeAttachmentVersionBytes(input(h.operations, { maxTotalBytes: 8 })),
    'CONFLUENCE_ATTACHMENT_OBSERVATION_INVALID');
  assert.equal(h.calls.includes('bytes-2-2'), true);
});

test('invalid tenant host is rejected before token or provider calls', async () => {
  const h = harness();
  await rejected(() => observeAttachmentVersionBytes(input(h.operations, {
    siteHostname: 'evil.example',
  })), 'CONFLUENCE_ATTACHMENT_OBSERVATION_INPUT_INVALID');
  assert.deepEqual(h.calls, []);
});

const operationId = '0123456789abcdef0123456789abcdef';

test('identifies one matching upload message and byte digest as a non-authorizing candidate', async () => {
  const marked = versions.map((version) => version.number === 1
    ? { ...version, message: confluenceUploadOperationMarker(operationId, digest('1')) }
    : version);
  const h = harness({ listAttachmentVersions: async () => marked });
  const result = await observeAttachmentVersionBytes(input(h.operations, {
    expectedUpload: { operationId, sha256: digest('1') },
  }));
  assert.equal(result.uploadCandidateVersionNumber, 1);
  assert.equal(result.actionAuthorized, false);
});

test('missing upload marker yields no candidate or action authority', async () => {
  const h = harness();
  const result = await observeAttachmentVersionBytes(input(h.operations, {
    expectedUpload: { operationId, sha256: digest('1') },
  }));
  assert.equal(result.uploadCandidateVersionNumber, null);
  assert.equal(result.actionAuthorized, false);
});

test('duplicate marker, mismatched bytes and changed messages invalidate the observation', async () => {
  const marker = confluenceUploadOperationMarker(operationId, digest('1'));
  const duplicate = harness({ listAttachmentVersions: async () => versions.map(
    (version) => ({ ...version, message: marker }),
  ) });
  await rejected(() => observeAttachmentVersionBytes(input(duplicate.operations, {
    expectedUpload: { operationId, sha256: digest('1') },
  })), 'CONFLUENCE_ATTACHMENT_OBSERVATION_INVALID');

  const mismatched = harness({ listAttachmentVersions: async () => versions.map(
    (version) => version.number === 2 ? { ...version, message: marker } : version,
  ) });
  await rejected(() => observeAttachmentVersionBytes(input(mismatched.operations, {
    expectedUpload: { operationId, sha256: digest('1') },
  })), 'CONFLUENCE_ATTACHMENT_OBSERVATION_INVALID');

  let reads = 0;
  const drift = harness({ listAttachmentVersions: async () => {
    reads += 1;
    return versions.map((version) => version.number === 1
      ? { ...version, message: reads === 3 ? 'changed' : marker } : version);
  } });
  await rejected(() => observeAttachmentVersionBytes(input(drift.operations, {
    expectedUpload: { operationId, sha256: digest('1') },
  })), 'CONFLUENCE_ATTACHMENT_OBSERVATION_INVALID');
});

test('invalid expected upload identity is refused before token or provider calls', async () => {
  const h = harness();
  let tokenCalls = 0;
  await rejected(() => observeAttachmentVersionBytes(input(h.operations, {
    getAccessToken: async () => { tokenCalls += 1; return 'private-token'; },
    expectedUpload: { operationId: 'not-an-id', sha256: digest('1') },
  })), 'CONFLUENCE_UPLOAD_OPERATION_INVALID');
  assert.equal(tokenCalls, 0);
  assert.deepEqual(h.calls, []);
});
