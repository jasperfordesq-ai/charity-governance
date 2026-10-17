import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ManagedS3MaintenanceEvidence } from '../services/managed-s3-maintenance-evidence.js';
import { SupabaseStorageWriterControl } from '../services/supabase-storage-writer-control.js';
import {
  s3CapabilityCohortFixture,
  cohortParent,
} from './fixtures/s3-capability-cohort.js';
import {
  s3FeatureBoundaryFixture,
  control,
} from './fixtures/s3-feature-boundary.js';
import {
  resumableEvidenceFixture,
  resumableEvidenceConfig,
} from './fixtures/resumable-upload-evidence.js';
import { GetObjectCommand } from '@aws-sdk/client-s3';
const metadataConfig = {
  installationId: 'synthetic',
  projectRef: 'abcdefghijklmnopqrst',
  region: 'eu-west-1',
  bucket: 'synthetic-governance',
  organisationId: 'org-synthetic',
  captureKeyId: control.id,
  writerKeys: [] as { id: string; type: 'secret' | 'publishable' }[],
};
function working() {
  const f = s3CapabilityCohortFixture();
  const metadata = (config: unknown = metadataConfig) =>
    new SupabaseStorageWriterControl(
      config,
      'synthetic-management',
      async () => {
        throw new Error('working selector must not call metadata');
      },
    );
  const make = (
    raw: unknown = f.registry,
    adapter = metadata(),
    secrets: unknown = { control: f.control, retired: f.retired },
  ) =>
    new ManagedS3MaintenanceEvidence(
      raw,
      secrets,
      adapter,
      f.vaultStorage,
      f.storage,
      f.credentials,
      f.credentials,
      f.transport,
      { vault: f.sdk, evidence: f.sdk, manifest: f.sdk, kms: f.kms },
    );
  return { f, metadata, make };
}
function current() {
  const f = s3FeatureBoundaryFixture(),
    { stage, maintenance, ...base } = f.config,
    registry = { mode: 'CURRENT_DISABLED', ...base };
  const a = resumableEvidenceFixture(
    { ...resumableEvidenceConfig, maintenance },
    's3-current-feature',
  );
  const storage = {
    installationId: 'synthetic',
    bucket: resumableEvidenceConfig.bucket,
    accountId: resumableEvidenceConfig.accountId,
    kmsKeyArn: resumableEvidenceConfig.kmsKeyArn,
  };
  const make = (raw: unknown = registry, secrets: unknown = { control }) =>
    new ManagedS3MaintenanceEvidence(
      raw,
      secrets,
      f.metadata,
      null,
      storage,
      a.credentials,
      null,
      f.transport,
      { manifest: a.client },
    );
  return { f, a, registry, maintenance, storage, make };
}

test('common working mode runs every configured original capability scope and reports saved inspection as historical', async () => {
  const { f, metadata, make } = working(),
    m = make(),
    adapter = metadata();
  assert.equal(m.mode, 'WORKING_CAPABILITIES');
  m.assertStorageScope(
    adapter.s3FeatureProofScope(),
    adapter.configurationDigest(),
  );
  const attempt = m.forAttempt(cohortParent);
  assert.equal(f.events.length, 0);
  const bp = await attempt.baseline();
  f.blockAll();
  const result = await attempt.verifyRefusal(bp);
  assert.equal(result.mode, 'WORKING_CAPABILITIES');
  assert.equal(result.freshS3CoverageObserved, true);
  assert.equal(result.wholeStorageQuiesced, false);
  assert.equal(result.credentialInventoryComplete, false);
  assert.equal(result.actionAuthorized, false);
  const before = f.events.length,
    observed = await make()
      .forAttempt(cohortParent)
      .observeObservation(result.pin, bp);
  assert.equal(observed.recordedS3CoverageObserved, true);
  assert.equal(observed.freshS3CoverageObserved, false);
  assert.equal(observed.originalAcknowledgementReconstructed, false);
  assert.equal(observed.savedObservationAuthorizesExecution, false);
  assert.equal(observed.observationDigest, result.observationDigest);
  assert.ok(f.events.slice(before).every((e) => e === 's3-get'));
});

