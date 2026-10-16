import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  canonicalDocumentIdentitySha256,
  canonicalMetadataBindingSha256,
  canonicalObjectKeySha256,
  canonicalMetadataInventorySha256,
  canonicalObjectInventorySha256,
} from '../../../../packages/shared/runtime/document-recovery-inventory.mjs';
import {
  DOCUMENT_BACKUP_KEY_ARN,
  documentBackupContext,
} from './document-byte-backup.js';
import { DOCUMENT_UPLOAD_MAX_FILE_SIZE } from './document-upload-limits.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
const time = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
  );
const bytes = z.number().int().min(0).max(DOCUMENT_UPLOAD_MAX_FILE_SIZE);
const scopeSchema = z
  .object({
    installationId: id,
    setId: uuid,
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    databaseSha256: sha,
    sourceCaptureReportSha256: sha,
    databaseIdentitySha256: sha,
    objectStoreIdentitySha256: sha,
    dataKeyArn: DOCUMENT_BACKUP_KEY_ARN,
    macKeyArn: DOCUMENT_BACKUP_KEY_ARN,
    metadataCapturedAt: time,
    metadataCaptureTransactionId: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$/)
      .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n),
    objectCapturedAt: time,
  })
  .strict()
  .refine(
    (value) =>
      value.dataKeyArn !== value.macKeyArn &&
      value.dataKeyArn.split(':')[4] === value.macKeyArn.split(':')[4] &&
      Math.abs(
        Date.parse(value.metadataCapturedAt) -
          Date.parse(value.objectCapturedAt),
      ) <=
        60 * 60 * 1000,
  );
export type DocumentBackupIndexScope = z.infer<typeof scopeSchema>;
const version = z
  .string()
  .regex(/^[\x21-\x7e]{1,1024}$/)
  .refine((value) => value !== 'null');
const receiptSchema = z
  .object({
    context: z.unknown().transform((value) => documentBackupContext(value)),
    sha256: sha,
    objectKey: z.string().max(1024),
    versionId: version,
  })
  .strict();
const metadataSchema = z
  .object({
    id,
    organisationId: id,
    fileUrl: z.string().min(1).max(2048),
    fileSize: bytes,
    mimeType: z.string().min(1).max(255),
  })
  .strict();
const objectSchema = z
  .object({ fileUrl: z.string().min(1).max(2048), bytes, sha256: sha })
  .strict();
const metadataEntry = z
  .object({
    documentIdentitySha256: sha,
    metadataBindingSha256: sha,
    objectKeySha256: sha,
    fileSize: bytes,
  })
  .strict();
const objectEntry = z
  .object({ objectKeySha256: sha, bytes, sha256: sha })
  .strict();
const indexSchema = z
  .object({
    format: z.literal(1),
    kind: z.literal('DOCUMENT_BACKUP_INDEX_V1'),
    scope: scopeSchema,
    metadataInventorySha256: sha,
    objectInventorySha256: sha,
    metadata: z.array(metadataEntry).max(5000),
    objects: z.array(objectEntry).max(5000),
    entries: z
      .array(
        z
          .object({
            context: z
              .unknown()
              .transform((value) => documentBackupContext(value)),
            documentIdentitySha256: sha,
            metadataBindingSha256: sha,
            objectKeySha256: sha,
            archive: z
              .object({
                objectKey: z.string().max(1024),
                versionId: version,
                sha256: sha,
              })
              .strict(),
          })
          .strict(),
      )
      .max(5000),
  })
  .strict();
export type DocumentBackupIndex = z.infer<typeof indexSchema>;
export interface DocumentBackupIndexMac {
  generate(
    keyArn: string,
    message: Buffer,
  ): Promise<{ keyArn: string; mac: Buffer }>;
  verify(
    keyArn: string,
    message: Buffer,
    mac: Buffer,
  ): Promise<{ keyArn: string; valid: boolean }>;
}
export const DOCUMENT_BACKUP_INDEX_MAX_BYTES = 16 * 1024 * 1024;
const refused = () => new Error('Document backup index unavailable');
const hash = (body: string) => createHash('sha256').update(body).digest('hex');
const message = (index: DocumentBackupIndex) =>
  Buffer.from(
    'CHARITYPILOT_DOCUMENT_BACKUP_INDEX_V1\n' + hash(JSON.stringify(index)),
  );
