import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { z } from 'zod';
import {
  DOCUMENT_BACKUP_KEY_ARN,
  DOCUMENT_BACKUP_MAX_ENVELOPE_BYTES,
  documentBackupContext,
  inspectDocumentByteBackup,
  type DocumentBackupContext,
} from './document-byte-backup.js';

const configSchema = z
  .object({
    bucket: z
      .string()
      .min(3)
      .max(63)
      .regex(/^[a-z0-9][a-z0-9-]+[a-z0-9]$/),
    accountId: z.string().regex(/^[0-9]{12}$/),
    storageKeyArn: DOCUMENT_BACKUP_KEY_ARN,
    dataKeyArn: DOCUMENT_BACKUP_KEY_ARN,
    installationId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
  })
  .strict()
  .refine(
    (c) =>
      c.storageKeyArn !== c.dataKeyArn &&
      [c.storageKeyArn, c.dataKeyArn].every(
        (arn) => arn.split(':')[4] === c.accountId,
      ),
  );
type Configuration = z.infer<typeof configSchema>;
const hash = (body: string) => createHash('sha256').update(body).digest('hex');
const checksum = (body: string) =>
  createHash('sha256').update(body).digest('base64');
const refused = () => new Error('Document backup storage unavailable');
const version = (value: unknown): value is string =>
  typeof value === 'string' &&
  value !== 'null' &&
  /^[\x21-\x7e]{1,1024}$/.test(value);
/** Immutable candidates only. No bucket creation, key lookup, overwrite, delete,
 * head advancement, manifest completion or restore/reopening authorisation. */
export class S3DocumentByteBackups {
  private readonly config: Configuration;
  private readonly client: S3Client;
  constructor(
    config: Configuration,
    credentials: NonNullable<S3ClientConfig['credentials']>,
    client?: S3Client,
  ) {
    this.config = configSchema.parse(config);
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
          requestTimeout: 15000,
          throwOnRequestTimeout: true,
        },
      });
  }
  private request(raw: DocumentBackupContext) {
    const c = documentBackupContext(raw);
    if (
      c.installationId !== this.config.installationId ||
      c.keyArn !== this.config.dataKeyArn
    )
      throw refused();
    return {
      Bucket: this.config.bucket,
      ExpectedBucketOwner: this.config.accountId,
      Key:
        'business-data/' +
        c.installationId +
        '/' +
        c.setId +
        '/documents/' +
        c.organisationId +
        '/' +
        c.documentId +
        '/' +
        c.sourceBindingSha256 +
        '.json',
    };
  }
  private validate(
    context: DocumentBackupContext,
    body: string,
    sha256: string,
  ) {
    const expected = documentBackupContext(context),
      parsed = inspectDocumentByteBackup(body);
    if (
      !/^[a-f0-9]{64}$/.test(sha256) ||
      hash(body) !== sha256 ||
      JSON.stringify(parsed.context) !== JSON.stringify(expected)
    )
      throw refused();
  }
  private async bounded<T>(
    run: (signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController(),
      signal = callerSignal
        ? AbortSignal.any([callerSignal, controller.signal])
        : controller.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => {};
    const stopped = new Promise<never>((_resolve, reject) => {
      abort = () => reject(refused());
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => controller.abort(), 15000);
    });
    try {
      if (signal.aborted) throw refused();
      return await Promise.race([run(signal), stopped]);
    } catch {
      throw refused();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      controller.abort();
    }
  }
  async publish(
    context: DocumentBackupContext,
    artifact: { body: string; sha256: string },
    callerSignal?: AbortSignal,
  ) {
    try {
      const bound = documentBackupContext(context),
        body = artifact.body,
        sha256 = artifact.sha256;
      this.validate(bound, body, sha256);
      const request = this.request(bound);
      // Snapshot caller-owned strings before awaiting. A lost ACK never generates
      // another key, overwrites an object or turns a read into a write retry.
      const versionId = await this.bounded(async (signal) => {
        const result = await this.client.send(
          new PutObjectCommand({
            ...request,
            Body: body,
            ContentType: 'application/json',
            ContentLength: Buffer.byteLength(body),
            IfNoneMatch: '*',
            ServerSideEncryption: 'aws:kms',
            SSEKMSKeyId: this.config.storageKeyArn,
            ChecksumSHA256: checksum(body),
          }),
          { abortSignal: signal },
        );
        if (
          signal.aborted ||
          !version(result.VersionId) ||
          result.ServerSideEncryption !== 'aws:kms' ||
          result.SSEKMSKeyId !== this.config.storageKeyArn ||
          result.ChecksumSHA256 !== checksum(body)
        )
          throw refused();
        return result.VersionId;
      }, callerSignal);
      return await this.observe(bound, sha256, versionId, callerSignal);
    } catch {
      throw refused();
    }
  }
  /** Read-only inspection can resolve a lost acknowledgement against the exact
   * originally held digest. It does not manufacture a committed set manifest. */
  async observe(
    context: DocumentBackupContext,
    expectedDigest: string,
    versionId?: string,
    callerSignal?: AbortSignal,
  ) {
    try {
      if (
        !/^[a-f0-9]{64}$/.test(expectedDigest) ||
        (versionId !== undefined && !version(versionId))
      )
        throw refused();
      const bound = documentBackupContext(context),
        request = this.request(bound);
      return await this.bounded(async (signal) => {
        let body: Readable | undefined;
        const destroy = () => body?.destroy(refused());
        signal.addEventListener('abort', destroy, { once: true });
        try {
          const result = await this.client.send(
            new GetObjectCommand({
              ...request,
              ...(versionId ? { VersionId: versionId } : {}),
              ChecksumMode: 'ENABLED',
            }),
            { abortSignal: signal },
          );
          if (result.Body instanceof Readable) body = result.Body;
          if (
            signal.aborted ||
            !body ||
            result.DeleteMarker ||
            !version(result.VersionId) ||
            (versionId && result.VersionId !== versionId) ||
            result.ServerSideEncryption !== 'aws:kms' ||
            result.SSEKMSKeyId !== this.config.storageKeyArn ||
            result.ChecksumSHA256 !==
              Buffer.from(expectedDigest, 'hex').toString('base64') ||
            (result.ChecksumType && result.ChecksumType !== 'FULL_OBJECT') ||
            !Number.isSafeInteger(result.ContentLength) ||
            result.ContentLength! < 1 ||
            result.ContentLength! > DOCUMENT_BACKUP_MAX_ENVELOPE_BYTES
          )
            throw refused();
          const chunks: Buffer[] = [];
          let length = 0;
          for await (const chunk of body) {
            if (signal.aborted || !(chunk instanceof Uint8Array))
              throw refused();
            length += chunk.byteLength;
            if (
              length > DOCUMENT_BACKUP_MAX_ENVELOPE_BYTES ||
              length > result.ContentLength!
            )
              throw refused();
            chunks.push(Buffer.from(chunk));
          }
          if (length !== result.ContentLength) throw refused();
          const text = new TextDecoder('utf-8', {
            fatal: true,
            ignoreBOM: true,
          }).decode(Buffer.concat(chunks));
          this.validate(bound, text, expectedDigest);
          return {
            body: text,
            sha256: expectedDigest,
            versionId: result.VersionId,
            objectKey: request.Key,
          };
        } finally {
          signal.removeEventListener('abort', destroy);
          body?.destroy();
        }
      }, callerSignal);
    } catch {
      throw refused();
    }
  }
}
