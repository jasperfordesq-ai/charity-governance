import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateDocumentDisposalCompleteness } from '../services/document-disposal-completeness.js';

const NOW = new Date('2026-10-11T12:00:00.000Z');
const LATER = new Date('2026-11-11T12:00:00.000Z');
const EARLIER = new Date('2026-10-01T12:00:00.000Z');
const store = (disposition: string) => ({ disposition, evidenceRef: 'PLAN-001' });
const plan = (overrides: Record<string, string> = {}) => ({ PRIMARY: store('DISPOSE'),
  VERSIONS: store('DISPOSE'), CONFLUENCE: store('DISPOSE'), EXPORTS: store('RETAIN_APPROVED'),
  AUDIT: store('RETAIN_APPROVED'), BACKUPS: store('NOT_APPLICABLE'),
  ...Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, store(v)])) });
let seq = 0;
const obs = (area: string, scopeRef: string, status: string, extra: Record<string, unknown> = {}) => ({
  id: `obs-${++seq}`, area, scopeRef, revision: 1, status, copyAuthorityId: null,
  nextReviewAt: status === 'RETAINED_APPROVED' ? LATER : null, ...extra });
/** Every area resolved: the baseline every case below changes one thing in. */
const resolved = () => [
  obs('VERSIONS', 'VERSION-STORE', 'VERIFIED_ABSENT'),
  obs('CONFLUENCE', 'PAGE-1001', 'VERIFIED_ABSENT'),
  obs('EXPORTS', 'BOARD-PACK-2026', 'RETAINED_APPROVED'),
  obs('AUDIT', 'AUDIT-LOG', 'RETAINED_APPROVED'),
];
const evaluate = (changes: Partial<Parameters<typeof evaluateDocumentDisposalCompleteness>[0]> = {}) =>
  evaluateDocumentDisposalCompleteness({ plan: plan(), primaryCompletionRecorded: true,
    observations: resolved(), authorities: [], holds: [], now: NOW, ...changes });
const reasons = (result: ReturnType<typeof evaluate>) =>
  result.areas.flatMap((a) => a.unresolved.map((u) => `${a.area}:${u.scopeRef ?? '-'}:${u.reason}`));

test('a case is complete only with the primary completion and every planned area resolved', () => {
  const result = evaluate();
  assert.equal(result.complete, true);
  assert.equal(result.actionAuthorized, false);
  assert.deepEqual(result.areas.map((a) => [a.area, a.plan, a.scopes, a.resolved, a.unresolved.length]), [
    ['VERSIONS', 'DISPOSE', 1, 1, 0], ['CONFLUENCE', 'DISPOSE', 1, 1, 0], ['EXPORTS', 'RETAIN_APPROVED', 1, 1, 0],
    ['AUDIT', 'RETAIN_APPROVED', 1, 1, 0], ['BACKUPS', 'NOT_APPLICABLE', 0, 0, 0]]);
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  const primaryOnly = evaluate({ primaryCompletionRecorded: false });
  assert.equal(primaryOnly.complete, false, 'copies alone never complete a case');
  assert.deepEqual(reasons(primaryOnly), []);
  assert.notEqual(primaryOnly.digest, result.digest);
});

test('primary absence alone leaves the case incomplete: every planned area needs a recorded scope', () => {
  const result = evaluate({ observations: [] });
  assert.equal(result.complete, false);
  assert.deepEqual(reasons(result), ['VERSIONS:-:NO_SCOPE_RECORDED', 'CONFLUENCE:-:NO_SCOPE_RECORDED',
    'EXPORTS:-:NO_SCOPE_RECORDED', 'AUDIT:-:NO_SCOPE_RECORDED']);
});

