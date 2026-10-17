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
  })
  .strict()
  .refine((c) => c.kmsKeyArn.split(':')[4] === c.accountId);
export type MaintenanceArtifactKind = 'BASELINE' | 'OBSERVATION';
export type MaintenanceArtifact = { body: string; sha256: string };
export type MaintenanceArtifactPin = {
  kind: MaintenanceArtifactKind;
  versionId: string;
  sha256: string;
  byteLength: number;
};
export type MaintenanceArtifactPolicy<P extends MaintenanceArtifactPin> = {
  namespace: 'write' | 'signed' | 'resumable';
  pinSchema: z.ZodType<P>;
  limits: Record<MaintenanceArtifactKind, number>;
  baseline: (raw: unknown) => MaintenanceArtifact;
  parseObservation: (raw: unknown) => MaintenanceArtifact;
  observationFromValue: (raw: unknown) => MaintenanceArtifact;
  assertPair: (
    baseline: MaintenanceArtifact,
    observation: MaintenanceArtifact,
  ) => void;
  failure: () => Error;
};
/** Conditional exact-version evidence custody only. The parent must durably pin
 * the acknowledged baseline before revocation. No head transition, provider
 * mutation, retry, replacement, current tenant authority or reopening exists. */
export class S3MaintenanceArtifactStore<P extends MaintenanceArtifactPin> {
  private readonly config: z.infer<typeof configuration>;
  private readonly client: S3Client;
  private readonly policy: MaintenanceArtifactPolicy<P>;
  private readonly attempted = new Set<MaintenanceArtifactKind>();
  constructor(
    raw: unknown,
    credentials: NonNullable<S3ClientConfig['credentials']>,
    policy: MaintenanceArtifactPolicy<P>,
    client?: S3Client,
  ) {
    this.policy = { ...policy, limits: { ...policy.limits } };
    this.config = configuration.parse(raw);
    if (!credentials) throw this.policy.failure();
    z.enum(['write', 'signed', 'resumable']).parse(policy.namespace);
    z.object({
      BASELINE: z.number().int().min(1).max(16384),
      OBSERVATION: z.number().int().min(1).max(16384),
    })
      .strict()
      .parse(policy.limits);
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
  private request(kind: MaintenanceArtifactKind) {
    return {
      Bucket: this.config.bucket,
      ExpectedBucketOwner: this.config.accountId,
      Key: `managed-maintenance/${this.config.installationId}/${this.config.maintenance.attemptId}/${this.policy.namespace}-${kind === 'BASELINE' ? 'baseline' : 'observation'}.json`,
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
      stop = () => reject(this.policy.failure());
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
          throw this.policy.failure();
        }
        return response;
      });
      return await Promise.race([pending, cancelled]);
    } finally {
      signal.removeEventListener('abort', stop);
    }
  }
  private baseline(raw: unknown) {
    return this.policy.baseline(raw);
  }
  private async read(
    raw: unknown,
    kind: MaintenanceArtifactKind,
    caller?: AbortSignal,
  ) {
    const pin = this.policy.pinSchema.parse(raw);
    if (pin.kind !== kind || pin.byteLength > this.policy.limits[kind])
      throw this.policy.failure();
    const controller = new AbortController(),
      signal = caller
        ? AbortSignal.any([controller.signal, caller])
        : controller.signal;
    const timer = setTimeout(() => controller.abort(), 15000);
    let body: Readable | undefined;
    const abort = () => body?.destroy(this.policy.failure());
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
        throw this.policy.failure();
      const chunks: Buffer[] = [];
      let count = 0;
      for await (const chunk of body) {
        if (!(chunk instanceof Uint8Array)) throw this.policy.failure();
        count += chunk.byteLength;
        if (count > pin.byteLength) throw this.policy.failure();
        chunks.push(Buffer.from(chunk));
      }
      if (signal.aborted || count !== pin.byteLength)
        throw this.policy.failure();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(
          Buffer.concat(chunks),
        ),
        artifact = { body: text, sha256: pin.sha256 };
      return kind === 'BASELINE'
        ? this.baseline(artifact)
        : this.policy.parseObservation(artifact);
    } catch {
      throw this.policy.failure();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      body?.destroy();
      controller.abort();
    }
  }
  private async publish(
    kind: MaintenanceArtifactKind,
    artifact: MaintenanceArtifact,
    caller?: AbortSignal,
  ) {
    if (
      Buffer.byteLength(artifact.body) > this.policy.limits[kind] ||
      createHash('sha256').update(artifact.body).digest('hex') !==
        artifact.sha256
    )
      throw this.policy.failure();
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
      if (signal.aborted || !this.metadata(response))
        throw this.policy.failure();
      const pin = this.policy.pinSchema.parse({
        kind,
        versionId: response.VersionId,
        sha256: artifact.sha256,
        byteLength: Buffer.byteLength(artifact.body),
      });
      const retained = await this.read(pin, kind, signal);
      if (retained.body !== artifact.body) throw this.policy.failure();
      return pin;
    } catch {
      throw this.policy.failure();
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  async publishBaseline(raw: unknown, caller?: AbortSignal) {
    if (this.attempted.has('BASELINE')) throw this.policy.failure();
    this.attempted.add('BASELINE');
    try {
      return await this.publish('BASELINE', this.baseline(raw), caller);
    } catch {
      throw this.policy.failure();
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
    if (this.attempted.has('OBSERVATION')) throw this.policy.failure();
    this.attempted.add('OBSERVATION');
    try {
      const baseline = await this.observeBaseline(baselinePin, caller),
        artifact = this.policy.observationFromValue(raw);
      this.policy.assertPair(baseline, artifact);
      return await this.publish('OBSERVATION', artifact, caller);
    } catch {
      throw this.policy.failure();
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
      this.policy.assertPair(baseline, artifact);
      return artifact;
    } catch {
      throw this.policy.failure();
    }
  }
}
