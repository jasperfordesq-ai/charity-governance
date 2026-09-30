import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { z } from 'zod';
import type { AuthorityObjectStore, AuthorityHeadPublisher, AuthorityCheckpoint } from './recovery-authority-journal.js';

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const configuration = z.object({
  bucket: z.string().min(3).max(63).regex(/^[a-z0-9][a-z0-9-]+[a-z0-9]$/),
  accountId: z.string().regex(/^\d{12}$/),
  kmsKeyArn: z.string().regex(/^arn:aws:kms:eu-west-1:\d{12}:key\/[a-f0-9-]{36}$/),
  installationId: identity, organisationId: identity,
}).strict().refine(c => c.kmsKeyArn.split(':')[4] === c.accountId);
type Configuration = z.infer<typeof configuration>;
const errorMetadata = z.object({ name: z.string().optional(),
  $metadata: z.object({ httpStatusCode: z.number().optional() }).optional() });
const checkpointFields = { installationId: identity, organisationId: identity,
  generation: z.number().int().min(0).max(10000), digest: z.string().regex(/^[a-f0-9]{64}$/).nullable() };
const checkpoint = z.object(checkpointFields).strict()
  .refine(v => (v.generation === 0) === (v.digest === null));
const headEnvelope = z.object({ ...checkpointFields, format: z.literal(1), publicationId: z.string().uuid() }).strict()
  .refine(v => (v.generation === 0) === (v.digest === null));
const etag = z.string().min(3).max(256).regex(/^"[\x21\x23-\x7e]+"$/);
function operationDeadline() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

/** Intent objects and conditional head publication. Bucket provisioning, retention and
 * independent custody must be verified separately before production use.
 * No default credentials or ambient endpoint are used by the default client.
 * Client injection is for isolated transport tests; it is a trusted boundary. */
export class S3AuthorityObjectStore implements AuthorityObjectStore, AuthorityHeadPublisher {
  private readonly config: Configuration;
  private readonly client: S3Client;
  constructor(config: Configuration, credentials: NonNullable<S3ClientConfig['credentials']>, client?: S3Client) {
    this.config = configuration.parse(config);
    if (!credentials) throw new Error('Explicit recovery storage credentials are required');
    this.client = client ?? new S3Client({ region: 'eu-west-1', credentials,
      endpoint: 'https://s3.eu-west-1.amazonaws.com', maxAttempts: 1,
      followRegionRedirects: false, requestHandler: { connectionTimeout: 5000, requestTimeout: 15000,
        throwOnRequestTimeout: true } });
  }

  private request(key: string, creating = false) {
    const prefix = `authority/${this.config.installationId}/${this.config.organisationId}/`;
    const suffix = key.startsWith(prefix) ? key.slice(prefix.length) : '';
    if (!/^\d{10}\.json$/.test(suffix) || Number(suffix.slice(0, 10)) < 1 ||
      Number(suffix.slice(0, 10)) > (creating ? 10000 : 10001)) {
      throw new Error('Invalid recovery authority object scope');
    }
    return { Bucket: this.config.bucket, Key: key, ExpectedBucketOwner: this.config.accountId };
  }

  private validMetadata(value: { VersionId?: string; ServerSideEncryption?: string; SSEKMSKeyId?: string }) {
    return Boolean(value.VersionId && value.VersionId !== 'null' &&
      value.ServerSideEncryption === 'aws:kms' && value.SSEKMSKeyId === this.config.kmsKeyArn);
  }

  async read(key: string, signal?: AbortSignal): Promise<string | null> {
    return (await this.readObject(this.request(key), signal))?.body ?? null;
  }

