import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  GetObjectCommand,
  type S3ClientConfig,
  type CompletedPart,
} from '@aws-sdk/client-s3';
import { DOCUMENT_BACKUP_KEY_ARN } from './document-byte-backup.js';
import {
  databaseBackupContext,
  databaseBackupArchiveBounds,
  inspectDatabaseByteBackupArchive,
  type DatabaseBackupContext,
} from './database-byte-backup.js';

export const DATABASE_BACKUP_S3_PART_BYTES = 16 * 1024 * 1024;
const refused = () => new Error('Database backup storage unavailable');
const configuration = z
  .object({
    installationId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
    bucket: z
      .string()
      .min(3)
      .max(63)
      .regex(/^[a-z0-9][a-z0-9-]+[a-z0-9]$/),
    accountId: z.string().regex(/^[0-9]{12}$/),
    dataKeyArn: DOCUMENT_BACKUP_KEY_ARN,
    storageKeyArn: DOCUMENT_BACKUP_KEY_ARN,
  })
  .strict()
  .refine(
    (c) =>
      c.dataKeyArn !== c.storageKeyArn &&
      [c.dataKeyArn, c.storageKeyArn].every(
        (arn) => arn.split(':')[4] === c.accountId,
      ),
  );
type Configuration = z.infer<typeof configuration>;
const artifactSchema = z
  .object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteLength: z.number().int(),
    databaseSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type DatabaseArchiveArtifact = z.infer<typeof artifactSchema>;
const opaque = (value: unknown): value is string =>
  typeof value === 'string' &&
  value !== 'null' &&
  /^[\x21-\x7e]{1,1024}$/.test(value);
const etag = (value: unknown): value is string =>
  typeof value === 'string' && /^"[\x21\x23-\x7e]{1,128}"$/.test(value);
const digest = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('base64');
class CompositeChecksum {
  private part = createHash('sha256');
  private readonly composite = createHash('sha256');
  private bytes = 0;
  private parts = 0;
  update(chunk: Buffer) {
    let offset = 0;
    while (offset < chunk.length) {
      const count = Math.min(
        DATABASE_BACKUP_S3_PART_BYTES - this.bytes,
        chunk.length - offset,
      );
      this.part.update(chunk.subarray(offset, offset + count));
      offset += count;
      this.bytes += count;
      if (this.bytes === DATABASE_BACKUP_S3_PART_BYTES) this.completePart();
    }
  }
  private completePart() {
    this.composite.update(this.part.digest());
    this.part = createHash('sha256');
    this.bytes = 0;
    this.parts++;
  }
  finish() {
    if (this.bytes) this.completePart();
    if (!this.parts) throw refused();
    return this.composite.digest('base64') + '-' + this.parts;
  }
}
function operation(caller?: AbortSignal) {
  const controller = new AbortController(),
    signal = caller
      ? AbortSignal.any([controller.signal, caller])
      : controller.signal;
  const sources = new Set<Readable>(),
    destinations = new Set<Writable>();
  const deadline = performance.now() + 45 * 60 * 1000;
  let idle: ReturnType<typeof setTimeout>;
  const total = setTimeout(() => controller.abort(), 45 * 60 * 1000);
  const stop = () => {
    for (const source of sources) source.destroy();
    for (const destination of destinations) destination.destroy();
  };
  signal.addEventListener('abort', stop, { once: true });
  const progress = (milliseconds = 60000) => {
    clearTimeout(idle);
    if (!signal.aborted)
      idle = setTimeout(() => controller.abort(), milliseconds);
  };
  const check = () => {
    if (performance.now() >= deadline) controller.abort();
    if (signal.aborted) throw refused();
  };
  progress();
  const error = () => controller.abort();
  return {
    signal,
    progress,
    check,
    cancel: () => controller.abort(),
    source(body: Readable) {
      sources.add(body);
      body.on('error', error);
      body.on('readable', () => progress());
      if (signal.aborted) body.destroy();
    },
    destination(body: Writable) {
      destinations.add(body);
      body.on('error', error);
      if (signal.aborted) body.destroy();
    },
    finish() {
      clearTimeout(total);
      clearTimeout(idle);
      signal.removeEventListener('abort', stop);
      controller.abort();
      for (const source of sources) source.destroy();
      for (const destination of destinations) {
        if (!destination.writableFinished) destination.destroy();
      }
    },
  };
}
type Operation = ReturnType<typeof operation>;
type Encryption = { ServerSideEncryption?: string; SSEKMSKeyId?: string };
/** Immutable encrypted candidates only. No bucket/IAM provisioning, latest-head
 * mutation, overwrite, delete, abort, write retry or complete-set admission. */
