/**
 * Consistent date formatting across the app.
 * Uses en-IE locale (Irish English) for all date display.
 */

const DATE_LOCALE = 'en-IE';

/** Format as "3 Jan 2026" */
export function formatDate(date: string | Date): string {
  return new Date(date).toLocaleDateString(DATE_LOCALE, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Format as "3 Jan 2026, 14:30" */
export function formatDateTime(date: string | Date): string {
  return new Date(date).toLocaleDateString(DATE_LOCALE, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Days until a date from today (positive = future, negative = past) */
export function daysUntil(date: string | Date): number {
  const target = new Date(date);
  const today = new Date();
  // Normalise to start of day in local timezone to avoid DST issues
  target.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  return Math.ceil((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}
