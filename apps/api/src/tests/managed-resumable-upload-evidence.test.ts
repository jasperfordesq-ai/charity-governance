import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { ManagedResumableUploadEvidence } from '../services/managed-resumable-upload-evidence.js';
import { S3ResumableCohortEvidence } from '../services/resumable-cohort-evidence.js';
import {
  resumableChildAttempt,
  resumableCohortBaselineSchema,
} from '../services/resumable-cohort-contract.js';
import {
  resumableCohortFixture,
  cohortParent,
  cohortHash as hash,
} from './fixtures/resumable-cohort.js';
test('complete configured credential cohort uses distinct original uploads and fresh report inspection makes no TUS KMS or PUT request', async () => {
  const f = resumableCohortFixture(),
    factory = f.factory();
  factory.assertStorageScope({
    installationId: 'synthetic',
    projectRef: f.registry.projectRef,
    captureKeyId: f.control.id,
    secretWriterIds: f.retired.map((k) => k.id),
  });
  const attempt = factory.forAttempt(cohortParent);
  assert.equal(f.events.length, 0);
  const bp = await attempt.baseline(),
    baseline = await attempt.observeBaseline(bp);
  assert.equal(baseline.value.entries.length, 2);
  assert.equal(
    new Set(baseline.value.entries.map((e) => e.childAttemptId)).size,
    2,
  );
  assert.equal(f.sessions.size, 2);
  assert.equal(f.completed.size, 0);
  f.blockAll();
  const result = await attempt.verifyRefusal(bp);
  assert.equal(result.configuredCredentialCohortRefusalsObserved, true);
  assert.equal(result.resumableSessionsRevoked, false);
  const before = f.events.length,
    retained = await f
      .factory()
      .forAttempt(cohortParent)
      .observeObservation(result.pin, bp);
  assert.equal(retained.value.entries.length, 2);
  assert.equal(retained.artifact.sha256, result.observationDigest);
  assert.ok(f.events.slice(before).every((e) => e === 's3-get'));
  assert.ok(f.plaintext.every((p) => p.every((v) => v === 0)));
  assert.equal(JSON.stringify(retained).includes('https://'), false);
  await assert.rejects(attempt.baseline());
  await assert.rejects(attempt.verifyRefusal(bp));
});
test('scope mismatch duplicate missing or substituted credentials fail before provider access and registry order normalises', () => {
  const f = resumableCohortFixture(),
    input = structuredClone(f.registry),
    secrets = { control: f.control, retired: [...f.retired].reverse() },
    make = (r: unknown, s: unknown) =>
      new ManagedResumableUploadEvidence(
        r,
        s,
        f.vaultStorage,
        f.storage,
        f.credentials,
        f.credentials,
        f.transport,
      );
  const a = make(input, secrets),
    b = make({ ...input, retired: [...input.retired].reverse() }, secrets);
  assert.equal(a.configurationDigest(), b.configurationDigest());
  input.providerRelease.sourceSha = '0'.repeat(40);
  assert.notEqual(
    a.configurationDigest(),
    make(input, secrets).configurationDigest(),
  );
  assert.throws(() =>
    a.assertStorageScope({
      installationId: 'synthetic',
      projectRef: f.registry.projectRef,
      captureKeyId: f.control.id,
      secretWriterIds: [f.retired[0].id],
    }),
  );
  assert.throws(() =>
    make(
      {
        ...f.registry,
        retired: [f.registry.retired[0], f.registry.retired[0]],
      },
      secrets,
    ),
  );
  assert.throws(() =>
    make(f.registry, { control: f.control, retired: [f.retired[0]] }),
  );
  assert.throws(() =>
    make(f.registry, {
      control: f.control,
      retired: f.retired.map((k) => ({ ...k, secret: k.secret + 'wrong' })),
    }),
  );
  assert.equal(f.events.length, 0);
});
test('one still-working credential cannot become an aggregate refusal or be backfilled by fresh inspection', async () => {
  const f = resumableCohortFixture(),
    attempt = f.factory().forAttempt(cohortParent),
    bp = await attempt.baseline();
  f.blocked.add(f.retired[0].secret);
  await assert.rejects(attempt.verifyRefusal(bp));
  assert.ok(
    [...f.objects.keys()].some((k) =>
      k.endsWith('/resumable-observation.json'),
    ),
  );
  assert.equal(
    [...f.objects.keys()].some((k) =>
      k.endsWith('/resumable-cohort-observation.json'),
    ),
    false,
  );
  const before = f.events.length;
  await assert.rejects(attempt.verifyRefusal(bp));
  assert.equal(f.events.length, before);
  await f.factory().forAttempt(cohortParent).observeBaseline(bp);
  assert.ok(f.events.slice(before).every((e) => e === 's3-get'));
});
test('lost child or aggregate publication acknowledgements remain consumed and do not publish a replacement aggregate', async () => {
  for (const stage of [
    'child-baseline',
    'aggregate-baseline',
    'aggregate-report',
  ]) {
    const f = resumableCohortFixture(),
      attempt = f.factory().forAttempt(cohortParent);
    const suffix =
      stage === 'child-baseline'
        ? '/resumable-baseline.json'
        : stage === 'aggregate-baseline'
          ? '/resumable-cohort-baseline.json'
          : '/resumable-cohort-observation.json';
    f.setFault((c) => {
      if (c instanceof PutObjectCommand && c.input.Key!.endsWith(suffix)) {
        f.commit(c);
        throw new Error('synthetic committed cohort ACK lost');
      }
    });
    if (stage === 'aggregate-report') {
      const bp = await attempt.baseline();
      f.blockAll();
      await assert.rejects(attempt.verifyRefusal(bp));
      const before = f.events.length;
      await assert.rejects(attempt.verifyRefusal(bp));
      assert.equal(f.events.length, before);
    } else {
      await assert.rejects(attempt.baseline());
      const before = f.events.length;
      await assert.rejects(attempt.baseline());
      assert.equal(f.events.length, before);
    }
  }
});
test('derived child identities bind every parent dimension and credential but do not confer execution authority', () => {
  const id = '22222222-2222-4222-8222-222222222222',
    child = resumableChildAttempt(cohortParent, id);
  assert.match(child, /^[a-f0-9-]{14}8[a-f0-9]{3}-[89ab]/);
  for (const change of [
    { attemptId: randomUUID() },
    { planDigest: '0'.repeat(64) },
    { sourceSha: '0'.repeat(40) },
    { maintenanceEpoch: 2 },
  ])
    assert.notEqual(
      resumableChildAttempt({ ...cohortParent, ...change }, id),
      child,
    );
  assert.notEqual(resumableChildAttempt(cohortParent, randomUUID()), child);
  assert.equal(resumableChildAttempt(cohortParent, id), child);
});
test('fifty long-version child pins fit a bounded separate manifest while missing reordered duplicate or swapped identities refuse', async () => {
  const f = resumableCohortFixture(),
    ids = Array.from(
      { length: 50 },
      (_, i) => '00000000-0000-4000-8000-' + String(i + 1).padStart(12, '0'),
    ),
    digest = '5'.repeat(64),
    store = () =>
      new S3ResumableCohortEvidence(
        {
          storage: f.storage,
          maintenance: cohortParent,
          configurationDigest: digest,
          credentialIds: ids,
        },
        f.credentials,
        f.sdk,
      );
  const value = {
    format: 1,
    kind: 'RESUMABLE_COHORT_BASELINE_V1',
    configurationDigest: digest,
    maintenance: cohortParent,
    capturedAt: new Date().toISOString(),
    entries: ids.map((credentialId) => ({
      credentialId,
      childAttemptId: resumableChildAttempt(cohortParent, credentialId),
      baselinePin: {
        kind: 'BASELINE',
        versionId: 'v'.repeat(1024),
        sha256: '6'.repeat(64),
        byteLength: 1024,
      },
    })),
  };
  for (const entries of [
    value.entries.slice(1),
    [...value.entries].reverse(),
    [value.entries[0], ...value.entries.slice(0, 49)],
    value.entries.map((e, i) =>
      i === 0 ? { ...e, childAttemptId: randomUUID() } : e,
    ),
  ]) {
    const body = JSON.stringify({ ...value, entries });
    await assert.rejects(store().publishBaseline({ body, sha256: hash(body) }));
  }
  assert.equal(f.events.length, 0);
  const body = JSON.stringify(resumableCohortBaselineSchema.parse(value)),
    pin = await store().publishBaseline({ body, sha256: hash(body) });
  assert.ok(pin.byteLength > 16384);
  assert.ok(pin.byteLength <= 131072);
});

