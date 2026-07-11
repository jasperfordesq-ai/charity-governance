import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  civilDateFromPrisma,
  nullableCivilDateFromPrisma,
  prismaDateFromCivil,
} from '../utils/civil-date.js';

test('Prisma civil-date boundary round-trips exact dates without local timezone arithmetic', () => {
  const stored = prismaDateFromCivil('2026-06-30');
  assert.equal(stored.toISOString(), '2026-06-30T00:00:00.000Z');
  assert.equal(civilDateFromPrisma(stored), '2026-06-30');
  assert.equal(civilDateFromPrisma('2026-06-30T00:00:00.000Z'), '2026-06-30');
  assert.equal(nullableCivilDateFromPrisma(null), null);
});

test('Prisma civil-date boundary rejects impossible or non-date inputs', () => {
  assert.throws(() => prismaDateFromCivil('2026-02-29'), RangeError);
  assert.throws(() => prismaDateFromCivil('2026-06-30T00:00:00Z'), RangeError);
  assert.throws(() => civilDateFromPrisma('not-a-date'), RangeError);
  assert.throws(() => civilDateFromPrisma(new Date(Number.NaN)), RangeError);
});
