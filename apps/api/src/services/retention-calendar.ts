import { addCalendarMonthsClamp } from '@charitypilot/shared';

/**
 * A proposed UTC anniversary cutoff for a whole-calendar-year retention term.
 * This is arithmetic only: it does not approve a term, infer its starting
 * event, authorize disposal, or replace the current day-based policy guard.
 * A 29 February anchor clamps to 28 February in a non-leap target year.
 */
export function calendarYearRetentionCutoffUtc(anchor: Date, years: number): Date {
  if (!(anchor instanceof Date) || !Number.isFinite(anchor.getTime())) {
    throw new RangeError('A valid UTC retention anchor is required');
  }
  if (!Number.isSafeInteger(years) || years < 1 || years > 100) {
    throw new RangeError('Calendar retention years must be an integer from 1 to 100');
  }

  const source = anchor.toISOString();
  const sourceYear = Number(source.slice(0, 4));
  if (!/^\d{4}-/.test(source) || sourceYear < 1 || sourceYear + years > 9999) {
    throw new RangeError('Calendar retention cutoff is outside the supported date range');
  }
  const date = addCalendarMonthsClamp(source.slice(0, 10), years * 12);
  const cutoff = new Date(`${date}${source.slice(10)}`);
  if (!Number.isFinite(cutoff.getTime())) {
    throw new RangeError('Calendar retention cutoff is outside the supported date range');
  }
  return cutoff;
}
