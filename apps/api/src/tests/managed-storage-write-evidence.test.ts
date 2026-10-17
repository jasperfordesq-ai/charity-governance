import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ManagedStorageWriteEvidence } from '../services/managed-storage-write-evidence.js';
import {
  syntheticWriteProbe,
  syntheticWriteUpdate,
} from '../services/supabase-credential-write-proof.js';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const control = {
  id: '11111111-1111-4111-8111-111111111111',
  secret: 'sb_secret_' + 'a'.repeat(40),
};
const writer = {
  id: '22222222-2222-4222-8222-222222222222',
  secret: 'sb_secret_' + 'b'.repeat(40),
};
const probe = {
  installationId: 'synthetic',
  projectRef: 'abcdefghijklmnopqrst',
  bucket: 'charitypilot-recovery-write-probes',
  control: { id: control.id, sha256: hash(control.secret) },
  retired: [{ id: writer.id, sha256: hash(writer.secret) }],
};
const storage = {
  installationId: 'synthetic',
  bucket: 'synthetic-evidence',
  accountId: '123456789012',
  kmsKeyArn:
    'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-1111-1111-111111111111',
};
test('write factory binds static registry and custody without a circular maintenance-plan digest', () => {
  const input = structuredClone(probe),
    factory = new ManagedStorageWriteEvidence(
      input,
      { control, retired: [writer] },
      storage,
      { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' },
    );
  const digest = factory.configurationDigest('synthetic');
  input.projectRef = 'z'.repeat(20);
  assert.equal(factory.configurationDigest('synthetic'), digest);
  const scope = {
    installationId: 'synthetic',
    projectRef: probe.projectRef,
    captureKeyId: control.id,
    secretWriterIds: [writer.id],
  };
  factory.assertStorageScope(scope);
  assert.throws(() =>
    factory.assertStorageScope({ ...scope, secretWriterIds: [] }),
  );
  assert.throws(() => factory.configurationDigest('other'));
  const binding = {
    attemptId: control.id,
    sourceSha: '1'.repeat(40),
    planDigest: '2'.repeat(64),
    maintenanceEpoch: 1,
  };
  const first = factory.forAttempt(binding),
    second = factory.forAttempt({ ...binding, planDigest: '3'.repeat(64) });
  assert.equal(
    first.probe.configurationDigest(),
    second.probe.configurationDigest(),
  );
  assert.equal(factory.configurationDigest('synthetic'), digest);
});
test('saved baseline validation checks actual cohort and payload as well as an unchanged registry digest', () => {
  let calls = 0;
  const transport: typeof fetch = async () => {
    calls++;
    throw new Error('unexpected transport');
  };
  const factory = new ManagedStorageWriteEvidence(
    probe,
    { control, retired: [writer] },
    storage,
    { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' },
    transport,
  );
  const maintenance = {
      attemptId: control.id,
      planDigest: '2'.repeat(64),
      sourceSha: '1'.repeat(40),
      maintenanceEpoch: 1,
    },
    active = factory.forAttempt(maintenance).probe;
  const value = {
    format: 1,
    kind: 'SUPABASE_STANDARD_WRITE_BASELINE_V1',
    configurationDigest: active.configurationDigest(),
    maintenance,
    capturedAt: new Date().toISOString(),
    credentialIds: [writer.id],
    payloadSha256: hash(syntheticWriteProbe),
    updatePayloadSha256: hash(syntheticWriteUpdate),
    operations: ['CREATE', 'UPDATE', 'DELETE'],
  };
  const body = JSON.stringify(value);
  active.assertBaseline({ body, sha256: hash(body) });
  for (const change of [
    { credentialIds: [control.id] },
    { payloadSha256: '0'.repeat(64) },
    { maintenance: { ...maintenance, sourceSha: '9'.repeat(40) } },
  ]) {
    const forged = JSON.stringify({ ...value, ...change });
    assert.throws(() =>
      active.assertBaseline({ body: forged, sha256: hash(forged) }),
    );
  }
  assert.equal(calls, 0);
});
