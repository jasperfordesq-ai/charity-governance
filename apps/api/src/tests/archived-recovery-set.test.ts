import {snapshotIntervalFixture,snapshotContext} from './fixtures/managed-snapshot-interval.js';
import assert from 'node:assert/strict';
import {backend,config,credentials,hash,arn,source,sink} from './fixtures/archived-custody.js';
import { Readable } from 'node:stream';
import test from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import { ArchivedRecoverySets } from '../services/archived-recovery-set.js';
import { KmsBackupManifestMac } from '../services/backup-manifest-kms.js';
import { S3BackupManifests } from '../services/backup-manifests-s3.js';
import { S3DatabaseByteBackups } from '../services/database-byte-backup-s3.js';
import { S3DocumentByteBackups } from '../services/document-byte-backup-s3.js';
import { SupabaseRecoveryCapture } from '../services/supabase-recovery-capture.js';
import { KmsDatabaseBackupKeys } from '../services/database-byte-backup-kms.js';
import { KmsDocumentBackupKeys } from '../services/document-byte-backup-kms.js';
import { KmsDocumentBackupIndexMac } from '../services/document-backup-index-kms.js';
import { sealDatabaseByteBackup } from '../services/database-byte-backup.js';
import { sealDocumentByteBackup } from '../services/document-byte-backup.js';
import { sealDocumentBackupIndex } from '../services/document-backup-index.js';
import {
  canonicalMetadataBindingSha256,
  canonicalDocumentIdentitySha256,
  canonicalObjectKeySha256,
  canonicalDocumentMetadataRowsSha256,
} from '../../../../packages/shared/runtime/document-recovery-inventory.mjs';

