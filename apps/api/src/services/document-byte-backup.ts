import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { z } from 'zod';
import { DOCUMENT_UPLOAD_MAX_FILE_SIZE } from './document-upload-limits.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
export const DOCUMENT_BACKUP_KEY_ARN = z
  .string()
  .regex(
    /^arn:aws:kms:eu-west-1:[0-9]{12}:key\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
  );
const scope = z
  .object({
    installationId: id,
    setId: z
      .string()
      .uuid()
      .refine((value) => value === value.toLowerCase()),
    organisationId: id,
    documentId: id,
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    databaseSha256: digest,
    sourceBindingSha256: digest,
    bytesSha256: digest,
    byteLength: z.number().int().min(0).max(DOCUMENT_UPLOAD_MAX_FILE_SIZE),
    keyArn: DOCUMENT_BACKUP_KEY_ARN,
  })
  .strict();
export type DocumentBackupContext = z.infer<typeof scope>;
export function documentBackupContext(raw: unknown): DocumentBackupContext {
  try {
    return Object.freeze(scope.parse(raw));
  } catch {
    throw new Error('Document byte backup scope refused');
  }
}
const base64 = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine(
      (value) => Buffer.from(value, 'base64').toString('base64') === value,
    );
const binaryLimit = 4 * Math.ceil(DOCUMENT_UPLOAD_MAX_FILE_SIZE / 3);
export const DOCUMENT_BACKUP_MAX_ENVELOPE_BYTES = binaryLimit + 65536;
const envelope = z
  .object({
    format: z.literal(1),
    kind: z.literal('DOCUMENT_BYTES_BACKUP_V1'),
    context: scope,
    wrappedKey: base64(8192).refine(
      (value) => Buffer.from(value, 'base64').length >= 1,
    ),
    iv: base64(16).refine(
      (value) => Buffer.from(value, 'base64').length === 12,
    ),
    tag: base64(24).refine(
      (value) => Buffer.from(value, 'base64').length === 16,
    ),
    ciphertext: base64(binaryLimit),
  })
  .strict();
const sha = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const refused = () => new Error('Document byte backup unavailable');
const aad = (context: DocumentBackupContext) =>
  Buffer.from(
    'CHARITYPILOT_DOCUMENT_BYTES_BACKUP_V1\n' + JSON.stringify(context),
  );
export interface DocumentBackupKeys {
  generate(
    context: DocumentBackupContext,
  ): Promise<{ key: Buffer; keyArn: string; wrappedKey: string }>;
  unwrap(
    wrappedKey: string,
    context: DocumentBackupContext,
  ): Promise<{ key: Buffer; keyArn: string }>;
}
/** Structural/canonical inspection only. Does not authenticate a backup set,
 * establish source completeness or authorise restoration/disclosure. */
export function inspectDocumentByteBackup(body: string) {
  try {
    if (
      typeof body !== 'string' ||
      Buffer.byteLength(body) > DOCUMENT_BACKUP_MAX_ENVELOPE_BYTES
    )
      throw refused();
    const parsed = envelope.parse(JSON.parse(body));
    if (
      JSON.stringify(parsed) !== body ||
      Buffer.from(parsed.ciphertext, 'base64').length !==
        parsed.context.byteLength
    )
      throw refused();
    return parsed;
  } catch {
    throw refused();
  }
}
function keyMatches(
  value: { key: Buffer; keyArn: string } | undefined,
  context: DocumentBackupContext,
) {
  if (
    !value ||
    !Buffer.isBuffer(value.key) ||
    value.key.length !== 32 ||
    value.keyArn !== context.keyArn
  )
    throw refused();
  return value.key;
}
export async function sealDocumentByteBackup(
  raw: unknown,
  input: Buffer,
  keys: DocumentBackupKeys,
) {
  let material: Awaited<ReturnType<DocumentBackupKeys['generate']>> | undefined,
    bytes: Buffer | undefined;
  try {
    const context = documentBackupContext(raw);
    if (!Buffer.isBuffer(input) || input.length !== context.byteLength)
      throw refused();
    bytes = Buffer.from(input);
    if (sha(bytes) !== context.bytesSha256) throw refused();
    material = await keys.generate(context);
    const key = keyMatches(material, context),
      iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(context));
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const body = JSON.stringify({
      format: 1,
      kind: 'DOCUMENT_BYTES_BACKUP_V1',
      context,
      wrappedKey: material.wrappedKey,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    });
    inspectDocumentByteBackup(body);
    return { body, sha256: sha(body) };
  } catch {
    throw refused();
  } finally {
    bytes?.fill(0);
    if (material?.key instanceof Uint8Array) material.key.fill(0);
  }
}
/** expectedDigest and scope must come from an independently authenticated set
 * manifest, never from this same object. Returned bytes remain quarantined until
 * current authority is reconciled; this function changes no database/file. */
export async function openDocumentByteBackup(
  raw: unknown,
  body: string,
  expectedDigest: string,
  keys: DocumentBackupKeys,
) {
  let material: Awaited<ReturnType<DocumentBackupKeys['unwrap']>> | undefined,
    partial: Buffer | undefined,
    bytes: Buffer | undefined;
  try {
    const context = documentBackupContext(raw);
    const parsed = inspectDocumentByteBackup(body);
    if (
      !digest.safeParse(expectedDigest).success ||
      sha(body) !== expectedDigest
    )
      throw refused();
    if (JSON.stringify(parsed.context) !== JSON.stringify(context))
      throw refused();
    material = await keys.unwrap(parsed.wrappedKey, context);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      keyMatches(material, context),
      Buffer.from(parsed.iv, 'base64'),
    );
    decipher.setAAD(aad(context));
    decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
    partial = decipher.update(Buffer.from(parsed.ciphertext, 'base64'));
    const final = decipher.final();
    bytes = Buffer.concat([partial, final]);
    final.fill(0);
    if (
      bytes.length !== context.byteLength ||
      sha(bytes) !== context.bytesSha256
    )
      throw refused();
    const verified = bytes;
    bytes = undefined;
    return verified;
  } catch {
    throw refused();
  } finally {
    partial?.fill(0);
    bytes?.fill(0);
    if (material?.key instanceof Uint8Array) material.key.fill(0);
  }
}
