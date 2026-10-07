import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { observeSavedConfluenceUpload } from '../services/confluence-saved-upload-observation.js';
import { confluenceUploadOperationMarker } from '../services/confluence-upload-operation-marker.js';
import { AppError } from '../utils/errors.js';

const operationId = '0123456789abcdef0123456789abcdef';
const sha256 = createHash('sha256').update('bytes').digest('hex');

function fixture(overrides: { org?: string; siteId?: string; siteUrl?: string; status?: string } = {}) {
  const calls: string[] = [];
  const prisma = {
    documentPublicationUploadIntent: {
      findFirst: async (args: { where: { id: string; organisationId: string } }) => {
        calls.push('intent');
        assert.deepEqual(args.where, { id: operationId, organisationId: overrides.org ?? 'org-1' });
        return { id: operationId, cloudId: 'cloud-1', pageId: 'page-1', filename: 'policy.pdf', sha256 };
      },
    },
    organisationIntegration: {
      findUnique: async () => {
        calls.push('integration');
        return { id: 'integration-1', status: overrides.status ?? 'CONNECTED',
          config: { siteId: overrides.siteId ?? 'cloud-1',
            siteUrl: overrides.siteUrl ?? 'https://charity.atlassian.net/wiki' } };
      },
    },
  };
  const operations = {
    listAttachments: async () => {
      calls.push('attachments');
      return [{ id: 'att-1', title: 'policy.pdf', mediaType: 'application/pdf',
        fileSize: 5, downloadUrl: '', versionNumber: 1 }];
    },
    listAttachmentVersions: async () => {
      calls.push('versions');
      return [{ number: 1, attachmentId: 'att-1', createdAt: '2026-10-07',
        message: confluenceUploadOperationMarker(operationId, sha256) }];
    },
    readAttachmentVersionBytes: async (input: { cloudId: string; pageId: string;
      attachmentId: string; versionNumber: number; siteHostname: string }) => {
      calls.push('bytes');
      assert.equal(input.cloudId, 'cloud-1');
      assert.equal(input.pageId, 'page-1');
      assert.equal(input.siteHostname, 'charity.atlassian.net');
      return { attachmentId: input.attachmentId, versionNumber: input.versionNumber,
        byteLength: 5, sha256 };
    },
  };
  return { calls, prisma, operations };
}

test('saved intent supplies site, page, operation and digest for a non-authorizing observation', async () => {
  const f = fixture();
  const result = await observeSavedConfluenceUpload(f.prisma as never, {
    organisationId: 'org-1', operationId, attachmentId: 'att-1',
  }, { getAccessToken: async () => 'test-token', operations: f.operations });
  assert.equal(result.uploadOperationId, operationId);
  assert.equal(result.uploadCandidateVersionNumber, 1);
  assert.equal(result.actionAuthorized, false);
  assert.equal(f.calls.filter((call) => call === 'bytes').length, 2);
});

test('a changed cloud site or unconnected integration refuses provider I/O', async () => {
  for (const overrides of [{ siteId: 'other-cloud' }, { status: 'DISCONNECTED' },
    { siteUrl: 'https://evil.example/wiki' }]) {
    const f = fixture(overrides);
    await assert.rejects(() => observeSavedConfluenceUpload(f.prisma as never, {
      organisationId: 'org-1', operationId, attachmentId: 'att-1',
    }, { getAccessToken: async () => 'test-token', operations: f.operations }),
    (error: unknown) => error instanceof AppError
      && error.code === 'CONFLUENCE_UPLOAD_OBSERVATION_BINDING_INVALID');
    assert.equal(f.calls.includes('attachments'), false);
  }
});

test('invalid operation identity is rejected before database or provider reads', async () => {
  const f = fixture();
  await assert.rejects(() => observeSavedConfluenceUpload(f.prisma as never, {
    organisationId: 'org-1', operationId: 'wrong', attachmentId: 'att-1',
  }, { getAccessToken: async () => 'test-token', operations: f.operations }),
  (error: unknown) => error instanceof AppError
    && error.code === 'CONFLUENCE_UPLOAD_OBSERVATION_BINDING_INVALID');
  assert.deepEqual(f.calls, []);
});

test('an absent tenant-scoped intent cannot select a connected site or read provider bytes', async () => {
  let integrationReads = 0;
  const prisma = {
    documentPublicationUploadIntent: {
      findFirst: async (args: { where: { id: string; organisationId: string } }) => {
        assert.deepEqual(args.where, { id: operationId, organisationId: 'other-org' });
        return null;
      },
    },
    organisationIntegration: { findUnique: async () => {
      integrationReads += 1;
      throw new Error('must not read another site');
    } },
  };
  await assert.rejects(() => observeSavedConfluenceUpload(prisma as never, {
    organisationId: 'other-org', operationId, attachmentId: 'att-1',
  }), (error: unknown) => error instanceof AppError
    && error.code === 'CONFLUENCE_UPLOAD_OBSERVATION_BINDING_INVALID');
  assert.equal(integrationReads, 0);
});

test('a marker on a differently named attachment cannot become a saved-intent candidate', async () => {
  const f = fixture();
  f.operations.listAttachments = async () => {
    f.calls.push('attachments');
    return [{ id: 'att-1', title: 'other.pdf', mediaType: 'application/pdf',
      fileSize: 5, downloadUrl: '', versionNumber: 1 }];
  };
  await assert.rejects(() => observeSavedConfluenceUpload(f.prisma as never, {
    organisationId: 'org-1', operationId, attachmentId: 'att-1',
  }, { getAccessToken: async () => 'test-token', operations: f.operations }),
  (error: unknown) => error instanceof AppError
    && error.code === 'CONFLUENCE_UPLOAD_OBSERVATION_ATTACHMENT_INVALID');
});

test('a site switch during token retrieval stops before provider I/O', async () => {
  const overrides: { siteId?: string } = {};
  const f = fixture(overrides);
  let providerCalls = 0;
  await assert.rejects(() => observeSavedConfluenceUpload(f.prisma as never, {
    organisationId: 'org-1', operationId, attachmentId: 'att-1',
  }, {
    getAccessToken: async () => { overrides.siteId = 'other-cloud'; return 'test-token'; },
    fetch: (async () => { providerCalls += 1; throw new Error('provider must not be called'); }) as typeof fetch,
    operations: { readAttachmentVersionBytes: f.operations.readAttachmentVersionBytes },
  }), (error: unknown) => error instanceof AppError
    && error.code === 'CONFLUENCE_UPLOAD_OBSERVATION_BINDING_INVALID');
  assert.equal(providerCalls, 0);
});

test('a site switch after the first provider read stops the next request locally', async () => {
  const overrides: { siteId?: string } = {};
  const f = fixture(overrides);
  let providerCalls = 0;
  await assert.rejects(() => observeSavedConfluenceUpload(f.prisma as never, {
    organisationId: 'org-1', operationId, attachmentId: 'att-1',
  }, {
    getAccessToken: async () => 'test-token',
    fetch: (async () => {
      providerCalls += 1;
      overrides.siteId = 'other-cloud';
      return new Response(JSON.stringify({ results: [{ id: 'att-1', title: 'policy.pdf',
        mediaType: 'application/pdf', fileSize: 5, version: { number: 1 } }], _links: {} }), { status: 200,
        headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch,
    operations: { readAttachmentVersionBytes: f.operations.readAttachmentVersionBytes },
  }), (error: unknown) => error instanceof AppError
    && error.code === 'CONFLUENCE_UPLOAD_OBSERVATION_BINDING_INVALID');
  assert.equal(providerCalls, 1);
});
