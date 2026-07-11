const CIVIL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface CivilDateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export const IRISH_COMPANIES_ACT_WORKING_DAY_RULESET_VERSION =
  'ie-companies-act-2014-s3_owta-1997-si-50-2022_v1';

function isLeapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

function isValidParts(value: CivilDateParts) {
  return (
    Number.isInteger(value.year) &&
    value.year >= 1 &&
    value.year <= 9999 &&
    Number.isInteger(value.month) &&
    value.month >= 1 &&
    value.month <= 12 &&
    Number.isInteger(value.day) &&
    value.day >= 1 &&
    value.day <= daysInMonth(value.year, value.month)
  );
}

export function isCivilDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;

  const match = CIVIL_DATE_PATTERN.exec(value);
  if (!match) return false;

  return isValidParts({
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  });
}

export function parseCivilDate(value: string): CivilDateParts {
  const match = CIVIL_DATE_PATTERN.exec(value);
  const parsed = match
    ? {
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
      }
    : null;

  if (!parsed || !isValidParts(parsed)) {
    throw new RangeError('Civil date must be a valid YYYY-MM-DD date');
  }

  return parsed;
}

export function formatCivilDate(value: CivilDateParts) {
  if (!isValidParts(value)) {
    throw new RangeError('Civil date parts must describe a valid date');
  }

  return `${String(value.year).padStart(4, '0')}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
}

function assertSafeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer`);
  }
}

// Howard Hinnant's proleptic-Gregorian civil calendar conversion, with
// 1970-01-01 as day zero. Keeping this arithmetic date-only avoids DST and
// JavaScript Date's special handling of years 0 through 99.
function daysFromCivil({ year, month, day }: CivilDateParts) {
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const adjustedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * adjustedMonth + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;

  return era * 146097 + dayOfEra - 719468;
}

function civilFromDays(value: number): CivilDateParts {
  const shifted = value + 719468;
  const era = Math.floor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36524) -
      Math.floor(dayOfEra / 146096)) /
      365,
  );
  let year = yearOfEra + era * 400;
  const dayOfYear =
    dayOfEra -
    (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);
  year += month <= 2 ? 1 : 0;

  return { year, month, day };
}

export function addCalendarMonthsClamp(value: string, months: number) {
  assertSafeInteger(months, 'Calendar month amount');
  const parsed = parseCivilDate(value);
  const totalMonths = (parsed.year - 1) * 12 + (parsed.month - 1) + months;

  if (!Number.isSafeInteger(totalMonths)) {
    throw new RangeError(
      'Resulting calendar month is outside the supported range',
    );
  }

  const year = Math.floor(totalMonths / 12) + 1;
  const month = (((totalMonths % 12) + 12) % 12) + 1;
  const day = Math.min(
    parsed.day,
    year >= 1 && year <= 9999 ? daysInMonth(year, month) : 0,
  );

  return formatCivilDate({ year, month, day });
}

export function addCalendarDays(value: string, days: number) {
  assertSafeInteger(days, 'Calendar day amount');
  const ordinal = daysFromCivil(parseCivilDate(value));
  const resultOrdinal = ordinal + days;

  if (!Number.isSafeInteger(resultOrdinal)) {
    throw new RangeError('Resulting civil date is outside the supported range');
  }

  return formatCivilDate(civilFromDays(resultOrdinal));
}

export function compareCivilDates(left: string, right: string) {
  const difference =
    daysFromCivil(parseCivilDate(left)) - daysFromCivil(parseCivilDate(right));

  return difference === 0 ? 0 : difference < 0 ? -1 : 1;
}

export function minCivilDate(first: string, ...rest: string[]) {
  parseCivilDate(first);

  return rest.reduce((minimum, candidate) => {
    parseCivilDate(candidate);
    return compareCivilDates(candidate, minimum) < 0 ? candidate : minimum;
  }, first);
}

/** Returns `later - earlier` as a signed number of civil calendar days. */
export function differenceInCivilDays(later: string, earlier: string) {
  return (
    daysFromCivil(parseCivilDate(later)) -
    daysFromCivil(parseCivilDate(earlier))
  );
}

export function todayInTimeZone(timeZone: string, now = new Date()) {
  if (Number.isNaN(now.getTime())) {
    throw new RangeError('Current instant must be a valid Date');
  }

  const parts = new Intl.DateTimeFormat('en-CA-u-ca-gregory-nu-latn', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const valueByType = new Map(parts.map((part) => [part.type, part.value]));

  return formatCivilDate({
    year: Number(valueByType.get('year')),
    month: Number(valueByType.get('month')),
    day: Number(valueByType.get('day')),
  });
}

function dayOfWeek(value: string) {
  const ordinal = daysFromCivil(parseCivilDate(value));
  return (((ordinal + 4) % 7) + 7) % 7;
}

function firstWeekdayOfMonth(year: number, month: number, weekday: number) {
  const first = formatCivilDate({ year, month, day: 1 });
  return formatCivilDate({
    year,
    month,
    day: 1 + ((weekday - dayOfWeek(first) + 7) % 7),
  });
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number) {
  const lastDay = daysInMonth(year, month);
  const last = formatCivilDate({ year, month, day: lastDay });
  return formatCivilDate({
    year,
    month,
    day: lastDay - ((dayOfWeek(last) - weekday + 7) % 7),
  });
}

function easterSunday(year: number) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;

  return formatCivilDate({ year, month, day });
}

/**
 * Returns the actual statutory Irish public-holiday dates, not substitute
 * employee days off. The ruleset is intended for Companies Act 2014 section 3
 * deadlines and includes the one-off 18 March 2022 holiday and the recurring
 * St Brigid's Day rule effective from 2023.
 */
export function getIrishStatutoryPublicHolidays(year: number) {
  if (!Number.isInteger(year) || year < 1 || year > 9999) {
    throw new RangeError(
      'Public-holiday year must be an integer from 1 to 9999',
    );
  }

  const holidays = new Set<string>([
    formatCivilDate({ year, month: 1, day: 1 }),
    formatCivilDate({ year, month: 3, day: 17 }),
    addCalendarDays(easterSunday(year), 1),
    firstWeekdayOfMonth(year, 5, 1),
    firstWeekdayOfMonth(year, 6, 1),
    firstWeekdayOfMonth(year, 8, 1),
    lastWeekdayOfMonth(year, 10, 1),
    formatCivilDate({ year, month: 12, day: 25 }),
    formatCivilDate({ year, month: 12, day: 26 }),
  ]);

  if (year === 2022) holidays.add('2022-03-18');

  if (year >= 2023) {
    const firstFebruary = formatCivilDate({ year, month: 2, day: 1 });
    holidays.add(
      dayOfWeek(firstFebruary) === 5
        ? firstFebruary
        : firstWeekdayOfMonth(year, 2, 1),
    );
  }

  return [...holidays].sort();
}

export function isIrishStatutoryPublicHoliday(value: string) {
  const { year } = parseCivilDate(value);
  return getIrishStatutoryPublicHolidays(year).includes(value);
}

export function isIrishCompaniesActWorkingDay(value: string) {
  const weekday = dayOfWeek(value);
  return (
    weekday !== 0 && weekday !== 6 && !isIrishStatutoryPublicHoliday(value)
  );
}

export function adjustIrishCompaniesActDeadlineToWorkingDay(value: string) {
  let adjusted = formatCivilDate(parseCivilDate(value));

  while (!isIrishCompaniesActWorkingDay(adjusted)) {
    adjusted = addCalendarDays(adjusted, 1);
  }

  return adjusted;
}
