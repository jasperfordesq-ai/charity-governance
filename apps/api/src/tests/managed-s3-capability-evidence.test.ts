import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import {
  s3CapabilityChildAttempt,
  s3CapabilityCohortBaselineSchema,
  assertS3CapabilityCohortPair,
} from '../services/s3-capability-cohort-contract.js';
import {
  s3CapabilityCohortFixture,
  cohortParent,
  cohortHash as hash,
} from './fixtures/s3-capability-cohort.js';

test('all configured working S3 keys require original encrypted capabilities and both endpoint reports; inspection is GET only', async () => {
  const f = s3CapabilityCohortFixture(),
    factory = f.factory();
  factory.assertStorageScope({
    installationId: 'synthetic',
    projectRef: f.registry.projectRef,
    captureKeyId: f.control.id,
    region: f.registry.region,
  });
  const a = factory.forAttempt(cohortParent);
  assert.equal(f.events.length, 0);
  const bp = await a.baseline(),
    baseline = await a.observeBaseline(bp);
  assert.equal(baseline.value.entries.length, 4);
  assert.equal(
    new Set(baseline.value.entries.map((e) => e.childAttemptId)).size,
    4,
  );
  assert.deepEqual(
    baseline.value.entries.map((e) => e.endpoint),
    ['DIRECT', 'GATEWAY', 'DIRECT', 'GATEWAY'],
  );
  assert.ok([...f.children.values()].every((c) => c.uploads.size === 1));
  f.blockAll();
  const result = await a.verifyRefusal(bp);
  const before = f.events.length,
    report = await f
      .factory()
      .forAttempt(cohortParent)
      .observeObservation(result.pin, bp);
  assert.equal(report.value.entries.length, 4);
  assert.equal(report.artifact.sha256, result.observationDigest);
  assert.equal(report.value.credentialInventoryComplete, false);
  assert.equal(report.value.wholeStorageQuiesced, false);
  assert.ok(f.events.slice(before).every((e) => e === 's3-get'));
  assert.ok(f.plaintext.every((p) => p.every((b) => b === 0)));
  assert.ok(!JSON.stringify(report).includes('https://'));
  await assert.rejects(a.baseline());
  await assert.rejects(a.verifyRefusal(bp));
});

test('empty, duplicate, missing, wrong or alternate-mode registry refuses before any provider/storage dispatch', () => {
  const f = s3CapabilityCohortFixture(),
    make = (r: unknown, s: unknown) => f.factory(r, s),
    secrets = { control: f.control, retired: f.retired };
  const reverse = { ...f.registry, retired: [...f.registry.retired].reverse() };
  assert.equal(
    make(reverse, {
      control: f.control,
      retired: [...f.retired].reverse(),
    }).configurationDigest(),
    f.factory().configurationDigest(),
  );
  for (const r of [
    { ...f.registry, retired: [] },
    { ...f.registry, mode: 'CURRENT_DISABLED' },
    { ...f.registry, retired: [f.registry.retired[0], f.registry.retired[0]] },
    {
      ...f.registry,
      retired: f.registry.retired.map((k) => ({
        ...k,
        accessKeyIdSha256: '0'.repeat(64),
      })),
    },
  ])
    assert.throws(() => make(r, secrets));
  assert.throws(() =>
    make(f.registry, { control: f.control, retired: [f.retired[0]] }),
  );
  assert.throws(() =>
    make(f.registry, {
      ...secrets,
      retired: f.retired.map((k) => ({
        ...k,
        secretAccessKey: k.secretAccessKey + 'wrong',
      })),
    }),
  );
  assert.throws(() =>
    f.factory().assertStorageScope({
      installationId: 'synthetic',
      projectRef: f.registry.projectRef,
      captureKeyId: f.control.id,
      region: 'eu-central-1',
    }),
  );
  const changed = {
    ...f.registry,
    providerRelease: {
      ...f.registry.providerRelease,
      imageDigest: '0'.repeat(64),
    },
  };
  assert.notEqual(
    make(changed, secrets).configurationDigest(),
    f.factory().configurationDigest(),
  );
  assert.equal(f.events.length, 0);
});

