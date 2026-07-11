import { isCivilDate } from '@charitypilot/shared';

export function prismaDateFromCivil(value: string): Date {
  if (!isCivilDate(value)) {
    throw new RangeError('Civil date must be a valid YYYY-MM-DD date');
  }
  return new Date(`${value}T00:00:00.000Z`);
}

export function civilDateFromPrisma(value: Date | string): string {
  if (typeof value === 'string') {
    const datePart = value.slice(0, 10);
    if (isCivilDate(datePart)) return datePart;
    throw new RangeError('Stored civil date is invalid');
  }

  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError('Stored civil date is invalid');
  }
  const datePart = value.toISOString().slice(0, 10);
  if (!isCivilDate(datePart)) {
    throw new RangeError('Stored civil date is invalid');
  }
  return datePart;
}

export function nullableCivilDateFromPrisma(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : civilDateFromPrisma(value);
}
