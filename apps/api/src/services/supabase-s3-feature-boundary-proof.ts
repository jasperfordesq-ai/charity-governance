import { z } from 'zod';
import type { SupabaseStorageWriterControl } from './supabase-storage-writer-control.js';
import {
  BoundedStorageProbeTransport,
  type StorageProbeBudget as Budget,
} from './bounded-storage-probe-transport.js';
import { credentialReadMaintenanceBindingSchema } from './credential-read-evidence.js';
import { decodeNativeS3FeatureDisabled } from './s3-feature-response.js';
import { s3FeatureHash as hash } from './s3-feature-boundary-contract.js';
import {
  s3FeatureStageSchema,
  s3DisabledMetadataSchema,
  s3FeatureOperations,
  s3FeatureBoundaryArtifact,
  parseS3FeatureBoundary,
} from './s3-feature-boundary-contract.js';
const sha = z.string().regex(/^[a-f0-9]{64}$/),
  uuid = z.string().uuid();
const configuration = z
  .object({
    installationId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
    projectRef: z.string().regex(/^[a-z0-9]{20}$/),
    region: z.enum(['eu-west-1', 'eu-central-1']),
    bucket: z.literal('charitypilot-recovery-s3-probes'),
    stage: s3FeatureStageSchema,
    maintenance: credentialReadMaintenanceBindingSchema,
    providerRelease: z
      .object({
        sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
        imageDigest: sha,
      })
      .strict(),
    control: z.object({ id: uuid, sha256: sha }).strict(),
  })
  .strict();
type Endpoint = 'DIRECT' | 'GATEWAY';
type Slot =
  | 'protected'
  | 'after'
  | 'create'
  | 'multipart-create'
  | 'multipart-original'
  | 'presigned-shape';
const canary = Buffer.from('charitypilot-s3-feature-canary-v1'),
  replacement = Buffer.from('replacement-synthetic-byte');
const failure = () =>
  new Error(
    'Current S3 feature boundary is unresolved; preserve the original attempt and synthetic residue without retry or enabling S3',
  );
/** Active synthetic canaries, NOT read-only inspection or historical revocation.
 * No valid S3 credential/signature/issued UploadId is created or used. */
