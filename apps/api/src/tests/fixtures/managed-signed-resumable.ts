import type { S3Client } from '@aws-sdk/client-s3';
import { ManagedSignedResumableUploadEvidence } from '../../services/managed-signed-resumable-upload-evidence.js';
import { managedSignedFixture } from './managed-signed-upload.js';
import {
  signedResumableProbeFixture,
  config as probeConfig,
} from './signed-resumable-upload.js';
import { maintenanceSecretVaultFixture } from './resumable-location-vault.js';
type Storage = {
  installationId: string;
  bucket: string;
  accountId: string;
  kmsKeyArn: string;
};
export function managedSignedResumableFixture(
  signed: ReturnType<typeof managedSignedFixture>,
  storage: Storage,
  client: S3Client,
  events: string[],
) {
  const signer = signed.factory(),
    registry = signer.resumableProofRegistry('PATH_V1'),
    vaultStorage = {
      ...signed.vaultStorage,
      projectRef: registry.projectRef,
      uploadIdFormat: 'PATH_V1',
    },
    aws = maintenanceSecretVaultFixture(
      {
        ...vaultStorage,
        maintenance: { ...probeConfig.maintenance, sourceSha: '1'.repeat(40) },
        probeDigest: '9'.repeat(64),
      },
      'signed-resumable-credential.json',
      'charitypilot-signed-resumable-credential-v1',
      events,
    ),
    probe = signedResumableProbeFixture('PATH_V1', {
      config: { ...probeConfig, ...registry },
      secrets: signed.secrets,
      sign: signed.signResumableToken,
      verify: signed.verifyResumableToken,
      isRevoked: () => signed.revoked,
      events,
    });
  return {
    mode: probe.mode,
    calls: probe.calls,
    sessions: probe.sessions,
    objects: probe.objects,
    transport: probe.transport,
    aws,
    vaultStorage,
    factory: () =>
      new ManagedSignedResumableUploadEvidence(
        signer,
        'PATH_V1',
        signed.secrets,
        vaultStorage,
        storage,
        signed.credentials,
        signed.credentials,
        probe.transport,
        { vault: client, kms: aws.kms, evidence: client },
      ),
  };
}