async function fixture(
  b: ReturnType<typeof backend>,
  badCount = false,
  metadataMode: 'MATCH' | 'CHANGED' | 'MISSING' = 'MATCH',
  interval?:ReturnType<typeof snapshotIntervalFixture>,
) {
  const s3 = b.s3(),
    kms = b.kms(),
    clients = { s3, kms };
  const storage = {
    installationId: config.installationId,
    bucket: config.bucket,
    accountId: config.accountId,
    storageKeyArn: config.storageKeyArn,
  };
  const dataStorage = { ...storage, dataKeyArn: config.dataKeyArn };
  const db = Buffer.from('PGDMP synthetic database archive'),
    doc = Buffer.from('synthetic reviewed record');
  const row = {
    id: 'document',
    organisationId: 'tenant',
    fileUrl: 'private/document',
    fileSize: doc.length,
    mimeType: 'text/plain',
  };
  const documentMetadata =
    metadataMode === 'MISSING'
      ? undefined
      : {
          format: 'charitypilot-document-metadata-rows/v1',
          rowCount: 1,
          rowsSha256:
            metadataMode === 'CHANGED'
              ? '0'.repeat(64)
              : canonicalDocumentMetadataRowsSha256([
                  {
                    documentIdentitySha256: canonicalDocumentIdentitySha256(
                      row.id,
                    ),
                    metadataBindingSha256: canonicalMetadataBindingSha256(row),
                    objectKeySha256: canonicalObjectKeySha256(row.fileUrl),
                    fileSize: row.fileSize,
                  },
                ]),
        };
  const sourceSha = 'a'.repeat(40),
    dbSha = hash(db).toString('hex'),
    databaseIdentitySha256 = 'b'.repeat(64),
    setId = '11111111-1111-4111-8111-111111111111';
  const report = {
    format: 'charitypilot-postgres-restore-proof/v2',
    checksumAlgorithm: 'sha256',
    ok: true,
    sourceReadOnlyVerified: true,
    sourceIdentityBindingMatched: true,
    sourceDatabaseIdentitySha256: databaseIdentitySha256,
    expectedSourceDatabaseIdentitySha256: databaseIdentitySha256,
    helperImplementation: {
      commitSha: sourceSha,
      sourceMatchesCommit: true,
      canonicalRepositoryMatched: true,
      format: 'charitypilot-postgres-proof-helper/v1',
      repositoryUrl: 'https://github.com/jasperfordesq-ai/charity-governance',
      sourcePath: 'scripts/postgres-backup.mjs',
      sourceSha256: 'd'.repeat(64),
      commitSourceSha256: 'd'.repeat(64),
    },
    snapshot: {
      isolationLevel: 'repeatable read',
      readOnly: true,
      rowSecurityOff: true,
      accessShareLocks: true,
      exported: true,
    },
    dump: {
      sha256: dbSha,
      bytes: String(db.length),
      rehashAfterRestoreSha256: dbSha,
      bytesAfterRestore: String(db.length),
      unchangedDuringProof: true,
      capacityPreflight: { verified: true },
    },
    comparison: {
      schemaMatched: true,
      rowCountsMatched: true,
      rowFingerprintsMatched: true,
      mismatchCount: 0,
    },
    source: {
      documentMetadata,
      tables: [
        {
          schema: 'public',
          table: 'Document',
          relationKind: 'r',
          isPartition: false,
          rowCount: badCount ? '2' : '1',
        },
      ],
    },
    restored: { documentMetadata },
    restoreTarget: {
      type: 'isolated-disposable-postgresql',
      cleanupVerified: true,
      productionOverwritten: false,
      networkPublished: false,
      hostVolumeForDatabase: false,
    },
  };
  if(interval)Object.assign(report,{importedSnapshot:snapshotContext(interval)});
  const reportBody = JSON.stringify(report, null, 2) + '\n',
    reportSha = hash(reportBody).toString('hex');
  const context = {
    installationId: config.installationId,
    setId,
    sourceSha,
    databaseIdentitySha256,
    sourceCaptureReportSha256: reportSha,
    databaseSha256: dbSha,
    byteLength: db.length,
    keyArn: config.dataKeyArn,
  };
  const encrypted = sink(),
    sealed = await sealDatabaseByteBackup(
      context,
      source(db),
      encrypted.stream,
      new KmsDatabaseBackupKeys(config.dataKeyArn, credentials, kms),
    );
  const database = await new S3DatabaseByteBackups(
    dataStorage,
    credentials,
    s3,
  ).publish(context, sealed, source(Buffer.concat(encrypted.chunks)));
  const docContext = {
    installationId: config.installationId,
    setId,
    sourceSha,
    databaseSha256: dbSha,
    organisationId: row.organisationId,
    documentId: row.id,
    sourceBindingSha256: canonicalMetadataBindingSha256(row),
    bytesSha256: hash(doc).toString('hex'),
    byteLength: doc.length,
    keyArn: config.dataKeyArn,
  };
  const primary: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes('/bucket/'))
      return Response.json({ id: 'documents', public: false });
    assert.ok(url.pathname.includes('/object/'));
    return new Response(Buffer.from(doc), {
      headers: {
        'content-type': row.mimeType,
        'content-length': String(doc.length),
      },
    });
  };
  const captureService = new SupabaseRecoveryCapture(
    {
      installationId: config.installationId,
      projectRef: 'abcdefghijklmnopqrst',
      bucket: 'documents',
      credential: {
        id: '11111111-1111-4111-8111-111111111111',
        sha256: hash(Buffer.from('sb_secret_' + 's'.repeat(40))).toString(
          'hex',
        ),
      },
    },
    'sb_secret_' + 's'.repeat(40),
    async (input, init) => {
      if (String(input).includes('/object/list/')) {
        const prefix = JSON.parse(String(init?.body)).prefix;
        return Response.json(
          prefix === ''
            ? [
                {
                  name: 'private',
                  id: null,
                  metadata: null,
                  created_at: null,
                  updated_at: null,
                },
              ]
            : [
                {
                  name: 'document',
                  id: '11111111-1111-4111-8111-111111111111',
                  metadata: { size: doc.length, mimetype: row.mimeType },
                  created_at: '2026-10-17T00:00:00.000Z',
                  updated_at: '2026-10-17T00:00:00.000Z',
                },
              ],
        );
      }
      return primary(input, init);
    },
  );
  const candidates: Awaited<ReturnType<S3DocumentByteBackups['publish']>>[] =
    [];
  const captured = await captureService.capture(async (file, bytes, digest) => {
    assert.equal(file.fileUrl, row.fileUrl);
    assert.equal(digest, docContext.bytesSha256);
    const sealed = await sealDocumentByteBackup(
      docContext,
      bytes,
      new KmsDocumentBackupKeys(config.dataKeyArn, credentials, kms),
    );
    candidates.push(
      await new S3DocumentByteBackups(dataStorage, credentials, s3).publish(
        docContext,
        sealed,
      ),
    );
  });
  const docStored = candidates[0];
  assert.equal(candidates.length, 1);
  const indexScope = {
    installationId: config.installationId,
    setId,
    sourceSha,
    databaseSha256: dbSha,
    sourceCaptureReportSha256: reportSha,
    databaseIdentitySha256,
    objectStoreIdentitySha256: captureService.configurationDigest(),
    dataKeyArn: config.dataKeyArn,
    macKeyArn: config.indexMacKeyArn,
    metadataCapturedAt: '2026-10-17T00:00:00.000Z',
    metadataCaptureTransactionId: '42',
    objectCapturedAt: '2026-10-17T00:00:00.000Z',
  };
  const index = await sealDocumentBackupIndex(
    {
      scope: indexScope,
      metadataRows: [row],
      objectRows: captured.objects,
      receipts: [
        {
          context: docContext,
          sha256: docStored.sha256,
          objectKey: docStored.objectKey,
          versionId: docStored.versionId,
        },
      ],
    },
    new KmsDocumentBackupIndexMac(config.indexMacKeyArn, credentials, kms),
  );
  const metadata = new S3BackupManifests(storage, credentials, s3),
    target = { installationId: config.installationId, setId, sourceSha };
  const sourceReport = await metadata.publish(
    { ...target, kind: 'SOURCE_REPORT_V2' },
    { body: reportBody, sha256: reportSha },
  );
  const storedIndex = await metadata.publish(
    { ...target, kind: 'DOCUMENT_INDEX_V1' },
    index,
  );
  db.fill(0);
  doc.fill(0);
  return {
    clients,
    input: {
      indexScope,
      databaseContext: context,
      database: { artifact: database.artifact, versionId: database.versionId },
      index: { sha256: index.sha256, versionId: storedIndex.versionId },
      sourceReport: { sha256: reportSha, versionId: sourceReport.versionId },
    },
  };
}
test('source report, authenticated index and all encrypted candidates form a read-verified root; lost root ACK reconciles read-only', async () => {
  const b = backend(),
    f = await fixture(b),
    first = new ArchivedRecoverySets(config, credentials, f.clients);
  const fresh = { s3: b.s3(), kms: b.kms() };
  try {
    const prepared = await first.prepare(f.input);
    const staged = await first.stagePrepared(prepared.pin, prepared.artifact);
    b.loseRoot = true;
    await assert.rejects(first.publishPrepared(prepared.pin, staged.versionId));
    const writes = b.writes,
      generates = b.generates;
    const observed = await new ArchivedRecoverySets(
      config,
      credentials,
      fresh,
    ).verifySet(prepared.pin);
    assert.equal(observed.kind, 'ARCHIVED_SET_VERIFIED');
    assert.equal(observed.restoreMode, 'QUARANTINE_ONLY');
    assert.equal(observed.documentCount, 1);
    assert.equal(b.writes, writes);
    assert.equal(b.generates, generates);
  } finally {
    f.clients.s3.destroy();
    f.clients.kms.destroy();
    fresh.s3.destroy();
    fresh.kms.destroy();
    b.close();
  }
});
test('source report/document inventory mismatch cannot produce a prepared root', async () => {
  const b = backend(),
    f = await fixture(b, true);
  try {
    await assert.rejects(
      new ArchivedRecoverySets(config, credentials, f.clients).prepare(f.input),
    );
    assert.ok(![...b.objects.keys()].some((key) => key.endsWith('/root.json')));
  } finally {
    f.clients.s3.destroy();
    f.clients.kms.destroy();
    b.close();
  }
});
test('equal document counts do not excuse missing or substituted snapshot metadata', async () => {
  for (const mode of ['CHANGED', 'MISSING'] as const) {
    const b = backend(),
      f = await fixture(b, false, mode);
    try {
      const writes = b.writes;
      await assert.rejects(
        new ArchivedRecoverySets(config, credentials, f.clients).prepare(
          f.input,
        ),
      );
      assert.equal(b.writes, writes);
    } finally {
      f.clients.s3.destroy();
      f.clients.kms.destroy();
      b.close();
    }
  }
});
test('normal root publication verifies exact version and rejects tampering even with a substituted external digest', async () => {
  const b = backend(),
    f = await fixture(b),
    service = new ArchivedRecoverySets(config, credentials, f.clients);
  try {
    const prepared = await service.prepare(f.input),
      artifact = { ...prepared.artifact };
    b.rootVerify = () => {
      artifact.body = '{}';
      artifact.sha256 = '0'.repeat(64);
    };
    const staged = await service.stagePrepared(prepared.pin, artifact);
    const published = await service.publishPrepared(
      prepared.pin,
      staged.versionId,
    );
    assert.equal(published.kind, 'ARCHIVED_ROOT_READBACK');
    assert.equal(
      (await service.verifySet(prepared.pin, published.versionId))
        .documentCount,
      1,
    );
    const key = [...b.objects.keys()].find((key) =>
        key.endsWith('/root.json'),
      )!,
      object = b.objects.get(key)!;
    const parsed = JSON.parse(object.body.toString());
    parsed.manifest.preparedAt = '2026-10-16T00:00:00.000Z';
    object.body = Buffer.from(JSON.stringify(parsed));
    object.checksum = hash(object.body).toString('base64');
    const forgedPin = {
      ...prepared.pin,
      sha256: hash(object.body).toString('hex'),
    };
    await assert.rejects(service.verifySet(forgedPin));
  } finally {
    f.clients.s3.destroy();
    f.clients.kms.destroy();
    b.close();
  }
});
test('lost prepared response survives discarded source clients and reconciles read-only before exact-version publication', async () => {
  const b = backend(),
    f = await fixture(b),
    first = new ArchivedRecoverySets(config, credentials, f.clients);
  const fresh = { s3: b.s3(), kms: b.kms() };
  try {
    const prepared = await first.prepare(f.input),
      pin = prepared.pin;
    b.losePrepared = true;
    await assert.rejects(first.stagePrepared(pin, prepared.artifact));
    assert.ok(![...b.objects.keys()].some((key) => key.endsWith('/root.json')));
    prepared.artifact.body = '{}';
    f.clients.s3.destroy();
    f.clients.kms.destroy();
    const resumed = new ArchivedRecoverySets(config, credentials, fresh),
      writes = b.writes,
      generates = b.generates;
    const observed = await resumed.observePrepared(pin);
    assert.equal(observed.kind, 'PREPARED_ROOT_READBACK');
    assert.equal(b.writes, writes);
    assert.equal(b.generates, generates);
    await assert.rejects(resumed.publishPrepared(pin, 'wrong-version'));
    assert.equal(b.writes, writes);
    const published = await resumed.publishPrepared(pin, observed.versionId);
    assert.equal(
      (await resumed.verifySet(pin, published.versionId)).documentCount,
      1,
    );
  } finally {
    f.clients.s3.destroy();
    f.clients.kms.destroy();
    fresh.s3.destroy();
    fresh.kms.destroy();
    b.close();
  }
});
test('missing or substituted prepared state cannot publish a root and duplicate staging never retries a write', async () => {
  const b = backend(),
    f = await fixture(b),
    service = new ArchivedRecoverySets(config, credentials, f.clients);
  try {
    const prepared = await service.prepare(f.input),
      before = b.writes;
    await assert.rejects(
      service.publishPrepared(prepared.pin, 'missing-version'),
    );
    assert.equal(b.writes, before);
    const staged = await service.stagePrepared(prepared.pin, prepared.artifact);
    const writes = b.writes;
    await assert.rejects(
      service.stagePrepared(prepared.pin, prepared.artifact),
    );
    assert.equal(b.writes, writes + 1);
    const object = b.objects.get(staged.objectKey)!;
    const value = JSON.parse(object.body.toString());
    value.manifest.preparedAt = '2026-10-16T00:00:00.000Z';
    object.body = Buffer.from(JSON.stringify(value));
    object.checksum = hash(object.body).toString('base64');
    const forgedPin = {
      ...prepared.pin,
      sha256: hash(object.body).toString('hex'),
    };
    await assert.rejects(service.publishPrepared(forgedPin, staged.versionId));
    assert.equal(b.writes, writes + 1);
    assert.ok(![...b.objects.keys()].some((key) => key.endsWith('/root.json')));
  } finally {
    f.clients.s3.destroy();
    f.clients.kms.destroy();
    b.close();
  }
});
test('manifest transport refuses bad version/checksum/encryption/length and noncanonical index writes', async () => {
  const b = backend(),
    f = await fixture(b),
    storage = {
      installationId: config.installationId,
      bucket: config.bucket,
      accountId: config.accountId,
      storageKeyArn: config.storageKeyArn,
    };
  const target = {
    installationId: config.installationId,
    setId: f.input.indexScope.setId,
    sourceSha: f.input.indexScope.sourceSha,
    kind: 'DOCUMENT_INDEX_V1' as const,
  };
  try {
    const store = new S3BackupManifests(storage, credentials, f.clients.s3);
    for (const fault of [
      { 'x-amz-version-id': 'null' },
      { 'x-amz-checksum-type': 'COMPOSITE' },
      { 'x-amz-server-side-encryption-aws-kms-key-id': arn('6') },
      { 'x-amz-checksum-sha256': 'bad' },
      { 'content-length': '1' },
    ]) {
      Object.assign(b.metadata, fault);
      await assert.rejects(store.observe(target, f.input.index.sha256));
      for (const key of Object.keys(b.metadata)) delete b.metadata[key];
    }
    const staged = b.objects.get(
        `business-data/fixture/${target.setId}/index.json`,
      )!,
      body = staged.body.toString() + '\n',
      writes = b.writes;
    await assert.rejects(
      store.publish(target, { body, sha256: hash(body).toString('hex') }),
    );
    assert.equal(b.writes, writes);
  } finally {
    f.clients.s3.destroy();
    f.clients.kms.destroy();
    b.close();
  }
});
test('root/index signing domains and four independent key identities cannot be confused', async () => {
  const b = backend(),
    kms = b.kms();
  try {
    assert.throws(
      () =>
        new ArchivedRecoverySets(
          { ...config, rootMacKeyArn: config.indexMacKeyArn },
          credentials,
        ),
    );
    const mac = new KmsBackupManifestMac(
      config.rootMacKeyArn,
      'ARCHIVED_RECOVERY_SET_V1',
      credentials,
      kms,
    );
    await assert.rejects(
      mac.generate(
        config.rootMacKeyArn,
        Buffer.from('CHARITYPILOT_DOCUMENT_BACKUP_INDEX_V1\n' + 'a'.repeat(64)),
      ),
    );
    await assert.rejects(
      mac.generate(
        config.rootMacKeyArn,
        Buffer.from(
          'CHARITYPILOT_ARCHIVED_RECOVERY_SET_V1\n' + 'a'.repeat(64) + '\n',
        ),
      ),
    );
    assert.throws(
      () =>
        new KmsBackupManifestMac(
          config.rootMacKeyArn + '\n',
          'ARCHIVED_RECOVERY_SET_V1',
          credentials,
          kms,
        ),
    );
    assert.throws(
      () =>
        new ArchivedRecoverySets(
          { ...config, installationId: config.installationId + '\n' },
          credentials,
        ),
    );
    assert.throws(
      () =>
        new KmsBackupManifestMac(
          config.rootMacKeyArn,
          '.*' as never,
          credentials,
          kms,
        ),
    );
  } finally {
    kms.destroy();
    b.close();
  }
});
test('a cancelled set verification performs no storage read or write', async () => {
  const b = backend(),
    f = await fixture(b),
    service = new ArchivedRecoverySets(config, credentials, f.clients);
  try {
    const prepared = await service.prepare(f.input),
      reads = b.reads,
      writes = b.writes,
      controller = new AbortController();
    controller.abort();
    await assert.rejects(
      service.verifySet(prepared.pin, undefined, controller.signal),
    );
    assert.equal(b.reads, reads);
    assert.equal(b.writes, writes);
  } finally {
    f.clients.s3.destroy();
    f.clients.kms.destroy();
    b.close();
  }
});
test('metadata timeout destroys a late provider body even when transport ignores cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sdk = new S3Client({ region: 'eu-west-1', credentials });
  let finish!: (value: { Body: Readable }) => void;
  const delayed = new Promise<{ Body: Readable }>((resolve) => {
    finish = resolve;
  });
  sdk.send = (() => delayed) as typeof sdk.send;
  const storage = {
    installationId: config.installationId,
    bucket: config.bucket,
    accountId: config.accountId,
    storageKeyArn: config.storageKeyArn,
  };
  try {
    const pending = assert.rejects(
      new S3BackupManifests(storage, credentials, sdk).observe(
        {
          installationId: config.installationId,
          setId: '11111111-1111-4111-8111-111111111111',
          sourceSha: 'a'.repeat(40),
          kind: 'ARCHIVED_SET_V1',
        },
        'b'.repeat(64),
      ),
    );
    t.mock.timers.tick(60000);
    await pending;
    const body = new Readable({
      read() {},
      destroy(_error, callback) {
        callback(new Error('synthetic late metadata body fault'));
      },
    });
    finish({ Body: body });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(body.destroyed);
  } finally {
    sdk.destroy();
  }
});

