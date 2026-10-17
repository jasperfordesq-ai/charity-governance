import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { ManagedS3CurrentFeatureEvidence } from '../services/managed-s3-current-feature-evidence.js';
import {
  assertS3CurrentFeaturePair,
  parseS3CurrentFeatureObservation,
  s3CurrentFeatureObservationArtifact,
} from '../services/s3-current-feature-evidence-contract.js';
import { s3FeatureHash as hash } from '../services/s3-feature-boundary-contract.js';
import {
  s3FeatureBoundaryFixture,
  control,
} from './fixtures/s3-feature-boundary.js';
import {
  resumableEvidenceFixture,
  resumableEvidenceConfig,
} from './fixtures/resumable-upload-evidence.js';
function fixture() {
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
  const factory = (raw: unknown = registry, secret: unknown = control.secret) =>
    new ManagedS3CurrentFeatureEvidence(
      raw,
      secret,
      f.metadata,
      storage,
      a.credentials,
      f.transport,
      a.client,
    );
  return {
    f,
    a,
    registry,
    maintenance,
    factory,
    attempt: () => factory().forAttempt(maintenance),
  };
}

test('explicit already-disabled mode requires fresh PRE and POST checks, exact durable versions and GET-only saved inspection', async (t) => {
  const x = fixture(),
    attempt = x.attempt();
  assert.equal(x.f.calls.length, 0);
  assert.equal(x.a.calls.length, 0);
  const bp = await attempt.baseline(),
    b = await attempt.observeBaseline(bp);
  assert.equal(JSON.parse(b.value.preObservation.body).stage, 'PRE_CLOSURE');
  x.f.setStage('POST_CLOSURE');
  const result = await attempt.verifyRefusal(bp),
    before = x.f.calls.length,
    awsBefore = x.a.calls.length;
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 86400000 });
  const r = await x.attempt().observeObservation(result.pin, bp);
  assert.equal(JSON.parse(r.value.postObservation.body).stage, 'POST_CLOSURE');
  assert.equal(r.value.originalWorkingS3BaselineProven, false);
  assert.equal(r.value.historicalNeverEnabledProven, false);
  assert.equal(r.value.originalAcknowledgementReconstructed, false);
  assert.equal(r.value.savedObservationAuthorizesExecution, false);
  assert.equal(r.value.actionAuthorized, false);
  assert.equal(x.f.calls.length, before);
  assert.ok(
    x.a.calls.slice(awsBefore).every((c) => c instanceof GetObjectCommand),
  );
  assert.equal(x.a.objects.size, 2);
  await assert.rejects(attempt.baseline());
  await assert.rejects(attempt.verifyRefusal(bp));
});

test('unclosed metadata or one stale endpoint cannot publish a successful POST observation', async () => {
  for (const state of ['unclosed', 'gateway']) {
    const x = fixture(),
      attempt = x.attempt(),
      bp = await attempt.baseline();
    if (state === 'gateway') {
      x.f.setStage('POST_CLOSURE');
      x.f.mode.badEndpoint = 'GATEWAY';
    }
    const dataBefore = x.f.calls.filter((c) => c.kind === 'data').length;
    await assert.rejects(attempt.verifyRefusal(bp));
    if (state === 'unclosed')
      assert.equal(
        x.f.calls.filter((c) => c.kind === 'data').length,
        dataBefore,
      );
    assert.ok(
      ![...x.a.objects.keys()].some((k) => k.endsWith('-observation.json')),
    );
    const before = x.f.calls.length,
      aws = x.a.calls.length;
    await assert.rejects(
      x
        .attempt()
        .observeObservation(
          {
            kind: 'OBSERVATION',
            versionId: 'missing',
            sha256: '0'.repeat(64),
            byteLength: 100,
          },
          bp,
        ),
    );
    assert.equal(x.f.calls.length, before);
    assert.ok(x.a.calls.slice(aws).every((c) => c instanceof GetObjectCommand));
  }
});

test('missing original baseline refuses before any fresh provider or metadata probe', async () => {
  const x = fixture(),
    bp = await x.attempt().baseline();
  x.a.objects.clear();
  x.f.setStage('POST_CLOSURE');
  const before = x.f.calls.length;
  await assert.rejects(x.attempt().verifyRefusal(bp));
  assert.equal(x.f.calls.length, before);
});

test('wrong explicit mode, secret, control scope or extra credential list refuses without network effects', () => {
  const x = fixture();
  for (const raw of [
    { ...x.registry, mode: 'WORKING_CAPABILITIES' },
    { ...x.registry, retired: [] },
    { ...x.registry, region: 'eu-central-1' },
    { ...x.registry, projectRef: 'z'.repeat(20) },
    {
      ...x.registry,
      control: {
        ...x.registry.control,
        id: '99999999-9999-4999-8999-999999999999',
      },
    },
  ])
    assert.throws(() => x.factory(raw));
  assert.throws(() => x.factory(x.registry, control.secret + 'wrong'));
  assert.equal(x.f.calls.length, 0);
  assert.equal(x.a.calls.length, 0);
});

