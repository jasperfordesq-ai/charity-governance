import test from 'node:test';
import assert from 'node:assert/strict';
import { groupNarrativeWarnings, narrativeWarningDate } from '../constants/narrative-warnings.js';
import type { ComplianceNarrativeWarning } from '../types/api.js';

const edited = '2026-09-01T10:00:00.000Z';
const linked = (standardId: string, standardCode: string, documentId: string, linkedAt: string): ComplianceNarrativeWarning => ({
  kind: 'EVIDENCE_LINKED_AFTER_NARRATIVE', standardId, standardCode, recordUpdatedAt: edited, documentId, linkedAt,
});
const target = (standardId: string, standardCode: string, targetDate: string): ComplianceNarrativeWarning => ({
  kind: 'TARGET_DATE_PASSED', standardId, standardCode, recordUpdatedAt: edited, targetDate,
});

test('one warning per standard: documents linked since the record was edited are counted, with the latest date', () => {
  const groups = groupNarrativeWarnings([
    linked('s-23', '2.3', 'd-1', '2026-10-09T09:00:00.000Z'),
    linked('s-23', '2.3', 'd-2', '2026-10-11T15:00:00.000Z'),
    linked('s-23', '2.3', 'd-3', '2026-10-10T12:00:00.000Z'),
    target('s-23', '2.3', '2026-09-03'),
    linked('s-56', '5.6', 'd-1', '2026-10-09T09:00:00.000Z'),
  ]);

  assert.deepEqual(groups.map((g) => `${g.standardCode} — ${g.message}`), [
    `2.3 — 3 documents linked since this record was last edited (latest ${narrativeWarningDate('2026-10-11')})`,
    `2.3 — Target date ${narrativeWarningDate('2026-09-03')} has passed`,
    `5.6 — 1 document linked since this record was last edited (latest ${narrativeWarningDate('2026-10-09')})`,
  ]);
  assert.deepEqual(groups[0]!.documentIds, ['d-1', 'd-2', 'd-3']);
  assert.equal(new Set(groups.map((g) => g.key)).size, 3, 'each line has its own key');
});

test('the linked-evidence line comes before the target line, whatever order the warnings arrive in', () => {
  const groups = groupNarrativeWarnings([
    target('s-23', '2.3', '2026-09-03'),
    linked('s-23', '2.3', 'd-1', '2026-10-11T00:00:00.000Z'),
  ]);
  assert.deepEqual(groups.map((g) => g.kind), ['EVIDENCE_LINKED_AFTER_NARRATIVE', 'TARGET_DATE_PASSED']);
});

test('several passed targets on one standard are one warning, earliest first, and a repeated document counts once', () => {
  const groups = groupNarrativeWarnings([
    target('s-41', '4.1', '2026-10-01'),
    target('s-41', '4.1', '2026-09-03'),
    target('s-41', '4.1', '2026-09-03'),
    linked('s-41', '4.1', 'd-1', '2026-10-11T00:00:00.000Z'),
    linked('s-41', '4.1', 'd-1', '2026-10-12T00:00:00.000Z'),
  ]);
  assert.equal(groups.length, 2);
  assert.match(groups[0]!.message, /^1 document linked/);
  assert.equal(groups[1]!.message, `Target dates ${narrativeWarningDate('2026-09-03')} and ${narrativeWarningDate('2026-10-01')} have passed`);
});

test('dates are written with the month as a word, so day and month cannot be swapped', () => {
  assert.match(narrativeWarningDate('2026-10-11T00:00:00.000Z'), /^11 Oct 2026$/);
});

test('no warnings, or none sent by an older API, is an empty list', () => {
  assert.deepEqual(groupNarrativeWarnings([]), []);
  assert.deepEqual(groupNarrativeWarnings(undefined), []);
  assert.deepEqual(groupNarrativeWarnings(null), []);
});