export class SupabaseS3FeatureBoundaryProof {
  private readonly config: z.infer<typeof configuration>;
  private readonly secret: string;
  private attempted = false;
  private readonly http: Record<Endpoint, BoundedStorageProbeTransport>;
  constructor(
    raw: unknown,
    secret: unknown,
    private readonly metadata: SupabaseStorageWriterControl,
    transport: typeof fetch = fetch,
  ) {
    this.config = configuration.parse(raw);
    this.secret = z
      .string()
      .regex(/^sb_secret_[A-Za-z0-9_-]{16,512}$/)
      .parse(secret);
    const scope = z
      .object({
        installationId: z.string(),
        projectRef: z.string(),
        captureKeyId: uuid,
        region: z.string(),
      })
      .strict()
      .parse(metadata.s3FeatureProofScope());
    if (
      hash(this.secret) !== this.config.control.sha256 ||
      scope.installationId !== this.config.installationId ||
      scope.projectRef !== this.config.projectRef ||
      scope.captureKeyId !== this.config.control.id ||
      scope.region !== this.config.region
    )
      throw failure();
    this.http = {
      DIRECT: new BoundedStorageProbeTransport(
        this.origin('DIRECT'),
        transport,
      ),
      GATEWAY: new BoundedStorageProbeTransport(
        this.origin('GATEWAY'),
        transport,
      ),
    };
  }
  configurationDigest() {
    const { maintenance, ...registry } = this.config;
    return hash(
      JSON.stringify({
        format: 1,
        policy: 'CURRENT_UNAUTHENTICATED_S3_FEATURE_BOUNDARY_BOTH_ENDPOINTS_V1',
        registry,
        metadata: this.metadata.configurationDigest(this.config.installationId),
        canarySha256: hash(canary),
        endpoints: ['DIRECT', 'GATEWAY'],
      }),
    );
  }
  private origin(endpoint: Endpoint) {
    return (
      'https://' +
      this.config.projectRef +
      (endpoint === 'DIRECT' ? '.storage.supabase.co' : '.supabase.co')
    );
  }
  private object(endpoint: Endpoint, slot: Slot) {
    return (
      'charitypilot-recovery-s3-current-probe/' +
      this.config.installationId +
      '/' +
      this.config.maintenance.attemptId +
      '/' +
      this.config.stage.toLowerCase() +
      '/' +
      endpoint.toLowerCase() +
      '/' +
      slot +
      '.bin'
    );
  }
  private rest(endpoint: Endpoint, slot: Slot) {
    return (
      this.origin(endpoint) +
      '/storage/v1/object/' +
      this.config.bucket +
      '/' +
      this.object(endpoint, slot)
    );
  }
  private s3(endpoint: Endpoint, slot: Slot) {
    return (
      this.origin(endpoint) +
      '/storage/v1/s3/' +
      this.config.bucket +
      '/' +
      this.object(endpoint, slot)
    );
  }
  private async bucket(endpoint: Endpoint, b: Budget) {
    const r = await this.http[endpoint].request(
      'GET',
      this.origin(endpoint) + '/storage/v1/bucket/' + this.config.bucket,
      b,
      { apikey: this.secret },
    );
    try {
      const v = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(r.bytes),
      );
      if (r.status !== 200 || v.id !== this.config.bucket || v.public !== false)
        throw failure();
    } finally {
      r.bytes.fill(0);
    }
  }
  private async objectState(
    endpoint: Endpoint,
    slot: Slot,
    expected: Buffer | null,
    b: Budget,
  ) {
    const r = await this.http[endpoint].request(
      'GET',
      this.rest(endpoint, slot),
      b,
      { apikey: this.secret },
    );
    try {
      if (
        expected === null
          ? r.status !== 404
          : r.status !== 200 || !r.bytes.equals(expected)
      )
        throw failure();
    } finally {
      r.bytes.fill(0);
    }
  }
  private async createCanary(
    endpoint: Endpoint,
    slot: 'protected' | 'after',
    b: Budget,
  ) {
    const r = await this.http[endpoint].request(
      'POST',
      this.rest(endpoint, slot),
      b,
      {
        apikey: this.secret,
        'Content-Type': 'text/plain',
        'x-upsert': 'false',
      },
      canary,
    );
    try {
      if (![200, 201].includes(r.status)) throw failure();
    } finally {
      r.bytes.fill(0);
    }
    await this.objectState(endpoint, slot, canary, b);
  }
  private shape(endpoint: Endpoint, index: number) {
    const unissued =
        'charitypilot-unissued-' + this.config.maintenance.attemptId,
      query = '?uploadId=' + encodeURIComponent(unissued);
    switch (index) {
      case 0:
        return { method: 'GET' as const, url: this.s3(endpoint, 'protected') };
      case 1:
        return {
          method: 'PUT' as const,
          url: this.s3(endpoint, 'create'),
          body: replacement,
        };
      case 2:
        return {
          method: 'PUT' as const,
          url: this.s3(endpoint, 'protected'),
          body: replacement,
        };
      case 3:
        return {
          method: 'DELETE' as const,
          url: this.s3(endpoint, 'protected'),
        };
      case 4:
        return {
          method: 'POST' as const,
          url: this.s3(endpoint, 'multipart-create') + '?uploads=',
        };
      case 5:
        return {
          method: 'PUT' as const,
          url:
            this.s3(endpoint, 'multipart-original') + query + '&partNumber=1',
          body: replacement,
        };
      case 6:
        return {
          method: 'POST' as const,
          url: this.s3(endpoint, 'multipart-original') + query,
          body: Buffer.from(
            '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"unissued-part"</ETag></Part></CompleteMultipartUpload>',
          ),
        };
      case 7: {
        const date = new Date()
            .toISOString()
            .replace(/[-:]/g, '')
            .replace(/\.\d{3}Z$/, 'Z'),
          q = new URLSearchParams({
            'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
            'X-Amz-Credential':
              'CHARITYPILOT_UNISSUED_PROBE/' +
              date.slice(0, 8) +
              '/' +
              this.config.region +
              '/s3/aws4_request',
            'X-Amz-Date': date,
            'X-Amz-Expires': '900',
            'X-Amz-SignedHeaders': 'host',
            'X-Amz-Signature': '0'.repeat(64),
            'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD',
          });
        return {
          method: 'PUT' as const,
          url: this.s3(endpoint, 'presigned-shape') + '?' + q.toString(),
          body: replacement,
        };
      }
      default:
        throw failure();
    }
  }
  private async endpoint(endpoint: Endpoint, b: Budget) {
    await this.bucket(endpoint, b);
    for (const slot of [
      'protected',
      'after',
      'create',
      'multipart-create',
      'multipart-original',
      'presigned-shape',
    ] as const)
      await this.objectState(endpoint, slot, null, b);
    await this.createCanary(endpoint, 'protected', b);
    const refusals = [];
    for (let i = 0; i < s3FeatureOperations.length; i++) {
      const shape = this.shape(endpoint, i),
        r = await this.http[endpoint].request(
          shape.method,
          shape.url,
          b,
          { 'Content-Type': i === 6 ? 'application/xml' : 'text/plain' },
          shape.body,
        );
      try {
        if (!(await decodeNativeS3FeatureDisabled(r, b.signal)))
          throw failure();
        refusals.push({
          endpoint,
          operation: s3FeatureOperations[i],
          status: 403 as const,
          code: 'FeatureNotEnabled' as const,
          providerObservedAt: new Date(r.date).toISOString(),
        });
      } finally {
        r.bytes.fill(0);
      }
    }
    await this.objectState(endpoint, 'protected', canary, b);
    for (const slot of [
      'create',
      'multipart-create',
      'multipart-original',
      'presigned-shape',
    ] as const)
      await this.objectState(endpoint, slot, null, b);
    await this.createCanary(endpoint, 'after', b);
    await this.bucket(endpoint, b);
    return refusals;
  }
  private assertMetadata(raw: unknown) {
    const v = s3DisabledMetadataSchema.parse(raw);
    if (
      v.stage !== this.config.stage ||
      v.configurationDigest !==
        this.metadata.configurationDigest(this.config.installationId) ||
      Math.abs(Date.now() - Date.parse(v.observedAt)) > 60000
    )
      throw failure();
    return v;
  }
  assertObservation(raw: unknown) {
    const { artifact, value: v } = parseS3FeatureBoundary(raw);
    if (
      v.configurationDigest !== this.configurationDigest() ||
      v.stage !== this.config.stage ||
      JSON.stringify(v.maintenance) !==
        JSON.stringify(this.config.maintenance) ||
      v.metadataBefore.configurationDigest !==
        this.metadata.configurationDigest(this.config.installationId) ||
      v.metadataAfter.configurationDigest !==
        this.metadata.configurationDigest(this.config.installationId) ||
      Date.parse(v.observedAt) > Date.now() + 60000
    )
      throw failure();
    return artifact;
  }
  async probe(caller?: AbortSignal) {
    if (this.attempted) throw failure();
    this.attempted = true;
    return this.http.DIRECT.work(
      (direct) =>
        this.http.GATEWAY.work(async (gateway) => {
          const beganAt = new Date().toISOString(),
            metadataBefore = this.assertMetadata(
              await this.metadata.observeS3Disabled(
                this.config.stage,
                direct.signal,
              ),
            );
          const refusals = [
              ...(await this.endpoint('DIRECT', direct)),
              ...(await this.endpoint('GATEWAY', gateway)),
            ],
            metadataAfter = this.assertMetadata(
              await this.metadata.observeS3Disabled(
                this.config.stage,
                direct.signal,
              ),
            );
          const core = {
            format: 1 as const,
            kind: 'SUPABASE_S3_CURRENT_FEATURE_BOUNDARY_V1' as const,
            configurationDigest: this.configurationDigest(),
            maintenance: this.config.maintenance,
            stage: this.config.stage,
            beganAt,
            observedAt: new Date().toISOString(),
            metadataBefore,
            metadataAfter,
            refusals,
          };
          return this.assertObservation(
            s3FeatureBoundaryArtifact({
              ...core,
              observationDigest: hash(JSON.stringify(core)),
              testedCurrentFeatureBoundaryObserved: true,
              coverage:
                'UNAUTHENTICATED_REGISTERED_S3_ROUTE_SHAPES_BOTH_ENDPOINTS_ONLY',
              originalWorkingS3BaselineProven: false,
              historicalNeverEnabledProven: false,
              s3CredentialsRevoked: false,
              presignedCapabilitiesRevoked: false,
              multipartUploadsDrained: false,
              unknownMultipartSideEffectsExcluded: false,
              inFlightWritesDrained: false,
              providerReleaseAttested: false,
              controlPlaneWritersExcluded: false,
              wholeStorageQuiesced: false,
              savedObservationAuthorizesExecution: false,
              actionAuthorized: false,
            }),
          );
        }, direct.signal),
      caller,
    ).catch(() => {
      throw failure();
    });
  }
}
