import {managedSnapshotInterval,managedSnapshotIntervalSchema,assertImportedSnapshotInterval,type ManagedSnapshotInterval} from './managed-snapshot-interval.js';
import { createHash } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { z } from 'zod';
import { type S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { type KMSClient } from '@aws-sdk/client-kms';
import {
  DOCUMENT_BACKUP_KEY_ARN,
  openDocumentByteBackup,
} from './document-byte-backup.js';
import {
  databaseBackupContext,
  databaseBackupArchiveBounds,
  openDatabaseByteBackupToQuarantine,
} from './database-byte-backup.js';
import {
  documentBackupIndexScope,
  openDocumentBackupIndex,
  type DocumentBackupIndex,
} from './document-backup-index.js';
import { KmsDocumentBackupIndexMac } from './document-backup-index-kms.js';
import { canonicalDocumentMetadataRowsSha256 } from '../../../../packages/shared/runtime/document-recovery-inventory.mjs';
import { KmsBackupManifestMac } from './backup-manifest-kms.js';
import { KmsDatabaseBackupKeys } from './database-byte-backup-kms.js';
import { KmsDocumentBackupKeys } from './document-byte-backup-kms.js';
import {
  S3DatabaseByteBackups,
  DATABASE_BACKUP_S3_PART_BYTES,
} from './database-byte-backup-s3.js';
import { S3DocumentByteBackups } from './document-byte-backup-s3.js';
import {
  S3BackupManifests,
  type BackupManifestTarget,
} from './backup-manifests-s3.js';

const refused = () => new Error('Archived recovery set unavailable');
const id = z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,120}$/)
    .refine((v) => v === v.trim()),
  sha = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .length(64);
const version = z
  .string()
  .regex(/^[\x21-\x7e]{1,1024}$/)
  .refine((v) => v !== 'null' && v === v.trim());
const storageSchema = z
  .object({
    bucket: z
      .string()
      .min(3)
      .max(63)
      .regex(/^[a-z0-9][a-z0-9-]+[a-z0-9]$/)
      .refine((v) => v === v.trim()),
    accountId: z.string().regex(/^[0-9]{12}$/),
    storageKeyArn: DOCUMENT_BACKUP_KEY_ARN,
  })
  .strict();
const configuration = storageSchema
  .extend({
    installationId: id,
    dataKeyArn: DOCUMENT_BACKUP_KEY_ARN,
    indexMacKeyArn: DOCUMENT_BACKUP_KEY_ARN,
    rootMacKeyArn: DOCUMENT_BACKUP_KEY_ARN,
  })
  .strict()
  .refine((c) => {
    const keys = [
      c.storageKeyArn,
      c.dataKeyArn,
      c.indexMacKeyArn,
      c.rootMacKeyArn,
    ];
    return (
      new Set(keys).size === 4 &&
      keys.every((k) => k.split(':')[4] === c.accountId)
    );
  });
type Configuration = z.infer<typeof configuration>;
const scopeSchema = z
  .object({
    index: z.unknown().transform(documentBackupIndexScope),
    database: z.unknown().transform(databaseBackupContext),
    storage: storageSchema,
    rootMacKeyArn: DOCUMENT_BACKUP_KEY_ARN,
  })
  .strict()
  .refine((s) => {
    const a = s.index,
      b = s.database,
      keys = [
        a.dataKeyArn,
        a.macKeyArn,
        s.storage.storageKeyArn,
        s.rootMacKeyArn,
      ];
    return (
      a.installationId === b.installationId &&
      a.setId === b.setId &&
      a.sourceSha === b.sourceSha &&
      a.databaseSha256 === b.databaseSha256 &&
      a.databaseIdentitySha256 === b.databaseIdentitySha256 &&
      a.sourceCaptureReportSha256 === b.sourceCaptureReportSha256 &&
      a.dataKeyArn === b.keyArn &&
      new Set(keys).size === 4 &&
      keys.every((k) => k.split(':')[4] === s.storage.accountId)
    );
  });