  private async readObject(request: { Bucket: string; Key: string; ExpectedBucketOwner: string }, callerSignal?: AbortSignal) {
    let body: Readable | undefined;
    let responseReceived = false;
    const deadline = operationDeadline();
    const signal = callerSignal ? AbortSignal.any([callerSignal, deadline.signal]) : deadline.signal;
    const abortBody = () => { body?.destroy(new Error('Recovery storage deadline exceeded')); };
    signal.addEventListener('abort', abortBody, { once: true });
    try {
      if (signal.aborted) throw new Error('Recovery storage read cancelled');
      const response = await this.client.send(new GetObjectCommand({ ...request, ChecksumMode: 'ENABLED' }),
        { abortSignal: signal });
      responseReceived = true;
      if (response.Body instanceof Readable) body = response.Body;
      if (signal.aborted) throw new Error('Recovery storage deadline exceeded');
      if (!body || response.DeleteMarker || !this.validMetadata(response) ||
        !Number.isInteger(response.ContentLength) || response.ContentLength! < 0 || response.ContentLength! > 4096) {
        throw new Error('Invalid object metadata');
      }
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of body) {
        if (!(chunk instanceof Uint8Array)) throw new Error('Invalid body stream');
        length += chunk.byteLength;
        if (length > 4096) throw new Error('Object exceeds limit');
        chunks.push(Buffer.from(chunk));
      }
      if (length !== response.ContentLength) throw new Error('Incomplete object');
      return { body: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
        etag: response.ETag, versionId: response.VersionId! };
    } catch (error) {
      const parsed = errorMetadata.safeParse(error);
      if (!responseReceived && parsed.success && parsed.data.name === 'NoSuchKey' &&
        parsed.data.$metadata?.httpStatusCode === 404) return null;
      throw new Error('Recovery S3 read failed');
    } finally {
      deadline.dispose(); signal.removeEventListener('abort', abortBody); body?.destroy();
    }
  }

  async create(key: string, body: string): Promise<boolean> {
    return this.writeObject(this.request(key, true), body, { IfNoneMatch: '*' });
  }

  private async writeObject(request: { Bucket: string; Key: string; ExpectedBucketOwner: string }, body: string,
    condition: { IfNoneMatch: '*' } | { IfMatch: string }) {
    if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > 4096) throw new Error('Invalid recovery object size');
    const deadline = operationDeadline();
    try {
      const response = await this.client.send(new PutObjectCommand({ ...request, Body: body,
        ...condition, ContentType: 'application/json', ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: this.config.kmsKeyArn, ChecksumSHA256: createHash('sha256').update(body).digest('base64') }),
        { abortSignal: deadline.signal });
      if (deadline.signal.aborted) throw new Error('Recovery storage deadline exceeded');
      if (!this.validMetadata(response)) throw new Error('Missing write proof');
      return true;
    } catch (error) {
      const parsed = errorMetadata.safeParse(error);
      if (parsed.success && parsed.data.$metadata?.httpStatusCode === 412) return false;
      throw new Error('Recovery S3 write outcome is unknown');
    } finally { deadline.dispose(); }
  }

  private headRequest() {
    return { Bucket: this.config.bucket, ExpectedBucketOwner: this.config.accountId,
      Key: `authority/${this.config.installationId}/${this.config.organisationId}/head.json` };
  }

  private checkBinding(value: AuthorityCheckpoint) {
    if (value.installationId !== this.config.installationId || value.organisationId !== this.config.organisationId) {
      throw new Error('Recovery S3 head binding mismatch');
    }
  }

  private async currentHead() {
    const object = await this.readObject(this.headRequest());
    if (!object) throw new Error('Recovery S3 head is missing; initialization is not automatic');
    try {
      const value = headEnvelope.parse(JSON.parse(object.body));
      this.checkBinding(value);
      const tag = etag.parse(object.etag);
      const versionId = z.string().min(1).max(1024).parse(object.versionId);
      const revision = createHash('sha256').update(JSON.stringify({ request: this.headRequest(),
        etag: tag, versionId, body: object.body })).digest('hex');
      return { checkpoint: checkpoint.parse({ installationId: value.installationId,
        organisationId: value.organisationId, generation: value.generation, digest: value.digest }), etag: tag, revision };
    } catch { throw new Error('Recovery S3 head verification failed'); }
  }

  async readHead() {
    const current = await this.currentHead();
    return { ...current.checkpoint, revision: current.revision };
  }

  /** S3 atomically matches ETag, not VersionId. A fresh publication ID prevents
   * this writer from recreating old bytes. Out-of-band privileged replay remains
   * outside this guarantee and must be addressed by custody/policy controls. */
  async compareAndSwap(expectedRevision: string, raw: AuthorityCheckpoint): Promise<boolean> {
    z.string().regex(/^[a-f0-9]{64}$/).parse(expectedRevision);
    const next = checkpoint.parse(raw); this.checkBinding(next);
    const current = await this.currentHead();
    if (current.revision !== expectedRevision) return false;
    if (next.generation !== current.checkpoint.generation + 1) {
      throw new Error('Recovery S3 head must advance exactly one generation');
    }
    return this.writeObject(this.headRequest(), JSON.stringify({ format: 1, ...next, publicationId: randomUUID() }),
      { IfMatch: current.etag });
  }
}