test('unresolved observations, overdue retention and plan contradictions keep it incomplete', () => {
  for (const [status, reason] of [['NEEDS_REVIEW', 'NEEDS_REVIEW'], ['PENDING_DISPOSAL', 'PENDING_DISPOSAL'],
    ['FAILED', 'FAILED']] as const) {
    const result = evaluate({ observations: [...resolved(), obs('CONFLUENCE', 'PAGE-2002', status)] });
    assert.deepEqual([result.complete, reasons(result)], [false, [`CONFLUENCE:PAGE-2002:${reason}`]], status);
  }
  const overdue = evaluate({ observations: [...resolved().slice(0, 3),
    obs('AUDIT', 'AUDIT-LOG', 'RETAINED_APPROVED', { nextReviewAt: NOW })] });
  assert.deepEqual(reasons(overdue), ['AUDIT:AUDIT-LOG:REVIEW_OVERDUE']);
  const noReview = evaluate({ observations: [...resolved().slice(0, 3),
    obs('AUDIT', 'AUDIT-LOG', 'RETAINED_APPROVED', { nextReviewAt: null })] });
  assert.deepEqual(reasons(noReview), ['AUDIT:AUDIT-LOG:REVIEW_OVERDUE']);
  // Without scoped authority, an outcome must match the area's plan.
  for (const [areaName, status] of [['VERSIONS', 'RETAINED_APPROVED'], ['EXPORTS', 'VERIFIED_ABSENT'],
    ['CONFLUENCE', 'NOT_APPLICABLE']] as const) {
    const result = evaluate({ observations: [...resolved(), obs(areaName, 'ODD-SCOPE', status)] });
    assert.deepEqual(reasons(result), [`${areaName}:ODD-SCOPE:CONTRADICTS_PLAN`], `${areaName} ${status}`);
  }
  // A NOT_APPLICABLE area is resolved by its plan, unless evidence says otherwise.
  const backups = evaluate({ observations: [...resolved(), obs('BACKUPS', 'NIGHTLY-SET', 'NEEDS_REVIEW')] });
  assert.deepEqual(reasons(backups), ['BACKUPS:NIGHTLY-SET:NEEDS_REVIEW']);
  const backupsNa = evaluate({ observations: [...resolved(), obs('BACKUPS', 'NIGHTLY-SET', 'NOT_APPLICABLE')] });
  assert.equal(backupsNa.complete, true);
});

test('only the latest revision of each scope counts', () => {
  const fixed = evaluate({ observations: [...resolved(),
    obs('CONFLUENCE', 'PAGE-2002', 'FAILED', { revision: 1 }),
    obs('CONFLUENCE', 'PAGE-2002', 'VERIFIED_ABSENT', { revision: 2 })] });
  assert.equal(fixed.complete, true);
  const regressed = evaluate({ observations: [...resolved(),
    obs('CONFLUENCE', 'PAGE-2002', 'VERIFIED_ABSENT', { revision: 1 }),
    obs('CONFLUENCE', 'PAGE-2002', 'PENDING_DISPOSAL', { revision: 2 })] });
  assert.deepEqual(reasons(regressed), ['CONFLUENCE:PAGE-2002:PENDING_DISPOSAL']);
  assert.throws(() => evaluate({ observations: [...resolved(),
    obs('CONFLUENCE', 'PAGE-2002', 'FAILED'), obs('CONFLUENCE', 'PAGE-2002', 'FAILED')] }), /duplicate revision/);
});

test('scoped authority must still be current, and retention under it unexpired', () => {
  const authority = { id: 'auth-1', area: 'EXPORTS', scopeRef: 'BOARD-PACK-2026', revision: 1,
    state: 'AUTHORIZED', validUntil: LATER };
  const underAuthority = [...resolved().slice(0, 2),
    obs('EXPORTS', 'BOARD-PACK-2026', 'RETAINED_APPROVED', { copyAuthorityId: 'auth-1' }), resolved()[3]!];
  assert.equal(evaluate({ observations: underAuthority, authorities: [authority] }).complete, true);
  const expired = evaluate({ observations: underAuthority, authorities: [{ ...authority, validUntil: EARLIER }] });
  assert.deepEqual(reasons(expired), ['EXPORTS:BOARD-PACK-2026:AUTHORITY_EXPIRED']);
  const untimed = evaluate({ observations: underAuthority, authorities: [{ ...authority, validUntil: null }] });
  assert.deepEqual(reasons(untimed), ['EXPORTS:BOARD-PACK-2026:AUTHORITY_EXPIRED']);
  const withdrawn = evaluate({ observations: underAuthority, authorities: [authority,
    { ...authority, id: 'auth-2', revision: 2, state: 'WITHDRAWN', validUntil: null }] });
  assert.deepEqual(reasons(withdrawn), ['EXPORTS:BOARD-PACK-2026:AUTHORITY_CHANGED']);
  // Authority granted after a plan-based observation also needs a fresh one.
  const later = evaluate({ authorities: [{ ...authority, area: 'VERSIONS', scopeRef: 'VERSION-STORE' }] });
  assert.deepEqual(reasons(later), ['VERSIONS:VERSION-STORE:AUTHORITY_CHANGED']);
  // A verified absence is a past fact: authority expiring later does not undo it.
  const absent = evaluate({ observations: [obs('VERSIONS', 'VERSION-STORE', 'VERIFIED_ABSENT', { copyAuthorityId: 'v-1' }),
    ...resolved().slice(1)], authorities: [{ id: 'v-1', area: 'VERSIONS', scopeRef: 'VERSION-STORE', revision: 1,
    state: 'AUTHORIZED', validUntil: EARLIER }] });
  assert.equal(absent.complete, true);
});