test('recomputed aggregate hashes cannot substitute child pins chronology or actual child report digests',async()=>{
 for(const mode of ['pins','chronology','report-digest']){
  const f=resumableCohortFixture(),attempt=f.factory().forAttempt(cohortParent),bp=await attempt.baseline();
  if(mode==='report-digest'){
   f.blockAll();const result=await attempt.verifyRefusal(bp),row=[...f.objects.entries()].find(([key])=>key.endsWith('/resumable-cohort-observation.json'))![1],v=JSON.parse(row.body);v.entries[0].observationDigest='0'.repeat(64);row.body=JSON.stringify(v);
   const before=f.events.length;await assert.rejects(f.factory().forAttempt(cohortParent).observeObservation({...result.pin,sha256:hash(row.body),byteLength:Buffer.byteLength(row.body)},bp));assert.ok(f.events.slice(before).every(e=>e==='s3-get'));
  }else{
   const row=[...f.objects.entries()].find(([key])=>key.endsWith('/resumable-cohort-baseline.json'))![1],v=JSON.parse(row.body);
   if(mode==='pins')v.entries[0].baselinePin=v.entries[1].baselinePin;else v.capturedAt=new Date(Date.parse(v.capturedAt)-60000).toISOString();
   row.body=JSON.stringify(v);const before=f.events.length;
   await assert.rejects(f.factory().forAttempt(cohortParent).observeBaseline({...bp,sha256:hash(row.body),byteLength:Buffer.byteLength(row.body)}));assert.ok(f.events.slice(before).every(e=>e==='s3-get'));
  }
 }
});
