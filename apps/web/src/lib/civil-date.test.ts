import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addCivilDays,
  civilDaysBetween,
  civilToday,
  compareCivilDates,
  formatCivilDate,
  toCivilDate,
} from './civil-date';

test('civil dates reject impossible values and accept the legacy ISO transition shape', () => {
  assert.equal(toCivilDate('2024-02-29'), '2024-02-29');
  assert.equal(toCivilDate('2026-06-30T00:00:00.000Z'), '2026-06-30');
  assert.equal(toCivilDate('2026-02-29'), null);
  assert.equal(toCivilDate('2026-04-31'), null);
  assert.equal(toCivilDate('not-a-date'), null);
});

test('civil arithmetic is stable across month ends and leap years', () => {
  assert.equal(addCivilDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addCivilDays('2024-02-29', 1), '2024-03-01');
  assert.equal(addCivilDays('2025-03-01', -1), '2025-02-28');
  assert.equal(addCivilDays('2026-12-31', 30), '2027-01-30');
  assert.equal(civilDaysBetween('2024-02-28', '2024-03-01'), 2);
  assert.equal(civilDaysBetween('2025-03-29', '2025-03-31'), 2);
});

test('civil sorting and formatting never depend on the host timezone', () => {
  assert.equal(compareCivilDates('2026-06-30T00:00:00.000Z', '2026-07-01'), -1);
  assert.equal(formatCivilDate('2026-06-30', true), 'Tue, 30 Jun 2026');
  const instant = new Date('2026-06-30T23:30:00.000Z');
  assert.equal(civilToday(instant, 'America/Los_Angeles'), '2026-06-30');
  assert.equal(civilToday(instant, 'Pacific/Kiritimati'), '2026-07-01');
});