test('lost committed PRE/POST publication or readback consumes operation and preserves unknown evidence', async () => {
  for (const kind of ['baseline', 'observation'])
    for (const stage of ['put', 'get']) {
      const x = fixture(),
        attempt = x.attempt(),
        bp = kind === 'observation' ? await attempt.baseline() : undefined;
      if (kind === 'observation') x.f.setStage('POST_CLOSURE');
      x.a.setFault((c) => {
        if (c.input.Key!.endsWith('-' + kind + '.json')) {
          if (stage === 'put' && c instanceof PutObjectCommand) {
            x.a.commit(c);
            throw new Error('synthetic lost current-feature PUT');
          }
          if (stage === 'get' && c instanceof GetObjectCommand)
            throw new Error('synthetic lost current-feature readback');
        }
      });
      const publish = () =>
        kind === 'baseline' ? attempt.baseline() : attempt.verifyRefusal(bp);
      await assert.rejects(publish());
      const providerBefore = x.f.calls.length,
        awsBefore = x.a.calls.length;
      await assert.rejects(publish());
      assert.equal(x.f.calls.length, providerBefore);
      assert.equal(x.a.calls.length, awsBefore);
      assert.equal(x.a.objects.size, kind === 'baseline' ? 1 : 2);
      x.a.setFault(undefined);
      const fresh = x.attempt();
      await assert.rejects(
        kind === 'baseline' ? fresh.baseline() : fresh.verifyRefusal(bp),
      );
      assert.equal(x.a.objects.size, kind === 'baseline' ? 1 : 2);
    }
});

test('recomputed outer digests cannot substitute PRE for POST, bypass original pairing or claim authority', async () => {
  const x = fixture(),
    attempt = x.attempt(),
    bp = await attempt.baseline(),
    b = await attempt.observeBaseline(bp);
  x.f.setStage('POST_CLOSURE');
  const result = await attempt.verifyRefusal(bp),
    r = await attempt.observeObservation(result.pin, bp);
  const wrongStage = { ...r.value, postObservation: b.value.preObservation },
    body = JSON.stringify(wrongStage);
  assert.throws(() =>
    parseS3CurrentFeatureObservation({ body, sha256: hash(body) }),
  );
  const altered = JSON.stringify({
    ...r.value,
    baselineSha256: '0'.repeat(64),
  });
  assert.throws(() =>
    assertS3CurrentFeaturePair(b.artifact, {
      body: altered,
      sha256: hash(altered),
    }),
  );
  assert.throws(() =>
    s3CurrentFeatureObservationArtifact({
      ...r.value,
      historicalNeverEnabledProven: true,
    }),
  );
  assert.throws(() =>
    s3CurrentFeatureObservationArtifact({ ...r.value, actionAuthorized: true }),
  );
  assert.throws(() =>
    s3CurrentFeatureObservationArtifact({
      ...r.value,
      observedAt: new Date(
        Date.parse(r.value.observedAt) + 60001,
      ).toISOString(),
    }),
  );
});

test('saved public versions and ciphertext-independent scope are checked before returning a current-feature report', async () => {
  const x = fixture(),
    attempt = x.attempt(),
    bp = await attempt.baseline();
  x.f.setStage('POST_CLOSURE');
  const result = await attempt.verifyRefusal(bp);
  await assert.rejects(
    x.attempt().observeObservation({ ...result.pin, versionId: 'wrong' }, bp),
  );
  const wrong = x
    .factory({
      ...x.registry,
      providerRelease: {
        ...x.registry.providerRelease,
        imageDigest: '0'.repeat(64),
      },
    })
    .forAttempt(x.maintenance);
  await assert.rejects(wrong.observeObservation(result.pin, bp));
});

test('late PRE publication acknowledgement after cancellation cannot return a pin or repeat probes', async () => {
  const x = fixture(),
    attempt = x.attempt(),
    controller = new AbortController();
  let entered!: () => void, reply!: (v: unknown) => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  x.a.setFault((c) => {
    if (c instanceof PutObjectCommand) {
      const ack = x.a.commit(c);
      entered();
      return new Promise((r) => {
        reply = () => r(ack);
      });
    }
  });
  const pending = assert.rejects(attempt.baseline(controller.signal));
  await started;
  controller.abort();
  await pending;
  const before = x.f.calls.length,
    aws = x.a.calls.length;
  reply(undefined);
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(x.f.calls.length, before);
  assert.equal(x.a.calls.length, aws);
  assert.equal(x.a.objects.size, 1);
  await assert.rejects(attempt.baseline());
});