export type ArchivedRecoveryScope = z.infer<typeof scopeSchema>;
const artifactSchema = z
  .object({
    sha256: sha,
    byteLength: z.number().int().positive(),
    databaseSha256: sha,
  })
  .strict();
const referenceSchema = z
  .object({
    sha256: sha,
    byteLength: z.number().int().positive(),
    objectKey: z.string().max(1024),
    versionId: version,
  })
  .strict();
const databaseSchema = z
  .object({
    kind: z.literal('EXACT_VERSION_READBACK'),
    storageFormat: z.literal('S3_DATABASE_ARCHIVE_V1'),
    partBytes: z.literal(DATABASE_BACKUP_S3_PART_BYTES),
    artifact: artifactSchema,
    objectKey: z.string().max(1024),
    versionId: version,
    compositeChecksumSha256: z.string().max(64),
  })
  .strict();
const legacyManifestSchema = z
  .object({
    format: z.literal(1),
    kind: z.literal('ARCHIVED_RECOVERY_SET_V1'),
    restoreMode: z.literal('QUARANTINE_ONLY'),
    captureConsistency: z.literal('EXTERNAL_VERIFICATION_REQUIRED'),
    scope: scopeSchema,
    preparedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      .refine(
        (v) =>
          Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v,
      ),
    sourceReport: referenceSchema,
    index: referenceSchema,
    database: databaseSchema,
    documentCount: z.number().int().min(0).max(5000),
    objectCount: z.number().int().min(0).max(5000),
    metadataInventorySha256: sha,
    objectInventorySha256: sha,
  })
  .strict();
const pinSchema = z.object({ scope: scopeSchema, sha256: sha }).strict();
const manifestSchema=z.discriminatedUnion('format',[legacyManifestSchema,legacyManifestSchema.extend({format:z.literal(2),kind:z.literal('ARCHIVED_RECOVERY_SET_V2'),snapshotInterval:managedSnapshotIntervalSchema})]);
type Manifest = z.infer<typeof manifestSchema>;
const hash = (body: string) => createHash('sha256').update(body).digest('hex');
const message = (m: Manifest) =>
  Buffer.from(
    `CHARITYPILOT_ARCHIVED_RECOVERY_SET_V${m.format}\n` + hash(JSON.stringify(m)),
  );
function target(
  scope: ArchivedRecoveryScope,
  kind: BackupManifestTarget['kind'],
): BackupManifestTarget {
  return {
    installationId: scope.index.installationId,
    setId: scope.index.setId,
    sourceSha: scope.index.sourceSha,
    kind,
  };
}
function base(scope: ArchivedRecoveryScope) {
  return `business-data/${scope.index.installationId}/${scope.index.setId}/`;
}
function validManifest(raw: unknown) {
  const m = manifestSchema.parse(raw),
    s = m.scope,
    bounds = databaseBackupArchiveBounds(s.database);
  if (
    m.sourceReport.sha256 !== s.index.sourceCaptureReportSha256 ||
    m.sourceReport.objectKey !== base(s) + 'source-report.json' ||
    m.index.objectKey !== base(s) + 'index.json' ||
    m.database.objectKey !==
      base(s) + 'database/' + s.database.databaseIdentitySha256 + '.bin' ||
    m.database.artifact.databaseSha256 !== s.database.databaseSha256 ||
    m.database.artifact.byteLength < bounds.minimumBytes ||
    m.database.artifact.byteLength > bounds.maximumBytes ||
    m.sourceReport.byteLength > 32 * 1024 * 1024 ||
    m.index.byteLength > 16 * 1024 * 1024 ||
    !new RegExp(
      '^[A-Za-z0-9+/]{43}=-' +
        Math.ceil(
          m.database.artifact.byteLength / DATABASE_BACKUP_S3_PART_BYTES,
        ) +
        '$',
    ).test(m.database.compositeChecksumSha256)
  )
    throw refused();
  if(m.format===2)managedSnapshotInterval(m.snapshotInterval);
  return m;
}
/** Archives only. Source consistency/provenance and independently current policy
 * remain external gates. No latest pointer, live restore, disposal or reopening. */
