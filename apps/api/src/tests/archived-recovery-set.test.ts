import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import { KMSClient } from '@aws-sdk/client-kms';
import { ArchivedRecoverySets } from '../services/archived-recovery-set.js';
import { KmsBackupManifestMac } from '../services/backup-manifest-kms.js';
import { S3BackupManifests } from '../services/backup-manifests-s3.js';
import { S3DatabaseByteBackups } from '../services/database-byte-backup-s3.js';
import { S3DocumentByteBackups } from '../services/document-byte-backup-s3.js';
import { KmsDatabaseBackupKeys } from '../services/database-byte-backup-kms.js';
import { KmsDocumentBackupKeys } from '../services/document-byte-backup-kms.js';
import { KmsDocumentBackupIndexMac } from '../services/document-backup-index-kms.js';
import { sealDatabaseByteBackup } from '../services/database-byte-backup.js';
import { sealDocumentByteBackup } from '../services/document-byte-backup.js';
import { sealDocumentBackupIndex } from '../services/document-backup-index.js';
import { canonicalMetadataBindingSha256 } from '../../../../packages/shared/runtime/document-recovery-inventory.mjs';

type Request = {
  hostname: string;
  protocol: string;
  headers: Record<string, string>;
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
};
const hash = (value: Buffer | string) =>
  createHash('sha256').update(value).digest();