test('the digest binds the exact evidence rows relied on, holds included, and nothing else', () => {
  const base = evaluate();
  const again = evaluateDocumentDisposalCompleteness({ plan: plan(), primaryCompletionRecorded: true,
    observations: resolved().map((row, i) => ({ ...row, id: `obs-x${i}` })), authorities: [], holds: [], now: NOW });
  assert.notEqual(again.digest, base.digest, 'different evidence rows');
  const rows = resolved();
  const unheld = evaluate({ observations: rows });
  const held = evaluate({ observations: rows, holds: [{ area: 'EXPORTS', scopeRef: 'BOARD-PACK-2026', revision: 1, held: true }] });
  assert.equal(held.complete, true, 'a hold on a retained copy keeps it retained');
  assert.notEqual(held.digest, unheld.digest, 'the same rows with a hold revision are different evidence');
  const reordered = evaluate({ observations: resolved().reverse() });
  assert.equal(reordered.complete, true);
  const later = evaluate({ now: new Date('2026-10-12T12:00:00.000Z') });
  assert.equal(later.complete, true);
  const fixedRows = resolved();
  const first = evaluate({ observations: fixedRows });
  assert.equal(evaluate({ observations: [...fixedRows].reverse() }).digest, first.digest, 'order does not matter');
  assert.equal(evaluate({ observations: fixedRows, now: new Date('2026-10-12T12:00:00.000Z') }).digest, first.digest,
    'time is a judgement, not evidence');
});

test('malformed evidence, plans and time are refused', () => {
  assert.throws(() => evaluate({ plan: { ...plan(), EXTRA: store('DISPOSE') } }));
  assert.throws(() => evaluate({ plan: { ...plan(), PRIMARY: store('RETAIN_APPROVED') } }));
  const { BACKUPS: _omitted, ...missing } = plan();
  assert.throws(() => evaluate({ plan: missing }));
  assert.throws(() => evaluate({ observations: [obs('PRIMARY', 'FILE-1', 'VERIFIED_ABSENT')] }));
  assert.throws(() => evaluate({ observations: [obs('VERSIONS', 'lower-case', 'VERIFIED_ABSENT')] }));
  assert.throws(() => evaluate({ observations: [obs('VERSIONS', 'VERSION-STORE', 'ERASED')] }));
  assert.throws(() => evaluate({ now: new Date(Number.NaN) }), /time is invalid/);
});

test('the copy-evidence allowance needs this authorization\'s own claim and a completion in the same charity', async () => {
  const { documentPrimaryCompleted } = await import('../services/document-disposal-completeness.js');
  const tx = (claim: { deletionId: string } | null, completion: { organisationId: string } | null) => ({
    documentPurgeClaim: { findFirst: async ({ where }: { where: unknown }) => {
      assert.deepEqual(where, { authorizationId: 'auth', organisationId: 'org' });
      return claim;
    } },
    documentBytePrimaryCompletion: { findUnique: async ({ where }: { where: unknown }) => {
      assert.deepEqual(where, { deletionId: 'deletion' });
      return completion;
    } },
  }) as never;
  assert.equal(await documentPrimaryCompleted(tx(null, { organisationId: 'org' }), 'org', 'auth'), false, 'no claim');
  assert.equal(await documentPrimaryCompleted(tx({ deletionId: 'deletion' }, null), 'org', 'auth'), false, 'no completion');
  assert.equal(await documentPrimaryCompleted(tx({ deletionId: 'deletion' }, { organisationId: 'other' }), 'org', 'auth'), false);
  assert.equal(await documentPrimaryCompleted(tx({ deletionId: 'deletion' }, { organisationId: 'org' }), 'org', 'auth'), true);
});
