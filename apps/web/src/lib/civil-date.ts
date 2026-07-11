import {
  addCalendarDays,
  compareCivilDates as compareSharedCivilDates,
  differenceInCivilDays,
  isCivilDate,
  parseCivilDate,
  todayInTimeZone,
} from '@charitypilot/shared';

export type CivilDate = `${number}-${number}-${number}`;

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * Decode a civil date returned by the API. During the P0-06 rolling contract
 * migration, legacy UTC-midnight ISO values remain readable, but every value
 * sent back to the API is the exact YYYY-MM-DD date part.
 */
export function toCivilDate(value: string | null | undefined): CivilDate | null {
  if (!value) return null;
  const candidate = /^\d{4}-\d{2}-\d{2}T/u.test(value) ? value.slice(0, 10) : value;
  return isCivilDate(candidate) ? (candidate as CivilDate) : null;
}

export function compareCivilDates(left: string, right: string): number {
  const leftDate = toCivilDate(left);
  const rightDate = toCivilDate(right);
  if (!leftDate || !rightDate) return left.localeCompare(right);
  return compareSharedCivilDates(leftDate, rightDate);
}

export function civilDaysBetween(from: string, to: string): number {
  const fromDate = toCivilDate(from);
  const toDate = toCivilDate(to);
  if (!fromDate || !toDate) return Number.NaN;
  return differenceInCivilDays(toDate, fromDate);
}

export function addCivilDays(value: string, amount: number): CivilDate | null {
  const civil = toCivilDate(value);
  if (!civil || !Number.isSafeInteger(amount)) return null;
  try {
    return addCalendarDays(civil, amount) as CivilDate;
  } catch {
    return null;
  }
}

export function civilToday(
  now: Date = new Date(),
  timeZone = 'Europe/Dublin',
): CivilDate {
  return todayInTimeZone(timeZone, now) as CivilDate;
}

export function formatCivilDate(value: string, includeWeekday = false): string {
  const civil = toCivilDate(value);
  if (!civil) return 'Invalid date';
  const parsed = parseCivilDate(civil);
  const base = `${parsed.day} ${MONTH_NAMES[parsed.month - 1]} ${parsed.year}`;
  if (!includeWeekday) return base;
  const weekday = ((differenceInCivilDays(civil, '1970-01-01') + 4) % 7 + 7) % 7;
  return `${WEEKDAY_NAMES[weekday]}, ${base}`;
}