test('V2 root authenticates completed imported interval and fresh read-only reconciliation preserves it',async()=>{
 const interval=snapshotIntervalFixture(),b=backend(),f=await fixture(b,false,'MATCH',interval),fresh={s3:b.s3(),kms:b.kms()};
 try{
  const first=new ArchivedRecoverySets(config,credentials,f.clients),bad=structuredClone(interval);
  bad.databaseSnapshot.snapshotBindingSha256='3'.repeat(64);const writes=b.writes;
  await assert.rejects(first.prepareImported(f.input,bad));assert.equal(b.writes,writes);
  const prepared=await first.prepareImported(f.input,interval);
  assert.equal(JSON.parse(prepared.artifact.body).manifest.format,2);
  const downgrade=JSON.parse(prepared.artifact.body);downgrade.manifest.format=1;downgrade.manifest.kind='ARCHIVED_RECOVERY_SET_V1';delete downgrade.manifest.snapshotInterval;
  const downgradeBody=JSON.stringify(downgrade),downgradeSha=hash(downgradeBody).toString('hex'),beforeStage=b.writes;
  await assert.rejects(first.stagePrepared({...prepared.pin,sha256:downgradeSha},{body:downgradeBody,sha256:downgradeSha}));assert.equal(b.writes,beforeStage);
  const staged=await first.stagePrepared(prepared.pin,prepared.artifact);b.loseRoot=true;
  await assert.rejects(first.publishPrepared(prepared.pin,staged.versionId));const after=b.writes,generates=b.generates;
  const observed=await new ArchivedRecoverySets(config,credentials,fresh).verifySet(prepared.pin);
  assert.equal(observed.completedIntervalBindingVerified,true);assert.equal(observed.actionAuthorized,false);
  assert.deepEqual(observed.snapshotInterval,interval);assert.equal(b.writes,after);assert.equal(b.generates,generates);
 }finally{f.clients.s3.destroy();f.clients.kms.destroy();fresh.s3.destroy();fresh.kms.destroy();b.close();}
});
