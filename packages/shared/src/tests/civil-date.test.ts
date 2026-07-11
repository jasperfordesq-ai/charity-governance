import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IRISH_COMPANIES_ACT_WORKING_DAY_RULESET_VERSION,
  addCalendarDays,
  addCalendarMonthsClamp,
  adjustIrishCompaniesActDeadlineToWorkingDay,
  compareCivilDates,
  differenceInCivilDays,
  formatCivilDate,
  getIrishStatutoryPublicHolidays,
  isCivilDate,
  isIrishCompaniesActWorkingDay,
  isIrishStatutoryPublicHoliday,
  minCivilDate,
  parseCivilDate,
  todayInTimeZone,
} from '../calendar/index.js';

test('civil dates validate, parse and format strict YYYY-MM-DD values', () => {
  assert.equal(isCivilDate('2024-02-29'), true);
  assert.deepEqual(parseCivilDate('2024-02-29'), {
    year: 2024,
    month: 2,
    day: 29,
  });
  assert.equal(formatCivilDate({ year: 2026, month: 7, day: 9 }), '2026-07-09');

  for (const invalid of [
    '2023-02-29',
    '1900-02-29',
    '0000-01-01',
    '2026-2-01',
    '2026-02-1',
    '2026-02-01T00:00:00Z',
    ' 2026-02-01',
    '2026-02-01 ',
  ]) {
    assert.equal(isCivilDate(invalid), false, `${invalid} must be rejected`);
    assert.throws(() => parseCivilDate(invalid), RangeError);
  }

  assert.throws(
    () => formatCivilDate({ year: 2026, month: 2, day: 29 }),
    RangeError,
  );
});

test('calendar month arithmetic clamps every month-end class', () => {
  assert.equal(addCalendarMonthsClamp('2023-01-31', 1), '2023-02-28');
  assert.equal(addCalendarMonthsClamp('2024-01-31', 1), '2024-02-29');
  assert.equal(addCalendarMonthsClamp('2026-03-31', 1), '2026-04-30');
  assert.equal(addCalendarMonthsClamp('2026-01-31', 2), '2026-03-31');
  assert.equal(addCalendarMonthsClamp('2026-04-30', 1), '2026-05-30');
  assert.equal(addCalendarMonthsClamp('2025-08-31', 10), '2026-06-30');
  assert.equal(addCalendarMonthsClamp('2024-02-29', 12), '2025-02-28');
  assert.equal(addCalendarMonthsClamp('2026-03-31', -1), '2026-02-28');

  const monthEnd = (year: number, month: number) =>
    new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (const year of [2024, 2025]) {
    for (let sourceMonth = 1; sourceMonth <= 12; sourceMonth += 1) {
      const sourceDay = monthEnd(year, sourceMonth);
      const source = `${year}-${String(sourceMonth).padStart(2, '0')}-${String(sourceDay).padStart(2, '0')}`;
      for (let offset = 1; offset <= 12; offset += 1) {
        const targetIndex = sourceMonth - 1 + offset;
        const targetYear = year + Math.floor(targetIndex / 12);
        const targetMonth = (targetIndex % 12) + 1;
        const targetDay = Math.min(sourceDay, monthEnd(targetYear, targetMonth));
        const expected = `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
        assert.equal(addCalendarMonthsClamp(source, offset), expected, `${source} + ${offset} months`);
      }
    }
  }
});

test('calendar day arithmetic handles leap years and CRO 56-day timing', () => {
  assert.equal(addCalendarDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addCalendarDays('2024-02-29', 1), '2024-03-01');
  assert.equal(addCalendarDays('2000-02-28', 1), '2000-02-29');
  assert.equal(addCalendarDays('1900-02-28', 1), '1900-03-01');
  assert.equal(addCalendarDays('2026-09-30', 56), '2026-11-25');
  assert.equal(addCalendarDays('2026-01-01', -1), '2025-12-31');
});

test('civil comparison, minimum and differences are date-only and signed', () => {
  assert.equal(compareCivilDates('2026-03-29', '2026-03-30'), -1);
  assert.equal(compareCivilDates('2026-03-30', '2026-03-29'), 1);
  assert.equal(compareCivilDates('2026-03-30', '2026-03-30'), 0);
  assert.equal(
    minCivilDate('2026-10-25', '2026-03-29', '2026-03-30'),
    '2026-03-29',
  );
  assert.equal(differenceInCivilDays('2026-03-30', '2026-03-28'), 2);
  assert.equal(differenceInCivilDays('2026-03-28', '2026-03-30'), -2);
});

test('todayInTimeZone extracts Europe/Dublin dates across DST boundaries', () => {
  assert.equal(
    todayInTimeZone('Europe/Dublin', new Date('2026-03-29T23:30:00.000Z')),
    '2026-03-30',
  );
  assert.equal(
    todayInTimeZone('Europe/Dublin', new Date('2026-10-25T00:30:00.000Z')),
    '2026-10-25',
  );
  assert.equal(
    todayInTimeZone('Europe/Dublin', new Date('2026-10-25T23:30:00.000Z')),
    '2026-10-25',
  );
});

test('Irish statutory holidays include Easter Monday and St Brigid rules', () => {
  assert.match(
    IRISH_COMPANIES_ACT_WORKING_DAY_RULESET_VERSION,
    /companies-act-2014/,
  );
  assert.equal(isIrishStatutoryPublicHoliday('2026-04-06'), true);
  assert.equal(isIrishStatutoryPublicHoliday('2026-02-02'), true);
  assert.equal(isIrishStatutoryPublicHoliday('2030-02-01'), true);
  assert.equal(isIrishStatutoryPublicHoliday('2030-02-04'), false);
  assert.equal(isIrishStatutoryPublicHoliday('2022-03-18'), true);
  assert.equal(isIrishStatutoryPublicHoliday('2022-02-07'), false);

  const holidays = getIrishStatutoryPublicHolidays(2026);
  assert.deepEqual(holidays, [
    '2026-01-01',
    '2026-02-02',
    '2026-03-17',
    '2026-04-06',
    '2026-05-04',
    '2026-06-01',
    '2026-08-03',
    '2026-10-26',
    '2026-12-25',
    '2026-12-26',
  ]);
});

test('Companies Act deadline adjustment advances weekends and public holidays', () => {
  assert.equal(isIrishCompaniesActWorkingDay('2026-07-10'), true);
  assert.equal(isIrishCompaniesActWorkingDay('2026-07-11'), false);
  assert.equal(
    adjustIrishCompaniesActDeadlineToWorkingDay('2026-07-11'),
    '2026-07-13',
  );
  assert.equal(
    adjustIrishCompaniesActDeadlineToWorkingDay('2026-03-17'),
    '2026-03-18',
  );
  assert.equal(
    adjustIrishCompaniesActDeadlineToWorkingDay('2026-04-06'),
    '2026-04-07',
  );
  assert.equal(
    adjustIrishCompaniesActDeadlineToWorkingDay('2026-12-25'),
    '2026-12-28',
  );
});