const archiveKey = (c: ReturnType<typeof documentBackupContext>) =>
  `business-data/${c.installationId}/${c.setId}/documents/${c.organisationId}/${c.documentId}/${c.sourceBindingSha256}.json`;
const sorted = <T>(rows: T[], key: (row: T) => string) =>
  rows.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
function unique<T>(rows: T[], key: (row: T) => string) {
  const result = new Map(rows.map((row) => [key(row), row]));
  if (result.size !== rows.length) throw refused();
  return result;
}
function validateIndex(raw: unknown): DocumentBackupIndex {
  const index = indexSchema.parse(raw),
    s = index.scope;
  const metadata = unique(index.metadata, (row) => row.documentIdentitySha256);
  const objects = unique(index.objects, (row) => row.objectKeySha256);
  unique(index.entries, (row) => row.documentIdentitySha256);
  unique(index.entries, (row) => row.archive.objectKey);
  if (
    index.entries.length !== metadata.size ||
    canonicalMetadataInventorySha256(
      index.metadata,
      s.metadataCapturedAt,
      s.metadataCaptureTransactionId,
    ) !== index.metadataInventorySha256 ||
    canonicalObjectInventorySha256(index.objects, s.objectCapturedAt) !==
      index.objectInventorySha256
  )
    throw refused();
  const coveredObjects = new Set<string>();
  for (const e of index.entries) {
    const c = e.context,
      m = metadata.get(e.documentIdentitySha256),
      o = objects.get(e.objectKeySha256);
    if (
      !m ||
      !o ||
      canonicalDocumentIdentitySha256(c.documentId) !==
        e.documentIdentitySha256 ||
      c.installationId !== s.installationId ||
      c.setId !== s.setId ||
      c.sourceSha !== s.sourceSha ||
      c.databaseSha256 !== s.databaseSha256 ||
      c.keyArn !== s.dataKeyArn ||
      c.sourceBindingSha256 !== e.metadataBindingSha256 ||
      m.metadataBindingSha256 !== e.metadataBindingSha256 ||
      m.objectKeySha256 !== e.objectKeySha256 ||
      m.fileSize !== o.bytes ||
      c.byteLength !== o.bytes ||
      c.bytesSha256 !== o.sha256 ||
      e.archive.objectKey !== archiveKey(c)
    )
      throw refused();
    coveredObjects.add(e.objectKeySha256);
  }
  if (coveredObjects.size !== objects.size) throw refused();
  // Stable ordering is part of the canonical index, not caller array order.
  sorted(index.metadata, (row) => row.documentIdentitySha256);
  sorted(index.objects, (row) => row.objectKeySha256);
  sorted(index.entries, (row) => row.documentIdentitySha256);
  if (
    Buffer.byteLength(JSON.stringify(index)) >
    DOCUMENT_BACKUP_INDEX_MAX_BYTES - 1024
  )
    throw refused();
  return index;
}
/** Reconcile supplied inventories and receipt fields. Callers must obtain those
 * receipts from verified archive readback. This does not capture the source,
 * prove quiescence, read an object or validate a database dump. */
