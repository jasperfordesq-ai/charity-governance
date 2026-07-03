import { z } from 'zod';

function hasValidIsoDatePart(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
  if (!match) return false;

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);

  if (month < 1 || month > 12 || day < 1 || day > 31) return false;

  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function isIsoDateOrDateTime(value: string) {
  return (
    hasValidIsoDatePart(value) &&
    (/^\d{4}-\d{2}-\d{2}$/.test(value) || /^\d{4}-\d{2}-\d{2}T/.test(value)) &&
    !Number.isNaN(Date.parse(value))
  );
}

export const dateInputSchema = z.string().refine(
  isIsoDateOrDateTime,
  'Date must be a valid ISO date or datetime',
);

export const nullableDateInputSchema = z
  .string()
  .trim()
  .refine(
    (value) => value === '' || isIsoDateOrDateTime(value),
    'Date must be a valid ISO date or datetime',
  )
  .nullable()
  .optional()
  .transform((value) => (value === '' ? null : value));
