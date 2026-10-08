import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calendarYearRetentionCutoffUtc } from '../services/retention-calendar.js';

test('calendar-year retention clamps a leap-day anchor only when the target year is not leap', () => {
  const anchor = new Date('2024-02-29T12:34:56.789Z');
  assert.equal(calendarYearRetentionCutoffUtc(anchor, 6).toISOString(), '2030-02-28T12:34:56.789Z');
  assert.equal(calendarYearRetentionCutoffUtc(anchor, 4).toISOString(), '2028-02-29T12:34:56.789Z');
  assert.equal(anchor.toISOString(), '2024-02-29T12:34:56.789Z');
});

test('calendar-year retention preserves the UTC instant at the anniversary cutoff', () => {
  const cutoff = calendarYearRetentionCutoffUtc(new Date('2025-12-31T23:59:59.999Z'), 1);
  assert.equal(cutoff.toISOString(), '2026-12-31T23:59:59.999Z');
  assert.ok(new Date('2026-12-31T23:59:59.998Z') < cutoff);
  assert.ok(new Date('2026-12-31T23:59:59.999Z') >= cutoff);
});

test('calendar-year retention rejects invalid anchors, fractional terms and unsupported years', () => {
  assert.throws(() => calendarYearRetentionCutoffUtc(new Date(Number.NaN), 6), /valid UTC retention anchor/);
  for (const years of [0, -1, 1.5, 101, Number.NaN]) {
    assert.throws(() => calendarYearRetentionCutoffUtc(new Date('2024-01-01T00:00:00Z'), years),
      /integer from 1 to 100/);
  }
  assert.throws(() => calendarYearRetentionCutoffUtc(new Date('9999-01-01T00:00:00Z'), 1),
    /supported date range/);
});
