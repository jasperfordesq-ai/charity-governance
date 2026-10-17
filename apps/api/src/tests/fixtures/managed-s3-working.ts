import assert from 'node:assert/strict';
import type { S3Client } from '@aws-sdk/client-s3';
import type { SupabaseStorageWriterControl } from '../../services/supabase-storage-writer-control.js';
import { ManagedS3MaintenanceEvidence } from '../../services/managed-s3-maintenance-evidence.js';
import { ManagedS3CapabilityEvidence } from '../../services/managed-s3-capability-evidence.js';
import { s3CapabilityChildAttempt } from '../../services/s3-capability-cohort-contract.js';
import { s3ProbeHash as hash } from '../../services/s3-capability-contract.js';
import { s3CapabilityProbeFixture } from './s3-capability-proof.js';
import { resumableCohortFixture } from './resumable-cohort.js';
type Storage = {
  installationId: string;
  bucket: string;
  accountId: string;
  kmsKeyArn: string;
};
type Binding = {
  attemptId: string;
  planDigest: string;
  sourceSha: string;
  maintenanceEpoch: number;
};
/** Synthetic previously-enabled S3 state. Actual SDK signing, HMAC validation,
 * encryption and public storage are composed with the real parent, not live IAM. */
export function managedS3WorkingFixture(
  storage: Storage,
  client: S3Client,
  metadata: SupabaseStorageWriterControl,
  control: { id: string; secret: string },
  events: string[],
  binding: () => Binding,
  isFeatureDisabled: () => boolean,
) {
  const scope = metadata.s3FeatureProofScope(),
    retired = [
      {
        id: '44444444-4444-4444-8444-444444444444',
        accessKeyId: 'SYNTHETIC_S3_B',
        secretAccessKey: 'synthetic-s3-b-'.repeat(4),
      },
      {
        id: '55555555-5555-4555-8555-555555555555',
        accessKeyId: 'SYNTHETIC_S3_C',
        secretAccessKey: 'synthetic-s3-c-'.repeat(4),
      },
    ],
    registry = {
      mode: 'WORKING_CAPABILITIES',
      installationId: scope.installationId,
      projectRef: scope.projectRef,
      region: scope.region,
      bucket: 'charitypilot-recovery-s3-probes',
      providerRelease: {
        sourceSha: '3'.repeat(40),
        imageDigest: '4'.repeat(64),
      },
      control: { id: control.id, sha256: hash(control.secret) },
      retired: retired.map((k) => ({
        id: k.id,
        accessKeyIdSha256: hash(k.accessKeyId),
        secretAccessKeySha256: hash(k.secretAccessKey),
      })),
    };
  const crypto = resumableCohortFixture({
      storage,
      client,
      control,
      events,
      custodyPurpose: 'charitypilot-s3-capability-v1',
    }),
    { uploadIdFormat, ...vaultStorage } = crypto.vaultStorage,
    clients = {
      vault: client,
      evidence: client,
      manifest: client,
      kms: crypto.kms,
    },
    children = new Map<string, ReturnType<typeof s3CapabilityProbeFixture>>();
  let savedParent = '';
  const transport: typeof fetch = async (input, init) => {
    events.push('s3-working-' + init!.method);
    const parent = binding(),
      label = JSON.stringify(parent),
      url = new URL(String(input)),
      endpoint = url.hostname.includes('.storage.') ? 'DIRECT' : 'GATEWAY';
    if (label !== savedParent) {
      assert.equal(
        children.size,
        0,
        'one original parent per synthetic fixture',
      );
      savedParent = label;
      const digest = new ManagedS3CapabilityEvidence(
        registry,
        { control, retired },
        vaultStorage,
        storage,
        crypto.credentials,
        crypto.credentials,
        transport,
        clients,
      ).configurationDigest();
      for (let i = 0; i < retired.length; i++)
        for (const e of ['DIRECT', 'GATEWAY']) {
          const attemptId = s3CapabilityChildAttempt(
            parent,
            retired[i].id,
            e,
            digest,
          );
          children.set(
            e + ':' + attemptId,
            s3CapabilityProbeFixture(e, {
              config: {
                installationId: registry.installationId,
                projectRef: registry.projectRef,
                region: registry.region,
                endpoint: e,
                bucket: registry.bucket,
                providerRelease: registry.providerRelease,
                control: registry.control,
                retired: registry.retired[i],
                maintenance: { ...parent, attemptId },
              },
              control,
              retired: retired[i],
            }),
          );
        }
    }
    const childId = /\/charitypilot-recovery-s3-probe\/[^/]+\/([^/]+)\//.exec(
        url.pathname,
      )?.[1],
      child = childId
        ? children.get(endpoint + ':' + childId)
        : [...children.entries()].find(([k]) =>
            k.startsWith(endpoint + ':'),
          )?.[1];
    assert.ok(child);
    child.mode.disabled = isFeatureDisabled();
    return child.transport(input, init);
  };
  return {
    children,
    crypto,
    registry,
    factory: () =>
      new ManagedS3MaintenanceEvidence(
        registry,
        { control, retired },
        metadata,
        vaultStorage,
        storage,
        crypto.credentials,
        crypto.credentials,
        transport,
        clients,
      ),
  };
}
