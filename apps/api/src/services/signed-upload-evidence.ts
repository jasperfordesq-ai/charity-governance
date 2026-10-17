import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
  type GetObjectCommandOutput,
  type PutObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { z } from 'zod';
import { credentialReadMaintenanceBindingSchema } from './credential-read-evidence.js';
import {
  parseSignedUploadBaseline,
  parseSignedUploadObservation,
  signedUploadObservationArtifact,
  signedUploadBaselineSchema,
  assertSignedUploadPair,
  type SignedUploadArtifact,
} from './signed-upload-evidence-contract.js';
const sha = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .length(64);
const configuration = z
  .object({
    installationId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
    bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
    accountId: z.string().regex(/^\d{12}$/),
    kmsKeyArn: z
      .string()
      .regex(
        /^arn:aws:kms:eu-west-1:\d{12}:key\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
      ),
    maintenance: credentialReadMaintenanceBindingSchema,
    probeDigest: sha,
    credentialCustodyDigest: sha,
  })
  .strict()
  .refine((c) => c.kmsKeyArn.split(':')[4] === c.accountId);
const pinSchema = z
  .object({
    kind: z.enum(['BASELINE', 'OBSERVATION']),
    versionId: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^[!-~]+$/)
      .refine((v) => v !== 'null'),
    sha256: sha,
    byteLength: z.number().int().min(1).max(8192),
  })
  .strict();
export type SignedUploadEvidencePin = z.infer<typeof pinSchema>;
export { pinSchema as signedUploadEvidencePinSchema };
export const signedUploadEvidenceStorageSchema = configuration
  .innerType()
  .omit({ maintenance: true, probeDigest: true, credentialCustodyDigest: true })
  .refine((c) => c.kmsKeyArn.split(':')[4] === c.accountId);
const failure = () =>
  new Error(
    'Independent signed-upload evidence is unresolved; preserve the original attempt without retrying publication',
  );

/** Conditional exact-version evidence custody only. The parent must durably pin
 * the acknowledged baseline before revocation. No head transition, provider
 * mutation, retry, replacement, current tenant authority or reopening exists. */