const arn = (n: string) =>
  `arn:aws:kms:eu-west-1:123456789012:key/${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const config = {
  installationId: 'fixture',
  bucket: 'synthetic-recovery-sets',
  accountId: '123456789012',
  dataKeyArn: arn('2'),
  storageKeyArn: arn('3'),
  indexMacKeyArn: arn('4'),
  rootMacKeyArn: arn('5'),
};
const credentials = { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' };
const source = (body: Buffer) =>
  Readable.from(
    (function* () {
      for (let i = 0; i < body.length; i += 65536)
        yield body.subarray(i, i + 65536);
    })(),
  );
function sink() {
  const chunks: Buffer[] = [];
  return {
    chunks,
    stream: new Writable({
      write(chunk, _encoding, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    }),
  };
}
function backend() {
  const objects = new Map<
    string,
    {
      body: Buffer;
      version: string;
      checksum: string;
      type: string;
      contentType: string;
    }
  >();
  const parts = new Map<string, { body: Buffer; checksum: string }[]>(),
    secrets = new Map<string, Buffer>();
  let writes = 0,
    reads = 0,
    generates = 0,
    sequence = 0,
    loseRoot = false,
    losePrepared = false;
  let onRootVerify = () => {};
  const metadata: Record<string, string> = {};
  const encryption = {
    'x-amz-server-side-encryption': 'aws:kms',
    'x-amz-server-side-encryption-aws-kms-key-id': config.storageKeyArn,
  };
  const reply = (
    body: string,
    headers: Record<string, string> = {},
    statusCode = 200,
  ) => ({
    response: {
      statusCode,
      headers: { 'content-type': 'application/xml', ...headers },
      body: Readable.from([body]),
    },
  });
  const body = (request: Request) =>
    typeof request.body === 'string'
      ? Buffer.from(request.body)
      : Buffer.from(request.body as Uint8Array);
  const s3 = () =>
    new S3Client({
      region: 'eu-west-1',
      endpoint: 'https://s3.eu-west-1.amazonaws.com',
      credentials,
      maxAttempts: 1,
      requestHandler: {
        async handle(request: Request) {
          assert.match(request.headers.authorization, /AWS4-HMAC-SHA256/);
          assert.equal(request.protocol, 'https:');
          assert.equal(
            request.headers['x-amz-expected-bucket-owner'],
            config.accountId,
          );
          const key = request.path.slice(1);
          if (request.method === 'POST' && 'uploads' in request.query) {
            writes++;
            const id = 'upload-' + ++sequence;
            parts.set(id, []);
            return reply(
              `<InitiateMultipartUploadResult><Bucket>${config.bucket}</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
              encryption,
            );
          }
          if (request.method === 'PUT' && request.query.uploadId) {
            writes++;
            const bytes = body(request),
              checksum = hash(bytes).toString('base64');
            assert.equal(request.headers['x-amz-checksum-sha256'], checksum);
            parts.get(request.query.uploadId)!.push({ body: bytes, checksum });
            return reply('', {
              ...encryption,
              etag: '"part"',
              'x-amz-checksum-sha256': checksum,
            });
          }
          if (request.method === 'PUT' || request.method === 'POST') {
            writes++;
            assert.equal(request.headers['if-none-match'], '*');
            if (objects.has(key))
              return reply(
                '<Error><Code>PreconditionFailed</Code></Error>',
                {},
                412,
              );
            const uploaded = request.query.uploadId
              ? parts.get(request.query.uploadId)!
              : undefined;
            const bytes = uploaded
              ? Buffer.concat(uploaded.map((p) => p.body))
              : body(request);
            const checksum = uploaded
              ? hash(
                  Buffer.concat(
                    uploaded.map((p) => Buffer.from(p.checksum, 'base64')),
                  ),
                ).toString('base64') +
                '-' +
                uploaded.length
              : hash(bytes).toString('base64');
            assert.equal(request.headers['x-amz-checksum-sha256'], checksum);
            const version = 'version-' + ++sequence,
              type = uploaded ? 'COMPOSITE' : 'FULL_OBJECT';
            objects.set(key, {
              body: bytes,
              checksum,
              type,
              version,
              contentType: uploaded
                ? 'application/octet-stream'
                : 'application/json',
            });
            if (loseRoot && key.endsWith('/root.json'))
              throw new Error('synthetic lost root ACK');
            if (losePrepared && key.endsWith('/prepared-root.json'))
              throw new Error('synthetic lost prepared ACK');
            return reply(
              uploaded
                ? `<CompleteMultipartUploadResult><Bucket>${config.bucket}</Bucket><Key>${key}</Key><ETag>"complete"</ETag><ChecksumType>${type}</ChecksumType><ChecksumSHA256>${checksum}</ChecksumSHA256></CompleteMultipartUploadResult>`
                : '',
              {
                ...encryption,
                'x-amz-version-id': version,
                'x-amz-checksum-sha256': checksum,
                'x-amz-checksum-type': type,
              },
            );
          }
          assert.equal(request.method, 'GET');
          reads++;
          const value = objects.get(key);
          assert.ok(value, 'missing staged fixture object');
          if (request.query.versionId)
            assert.equal(request.query.versionId, value.version);
          return {
            response: {
              statusCode: 200,
              headers: {
                ...encryption,
                'x-amz-version-id': value.version,
                'x-amz-checksum-sha256': value.checksum,
                'x-amz-checksum-type': value.type,
                'content-type': value.contentType,
                'content-length': String(value.body.length),
                ...metadata,
              },
              body: source(value.body),
            },
          };
        },
      },
    });
  const kms = () =>
    new KMSClient({
      region: 'eu-west-1',
      endpoint: 'https://kms.eu-west-1.amazonaws.com',
      credentials,
      maxAttempts: 1,
      requestHandler: {
        async handle(request: Request) {
          assert.equal(request.hostname, 'kms.eu-west-1.amazonaws.com');
          assert.match(request.headers.authorization, /AWS4-HMAC-SHA256/);
          const input = JSON.parse(body(request).toString()),
            method = request.headers['x-amz-target'];
          let result;
          if (method.endsWith('.GenerateDataKey')) {
            generates++;
            const wrapped = Buffer.from('wrapped-' + generates).toString(
                'base64',
              ),
              key = randomBytes(32);
            secrets.set(wrapped, key);
            result = {
              KeyId: input.KeyId,
              Plaintext: key.toString('base64'),
              CiphertextBlob: wrapped,
            };
          } else if (method.endsWith('.Decrypt')) {
            result = {
              KeyId: input.KeyId,
              Plaintext: secrets.get(input.CiphertextBlob)!.toString('base64'),
              EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
            };
          } else {
            assert.equal(input.MacAlgorithm, 'HMAC_SHA_256');
            assert.match(
              Buffer.from(input.Message, 'base64').toString(),
              input.KeyId === config.rootMacKeyArn
                ? /^CHARITYPILOT_ARCHIVED_RECOVERY_SET_V1\n/
                : /^CHARITYPILOT_DOCUMENT_BACKUP_INDEX_V1\n/,
            );
            if (
              input.KeyId === config.rootMacKeyArn &&
              method.endsWith('.VerifyMac')
            )
              onRootVerify();
            const secret = secrets.get(input.KeyId) ?? randomBytes(32);
            secrets.set(input.KeyId, secret);
            const mac = createHmac('sha256', secret)
              .update(Buffer.from(input.Message, 'base64'))
              .digest('base64');
            result = method.endsWith('.GenerateMac')
              ? { KeyId: input.KeyId, MacAlgorithm: 'HMAC_SHA_256', Mac: mac }
              : {
                  KeyId: input.KeyId,
                  MacAlgorithm: 'HMAC_SHA_256',
                  MacValid: input.Mac === mac,
                };
          }
          return reply(JSON.stringify(result), {
            'content-type': 'application/x-amz-json-1.1',
          });
        },
      },
    });
  return {
    s3,
    kms,
    objects,
    metadata,
    set rootVerify(callback: () => void) {
      onRootVerify = callback;
    },
    get reads() {
      return reads;
    },
    get writes() {
      return writes;
    },
    get generates() {
      return generates;
    },
    set loseRoot(value: boolean) {
      loseRoot = value;
    },
    set losePrepared(value: boolean) {
      losePrepared = value;
    },
    close() {
      for (const key of secrets.values()) key.fill(0);
    },
  };
}
async function fixture(b: ReturnType<typeof backend>, badCount = false) {
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
    restoreTarget: {
      type: 'isolated-disposable-postgresql',
      cleanupVerified: true,
      productionOverwritten: false,
      networkPublished: false,
      hostVolumeForDatabase: false,
    },
  };
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
  const row = {
    id: 'document',
    organisationId: 'tenant',
    fileUrl: 'private/document',
    fileSize: doc.length,
    mimeType: 'text/plain',
  };
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
  const docSealed = await sealDocumentByteBackup(
    docContext,
    doc,
    new KmsDocumentBackupKeys(config.dataKeyArn, credentials, kms),
  );
  const docStored = await new S3DocumentByteBackups(
    dataStorage,
    credentials,
    s3,
  ).publish(docContext, docSealed);
  const indexScope = {
    installationId: config.installationId,
    setId,
    sourceSha,
    databaseSha256: dbSha,
    sourceCaptureReportSha256: reportSha,
    databaseIdentitySha256,
    objectStoreIdentitySha256: 'c'.repeat(64),
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
      objectRows: [
        {
          fileUrl: row.fileUrl,
          bytes: doc.length,
          sha256: docContext.bytesSha256,
        },
      ],
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
