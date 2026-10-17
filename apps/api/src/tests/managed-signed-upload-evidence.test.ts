import assert from 'node:assert/strict';
import { test } from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import { managedSignedFixture } from './fixtures/managed-signed-upload.js';
import { ManagedSignedUploadEvidence } from '../services/managed-signed-upload-evidence.js';
import { SupabaseSigningKeyControl } from '../services/supabase-signing-key-control.js';
const storage = {
    installationId: 'synthetic',
    bucket: 'synthetic-evidence',
    accountId: '123456789012',
    kmsKeyArn:
      'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-4111-8111-111111111111',
  },
  credentials = { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' };
test('signed factory binds copied static scope without circular attempt hashes or provider access', () => {
  const events: string[] = [],
    sdk = new S3Client({ region: 'eu-west-1', credentials }),
    f = managedSignedFixture(storage, sdk, events);
  const registry = structuredClone(f.registry),
    factory = new ManagedSignedUploadEvidence(
      registry,
      f.secrets,
      f.vaultStorage,
      storage,
      credentials,
      credentials,
      new SupabaseSigningKeyControl(f.signingConfig, 'synthetic', f.management),
      f.transport,
      { vault: sdk, evidence: sdk, kms: f.kms },
    ),
    digest = factory.configurationDigest();
  registry.providerRelease.sourceSha = '0'.repeat(40);
  assert.equal(factory.configurationDigest(), digest);
  for (const attemptId of [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ]) {
    const binding = {
        attemptId,
        sourceSha: '3'.repeat(40),
        planDigest: digest,
        maintenanceEpoch: 1,
      },
      components = factory.forAttempt(binding);
    assert.match(components.probe.configurationDigest(), /^[a-f0-9]{64}$/);
    assert.match(components.vault.configurationDigest(), /^[a-f0-9]{64}$/);
  }
  assert.equal(events.length, 0);
  assert.throws(() => factory.configurationDigest('other'));
  assert.throws(() =>
    factory.assertStorageScope({
      installationId: storage.installationId,
      projectRef: f.registry.projectRef,
      captureKeyId: '99999999-9999-4999-8999-999999999999',
      secretWriterIds: [],
    }),
  );
});
test('mismatched signing identity material and custody scopes refuse before any provider access', () => {
  const events: string[] = [],
    sdk = new S3Client({ region: 'eu-west-1', credentials }),
    f = managedSignedFixture(storage, sdk, events);
  for (const change of [
    { projectRef: 'z'.repeat(20) },
    {
      keys: f.signingConfig.keys.map((k) => ({
        ...k,
        fingerprint: '0'.repeat(64),
      })),
    },
    {
      keys: f.signingConfig.keys.map((k) => ({
        ...k,
        id:
          k.disposition === 'REVOKE_PREVIOUS'
            ? '99999999-9999-4999-8999-999999999999'
            : k.id,
      })),
    },
  ]) {
    assert.throws(
      () =>
        new ManagedSignedUploadEvidence(
          f.registry,
          f.secrets,
          f.vaultStorage,
          storage,
          credentials,
          credentials,
          new SupabaseSigningKeyControl(
            { ...f.signingConfig, ...change },
            'synthetic',
            f.management,
          ),
          f.transport,
        ),
    );
  }
  assert.throws(
    () =>
      new ManagedSignedUploadEvidence(
        f.registry,
        f.secrets,
        { ...f.vaultStorage, installationId: 'other' },
        storage,
        credentials,
        credentials,
        new SupabaseSigningKeyControl(
          f.signingConfig,
          'synthetic',
          f.management,
        ),
        f.transport,
      ),
  );
  assert.equal(events.length, 0);
});