test('one still-working gateway among four scopes prevents aggregate success without inspection backfill', async () => {
  const f = s3CapabilityCohortFixture(),
    a = f.factory().forAttempt(cohortParent),
    bp = await a.baseline();
  f.blockAll();
  [...f.children.values()][3].mode.stillWorks = true;
  await assert.rejects(a.verifyRefusal(bp));
  assert.ok([...f.objects.keys()].some((k) => k.endsWith('/observation.json')));
  assert.ok(
    ![...f.objects.keys()].some((k) =>
      k.endsWith('/s3-capability-cohort-observation.json'),
    ),
  );
  const before = f.events.length;
  await assert.rejects(
    f
      .factory()
      .forAttempt(cohortParent)
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
  assert.ok(f.events.slice(before).every((e) => e === 's3-get'));
});

test('lost aggregate publication/readback ACK cannot be retried or reconstruct parent authority', async () => {
  for (const stage of ['put', 'get']) {
    const f = s3CapabilityCohortFixture(),
      a = f.factory().forAttempt(cohortParent);
    f.setFault((c) => {
      if (c.input.Key!.endsWith('/s3-capability-cohort-baseline.json')) {
        if (stage === 'put' && c instanceof PutObjectCommand) {
          f.commit(c);
          throw new Error('synthetic lost aggregate PUT');
        }
        if (stage === 'get' && c instanceof GetObjectCommand)
          throw new Error('synthetic lost aggregate GET');
      }
    });
    await assert.rejects(a.baseline());
    const before = f.events.length;
    await assert.rejects(a.baseline());
    assert.equal(f.events.length, before);
    assert.ok(
      [...f.objects.keys()].some((k) =>
        k.endsWith('/s3-capability-cohort-baseline.json'),
      ),
    );
    f.setFault(undefined);
    await assert.rejects(f.factory().forAttempt(cohortParent).baseline());
  }
});

test('missing original child baseline refuses before decryption or active S3 verification', async () => {
  const f = s3CapabilityCohortFixture(),
    a = f.factory().forAttempt(cohortParent),
    bp = await a.baseline();
  f.blockAll();
  const key = [...f.objects.keys()].find((k) => k.endsWith('/baseline.json'))!;
  f.objects.delete(key);
  const before = f.events.length;
  await assert.rejects(a.verifyRefusal(bp));
  assert.ok(f.events.slice(before).every((e) => e === 's3-get'));
});

test('cohort manifests reject omitted endpoint, cross-attempt child, reordered keys and recomputed pairing substitutions', async () => {
  const f = s3CapabilityCohortFixture(),
    a = f.factory().forAttempt(cohortParent),
    bp = await a.baseline(),
    baseline = await a.observeBaseline(bp);
  const b = baseline.value;
  for (const entries of [
    b.entries.slice(1),
    [...b.entries].reverse(),
    b.entries.map((e, i) =>
      i === 0 ? { ...e, childAttemptId: randomUUID() } : e,
    ),
    b.entries.map((e) => ({ ...e, endpoint: 'DIRECT' })),
  ])
    assert.equal(
      s3CapabilityCohortBaselineSchema.safeParse({ ...b, entries }).success,
      false,
    );
  f.blockAll();
  const result = await a.verifyRefusal(bp),
    r = await a.observeObservation(result.pin, bp);
  const body = JSON.stringify({ ...r.value, baselineSha256: '0'.repeat(64) });
  assert.throws(() =>
    assertS3CapabilityCohortPair(baseline.artifact, {
      body,
      sha256: hash(body),
    }),
  );
  const ids = new Set<string>();
  for (const id of f.retired.map((k) => k.id))
    for (const endpoint of ['DIRECT', 'GATEWAY'])
      ids.add(
        s3CapabilityChildAttempt(
          cohortParent,
          id,
          endpoint,
          f.factory().configurationDigest(),
        ),
      );
  assert.equal(ids.size, 4);
  assert.ok(!ids.has(cohortParent.attemptId));
});

test('cancelled first encrypted-custody publication cannot resume original requests or start another child', async () => {
  const f = s3CapabilityCohortFixture(),
    a = f.factory().forAttempt(cohortParent),
    controller = new AbortController();
  let entered!: () => void, reply!: (v: unknown) => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  f.setFault((c) => {
    if (c instanceof PutObjectCommand) {
      const ack = f.commit(c);
      entered();
      return new Promise((r) => {
        reply = () => r(ack);
      });
    }
  });
  const pending = assert.rejects(a.baseline(controller.signal));
  await started;
  controller.abort();
  await pending;
  const before = f.events.length;
  reply(undefined);
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(f.events.length, before);
  assert.ok(
    [...f.children.values()].every(
      (c) =>
        c.calls.filter((v) => v.presigned).length === 0 &&
        [...c.uploads.values()].every((u) => u.parts.size === 0),
    ),
  );
  assert.equal(f.objects.size, 1);
  await assert.rejects(a.baseline());
});

test('a later recomputed aggregate timestamp cannot make stale child refusals fresh', async (t) => {
  const f = s3CapabilityCohortFixture(),
    a = f.factory().forAttempt(cohortParent),
    bp = await a.baseline();
  f.blockAll();
  const result = await a.verifyRefusal(bp),
    retained = await a.observeObservation(result.pin, bp);
  const later = Date.parse(retained.value.observedAt) + 241000;
  t.mock.timers.enable({ apis: ['Date'], now: later });
  const row = [...f.objects.entries()].find(([k]) =>
    k.endsWith('/s3-capability-cohort-observation.json'),
  )![1];
  row.body = JSON.stringify({
    ...retained.value,
    observedAt: new Date(later).toISOString(),
  });
  const changed = {
    ...result.pin,
    sha256: hash(row.body),
    byteLength: Buffer.byteLength(row.body),
  };
  const before = f.events.length;
  await assert.rejects(
    f.factory().forAttempt(cohortParent).observeObservation(changed, bp),
  );
  assert.ok(f.events.slice(before).every((e) => e === 's3-get'));
});
