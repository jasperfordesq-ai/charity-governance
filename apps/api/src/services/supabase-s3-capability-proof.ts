import { assertOriginalS3PresignedUrl } from './s3-capability-target.js';
import {
  decodeNativeS3FeatureDisabled,
  isNativeS3FeatureDisabledError,
} from './s3-feature-response.js';
import { Readable } from 'node:stream';
import { z } from 'zod';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  ListPartsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  BoundedStorageProbeTransport,
  type StorageProbeBudget as Budget,
} from './bounded-storage-probe-transport.js';
import { credentialReadMaintenanceBindingSchema } from './credential-read-evidence.js';
import {
  s3ProbeHash as hash,
  s3CapabilityPinSchema,
  s3CapabilityBaselineSchema,
  parseS3CapabilityBaseline,
  assertS3CapabilityPair,
  s3ProbeOperations,
} from './s3-capability-contract.js';
const sha = z.string().regex(/^[a-f0-9]{64}$/),
  uuid = z
    .string()
    .uuid()
    .refine((v) => v === v.toLowerCase());
const configSchema = z
  .object({
    installationId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
    projectRef: z.string().regex(/^[a-z0-9]{20}$/),
    endpoint: z.enum(['DIRECT', 'GATEWAY']),
    region: z.enum(['eu-west-1', 'eu-central-1']),
    bucket: z.literal('charitypilot-recovery-s3-probes'),
    maintenance: credentialReadMaintenanceBindingSchema,
    providerRelease: z
      .object({
        sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
        imageDigest: sha,
      })
      .strict(),
    control: z.object({ id: uuid, sha256: sha }).strict(),
    retired: z
      .object({ id: uuid, accessKeyIdSha256: sha, secretAccessKeySha256: sha })
      .strict(),
  })
  .strict();
type Pin = z.infer<typeof s3CapabilityPinSchema>;
export type RetainS3Capability = (
  value: {
    presignedUrl: string;
    uploadId: string;
    presignedUrlSha256: string;
    uploadIdSha256: string;
  },
  signal: AbortSignal,
) => Promise<Pin>;
type SignedS3HttpRequest = {
  protocol: string;
  hostname: string;
  port?: number;
  path: string;
  method: string;
  headers: Record<string, string>;
  query?: Record<string, string | string[] | null>;
  body?: unknown;
};
type Response = {
  status: number;
  date: number;
  bytes: Buffer;
  contentType: string | null;
};
type Runtime = { b: Budget; sdk: S3Client; responses: Response[] };
type Slot =
  | 'standard'
  | 'presigned'
  | 'multipart'
  | 'multipart-control'
  | 'delete-control'
  | 'create-denied'
  | 'multipart-create-denied'
  | 'control-before'
  | 'control-after';
const prefix = Buffer.alloc(5242880, 0x43),
  a = Buffer.from('A'),
  bPayload = Buffer.from('B'),
  controlPayload = Buffer.from('P');
const failure = () =>
  new Error(
    'S3 capability proof is unresolved; preserve the original attempt and synthetic multipart residue without retry or cleanup',
  );
const encode = (v: string) =>
  encodeURIComponent(v).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
/** One reviewed S3 key and original PUT/multipart capabilities, one endpoint.
 * Requires actual feature-specific denials, not generic credential/outage errors. */
