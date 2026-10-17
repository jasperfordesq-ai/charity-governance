import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import { credentialReadMaintenanceBindingSchema } from './credential-read-evidence.js';
import {
  SupabaseCredentialWriteProof,
  supabaseWriteRegistrySchema,
  supabaseWriteRegistryDigest,
  supabaseWriteCredentialsSchema,
} from './supabase-credential-write-proof.js';
import {
  S3ManagedWriteEvidence,
  managedWriteStorageSchema,
} from './managed-write-evidence.js';

/** Static target/registry factory; active objects require the acquired attempt. */
export class ManagedStorageWriteEvidence {
  private readonly probe: z.infer<typeof supabaseWriteRegistrySchema>;
  private readonly secrets: z.infer<typeof supabaseWriteCredentialsSchema>;
  private readonly storage: z.infer<typeof managedWriteStorageSchema>;
  constructor(
    probe: unknown,
    secrets: unknown,
    storage: unknown,
    private readonly credentials: NonNullable<S3ClientConfig['credentials']>,
    private readonly transport: typeof fetch = fetch,
    private readonly client?: S3Client,
  ) {
    this.probe = supabaseWriteRegistrySchema.parse(probe);
    this.probe.retired.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.secrets = supabaseWriteCredentialsSchema.parse(secrets);
    this.storage = managedWriteStorageSchema.parse(storage);
    if (
      !credentials ||
      this.storage.installationId !== this.probe.installationId
    )
      throw new Error('Managed write scope is unresolved');
  }
  configurationDigest(installationId = this.probe.installationId) {
    if (installationId !== this.probe.installationId)
      throw new Error('Managed write scope is unresolved');
    return createHash('sha256')
      .update(
        JSON.stringify({
          format: 1,
          policy: 'DURABLE_STANDARD_WRITE_EVIDENCE_V1',
          probe: supabaseWriteRegistryDigest(this.probe),
          custody: this.storage,
        }),
      )
      .digest('hex');
  }
  assertStorageScope(raw: unknown) {
    const v = z
      .object({
        installationId: z.string(),
        projectRef: z.string(),
        captureKeyId: z.string().uuid(),
        secretWriterIds: z.array(z.string().uuid()),
      })
      .strict()
      .parse(raw);
    if (
      v.installationId !== this.probe.installationId ||
      v.projectRef !== this.probe.projectRef ||
      v.captureKeyId !== this.probe.control.id ||
      JSON.stringify([...v.secretWriterIds].sort()) !==
        JSON.stringify(this.probe.retired.map((k) => k.id))
    )
      throw new Error('Managed write scope is unresolved');
  }
  forAttempt(raw: unknown) {
    const maintenance = credentialReadMaintenanceBindingSchema.parse(raw);
    return {
      probe: new SupabaseCredentialWriteProof(
        { ...this.probe, maintenance },
        this.secrets,
        this.transport,
      ),
      evidence: new S3ManagedWriteEvidence(
        {
          ...this.storage,
          maintenance,
          probeRegistryDigest: supabaseWriteRegistryDigest(this.probe),
        },
        this.credentials,
        this.client,
      ),
    };
  }
}