export function buildDocumentBackupIndex(raw: unknown): DocumentBackupIndex {
  try {
    const value = z
      .object({
        scope: scopeSchema,
        metadataRows: z.array(metadataSchema).max(5000),
        objectRows: z.array(objectSchema).max(5000),
        receipts: z.array(receiptSchema).max(5000),
      })
      .strict()
      .parse(raw);
    const metadata = value.metadataRows.map((row) => ({
      documentIdentitySha256: canonicalDocumentIdentitySha256(row.id),
      metadataBindingSha256: canonicalMetadataBindingSha256(row),
      objectKeySha256: canonicalObjectKeySha256(row.fileUrl),
      fileSize: row.fileSize,
    }));
    const objects = value.objectRows.map((row) => ({
      objectKeySha256: canonicalObjectKeySha256(row.fileUrl),
      bytes: row.bytes,
      sha256: row.sha256,
    }));
    const receiptMap = unique(value.receipts, (row) =>
      canonicalDocumentIdentitySha256(row.context.documentId),
    );
    if (receiptMap.size !== metadata.length) throw refused();
    const entries = value.metadataRows.map((row, i) => {
      const receipt = receiptMap.get(metadata[i].documentIdentitySha256);
      if (!receipt || receipt.context.organisationId !== row.organisationId)
        throw refused();
      return {
        context: receipt.context,
        documentIdentitySha256: metadata[i].documentIdentitySha256,
        metadataBindingSha256: metadata[i].metadataBindingSha256,
        objectKeySha256: metadata[i].objectKeySha256,
        archive: {
          objectKey: receipt.objectKey,
          versionId: receipt.versionId,
          sha256: receipt.sha256,
        },
      };
    });
    return validateIndex({
      format: 1,
      kind: 'DOCUMENT_BACKUP_INDEX_V1',
      scope: value.scope,
      metadata,
      objects,
      entries,
      metadataInventorySha256: canonicalMetadataInventorySha256(
        metadata,
        value.scope.metadataCapturedAt,
        value.scope.metadataCaptureTransactionId,
      ),
      objectInventorySha256: canonicalObjectInventorySha256(
        objects,
        value.scope.objectCapturedAt,
      ),
    });
  } catch {
    throw refused();
  }
}
export async function sealDocumentBackupIndex(
  raw: unknown,
  provider: DocumentBackupIndexMac,
) {
  try {
    // Only the full source-row reconciliation can enter the signing path.
    const index = buildDocumentBackupIndex(raw); // Deep snapshot before await.
    const response = await provider.generate(
      index.scope.macKeyArn,
      message(index),
    );
    if (
      response.keyArn !== index.scope.macKeyArn ||
      !Buffer.isBuffer(response.mac) ||
      response.mac.length !== 32
    )
      throw refused();
    const body = JSON.stringify({
      index,
      mac: response.mac.toString('base64'),
    });
    return { body, sha256: hash(body) };
  } catch {
    throw refused();
  }
}
/** Expected scope and envelope digest must come from independently trusted
 * recovery-set authority, never from the object being opened. No restore grant. */
export async function openDocumentBackupIndex(
  expectedScope: unknown,
  body: string,
  expectedSha256: string,
  provider: DocumentBackupIndexMac,
) {
  try {
    if (
      typeof body !== 'string' ||
      Buffer.byteLength(body) > DOCUMENT_BACKUP_INDEX_MAX_BYTES ||
      !sha.safeParse(expectedSha256).success
    )
      throw refused();
    const expected = scopeSchema.parse(expectedScope),
      parsed = z
        .object({ index: indexSchema, mac: z.string().length(44) })
        .strict()
        .parse(JSON.parse(body));
    const index = validateIndex(parsed.index),
      tag = Buffer.from(parsed.mac, 'base64');
    if (
      tag.length !== 32 ||
      tag.toString('base64') !== parsed.mac ||
      JSON.stringify({ index, mac: parsed.mac }) !== body ||
      hash(body) !== expectedSha256 ||
      JSON.stringify(expected) !== JSON.stringify(index.scope)
    )
      throw refused();
    const result = await provider.verify(
      expected.macKeyArn,
      message(index),
      tag,
    );
    if (result.keyArn !== expected.macKeyArn || result.valid !== true)
      throw refused();
    return index;
  } catch {
    throw refused();
  }
}
