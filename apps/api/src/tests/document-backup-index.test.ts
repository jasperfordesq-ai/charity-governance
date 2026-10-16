import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import {
  buildDocumentBackupIndex,
  sealDocumentBackupIndex,
  openDocumentBackupIndex,
  type DocumentBackupIndexMac,
} from '../services/document-backup-index.js';
import {
  canonicalDocumentIdentitySha256,
  canonicalMetadataBindingSha256,
  canonicalObjectKeySha256,
  canonicalMetadataInventorySha256,
  canonicalObjectInventorySha256,
} from '../../../../packages/shared/runtime/document-recovery-inventory.mjs';

const arn = (n: string) =>
  `arn:aws:kms:eu-west-1:123456789012:key/${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const scope = {
  installationId: 'fixture',
  setId: '11111111-1111-4111-8111-111111111111',
  sourceSha: 'a'.repeat(40),
  databaseSha256: 'b'.repeat(64),
  sourceCaptureReportSha256: 'c'.repeat(64),
  databaseIdentitySha256: 'd'.repeat(64),
  objectStoreIdentitySha256: 'e'.repeat(64),
  dataKeyArn: arn('2'),
  macKeyArn: arn('3'),
  metadataCapturedAt: '2026-10-17T00:00:00.000Z',
  metadataCaptureTransactionId: '42',
  objectCapturedAt: '2026-10-17T00:00:00.000Z',
};
function input() {
  const row = {
    id: 'document',
    organisationId: 'tenant',
    fileUrl: 'private/tenant/document.pdf',
    fileSize: 5,
    mimeType: 'application/pdf',
  };
  const binding = canonicalMetadataBindingSha256(row);
  return {
    scope: { ...scope },
    metadataRows: [row],
    objectRows: [{ fileUrl: row.fileUrl, bytes: 5, sha256: 'f'.repeat(64) }],
    receipts: [
      {
        context: {
          installationId: scope.installationId,
          setId: scope.setId,
          organisationId: row.organisationId,
          documentId: row.id,
          sourceSha: scope.sourceSha,
          databaseSha256: scope.databaseSha256,
          sourceBindingSha256: binding,
          bytesSha256: 'f'.repeat(64),
          byteLength: 5,
          keyArn: scope.dataKeyArn,
        },
        sha256: '1'.repeat(64),
        versionId: 'exact-version',
        objectKey: `business-data/${scope.installationId}/${scope.setId}/documents/tenant/document/${binding}.json`,
      },
    ],
  };
}
function mac(): DocumentBackupIndexMac {
  const digest = (message: Buffer) =>
    createHmac('sha256', Buffer.alloc(32, 8)).update(message).digest();
  return {
    async generate(keyArn, message) {
      return { keyArn, mac: digest(message) };
    },
    async verify(keyArn, message, tag) {
      return { keyArn, valid: digest(message).equals(tag) };
    },
  };
}
test('archive index binds complete existing inventories, exact versions and database/set scope', async () => {
  const raw = input(),
    index = buildDocumentBackupIndex(raw);
  const metadata = [
    {
      documentIdentitySha256: canonicalDocumentIdentitySha256(
        raw.metadataRows[0].id,
      ),
      metadataBindingSha256: canonicalMetadataBindingSha256(
        raw.metadataRows[0],
      ),
      objectKeySha256: canonicalObjectKeySha256(raw.metadataRows[0].fileUrl),
      fileSize: 5,
    },
  ];
  const objects = [
    {
      objectKeySha256: metadata[0].objectKeySha256,
      bytes: 5,
      sha256: 'f'.repeat(64),
    },
  ];
  assert.equal(
    index.metadataInventorySha256,
    canonicalMetadataInventorySha256(metadata, scope.metadataCapturedAt, '42'),
  );
  assert.equal(
    index.objectInventorySha256,
    canonicalObjectInventorySha256(objects, scope.objectCapturedAt),
  );
  const sealed = await sealDocumentBackupIndex(raw, mac());
  assert.ok(!sealed.body.includes(raw.metadataRows[0].fileUrl));
  const opened = await openDocumentBackupIndex(
    scope,
    sealed.body,
    sealed.sha256,
    mac(),
  );
  assert.equal(opened.entries[0].archive.versionId, 'exact-version');
  assert.equal(opened.entries[0].context.organisationId, 'tenant');
});
test('missing, duplicate, extra, orphan and mismatched source records cannot produce an index', () => {
  const mutations: Array<(value: ReturnType<typeof input>) => void> = [
    (x) => {
      x.receipts = [];
    },
    (x) => {
      x.metadataRows.push(x.metadataRows[0]);
    },
    (x) => {
      x.objectRows.push(x.objectRows[0]);
    },
    (x) => {
      x.receipts.push(x.receipts[0]);
    },
    (x) => {
      x.objectRows.push({
        fileUrl: 'orphan',
        bytes: 1,
        sha256: 'a'.repeat(64),
      });
    },
    (x) => {
      x.objectRows = [];
    },
    (x) => {
      x.objectRows[0].bytes++;
    },
    (x) => {
      x.receipts[0].context.organisationId = 'other';
    },
    (x) => {
      x.receipts[0].context.bytesSha256 = 'a'.repeat(64);
    },
    (x) => {
      x.receipts[0].objectKey += '/redirect';
    },
    (x) => {
      x.receipts[0].versionId = 'null';
    },
    (x) => {
      x.scope.objectCapturedAt = '2026-10-17T02:00:00.000Z';
    },
  ];
  for (const mutate of mutations) {
    const x = input();
    mutate(x);
    assert.throws(() => buildDocumentBackupIndex(x));
  }
});
test('authenticated opening rejects substitution, replay under a new set, canonical changes and wrong MAC key', async () => {
  const sealed = await sealDocumentBackupIndex(input(), mac());
  const digest = (body: string) =>
    createHash('sha256').update(body).digest('hex');
  await assert.rejects(
    openDocumentBackupIndex(
      { ...scope, setId: '99999999-9999-4999-8999-999999999999' },
      sealed.body,
      sealed.sha256,
      mac(),
    ),
  );
  await assert.rejects(
    openDocumentBackupIndex(scope, sealed.body, '0'.repeat(64), mac()),
  );
  await assert.rejects(
    openDocumentBackupIndex(scope, sealed.body + '\n', sealed.sha256, mac()),
  );
  const altered = JSON.parse(sealed.body);
  altered.index.entries[0].archive.versionId = 'substituted';
  const body = JSON.stringify(altered);
  await assert.rejects(
    openDocumentBackupIndex(scope, body, digest(body), mac()),
  );
  for (const field of [
    'organisationId',
    'databaseSha256',
    'sourceBindingSha256',
  ] as const) {
    const changed = JSON.parse(sealed.body);
    changed.index.entries[0].context[field] =
      field === 'organisationId' ? 'other' : '0'.repeat(64);
    const tampered = JSON.stringify(changed);
    await assert.rejects(
      openDocumentBackupIndex(scope, tampered, digest(tampered), mac()),
    );
  }
  const extra = JSON.stringify({
    ...JSON.parse(sealed.body),
    title: 'unexpected private title',
  });
  await assert.rejects(
    openDocumentBackupIndex(scope, extra, digest(extra), mac()),
  );
  await assert.rejects(
    sealDocumentBackupIndex(buildDocumentBackupIndex(input()), mac()),
  );
  const wrong: DocumentBackupIndexMac = {
    ...mac(),
    async verify(_key, _message, _tag) {
      return { keyArn: arn('4'), valid: true };
    },
  };
  await assert.rejects(
    openDocumentBackupIndex(scope, sealed.body, sealed.sha256, wrong),
  );
});
test('empty whole inventories are explicit, large sets bounded and caller mutation after seal cannot alter scope', async () => {
  const empty = buildDocumentBackupIndex({
    scope,
    metadataRows: [],
    objectRows: [],
    receipts: [],
  });
  assert.deepEqual(empty.entries, []);
  assert.throws(() =>
    buildDocumentBackupIndex({
      ...input(),
      metadataRows: Array(5001).fill(input().metadataRows[0]),
    }),
  );
  const raw = input();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider = mac();
  const sealing = sealDocumentBackupIndex(raw, {
    ...provider,
    async generate(key, message) {
      await wait;
      return provider.generate(key, message);
    },
  });
  raw.receipts[0].versionId = 'mutated';
  release();
  const sealed = await sealing;
  const opened = await openDocumentBackupIndex(
    scope,
    sealed.body,
    sealed.sha256,
    provider,
  );
  assert.equal(opened.entries[0].archive.versionId, 'exact-version');
});
test('inventory order is canonical and shared source objects still need an archive for every document', async () => {
  const value = input();
  const row = { ...value.metadataRows[0], id: 'another-document' };
  const binding = canonicalMetadataBindingSha256(row);
  value.metadataRows.push(row);
  value.receipts.push({
    ...value.receipts[0],
    context: {
      ...value.receipts[0].context,
      documentId: row.id,
      sourceBindingSha256: binding,
    },
    objectKey: `business-data/${scope.installationId}/${scope.setId}/documents/tenant/${row.id}/${binding}.json`,
  });
  const first = await sealDocumentBackupIndex(value, mac());
  value.metadataRows.reverse();
  value.receipts.reverse();
  assert.deepEqual(await sealDocumentBackupIndex(value, mac()), first);
  const empty = await sealDocumentBackupIndex(
    { scope, metadataRows: [], objectRows: [], receipts: [] },
    mac(),
  );
  assert.deepEqual(
    (await openDocumentBackupIndex(scope, empty.body, empty.sha256, mac()))
      .entries,
    [],
  );
});