test('common current-disabled mode requires original PRE and fresh POST with no signing vault or KMS capability', async () => {
  const x = current(),
    m = x.make(),
    attempt = m.forAttempt(x.maintenance);
  m.assertStorageScope(
    x.f.metadata.s3FeatureProofScope(),
    x.f.metadata.configurationDigest(),
  );
  assert.equal(m.mode, 'CURRENT_DISABLED');
  const bp = await attempt.baseline();
  x.f.setStage('POST_CLOSURE');
  const result = await attempt.verifyRefusal(bp),
    before = x.f.calls.length,
    aws = x.a.calls.length;
  assert.equal(result.freshS3CoverageObserved, true);
  assert.equal(result.mode, 'CURRENT_DISABLED');
  assert.equal(
    result.coverage,
    'CURRENT_UNAUTHENTICATED_ROUTES_PRE_AND_POST_AT_BOTH_ENDPOINTS',
  );
  const observed = await x
    .make()
    .forAttempt(x.maintenance)
    .observeObservation(result.pin, bp);
  assert.equal(observed.freshS3CoverageObserved, false);
  assert.equal(observed.actionAuthorized, false);
  assert.equal(x.f.calls.length, before);
  assert.ok(x.a.calls.slice(aws).every((c) => c instanceof GetObjectCommand));
});

test('unknown, absent or disguised modes and empty working registries fail before any dispatch', () => {
  const x = working();
  for (const mode of [
    undefined,
    'AUTO',
    'DISABLED',
    null,
    {},
    'CURRENT_DISABLED',
  ])
    assert.throws(() => x.make({ ...x.f.registry, mode }));
  assert.throws(() => x.make({ ...x.f.registry, retired: [] }));
  const c = current();
  assert.throws(() => c.make({ ...c.registry, retired: [] }));
  assert.throws(() => c.make(c.registry, { control, retired: [] }));
  assert.equal(x.f.events.length, 0);
  assert.equal(c.f.calls.length, 0);
  assert.equal(c.a.calls.length, 0);
});

test('selector binds actual metadata configuration as well as visible storage scope', () => {
  const x = working(),
    a = x.metadata(),
    b = x.metadata({
      ...metadataConfig,
      writerKeys: [
        { id: '99999999-9999-4999-8999-999999999999', type: 'publishable' },
      ],
    });
  assert.deepEqual(a.s3FeatureProofScope(), b.s3FeatureProofScope());
  const first = x.make(x.f.registry, a),
    second = x.make(x.f.registry, b);
  assert.notEqual(first.configurationDigest(), second.configurationDigest());
  assert.throws(() =>
    first.assertStorageScope(b.s3FeatureProofScope(), b.configurationDigest()),
  );
  assert.throws(() => first.configurationDigest('other'));
  assert.throws(() =>
    x.make(
      x.f.registry,
      x.metadata({ ...metadataConfig, region: 'eu-central-1' }),
    ),
  );
  assert.throws(() =>
    x.make(x.f.registry, a, {
      control: { ...x.f.control, id: '99999999-9999-4999-8999-999999999999' },
      retired: x.f.retired,
    }),
  );
  assert.equal(x.f.events.length, 0);
});

test('explicit current mode rejects unused signing custody, KMS or extra clients rather than silently ignoring them', () => {
  const x = current(),
    w = working(),
    make = (
      vault: unknown,
      kms: typeof w.f.credentials | null,
      clients: ConstructorParameters<typeof ManagedS3MaintenanceEvidence>[8],
    ) =>
      new ManagedS3MaintenanceEvidence(
        x.registry,
        { control },
        x.f.metadata,
        vault,
        x.storage,
        x.a.credentials,
        kms,
        x.f.transport,
        clients,
      );
  assert.throws(() => make(w.f.vaultStorage, null, { manifest: x.a.client }));
  assert.throws(() => make(null, w.f.credentials, { manifest: x.a.client }));
  assert.throws(() =>
    make(null, null, { manifest: x.a.client, evidence: x.a.client }),
  );
  assert.throws(() => make(null, null, { manifest: x.a.client, kms: w.f.kms }));
  assert.equal(x.f.calls.length, 0);
  assert.equal(x.a.calls.length, 0);
});

test('failed working refusal never falls back to current unauthenticated probes or publishes success', async () => {
  const { f, make } = working(),
    a = make().forAttempt(cohortParent),
    bp = await a.baseline();
  f.blockAll();
  [...f.children.values()][0].mode.stillWorks = true;
  await assert.rejects(a.verifyRefusal(bp));
  assert.ok(
    ![...f.objects.keys()].some((k) => k.includes('s3-current-feature')),
  );
  assert.ok(
    ![...f.objects.keys()].some((k) =>
      k.endsWith('/s3-capability-cohort-observation.json'),
    ),
  );
  await assert.rejects(a.verifyRefusal(bp));
});
