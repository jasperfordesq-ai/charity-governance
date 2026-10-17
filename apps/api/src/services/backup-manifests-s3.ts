import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { z } from 'zod';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { DOCUMENT_BACKUP_KEY_ARN } from './document-byte-backup.js';

const refused = () => new Error('Backup manifest storage unavailable');
const id = z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,120}$/)
    .refine((v) => v === v.trim()),
  sha = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .length(64);
const targetSchema = z
  .object({
    installationId: id,
    setId: z
      .string()
      .uuid()
      .refine((v) => v === v.toLowerCase() && v === v.trim()),
    sourceSha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .length(40),
    kind: z.enum([
      'DOCUMENT_INDEX_V1',
      'SOURCE_REPORT_V2',
      'ARCHIVED_SET_V1',
      'PREPARED_SET_V1',
    ]),
  })
  .strict();
export type BackupManifestTarget = z.infer<typeof targetSchema>;
const configuration = z
  .object({
    installationId: id,
    bucket: z
      .string()
      .min(3)
      .max(63)
      .regex(/^[a-z0-9][a-z0-9-]+[a-z0-9]$/)
      .refine((v) => v === v.trim()),
    accountId: z.string().regex(/^[0-9]{12}$/),
    storageKeyArn: DOCUMENT_BACKUP_KEY_ARN,
  })
  .strict()
  .refine((c) => c.storageKeyArn.split(':')[4] === c.accountId);
type Configuration = z.infer<typeof configuration>;
const filename = {
  DOCUMENT_INDEX_V1: 'index.json',
  SOURCE_REPORT_V2: 'source-report.json',
  ARCHIVED_SET_V1: 'root.json',
  PREPARED_SET_V1: 'prepared-root.json',
};
const maximum = {
  DOCUMENT_INDEX_V1: 16 * 1024 * 1024,
  SOURCE_REPORT_V2: 32 * 1024 * 1024,
  ARCHIVED_SET_V1: 1024 * 1024,
  PREPARED_SET_V1: 1024 * 1024,
};
const version = (v: unknown): v is string =>
  typeof v === 'string' &&
  v !== 'null' &&
  v === v.trim() &&
  /^[\x21-\x7e]{1,1024}$/.test(v);
const hash = (body: string) => createHash('sha256').update(body).digest('hex');
function matches(target: BackupManifestTarget, body: string, expected: string) {
  if (
    typeof body !== 'string' ||
    !sha.safeParse(expected).success ||
    Buffer.byteLength(body) < 1 ||
    Buffer.byteLength(body) > maximum[target.kind] ||
    hash(body) !== expected
  )
    throw refused();
  const value = JSON.parse(body);
  if (target.kind === 'SOURCE_REPORT_V2') {
    if (
      value?.format !== 'charitypilot-postgres-restore-proof/v2' ||
      value?.helperImplementation?.commitSha !== target.sourceSha
    )
      throw refused();
  } else {
    const scope =
      target.kind === 'DOCUMENT_INDEX_V1'
        ? value?.index?.scope
        : value?.manifest?.scope?.index;
    const kind =
      target.kind === 'DOCUMENT_INDEX_V1'
        ? value?.index?.kind
        : value?.manifest?.kind;
    if (
      (target.kind === 'DOCUMENT_INDEX_V1' ? kind !== 'DOCUMENT_BACKUP_INDEX_V1'
        : !((kind === 'ARCHIVED_RECOVERY_SET_V1' && value.manifest.format === 1)
          || (kind === 'ARCHIVED_RECOVERY_SET_V2' && value.manifest.format === 2))) ||
      scope?.installationId !== target.installationId ||
      scope?.setId !== target.setId ||
      scope?.sourceSha !== target.sourceSha ||
      JSON.stringify(value) !== body
    )
      throw refused();
  }
}
/** Fixed metadata candidates only. Semantic/MAC validation belongs to the
 * archived-set coordinator. No head update, delete, retry or restore authority. */