export class S3SignedUploadEvidence {
  private readonly config: z.infer<typeof configuration>;
  private readonly client: S3Client;
  private readonly attempted = new Set<SignedUploadEvidencePin['kind']>();
  constructor(
    raw: unknown,
    credentials: NonNullable<S3ClientConfig['credentials']>,
    client?: S3Client,
  ) {
    this.config = configuration.parse(raw);
    if (!credentials) throw failure();
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
  private request(kind: SignedUploadEvidencePin['kind']) {
    return {
      Bucket: this.config.bucket,
      ExpectedBucketOwner: this.config.accountId,
      Key: `managed-maintenance/${this.config.installationId}/${this.config.maintenance.attemptId}/signed-${kind === 'BASELINE' ? 'baseline' : 'observation'}.json`,
    };
  }
  private metadata(
    value: {
      VersionId?: string;
      ServerSideEncryption?: string;
      SSEKMSKeyId?: string;
    },
    versionId?: string,
  ) {
    return Boolean(
      value.VersionId &&
      value.VersionId !== 'null' &&
      value.ServerSideEncryption === 'aws:kms' &&
      value.SSEKMSKeyId === this.config.kmsKeyArn &&
      (versionId === undefined || value.VersionId === versionId),
    );
  }
  private send(
    command: GetObjectCommand,
    signal: AbortSignal,
  ): Promise<GetObjectCommandOutput>;
  private send(
    command: PutObjectCommand,
    signal: AbortSignal,
  ): Promise<PutObjectCommandOutput>;
  private async send(
    command: GetObjectCommand | PutObjectCommand,
    signal: AbortSignal,
  ) {
    let stop!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      stop = () => reject(failure());
      signal.addEventListener('abort', stop, { once: true });
    });
    try {
      signal.throwIfAborted();
      const pending = (
        command instanceof GetObjectCommand
          ? this.client.send(command, { abortSignal: signal })
          : this.client.send(command, { abortSignal: signal })
      ).then((response) => {
        if (signal.aborted) {
          if ('Body' in response && response.Body instanceof Readable)
            response.Body.destroy();
          throw failure();
        }
        return response;
      });
      return await Promise.race([pending, cancelled]);
    } finally {
      signal.removeEventListener('abort', stop);
    }
  }
  private baseline(raw: unknown) {
    const artifact = parseSignedUploadBaseline(raw),
      value = signedUploadBaselineSchema.parse(JSON.parse(artifact.body));
    if (
      value.configurationDigest !== this.config.probeDigest ||
      value.credentialPin.custodyDigest !==
        this.config.credentialCustodyDigest ||
      JSON.stringify(value.maintenance) !==
        JSON.stringify(this.config.maintenance)
    )
      throw failure();
    return artifact;
  }
  private async read(
    raw: unknown,
    kind: SignedUploadEvidencePin['kind'],
    caller?: AbortSignal,
  ) {
    const pin = pinSchema.parse(raw);
    if (pin.kind !== kind) throw failure();
    const controller = new AbortController(),
      signal = caller
        ? AbortSignal.any([controller.signal, caller])
        : controller.signal;
    const timer = setTimeout(() => controller.abort(), 15000);
    let body: Readable | undefined;
    const abort = () => body?.destroy(failure());
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      const response = await this.send(
        new GetObjectCommand({
          ...this.request(kind),
          VersionId: pin.versionId,
          ChecksumMode: 'ENABLED',
        }),
        signal,
      );
      if (response.Body instanceof Readable) body = response.Body;
      if (
        signal.aborted ||
        !body ||
        response.DeleteMarker ||
        !this.metadata(response, pin.versionId) ||
        response.ContentLength !== pin.byteLength
      )
        throw failure();
      const chunks: Buffer[] = [];
      let count = 0;
      for await (const chunk of body) {
        if (!(chunk instanceof Uint8Array)) throw failure();
        count += chunk.byteLength;
        if (count > pin.byteLength) throw failure();
        chunks.push(Buffer.from(chunk));
      }
      if (signal.aborted || count !== pin.byteLength) throw failure();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(
          Buffer.concat(chunks),
        ),
        artifact = { body: text, sha256: pin.sha256 };
      return kind === 'BASELINE'
        ? this.baseline(artifact)
        : parseSignedUploadObservation(artifact);
    } catch {
      throw failure();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      body?.destroy();
      controller.abort();
    }
  }
  private async publish(
    kind: SignedUploadEvidencePin['kind'],
    artifact: SignedUploadArtifact,
    caller?: AbortSignal,
  ) {
    const controller = new AbortController(),
      signal = caller
        ? AbortSignal.any([caller, controller.signal])
        : controller.signal,
      timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await this.send(
        new PutObjectCommand({
          ...this.request(kind),
          IfNoneMatch: '*',
          Body: artifact.body,
          ContentType: 'application/json',
          ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId: this.config.kmsKeyArn,
          ChecksumSHA256: createHash('sha256')
            .update(artifact.body)
            .digest('base64'),
        }),
        signal,
      );
      if (signal.aborted || !this.metadata(response)) throw failure();
      const pin = pinSchema.parse({
        kind,
        versionId: response.VersionId,
        sha256: artifact.sha256,
        byteLength: Buffer.byteLength(artifact.body),
      });
      const retained = await this.read(pin, kind, signal);
      if (retained.body !== artifact.body) throw failure();
      return pin;
    } catch {
      throw failure();
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  async publishBaseline(raw: unknown, caller?: AbortSignal) {
    if (this.attempted.has('BASELINE')) throw failure();
    this.attempted.add('BASELINE');
    try {
      return await this.publish('BASELINE', this.baseline(raw), caller);
    } catch {
      throw failure();
    }
  }
  async observeBaseline(pin: unknown, caller?: AbortSignal) {
    return this.read(pin, 'BASELINE', caller);
  }
  async publishObservation(
    raw: unknown,
    baselinePin: unknown,
    caller?: AbortSignal,
  ) {
    if (this.attempted.has('OBSERVATION')) throw failure();
    this.attempted.add('OBSERVATION');
    try {
      const baseline = await this.observeBaseline(baselinePin, caller),
        artifact = signedUploadObservationArtifact(raw);
      assertSignedUploadPair(baseline, artifact);
      return await this.publish('OBSERVATION', artifact, caller);
    } catch {
      throw failure();
    }
  }
  async observeObservation(
    pin: unknown,
    baselinePin: unknown,
    caller?: AbortSignal,
  ) {
    try {
      const baseline = await this.observeBaseline(baselinePin, caller),
        artifact = await this.read(pin, 'OBSERVATION', caller);
      assertSignedUploadPair(baseline, artifact);
      return artifact;
    } catch {
      throw failure();
    }
  }
}
