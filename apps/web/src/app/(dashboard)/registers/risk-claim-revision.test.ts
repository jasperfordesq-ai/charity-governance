import assert from 'node:assert/strict';
import test from 'node:test';
import { activeVerifiedClaimIds, riskClaimRevisionCue } from './risk-claim-revision';

test('a later risk edit prompts review without declaring the control invalid', () => {
  const claim = { state: 'VERIFIED' as const, riskRevision: 3 };
  assert.match(riskClaimRevisionCue(claim, 4) ?? '', /Review whether/);
  assert.equal(riskClaimRevisionCue(claim, 3), null);
  assert.equal(riskClaimRevisionCue({ ...claim, state: 'WITHDRAWN' }, 4), null);
});

test('older claims with no revision have an explicit unknown-review cue', () => {
  assert.match(riskClaimRevisionCue({ state: 'VERIFIED', riskRevision: null }, 4) ?? '', /no captured risk revision/);
});

test('only the latest currently verified claim for each control gets a review cue', () => {
  const active = activeVerifiedClaimIds([
    { id: 'withdrawn', controlReference: 'C1', state: 'WITHDRAWN' },
    { id: 'old-c1', controlReference: 'C1', state: 'VERIFIED' },
    { id: 'new-c2', controlReference: 'C2', state: 'VERIFIED' },
    { id: 'old-c2', controlReference: 'C2', state: 'VERIFIED' },
  ]);
  assert.deepEqual([...active], ['new-c2']);
});