export class SupabaseS3CapabilityProof {
  private readonly config: z.infer<typeof configSchema>;
  private readonly http: BoundedStorageProbeTransport;
  private readonly control: string;
  private readonly credentials: {
    accessKeyId: string;
    secretAccessKey: string;
  };
  private baselineAttempted = false;
  private verificationAttempted = false;
  constructor(raw: unknown, secrets: unknown, transport: typeof fetch = fetch) {
    this.config = configSchema.parse(raw);
    const supplied = z
      .object({
        control: z
          .object({
            id: uuid,
            secret: z.string().regex(/^sb_secret_[A-Za-z0-9_-]{16,512}$/),
          })
          .strict(),
        retired: z
          .object({
            id: uuid,
            accessKeyId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
            secretAccessKey: z.string().regex(/^[!-~]{16,512}$/),
          })
          .strict(),
      })
      .strict()
      .parse(secrets);
    if (
      supplied.control.id !== this.config.control.id ||
      hash(supplied.control.secret) !== this.config.control.sha256 ||
      supplied.retired.id !== this.config.retired.id ||
      hash(supplied.retired.accessKeyId) !==
        this.config.retired.accessKeyIdSha256 ||
      hash(supplied.retired.secretAccessKey) !==
        this.config.retired.secretAccessKeySha256
    )
      throw failure();
    this.control = supplied.control.secret;
    this.credentials = {
      accessKeyId: supplied.retired.accessKeyId,
      secretAccessKey: supplied.retired.secretAccessKey,
    };
    this.http = new BoundedStorageProbeTransport(this.origin(), transport);
  }
  configurationDigest() {
    const { maintenance, ...registry } = this.config;
    return hash(
      JSON.stringify({
        format: 1,
        policy: 'ORIGINAL_S3_KEY_PRESIGNED_PUT_MULTIPART_FEATURE_EXCLUSION_V1',
        ...registry,
        prefixSha256: hash(prefix),
        presignSeconds: 900,
      }),
    );
  }
  private origin() {
    return (
      'https://' +
      this.config.projectRef +
      (this.config.endpoint === 'DIRECT'
        ? '.storage.supabase.co'
        : '.supabase.co')
    );
  }
  private endpoint() {
    return this.origin() + '/storage/v1/s3';
  }
  private object(slot: Slot) {
    return (
      'charitypilot-recovery-s3-probe/' +
      this.config.installationId +
      '/' +
      this.config.maintenance.attemptId +
      '/' +
      slot +
      '.bin'
    );
  }
  private async work<T>(run: (r: Runtime) => Promise<T>, caller?: AbortSignal) {
    return this.http
      .work(async (budget) => {
        const responses: Response[] = [],
          sdk = new S3Client({
            region: this.config.region,
            endpoint: this.endpoint(),
            forcePathStyle: true,
            credentials: this.credentials,
            maxAttempts: 1,
            followRegionRedirects: false,
            requestChecksumCalculation: 'WHEN_REQUIRED',
            responseChecksumValidation: 'WHEN_REQUIRED',
            requestHandler: {
              handle: async (request: SignedS3HttpRequest) => {
                if (
                  request.protocol !== 'https:' ||
                  request.hostname !== new URL(this.origin()).hostname ||
                  (request.port && request.port !== 443) ||
                  !request.path.startsWith(
                    '/storage/v1/s3/' + this.config.bucket + '/',
                  )
                )
                  throw failure();
                const method = z
                    .enum(['GET', 'HEAD', 'POST', 'PUT', 'DELETE'])
                    .parse(request.method),
                  query = Object.entries(request.query ?? {})
                    .flatMap(([k, v]) =>
                      (Array.isArray(v) ? v : [v]).map(
                        (value) =>
                          encode(k) + '=' + encode(String(value ?? '')),
                      ),
                    )
                    .join('&'),
                  url =
                    this.origin() + request.path + (query ? '?' + query : '');
                const body =
                  request.body === undefined
                    ? undefined
                    : typeof request.body === 'string'
                      ? Buffer.from(request.body)
                      : request.body instanceof Uint8Array
                        ? Buffer.from(request.body)
                        : undefined;
                if (request.body !== undefined && !body) throw failure();
                const r = await this.http.request(
                  method,
                  url,
                  budget,
                  request.headers,
                  body,
                );
                responses.push({
                  ...r,
                  contentType: r.headers.get('content-type'),
                });
                return {
                  response: {
                    statusCode: r.status,
                    headers: Object.fromEntries(r.headers.entries()),
                    body: Readable.from([r.bytes]),
                  },
                };
              },
            },
          });
        try {
          return await run({ b: budget, sdk, responses });
        } finally {
          sdk.destroy();
          for (const r of responses) r.bytes.fill(0);
        }
      }, caller)
      .catch(() => {
        throw failure();
      });
  }
  private async send<T>(
    r: Runtime,
    execute: () => Promise<T>,
    status: number,
    disabled = false,
  ) {
    const before = r.responses.length;
    let output: T;
    try {
      output = await execute();
    } catch (error) {
      const response = r.responses.at(-1);
      if (
        !disabled ||
        r.responses.length !== before + 1 ||
        response?.status !== 403 ||
        !isNativeS3FeatureDisabledError(
          error,
          response.status,
          response.contentType,
        )
      )
        throw failure();
      return {
        disabled: true as const,
        providerObservedAt: new Date(response.date).toISOString(),
      };
    }
    const response = r.responses.at(-1);
    if (
      disabled ||
      r.responses.length !== before + 1 ||
      response?.status !== status
    )
      throw failure();
    return { disabled: false as const, output };
  }
  private async bucket(r: Runtime) {
    const response = await this.http.request(
      'GET',
      this.origin() + '/storage/v1/bucket/' + this.config.bucket,
      r.b,
      { apikey: this.control },
    );
    try {
      const v = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(response.bytes),
      );
      if (
        response.status !== 200 ||
        v.id !== this.config.bucket ||
        v.public !== false
      )
        throw failure();
    } finally {
      response.bytes.fill(0);
    }
  }
  private async objectState(slot: Slot, expected: Buffer | null, r: Runtime) {
    const response = await this.http.request(
      'GET',
      this.origin() +
        '/storage/v1/object/' +
        this.config.bucket +
        '/' +
        this.object(slot),
      r.b,
      { apikey: this.control },
    );
    try {
      if (
        expected === null
          ? response.status !== 404
          : response.status !== 200 || !response.bytes.equals(expected)
      )
        throw failure();
    } finally {
      response.bytes.fill(0);
    }
  }
  private async restPositive(
    slot: 'control-before' | 'control-after',
    r: Runtime,
  ) {
    await this.objectState(slot, null, r);
    const response = await this.http.request(
      'POST',
      this.origin() +
        '/storage/v1/object/' +
        this.config.bucket +
        '/' +
        this.object(slot),
      r.b,
      {
        apikey: this.control,
        'Content-Type': 'text/plain',
        'x-upsert': 'false',
      },
      controlPayload,
    );
    try {
      if (![200, 201].includes(response.status)) throw failure();
    } finally {
      response.bytes.fill(0);
    }
    await this.objectState(slot, controlPayload, r);
  }
  private async put(slot: Slot, bytes: Buffer, r: Runtime) {
    const sent = await this.send(
      r,
      () =>
        r.sdk.send(
          new PutObjectCommand({
            Bucket: this.config.bucket,
            Key: this.object(slot),
            Body: bytes,
            ContentType: 'text/plain',
          }),
        ),
      200,
    );
    if (sent.disabled) throw failure();
  }
  private async getStandard(expected: Buffer, r: Runtime) {
    const sent = await this.send(
      r,
      () =>
        r.sdk.send(
          new GetObjectCommand({
            Bucket: this.config.bucket,
            Key: this.object('standard'),
          }),
        ),
      200,
    );
    if (sent.disabled) throw failure();
    const stream = sent.output.Body;
    if (!(stream instanceof Readable)) throw failure();
    const chunks: Buffer[] = [];
    let length = 0;
    try {
      for await (const part of stream) {
        if (!(part instanceof Uint8Array) || (length += part.length) > 32768)
          throw failure();
        chunks.push(Buffer.from(part));
      }
      if (!Buffer.concat(chunks).equals(expected)) throw failure();
    } finally {
      stream.destroy();
      for (const c of chunks) c.fill(0);
    }
  }
  private async create(slot: 'multipart' | 'multipart-control', r: Runtime) {
    const sent = await this.send(
      r,
      () =>
        r.sdk.send(
          new CreateMultipartUploadCommand({
            Bucket: this.config.bucket,
            Key: this.object(slot),
            ContentType: 'text/plain',
          }),
        ),
      200,
    );
    if (sent.disabled) throw failure();
    return z
      .string()
      .regex(/^[!-~]{1,1024}$/)
      .parse(sent.output.UploadId);
  }
  private async part(
    slot: 'multipart' | 'multipart-control',
    uploadId: string,
    bytes: Buffer,
    r: Runtime,
  ) {
    const sent = await this.send(
      r,
      () =>
        r.sdk.send(
          new UploadPartCommand({
            Bucket: this.config.bucket,
            Key: this.object(slot),
            UploadId: uploadId,
            PartNumber: 1,
            Body: bytes,
          }),
        ),
      200,
    );
    if (sent.disabled) throw failure();
    return z
      .string()
      .regex(/^"[\x21\x23-\x7e]{1,128}"$/)
      .parse(sent.output.ETag);
  }
  private async positiveMultipart(r: Runtime) {
    const uploadId = await this.create('multipart-control', r),
      etag = await this.part('multipart-control', uploadId, controlPayload, r);
    await this.send(
      r,
      () =>
        r.sdk.send(
          new CompleteMultipartUploadCommand({
            Bucket: this.config.bucket,
            Key: this.object('multipart-control'),
            UploadId: uploadId,
            MultipartUpload: { Parts: [{ PartNumber: 1, ETag: etag }] },
          }),
        ),
      200,
    );
    await this.objectState('multipart-control', controlPayload, r);
  }
  private presigned(raw: unknown) {
    return assertOriginalS3PresignedUrl(raw, {
      installationId: this.config.installationId,
      projectRef: this.config.projectRef,
      endpoint: this.config.endpoint,
      region: this.config.region,
      attemptId: this.config.maintenance.attemptId,
      accessKeyIdSha256: this.config.retired.accessKeyIdSha256,
    });
  }
  private async presignedPut(
    url: string,
    bytes: Buffer,
    r: Runtime,
    disabled = false,
  ) {
    const parsed = this.presigned(url);
    if (
      Date.now() + 60000 > Date.parse(parsed.expiresAt) ||
      Date.parse(parsed.issuedAt) > Date.now() + 30000
    )
      throw failure();
    const response = await this.http.request(
      'PUT',
      url,
      r.b,
      { 'Content-Type': 'text/plain' },
      bytes,
    );
    try {
      if (response.date + 60000 > Date.parse(parsed.expiresAt)) throw failure();
      if (!disabled) {
        if (response.status !== 200) throw failure();
        return null;
      }
      // Use the actual SDK XML decoder and error mapping for this exact response,
      // without dispatching a second signed request or changing the saved URL.
      if (!(await decodeNativeS3FeatureDisabled(response, r.b.signal)))
        throw failure();
      return new Date(response.date).toISOString();
    } finally {
      response.bytes.fill(0);
    }
  }
  assertBaseline(raw: unknown, custodyDigest: string) {
    const { artifact, value: v } = parseS3CapabilityBaseline(raw);
    if (
      v.configurationDigest !== this.configurationDigest() ||
      JSON.stringify(v.maintenance) !==
        JSON.stringify(this.config.maintenance) ||
      v.credentialId !== this.config.retired.id ||
      v.capabilityPin.custodyDigest !== sha.parse(custodyDigest) ||
      Date.parse(v.capturedAt) > Date.now() + 60000
    )
      throw failure();
    return artifact;
  }
  async baseline(
    retain: RetainS3Capability,
    custodyDigest: string,
    caller?: AbortSignal,
  ) {
    if (this.baselineAttempted) throw failure();
    this.baselineAttempted = true;
    return this.work(async (r) => {
      sha.parse(custodyDigest);
      if (typeof retain !== 'function') throw failure();
      await this.bucket(r);
      for (const slot of [
        'standard',
        'presigned',
        'multipart',
        'create-denied',
        'multipart-control',
        'delete-control',
      ] as const)
        await this.objectState(slot, null, r);
      await this.put('standard', a, r);
      await this.getStandard(a, r);
      await this.put('standard', bPayload, r);
      await this.getStandard(bPayload, r);
      await this.put('delete-control', a, r);
      await this.send(
        r,
        () =>
          r.sdk.send(
            new DeleteObjectCommand({
              Bucket: this.config.bucket,
              Key: this.object('delete-control'),
            }),
          ),
        204,
      );
      await this.objectState('delete-control', null, r);
      const url = this.presigned(
          await getSignedUrl(
            r.sdk,
            new PutObjectCommand({
              Bucket: this.config.bucket,
              Key: this.object('presigned'),
              ContentType: 'text/plain',
            }),
            { expiresIn: 900 },
          ),
        ),
        uploadId = await this.create('multipart', r),
        pin = s3CapabilityPinSchema.parse(
          await retain(
            {
              presignedUrl: url.url,
              uploadId,
              presignedUrlSha256: hash(url.url),
              uploadIdSha256: hash(uploadId),
            },
            r.b.signal,
          ),
        );
      r.b.signal.throwIfAborted();
      if (
        pin.custodyDigest !== custodyDigest ||
        pin.presignedUrlSha256 !== hash(url.url) ||
        pin.uploadIdSha256 !== hash(uploadId)
      )
        throw failure();
      await this.presignedPut(url.url, a, r);
      await this.objectState('presigned', a, r);
      const etag = await this.part('multipart', uploadId, prefix, r),
        listed = await this.send(
          r,
          () =>
            r.sdk.send(
              new ListPartsCommand({
                Bucket: this.config.bucket,
                Key: this.object('multipart'),
                UploadId: uploadId,
              }),
            ),
          200,
        );
      if (
        listed.disabled ||
        listed.output.IsTruncated ||
        listed.output.Parts?.length !== 1 ||
        listed.output.Parts[0].PartNumber !== 1 ||
        listed.output.Parts[0].ETag !== etag ||
        listed.output.Parts[0].Size !== prefix.length
      )
        throw failure();
      await this.positiveMultipart(r);
      await this.objectState('standard', bPayload, r);
      await this.objectState('presigned', a, r);
      await this.objectState('multipart', null, r);
      const body = JSON.stringify(
        s3CapabilityBaselineSchema.parse({
          format: 1,
          kind: 'SUPABASE_S3_CAPABILITY_BASELINE_V1',
          configurationDigest: this.configurationDigest(),
          maintenance: this.config.maintenance,
          credentialId: this.config.retired.id,
          capabilityPin: pin,
          capturedAt: new Date().toISOString(),
          presignedIssuedAt: url.issuedAt,
          presignedExpiresAt: url.expiresAt,
          partETag: etag,
          partBytes: prefix.length,
          partSha256: hash(prefix),
          standardSha256: hash(bPayload),
          presignedSha256: hash(a),
        }),
      );
      return this.assertBaseline({ body, sha256: hash(body) }, custodyDigest);
    }, caller);
  }
  async verifyRefusal(
    raw: unknown,
    custodyDigest: string,
    secret: unknown,
    caller?: AbortSignal,
  ) {
    if (this.verificationAttempted) throw failure();
    this.verificationAttempted = true;
    return this.work(async (r) => {
      const baseline = this.assertBaseline(raw, custodyDigest),
        saved = parseS3CapabilityBaseline(baseline).value,
        v = z
          .object({
            reference: uuid,
            presignedUrl: z.string().min(1).max(8192),
            uploadId: z.string().regex(/^[!-~]{1,1024}$/),
          })
          .strict()
          .parse(secret),
        url = this.presigned(v.presignedUrl);
      if (
        v.reference !== saved.capabilityPin.reference ||
        hash(v.presignedUrl) !== saved.capabilityPin.presignedUrlSha256 ||
        hash(v.uploadId) !== saved.capabilityPin.uploadIdSha256 ||
        url.issuedAt !== saved.presignedIssuedAt ||
        url.expiresAt !== saved.presignedExpiresAt ||
        Date.now() + 60000 > Date.parse(url.expiresAt)
      )
        throw failure();
      await this.bucket(r);
      await this.objectState('standard', bPayload, r);
      await this.objectState('presigned', a, r);
      await this.objectState('multipart', null, r);
      await this.objectState('create-denied', null, r);
      await this.restPositive('control-before', r);
      const common = { Bucket: this.config.bucket },
        multipart = {
          ...common,
          Key: this.object('multipart'),
          UploadId: v.uploadId,
        },
        commands = [
          () =>
            r.sdk.send(
              new GetObjectCommand({ ...common, Key: this.object('standard') }),
            ),
          () =>
            r.sdk.send(
              new PutObjectCommand({
                ...common,
                Key: this.object('create-denied'),
                Body: a,
              }),
            ),
          () =>
            r.sdk.send(
              new PutObjectCommand({
                ...common,
                Key: this.object('standard'),
                Body: a,
              }),
            ),
          () =>
            r.sdk.send(
              new DeleteObjectCommand({
                ...common,
                Key: this.object('standard'),
              }),
            ),
          () =>
            r.sdk.send(
              new CreateMultipartUploadCommand({
                ...common,
                Key: this.object('multipart-create-denied'),
              }),
            ),
          () =>
            r.sdk.send(
              new UploadPartCommand({
                ...multipart,
                PartNumber: 2,
                Body: controlPayload,
              }),
            ),
          () =>
            r.sdk.send(
              new CompleteMultipartUploadCommand({
                ...multipart,
                MultipartUpload: {
                  Parts: [{ PartNumber: 1, ETag: saved.partETag }],
                },
              }),
            ),
        ];
      const refusals = [];
      for (let i = 0; i < commands.length; i++) {
        const denied = await this.send(r, commands[i], 200, true);
        if (!denied.disabled) throw failure();
        refusals.push({
          operation: s3ProbeOperations[i],
          status: 403 as const,
          code: 'FeatureNotEnabled' as const,
          providerObservedAt: denied.providerObservedAt,
        });
      }
      const providerObservedAt = await this.presignedPut(
        v.presignedUrl,
        bPayload,
        r,
        true,
      );
      if (!providerObservedAt) throw failure();
      refusals.push({
        operation: 'PRESIGNED_PUT' as const,
        status: 403 as const,
        code: 'FeatureNotEnabled' as const,
        providerObservedAt,
      });
      await this.objectState('standard', bPayload, r);
      await this.objectState('presigned', a, r);
      await this.objectState('multipart', null, r);
      await this.objectState('create-denied', null, r);
      await this.restPositive('control-after', r);
      await this.bucket(r);
      const core = {
        kind: 'SUPABASE_S3_DISABLED_V1' as const,
        configurationDigest: this.configurationDigest(),
        baselineSha256: baseline.sha256,
        capabilityPinSha256: saved.capabilityPin.sha256,
        credentialId: this.config.retired.id,
        observedAt: new Date().toISOString(),
        refusals,
      };
      return assertS3CapabilityPair(baseline, {
        ...core,
        observationDigest: hash(JSON.stringify(core)),
        testedS3FeatureRefusalsObserved: true,
        coverage:
          'ONE_REVIEWED_S3_KEY_AND_ORIGINAL_CAPABILITIES_AT_ONE_ENDPOINT_ONLY',
        s3CredentialsRevoked: false,
        presignedCapabilitiesRevoked: false,
        multipartUploadsDrained: false,
        inFlightWritesDrained: false,
        providerReleaseAttested: false,
        wholeStorageQuiesced: false,
        actionAuthorized: false,
      });
    }, caller);
  }
}