export class S3BackupManifests {
  private readonly config: Configuration;
  private readonly client: S3Client;
  constructor(
    config: Configuration,
    credentials: NonNullable<S3ClientConfig['credentials']>,
    client?: S3Client,
  ) {
    this.config = configuration.parse(config);
    if (!credentials) throw refused();
    this.client =
      client ??
      new S3Client({
        region: 'eu-west-1',
        endpoint: 'https://s3.eu-west-1.amazonaws.com',
        credentials,
        maxAttempts: 1,
        followRegionRedirects: false,
        requestHandler: {
          connectionTimeout: 5000,
          requestTimeout: 60000,
          throwOnRequestTimeout: true,
        },
      });
  }
  private request(raw: BackupManifestTarget) {
    const target = Object.freeze(targetSchema.parse(raw));
    if (target.installationId !== this.config.installationId) throw refused();
    return {
      target,
      request: {
        Bucket: this.config.bucket,
        ExpectedBucketOwner: this.config.accountId,
        Key: `business-data/${target.installationId}/${target.setId}/${filename[target.kind]}`,
      },
    };
  }
  private async bounded<T>(
    run: (signal: AbortSignal) => Promise<T>,
    caller?: AbortSignal,
  ) {
    const controller = new AbortController(),
      signal = caller
        ? AbortSignal.any([caller, controller.signal])
        : controller.signal;
    let stop: () => void = () => {};
    const timer = setTimeout(() => controller.abort(), 60000);
    const cancelled = new Promise<never>((_resolve, reject) => {
      stop = () => reject(refused());
      signal.addEventListener('abort', stop, { once: true });
    });
    try {
      if (signal.aborted) throw refused();
      return await Promise.race([run(signal), cancelled]);
    } catch {
      throw refused();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      controller.abort();
    }
  }
  async publish(
    raw: BackupManifestTarget,
    artifact: { body: string; sha256: string },
    signal?: AbortSignal,
  ) {
    try {
      const { target, request } = this.request(raw),
        body = artifact.body,
        digest = artifact.sha256;
      matches(target, body, digest);
      const observed = await this.bounded(async (signal) => {
        const result = await this.client.send(
          new PutObjectCommand({
            ...request,
            Body: body,
            ContentType: 'application/json',
            ContentLength: Buffer.byteLength(body),
            IfNoneMatch: '*',
            ServerSideEncryption: 'aws:kms',
            SSEKMSKeyId: this.config.storageKeyArn,
            ChecksumSHA256: Buffer.from(digest, 'hex').toString('base64'),
          }),
          { abortSignal: signal },
        );
        if (
          signal.aborted ||
          !version(result.VersionId) ||
          result.ServerSideEncryption !== 'aws:kms' ||
          result.SSEKMSKeyId !== this.config.storageKeyArn ||
          result.ChecksumSHA256 !==
            Buffer.from(digest, 'hex').toString('base64') ||
          (result.ChecksumType && result.ChecksumType !== 'FULL_OBJECT')
        )
          throw refused();
        return result.VersionId;
      }, signal);
      return await this.observe(target, digest, observed, signal);
    } catch {
      throw refused();
    }
  }
  async observe(
    raw: BackupManifestTarget,
    expectedSha256: string,
    expectedVersion?: string,
    caller?: AbortSignal,
  ) {
    try {
      const { target, request } = this.request(raw);
      sha.parse(expectedSha256);
      if (expectedVersion !== undefined && !version(expectedVersion))
        throw refused();
      return await this.bounded(async (signal) => {
        let body: Readable | undefined;
        const stop = () => body?.destroy();
        signal.addEventListener('abort', stop, { once: true });
        try {
          const result = await this.client.send(
            new GetObjectCommand({
              ...request,
              ChecksumMode: 'ENABLED',
              ...(expectedVersion ? { VersionId: expectedVersion } : {}),
            }),
            { abortSignal: signal },
          );
          if (result.Body instanceof Readable) {
            body = result.Body;
            body.on('error', () => {});
          }
          const observedVersion = result.VersionId,
            bytes = result.ContentLength;
          if (
            signal.aborted ||
            !body ||
            result.DeleteMarker ||
            !version(observedVersion) ||
            (expectedVersion && observedVersion !== expectedVersion) ||
            result.ServerSideEncryption !== 'aws:kms' ||
            result.SSEKMSKeyId !== this.config.storageKeyArn ||
            result.ContentType !== 'application/json' ||
            result.ChecksumSHA256 !==
              Buffer.from(expectedSha256, 'hex').toString('base64') ||
            (result.ChecksumType && result.ChecksumType !== 'FULL_OBJECT') ||
            !Number.isSafeInteger(bytes) ||
            bytes! < 1 ||
            bytes! > maximum[target.kind]
          )
            throw refused();
          const buffer = Buffer.alloc(bytes!);
          let count = 0;
          for await (const chunk of body) {
            if (
              signal.aborted ||
              !Buffer.isBuffer(chunk) ||
              chunk.length > 1024 * 1024 ||
              count + chunk.length > buffer.length
            )
              throw refused();
            chunk.copy(buffer, count);
            count += chunk.length;
          }
          if (count !== buffer.length) throw refused();
          const text = new TextDecoder('utf-8', {
            fatal: true,
            ignoreBOM: true,
          }).decode(buffer);
          matches(target, text, expectedSha256);
          return {
            kind: 'EXACT_MANIFEST_READBACK' as const,
            artifact: { body: text, sha256: expectedSha256, byteLength: count },
            objectKey: request.Key,
            versionId: observedVersion,
          };
        } finally {
          signal.removeEventListener('abort', stop);
          body?.destroy();
        }
      }, caller);
    } catch {
      throw refused();
    }
  }
}
