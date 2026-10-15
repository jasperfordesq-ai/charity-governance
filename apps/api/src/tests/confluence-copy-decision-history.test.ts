import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareConfluenceCopyRecoveryFacts } from '../services/confluence-copy-recovery-facts.js';
import { recoveryFactsFixture, recoveryContextFixture as context } from './fixtures/confluence-copy-recovery-facts.js';
import { canonicalRetainedConfluenceCopyReviewEvidence } from '../services/confluence-retained-copy-review.js';
import { fixture, states } from './fixtures/confluence-copy-decision-history.js';

test('a stale backup prefix verifies against every published payload and latest state retains both withdrawals', async () => {
  const f = await fixture(), first = prepareConfluenceCopyRecoveryFacts(f.values[0]!);
  const result = await f.read([first]);
  assert.equal(result.confluencePayloadsVerified,true); assert.equal(result.latestStates.length,1);
  assert.equal(result.latestStates[0]?.factsRevision,2); assert.equal(result.generation,2);
  const latest = JSON.parse(result.latestStates[0]!.body);
  assert.equal(latest.permissionWithdrawal.id,'pw-a'); assert.equal(latest.reviewWithdrawal.id,'rw-a');
  assert.equal(result.currentHistoryVerified,false); assert.equal(result.reopeningAuthorised,false); assert.equal(result.actionAuthorized,false);
  assert.equal(result.scope,'CONFLUENCE_DECISION_STATES_ONLY');
});

for (const fault of ['missing-initial','wrong-predecessor','skipped-revision','dropped-withdrawal','rewritten-permission'] as const) {
  test(`rejects ${fault} despite valid encrypted envelopes and journal hashes`, async () => {
    const values = states();
    if (fault === 'missing-initial') values.shift();
    if (fault === 'wrong-predecessor') values[1]!.previousFactsDigest = '0'.repeat(64);
    if (fault === 'skipped-revision') values[1]!.factsRevision = 3;
    if (fault === 'rewritten-permission') values[1]!.permission.evidenceRef = 'OTHER-PERMISSION';
    if (fault === 'dropped-withdrawal') {
      const third = structuredClone(values[1]!); third.operationId = 'state-3'; third.factsRevision = 3;
      third.previousFactsDigest = prepareConfluenceCopyRecoveryFacts(values[1]!).digest;
      third.capturedAt = '2026-10-15T18:08:00.000Z'; third.permissionWithdrawal = null; third.reviewWithdrawal = null;
      values.push(third);
    }
    const f = await fixture(values); await assert.rejects(f.read);
  });
}

test('missing old or latest payload and replacement ciphertext cannot fall back to backup', async () => {
  for (const operation of ['state-1','state-2']) {
    const f = await fixture(), local = prepareConfluenceCopyRecoveryFacts(f.values[0]!);
    f.objects.delete(operation); await assert.rejects(() => f.read([local]), /payload is missing/);
    assert.equal(f.objects.size,1);
  }
  const f = await fixture(); f.objects.set('state-1','replacement');
  await assert.rejects(f.read, /digest mismatch/);
});

test('unapproved keys and unsupported writer epochs refuse before accepting history', async () => {
  const f = await fixture();
  await assert.rejects(() => f.read([],[]), /policy/);
  await assert.rejects(() => f.read([],[context.keyId.replace('11111111','22222222')]), /not approved/);
  f.state.current.writerEpoch = 2; await assert.rejects(f.read, /not approved/);
});

test('other journal kinds require their own protocol and cannot be skipped', async () => {
  const f = await fixture(states(),'CONTROL_CHANGE');
  await assert.rejects(f.read, /Unsupported journal kind/);
});

test('unknown, contradictory or malformed restored rows never become recovery authority', async () => {
  const f = await fixture(), local = prepareConfluenceCopyRecoveryFacts(f.values[0]!);
  await assert.rejects(() => f.read([{ ...local, digest: '0'.repeat(64) }]), /Invalid restored/);
  const foreign = recoveryFactsFixture(); foreign.operationId = 'never-published';
  await assert.rejects(() => f.read([prepareConfluenceCopyRecoveryFacts(foreign)]), /absent from independent/);
  await assert.rejects(() => f.read([local,local]), /Invalid restored/);
  await assert.rejects(() => f.read([{ body: '{PRIVATE-SENTINEL', digest: '0'.repeat(64) }]), error =>
    error instanceof Error && error.message === 'Invalid restored Confluence evidence');
});

test('head/control changes during decryption and missing earlier journal entries refuse', async () => {
  const f = await fixture(), unwrap = f.keys.unwrap;
  f.keys.unwrap = async (...args) => { const result = await unwrap(...args); f.state.current.revision = 'changed'; return result; };
  await assert.rejects(f.read, /changed during payload/);
  f.keys.unwrap = unwrap; f.entries.delete([...f.entries.keys()][0]!);
  await assert.rejects(f.read, /does not match|shorter/);
});

test('independent review lineages remain separate and cannot reuse globally immutable child IDs', async () => {
  const first = recoveryFactsFixture(), other = recoveryFactsFixture(); other.operationId = 'other-operation';
  other.review.id = 'review-b'; other.scope.reviewId = 'review-b'; other.permission.reviewId = 'review-b';
  const invalid = await fixture([first,other]); await assert.rejects(invalid.read, /globally immutable/);
  other.scope.id = 'scope-b'; other.permission.id = 'permission-b'; other.permission.scopeId = 'scope-b';
  const valid = await fixture([first,other]);
  assert.deepEqual((await valid.read()).latestStates.map(row => row.reviewId),['review-a','review-b']);
});

test('maximum reviewed inventory survives encrypted history verification without truncation', async () => {
  const value = recoveryFactsFixture();
  const versions = Array.from({ length: 1000 },(_,i) => ({ number: Number.MAX_SAFE_INTEGER - i,
    sha256: 'b'.repeat(64), sizeBytes: Number.MAX_SAFE_INTEGER }));
  value.review.review.snapshot.inventory.attachments = Array.from({ length: 100 },(_,i) => ({ id: `attachment-${i}`,
    currentVersion: Number.MAX_SAFE_INTEGER, versions }));
  const digest = canonicalRetainedConfluenceCopyReviewEvidence(value.review.review).snapshotSha256;
  value.review.snapshotSha256 = digest; value.scope.snapshotSha256 = digest; value.permission.snapshotSha256 = digest;
  const f = await fixture([value]), result = await f.read();
  const attachments = JSON.parse(result.latestStates[0]!.body).review.review.snapshot.inventory.attachments;
  assert.equal(attachments.length,100);
  assert.ok(attachments.every((attachment: { versions: unknown[] }) => attachment.versions.length === 1000));
  assert.equal(result.reopeningAuthorised,false);
});
