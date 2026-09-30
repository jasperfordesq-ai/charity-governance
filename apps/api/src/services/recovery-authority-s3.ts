import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { z } from 'zod';
import type { AuthorityObjectStore } from './recovery-authority-journal.js';

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

/** Intent objects only. Bucket provisioning, head publication, retention and
 * independent custody must be verified separately before production use.
 * No default credentials or ambient endpoint are used by the default client.
 * Client injection is for isolated transport tests; it is a trusted boundary. */
export class S3AuthorityObjectStore implements AuthorityObjectStore {
  private readonly config: Configuration;
  private readonly client: S3Client;
  constructor(config: Configuration, credentials: NonNullable<S3ClientConfig['credentials']>, client?: S3Client) {
    this.config = configuration.parse(config);
    if (!credentials) throw new Error('Explicit recovery storage credentials are required');
    this.client = client ?? new S3Client({ region: 'eu-west-1', credentials,
      endpoint: 'https://s3.eu-west-1.amazonaws.com', maxAttempts: 1,
      followRegionRedirects: false, requestHandler: { connectionTimeout: 5000, requestTimeout: 15000 } });
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

  async read(key: string): Promise<string | null> {
    const request = this.request(key);
    let body: Readable | undefined;
    let responseReceived = false;
    try {
      const response = await this.client.send(new GetObjectCommand({ ...request, ChecksumMode: 'ENABLED' }));
      responseReceived = true;
      if (response.Body instanceof Readable) body = response.Body;
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
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } catch (error) {
      const parsed = errorMetadata.safeParse(error);
      if (!responseReceived && parsed.success && parsed.data.name === 'NoSuchKey' &&
        parsed.data.$metadata?.httpStatusCode === 404) return null;
      throw new Error('Recovery S3 read failed');
    } finally { body?.destroy(); }
  }

  async create(key: string, body: string): Promise<boolean> {
    const request = this.request(key, true);
    if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > 4096) throw new Error('Invalid recovery object size');
    try {
      const response = await this.client.send(new PutObjectCommand({ ...request, Body: body,
        IfNoneMatch: '*', ContentType: 'application/json', ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: this.config.kmsKeyArn, ChecksumSHA256: createHash('sha256').update(body).digest('base64') }));
      if (!this.validMetadata(response)) throw new Error('Missing write proof');
      return true;
    } catch (error) {
      const parsed = errorMetadata.safeParse(error);
      if (parsed.success && parsed.data.$metadata?.httpStatusCode === 412) return false;
      throw new Error('Recovery S3 write outcome is unknown');
    }
  }
}