export class ArchivedRecoverySets {
  private readonly config: Configuration;
  private readonly metadata: S3BackupManifests;
  private readonly databases: S3DatabaseByteBackups;
  private readonly documents: S3DocumentByteBackups;
  private readonly dbKeys: KmsDatabaseBackupKeys;
  private readonly docKeys: KmsDocumentBackupKeys;
  private readonly indexMac: KmsDocumentBackupIndexMac;
  private readonly rootMac: KmsBackupManifestMac;
  private readonly rootMacV2: KmsBackupManifestMac;
  constructor(
    config: Configuration,
    credentials: NonNullable<S3ClientConfig['credentials']>,
    clients: { s3?: S3Client; kms?: KMSClient } = {},
  ) {
    this.config = configuration.parse(config);
    const c = this.config;
    const storage = {
      installationId: c.installationId,
      bucket: c.bucket,
      accountId: c.accountId,
      storageKeyArn: c.storageKeyArn,
    };
    this.metadata = new S3BackupManifests(storage, credentials, clients.s3);
    this.databases = new S3DatabaseByteBackups(
      { ...storage, dataKeyArn: c.dataKeyArn },
      credentials,
      clients.s3,
    );
    this.documents = new S3DocumentByteBackups(
      { ...storage, dataKeyArn: c.dataKeyArn },
      credentials,
      clients.s3,
    );
    this.dbKeys = new KmsDatabaseBackupKeys(
      c.dataKeyArn,
      credentials,
      clients.kms,
    );
    this.docKeys = new KmsDocumentBackupKeys(
      c.dataKeyArn,
      credentials,
      clients.kms,
    );
    this.indexMac = new KmsDocumentBackupIndexMac(
      c.indexMacKeyArn,
      credentials,
      clients.kms,
    );
    this.rootMac = new KmsBackupManifestMac(
      c.rootMacKeyArn,
      'ARCHIVED_RECOVERY_SET_V1',
      credentials,
      clients.kms,
    );
    this.rootMacV2=new KmsBackupManifestMac(c.rootMacKeyArn,'ARCHIVED_RECOVERY_SET_V2',credentials,clients.kms);
  }
  private scope(raw: unknown) {
    const s = scopeSchema.parse(raw),
      c = this.config;
    if (
      s.index.installationId !== c.installationId ||
      s.index.dataKeyArn !== c.dataKeyArn ||
      s.index.macKeyArn !== c.indexMacKeyArn ||
      s.rootMacKeyArn !== c.rootMacKeyArn ||
      s.storage.bucket !== c.bucket ||
      s.storage.accountId !== c.accountId ||
      s.storage.storageKeyArn !== c.storageKeyArn
    )
      throw refused();
    return s;
  }
  private async work<T>(
    run: (signal: AbortSignal) => Promise<T>,
    caller?: AbortSignal,
  ) {
    const controller = new AbortController(),
      signal = caller
        ? AbortSignal.any([caller, controller.signal])
        : controller.signal;
    const timeout = setTimeout(() => controller.abort(), 60 * 60 * 1000);
    try {
      if (signal.aborted) throw refused();
      const result = await run(signal);
      if (signal.aborted) throw refused();
      return result;
    } catch {
      throw refused();
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }
  private report(
    scope: ArchivedRecoveryScope,
    body: string,
    index: DocumentBackupIndex,
  ) {
    if (
      Buffer.byteLength(body) > 32 * 1024 * 1024 ||
      hash(body) !== scope.index.sourceCaptureReportSha256
    )
      throw refused();
    const r = JSON.parse(body),
      b = scope.database;
    const tables = r.source?.tables;
    if (!Array.isArray(tables) || tables.length > 5000) throw refused();
    const rows = tables.filter(
      (t) => t?.schema === 'public' && t?.table === 'Document',
    );
    if (
      r.format !== 'charitypilot-postgres-restore-proof/v2' ||
      r.ok !== true ||
      r.sourceReadOnlyVerified !== true ||
      r.sourceIdentityBindingMatched !== true ||
      r.sourceDatabaseIdentitySha256 !== b.databaseIdentitySha256 ||
      r.expectedSourceDatabaseIdentitySha256 !== b.databaseIdentitySha256 ||
      r.helperImplementation?.commitSha !== b.sourceSha ||
      r.helperImplementation?.sourceMatchesCommit !== true ||
      r.helperImplementation?.canonicalRepositoryMatched !== true ||
      r.helperImplementation?.format !==
        'charitypilot-postgres-proof-helper/v1' ||
      r.helperImplementation?.repositoryUrl !==
        'https://github.com/jasperfordesq-ai/charity-governance' ||
      r.helperImplementation?.sourcePath !== 'scripts/postgres-backup.mjs' ||
      !sha.safeParse(r.helperImplementation?.sourceSha256).success ||
      r.helperImplementation?.commitSourceSha256 !==
        r.helperImplementation?.sourceSha256 ||
      r.checksumAlgorithm !== 'sha256' ||
      r.dump?.sha256 !== b.databaseSha256 ||
      r.dump?.bytes !== String(b.byteLength) ||
      r.dump?.rehashAfterRestoreSha256 !== b.databaseSha256 ||
      r.dump?.bytesAfterRestore !== String(b.byteLength) ||
      r.dump?.unchangedDuringProof !== true ||
      r.dump?.capacityPreflight?.verified !== true ||
      r.snapshot?.isolationLevel !== 'repeatable read' ||
      r.snapshot?.readOnly !== true ||
      r.snapshot?.rowSecurityOff !== true ||
      r.snapshot?.accessShareLocks !== true ||
      r.snapshot?.exported !== true ||
      r.comparison?.schemaMatched !== true ||
      r.comparison?.rowCountsMatched !== true ||
      r.comparison?.rowFingerprintsMatched !== true ||
      r.comparison?.mismatchCount !== 0 ||
      r.restoreTarget?.type !== 'isolated-disposable-postgresql' ||
      r.restoreTarget?.cleanupVerified !== true ||
      r.restoreTarget?.productionOverwritten !== false ||
      r.restoreTarget?.networkPublished !== false ||
      r.restoreTarget?.hostVolumeForDatabase !== false ||
      rows.length !== 1 ||
      rows[0].relationKind !== 'r' ||
      rows[0].isPartition !== false ||
      rows[0].rowCount !== String(index.entries.length) ||
      r.source?.documentMetadata?.format !==
        'charitypilot-document-metadata-rows/v1' ||
      r.source?.documentMetadata?.rowCount !== index.metadata.length ||
      r.source?.documentMetadata?.rowsSha256 !==
        canonicalDocumentMetadataRowsSha256(index.metadata) ||
      JSON.stringify(r.restored?.documentMetadata) !==
        JSON.stringify(r.source.documentMetadata)
    )
      throw refused();
  }
  private async database(
    scope: ArchivedRecoveryScope,
    artifact: z.infer<typeof artifactSchema>,
    versionId: string,
    caller: AbortSignal,
  ) {
    const controller = new AbortController(),
      signal = AbortSignal.any([caller, controller.signal]);
    const encoded = new PassThrough({ highWaterMark: 65536 }),
      discard = new Writable({
        write(bytes: Buffer, _encoding, callback) {
          bytes.fill(0);
          callback();
        },
      });
    const watch = <T>(promise: Promise<T>) =>
      promise.catch((error) => {
        controller.abort();
        throw error;
      });
    try {
      const decoding = watch(
        openDatabaseByteBackupToQuarantine(
          scope.database,
          encoded,
          discard,
          artifact.sha256,
          this.dbKeys,
          signal,
        ),
      );
      const reading = watch(
        this.databases.observe(
          scope.database,
          artifact,
          encoded,
          versionId,
          signal,
        ),
      );
      const results = await Promise.allSettled([decoding, reading]);
      if (
        results[0].status !== 'fulfilled' ||
        results[1].status !== 'fulfilled'
      )
        throw refused();
      return results[1].value;
    } finally {
      controller.abort();
      encoded.destroy();
      discard.destroy();
    }
  }
  private async documentBytes(index: DocumentBackupIndex, signal: AbortSignal) {
    for (const e of index.entries) {
      if (signal.aborted) throw refused();
      const observed = await this.documents.observe(
        e.context,
        e.archive.sha256,
        e.archive.versionId,
        signal,
      );
      if (signal.aborted || observed.objectKey !== e.archive.objectKey)
        throw refused();
      const bytes = await openDocumentByteBackup(
        e.context,
        observed.body,
        e.archive.sha256,
        this.docKeys,
      );
      bytes.fill(0);
      if (signal.aborted) throw refused();
    }
  }
  private async envelope(pinRaw: unknown, body: string) {
    const pin = pinSchema.parse(pinRaw);
    this.scope(pin.scope);
    if (
      typeof body !== 'string' ||
      Buffer.byteLength(body) > 1024 * 1024 ||
      hash(body) !== pin.sha256
    )
      throw refused();
    const parsed = z
      .object({ manifest: manifestSchema, mac: z.string().length(44) })
      .strict()
      .parse(JSON.parse(body));
    const manifest = validManifest(parsed.manifest),
      tag = Buffer.from(parsed.mac, 'base64');
    if (
      tag.length !== 32 ||
      tag.toString('base64') !== parsed.mac ||
      JSON.stringify(manifest.scope) !== JSON.stringify(pin.scope) ||
      JSON.stringify({ manifest, mac: parsed.mac }) !== body
    )
      throw refused();
    const checked = await (manifest.format===2?this.rootMacV2:this.rootMac).verify(
      manifest.scope.rootMacKeyArn,
      message(manifest),
      tag,
    );
    if (!checked.valid || checked.keyArn !== manifest.scope.rootMacKeyArn)
      throw refused();
    return { pin, manifest };
  }
  async prepare(raw: unknown, caller?: AbortSignal) {return this.prepareInternal(raw,undefined,caller);}
  async prepareImported(raw:unknown,interval:unknown,caller?:AbortSignal){
    return this.prepareInternal(raw,managedSnapshotInterval(interval),caller);
  }
  private async prepareInternal(raw:unknown,interval:ManagedSnapshotInterval|undefined,caller?:AbortSignal){
    return this.work(async (signal) => {
      const value = z
        .object({
          indexScope: z.unknown().transform(documentBackupIndexScope),
          databaseContext: z.unknown().transform(databaseBackupContext),
          database: z
            .object({ artifact: artifactSchema, versionId: version })
            .strict(),
          index: z.object({ sha256: sha, versionId: version }).strict(),
          sourceReport: z.object({ sha256: sha, versionId: version }).strict(),
        })
        .strict()
        .parse(raw);
      const c = this.config,
        scope = this.scope({
          index: value.indexScope,
          database: value.databaseContext,
          storage: {
            bucket: c.bucket,
            accountId: c.accountId,
            storageKeyArn: c.storageKeyArn,
          },
          rootMacKeyArn: c.rootMacKeyArn,
        });
      if (value.sourceReport.sha256 !== scope.index.sourceCaptureReportSha256)
        throw refused();
      const sourceReport = await this.metadata.observe(
        target(scope, 'SOURCE_REPORT_V2'),
        value.sourceReport.sha256,
        value.sourceReport.versionId,
        signal,
      );
      const storedIndex = await this.metadata.observe(
        target(scope, 'DOCUMENT_INDEX_V1'),
        value.index.sha256,
        value.index.versionId,
        signal,
      );
      const index = await openDocumentBackupIndex(
        scope.index,
        storedIndex.artifact.body,
        value.index.sha256,
        this.indexMac,
      );
      this.report(scope, sourceReport.artifact.body, index);
      if(interval)assertImportedSnapshotInterval(interval,sourceReport.artifact.body);
      const database = await this.database(
        scope,
        value.database.artifact,
        value.database.versionId,
        signal,
      );
      await this.documentBytes(index, signal);
      const reference = (v: typeof storedIndex) => ({
        sha256: v.artifact.sha256,
        byteLength: v.artifact.byteLength,
        objectKey: v.objectKey,
        versionId: v.versionId,
      });
      const manifest = validManifest({
        ...(interval?{format:2,kind:'ARCHIVED_RECOVERY_SET_V2',snapshotInterval:interval}:{format:1,kind:'ARCHIVED_RECOVERY_SET_V1'}),
        restoreMode: 'QUARANTINE_ONLY',
        captureConsistency: 'EXTERNAL_VERIFICATION_REQUIRED',
        scope,
        preparedAt: new Date().toISOString(),
        sourceReport: reference(sourceReport),
        index: reference(storedIndex),
        database: {
          ...database,
          storageFormat: 'S3_DATABASE_ARCHIVE_V1',
          partBytes: DATABASE_BACKUP_S3_PART_BYTES,
        },
        documentCount: index.entries.length,
        objectCount: index.objects.length,
        metadataInventorySha256: index.metadataInventorySha256,
        objectInventorySha256: index.objectInventorySha256,
      });
      const signed = await (manifest.format===2?this.rootMacV2:this.rootMac).generate(
        scope.rootMacKeyArn,
        message(manifest),
      );
      if (signed.keyArn !== scope.rootMacKeyArn || signed.mac.length !== 32)
        throw refused();
      const body = JSON.stringify({
          manifest,
          mac: signed.mac.toString('base64'),
        }),
        digest = hash(body);
      return {
        pin: { scope, sha256: digest },
        artifact: { body, sha256: digest, byteLength: Buffer.byteLength(body) },
      };
    }, caller);
  }
  /** Persist the authenticated root body before any final-root write. An unknown
   * response is reconciled with observePrepared, never an automatic retry.
   * The pin and bootstrap configuration still require independent custody. */
  async stagePrepared(
    pinRaw: unknown,
    artifact: { body: string; sha256: string },
    caller?: AbortSignal,
  ) {
    return this.work(async (signal) => {
      const body = artifact.body,
        expectedSha = artifact.sha256;
      const { pin, manifest } = await this.envelope(pinRaw, body);
      if (expectedSha !== pin.sha256) throw refused();
      const observed = await this.metadata.publish(
        target(manifest.scope, 'PREPARED_SET_V1'),
        { body, sha256: pin.sha256 },
        signal,
      );
      await this.envelope(pin, observed.artifact.body);
      return {
        kind: 'PREPARED_ROOT_READBACK' as const,
        sha256: pin.sha256,
        objectKey: observed.objectKey,
        versionId: observed.versionId,
      };
    }, caller);
  }
  async observePrepared(
    pinRaw: unknown,
    preparedVersion?: string,
    caller?: AbortSignal,
  ) {
    return this.work(async (signal) => {
      const pin = pinSchema.parse(pinRaw),
        scope = this.scope(pin.scope);
      const observed = await this.metadata.observe(
        target(scope, 'PREPARED_SET_V1'),
        pin.sha256,
        preparedVersion,
        signal,
      );
      await this.envelope(pin, observed.artifact.body);
      return {
        kind: 'PREPARED_ROOT_READBACK' as const,
        sha256: pin.sha256,
        objectKey: observed.objectKey,
        versionId: observed.versionId,
      };
    }, caller);
  }
  /** The final write is sourced only from an authenticated, exact-version
   * durable preparation. An unknown final response uses verifySet read-only. */
  async publishPrepared(
    pinRaw: unknown,
    preparedVersion: string,
    caller?: AbortSignal,
  ) {
    return this.work(async (signal) => {
      const pin = pinSchema.parse(pinRaw),
        scope = this.scope(pin.scope);
      const exactVersion = version.parse(preparedVersion);
      const staged = await this.metadata.observe(
        target(scope, 'PREPARED_SET_V1'),
        pin.sha256,
        exactVersion,
        signal,
      );
      await this.envelope(pin, staged.artifact.body);
      const observed = await this.metadata.publish(
        target(scope, 'ARCHIVED_SET_V1'),
        staged.artifact,
        signal,
      );
      await this.envelope(pin, observed.artifact.body);
      return {
        kind: 'ARCHIVED_ROOT_READBACK' as const,
        sha256: pin.sha256,
        objectKey: observed.objectKey,
        versionId: observed.versionId,
      };
    }, caller);
  }
  async verifySet(pinRaw: unknown, rootVersion?: string, caller?: AbortSignal) {
    return this.work(async (signal) => {
      const pin = pinSchema.parse(pinRaw),
        scope = this.scope(pin.scope);
      const root = await this.metadata.observe(
        target(scope, 'ARCHIVED_SET_V1'),
        pin.sha256,
        rootVersion,
        signal,
      );
      const { manifest } = await this.envelope(pin, root.artifact.body);
      const report = await this.metadata.observe(
        target(scope, 'SOURCE_REPORT_V2'),
        manifest.sourceReport.sha256,
        manifest.sourceReport.versionId,
        signal,
      );
      const storedIndex = await this.metadata.observe(
        target(scope, 'DOCUMENT_INDEX_V1'),
        manifest.index.sha256,
        manifest.index.versionId,
        signal,
      );
      if (
        report.artifact.byteLength !== manifest.sourceReport.byteLength ||
        storedIndex.artifact.byteLength !== manifest.index.byteLength
      )
        throw refused();
      const index = await openDocumentBackupIndex(
        scope.index,
        storedIndex.artifact.body,
        manifest.index.sha256,
        this.indexMac,
      );
      this.report(scope, report.artifact.body, index);
      if(manifest.format===2)assertImportedSnapshotInterval(manifest.snapshotInterval,report.artifact.body);
      if (
        index.entries.length !== manifest.documentCount ||
        index.objects.length !== manifest.objectCount ||
        index.metadataInventorySha256 !== manifest.metadataInventorySha256 ||
        index.objectInventorySha256 !== manifest.objectInventorySha256
      )
        throw refused();
      const database = await this.database(
        scope,
        manifest.database.artifact,
        manifest.database.versionId,
        signal,
      );
      if (
        database.objectKey !== manifest.database.objectKey ||
        database.compositeChecksumSha256 !==
          manifest.database.compositeChecksumSha256
      )
        throw refused();
      await this.documentBytes(index, signal);
      return {
        kind: 'ARCHIVED_SET_VERIFIED' as const,
        restoreMode: 'QUARANTINE_ONLY' as const,
        captureConsistency: 'EXTERNAL_VERIFICATION_REQUIRED' as const,
        sha256: pin.sha256,
        rootVersionId: root.versionId,
        documentCount: index.entries.length,
        objectCount: index.objects.length,
        ...(manifest.format===2?{snapshotInterval:manifest.snapshotInterval,completedIntervalBindingVerified:true as const,wholeBackendQuiesced:false as const,actionAuthorized:false as const}:{}),
      };
    }, caller);
  }
}