export class S3DatabaseByteBackups {
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
        responseChecksumValidation: 'WHEN_REQUIRED',
        requestChecksumCalculation: 'WHEN_REQUIRED',
        requestHandler: {
          connectionTimeout: 5000,
          requestTimeout: 180000,
          throwOnRequestTimeout: true,
        },
      });
  }
  private bound(raw: unknown, expected: unknown) {
    const context = databaseBackupContext(raw),
      artifact = Object.freeze(artifactSchema.parse(expected)),
      bounds = databaseBackupArchiveBounds(context);
    if (
      context.installationId !== this.config.installationId ||
      context.keyArn !== this.config.dataKeyArn ||
      artifact.databaseSha256 !== context.databaseSha256 ||
      artifact.byteLength < bounds.minimumBytes ||
      artifact.byteLength > bounds.maximumBytes
    )
      throw refused();
    return {
      context,
      artifact,
      request: {
        Bucket: this.config.bucket,
        ExpectedBucketOwner: this.config.accountId,
        Key: `business-data/${context.installationId}/${context.setId}/database/${context.databaseIdentitySha256}.bin`,
      },
    };
  }
  private encryption(response: Encryption) {
    if (
      response.ServerSideEncryption !== 'aws:kms' ||
      response.SSEKMSKeyId !== this.config.storageKeyArn
    )
      throw refused();
  }
  private async send<T>(
    run: () => Promise<T>,
    io: Operation,
    milliseconds = 60000,
    late?: (value: T) => void,
  ): Promise<T> {
    io.check();
    io.progress(milliseconds);
    let abort: () => void = () => {};
    const deadline = setTimeout(io.cancel, milliseconds);
    const stopped = new Promise<never>((_resolve, reject) => {
      abort = () => reject(refused());
      io.signal.addEventListener('abort', abort, { once: true });
    });
    try {
      const pending = run().then((value) => {
        if (io.signal.aborted) {
          late?.(value);
          throw refused();
        }
        return value;
      });
      return await Promise.race([pending, stopped]);
    } catch {
      throw refused();
    } finally {
      clearTimeout(deadline);
      io.signal.removeEventListener('abort', abort);
      io.progress();
    }
  }
  async publish(
    raw: DatabaseBackupContext,
    expected: DatabaseArchiveArtifact,
    source: Readable,
    signal?: AbortSignal,
  ) {
    const io = operation(signal);
    io.source(source);
    let partBytes: Buffer = Buffer.alloc(0);
    try {
      io.check();
      const { context, artifact, request } = this.bound(raw, expected);
      partBytes = Buffer.alloc(DATABASE_BACKUP_S3_PART_BYTES);
      let uploadId: string | undefined,
        used = 0;
      let count = 0,
        versionId: string | undefined,
        checksum = '';
      const parts: CompletedPart[] = [],
        hash = createHash('sha256'),
        composite = new CompositeChecksum();
      const ensureUpload = async () => {
        if (uploadId) return;
        const result = await this.send(
          () =>
            this.client.send(
              new CreateMultipartUploadCommand({
                ...request,
                ContentType: 'application/octet-stream',
                ServerSideEncryption: 'aws:kms',
                SSEKMSKeyId: this.config.storageKeyArn,
                ChecksumAlgorithm: 'SHA256',
                ChecksumType: 'COMPOSITE',
              }),
              { abortSignal: io.signal },
            ),
          io,
        );
        this.encryption(result);
        if (
          result.Bucket !== request.Bucket ||
          result.Key !== request.Key ||
          !opaque(result.UploadId)
        )
          throw refused();
        uploadId = result.UploadId;
      };
      const flush = async () => {
        if (!used || !uploadId || parts.length >= 10000) throw refused();
        const bytes = Buffer.from(partBytes.subarray(0, used)),
          checksum = digest(bytes),
          number = parts.length + 1;
        const result = await this.send(
          () =>
            this.client.send(
              new UploadPartCommand({
                ...request,
                UploadId: uploadId,
                PartNumber: number,
                Body: bytes,
                ContentLength: bytes.length,
                ChecksumSHA256: checksum,
              }),
              { abortSignal: io.signal },
            ),
          io,
        );
        this.encryption(result);
        if (!etag(result.ETag) || result.ChecksumSHA256 !== checksum)
          throw refused();
        parts.push({
          PartNumber: number,
          ETag: result.ETag,
          ChecksumSHA256: checksum,
        });
        used = 0;
      };
      const append = async (chunk: Buffer) => {
        io.check();
        io.progress();
        await ensureUpload();
        count += chunk.length;
        if (count > artifact.byteLength) throw refused();
        hash.update(chunk);
        composite.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const length = Math.min(
            partBytes.length - used,
            chunk.length - offset,
          );
          chunk.copy(partBytes, used, offset, offset + length);
          used += length;
          offset += length;
          if (used === partBytes.length) await flush();
        }
      };
      const complete = async () => {
        if (
          count !== artifact.byteLength ||
          hash.digest('hex') !== artifact.sha256
        )
          throw refused();
        if (used) await flush();
        if (
          !uploadId ||
          parts.length !==
            Math.ceil(artifact.byteLength / DATABASE_BACKUP_S3_PART_BYTES)
        )
          throw refused();
        checksum = composite.finish();
        const result = await this.send(
          () =>
            this.client.send(
              new CompleteMultipartUploadCommand({
                ...request,
                UploadId: uploadId,
                MultipartUpload: { Parts: parts },
                IfNoneMatch: '*',
                ChecksumSHA256: checksum,
                ChecksumType: 'COMPOSITE',
                MpuObjectSize: artifact.byteLength,
              }),
              { abortSignal: io.signal },
            ),
          io,
          180000,
        );
        this.encryption(result);
        if (
          result.Bucket !== request.Bucket ||
          result.Key !== request.Key ||
          !opaque(result.VersionId) ||
          result.ChecksumType !== 'COMPOSITE' ||
          result.ChecksumSHA256 !== checksum
        )
          throw refused();
        versionId = result.VersionId;
      };
      const destination = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          append(chunk).then(
            () => callback(),
            () => callback(refused()),
          );
        },
        final(callback) {
          complete().then(
            () => callback(),
            () => callback(refused()),
          );
        },
      });
      io.destination(destination);
      await inspectDatabaseByteBackupArchive(
        context,
        source,
        destination,
        artifact.sha256,
        artifact.byteLength,
        io.signal,
      );
      if (!versionId) throw refused();
      partBytes = Buffer.alloc(0);
      const discard = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
      io.destination(discard);
      return await this.read(context, artifact, discard, versionId, io);
    } catch {
      throw refused();
    } finally {
      partBytes = Buffer.alloc(0);
      io.finish();
    }
  }
  /** Read-only reconciliation of the originally held candidate. A lost write
   * acknowledgement is not recreated; no original upload ID/commit is invented. */
  async observe(
    raw: DatabaseBackupContext,
    expected: DatabaseArchiveArtifact,
    destination: Writable,
    versionId?: string,
    signal?: AbortSignal,
  ) {
    const io = operation(signal);
    io.destination(destination);
    try {
      io.check();
      const { context, artifact } = this.bound(raw, expected);
      if (versionId !== undefined && !opaque(versionId)) throw refused();
      return await this.read(context, artifact, destination, versionId, io);
    } catch {
      throw refused();
    } finally {
      io.finish();
    }
  }
  private async read(
    context: DatabaseBackupContext,
    artifact: DatabaseArchiveArtifact,
    destination: Writable,
    versionId: string | undefined,
    io: Operation,
  ) {
    const { request } = this.bound(context, artifact);
    const result = await this.send(
      () =>
        this.client.send(
          new GetObjectCommand({
            ...request,
            ...(versionId ? { VersionId: versionId } : {}),
            ChecksumMode: 'ENABLED',
          }),
          { abortSignal: io.signal },
        ),
      io,
      60000,
      (result) => {
        if (result.Body instanceof Readable) {
          result.Body.on('error', () => {});
          result.Body.destroy();
        }
      },
    );
    const source = result.Body;
    if (source instanceof Readable) io.source(source);
    this.encryption(result);
    const parts = Math.ceil(
      artifact.byteLength / DATABASE_BACKUP_S3_PART_BYTES,
    );
    const checksum = result.ChecksumSHA256,
      observedVersion = result.VersionId;
    if (
      !(source instanceof Readable) ||
      result.DeleteMarker ||
      !opaque(observedVersion) ||
      (versionId !== undefined && observedVersion !== versionId) ||
      result.ContentLength !== artifact.byteLength ||
      result.ChecksumType !== 'COMPOSITE' ||
      typeof checksum !== 'string' ||
      !new RegExp('^[A-Za-z0-9+/]{43}=-' + parts + '$').test(checksum)
    )
      throw refused();
    const composite = new CompositeChecksum();
    const forward = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        try {
          io.check();
          io.progress();
          composite.update(chunk);
          destination.write(chunk, callback);
        } catch {
          callback(refused());
        }
      },
      final(callback) {
        destination.end(callback);
      },
    });
    io.destination(forward);
    await inspectDatabaseByteBackupArchive(
      context,
      source,
      forward,
      artifact.sha256,
      artifact.byteLength,
      io.signal,
    );
    if (composite.finish() !== checksum) throw refused();
    io.check();
    return {
      kind: 'EXACT_VERSION_READBACK' as const,
      artifact,
      versionId: observedVersion,
      objectKey: request.Key,
      compositeChecksumSha256: checksum,
    };
  }
}
