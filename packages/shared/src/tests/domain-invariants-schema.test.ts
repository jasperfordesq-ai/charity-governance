import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBoardMemberSchema,
  updateBoardMemberSchema,
  validateBoardMemberCompleteState,
} from '../schemas/board-member.js';
import {
  createFundraisingRecordSchema,
  updateFundraisingRecordSchema,
  upsertAnnualReportReadinessSchema,
  validateAnnualReportReadinessCompleteState,
  validateFundraisingRecordCompleteState,
} from '../schemas/governance-registers.js';

const boardMemberBase = {
  name: 'Alex Trustee',
  role: 'Trustee',
  appointedDate: '2026-01-01',
};

const fundraisingBase = {
  name: 'Community appeal',
  activityType: 'Public collection',
};

test('board member create validates chronology and effective boolean defaults', () => {
  assert.equal(
    createBoardMemberSchema.safeParse({
      ...boardMemberBase,
      appointedDate: '2026-02-31',
    }).success,
    false,
  );
  assert.equal(
    createBoardMemberSchema.safeParse({
      ...boardMemberBase,
      termEndDate: '2025-12-31',
    }).success,
    false,
  );
  assert.equal(
    createBoardMemberSchema.safeParse({
      ...boardMemberBase,
      conductSignedDate: '2026-01-02',
    }).success,
    false,
  );
  assert.equal(
    createBoardMemberSchema.safeParse({
      ...boardMemberBase,
      inductionCompleted: true,
    }).success,
    false,
  );
  assert.equal(
    createBoardMemberSchema.safeParse({
      ...boardMemberBase,
      conductSigned: true,
      conductSignedDate: '2026-01-02',
      inductionCompleted: true,
      inductionDate: '2026-01-03',
    }).success,
    true,
  );
});

test('board member chronology compares accepted timestamp offsets by instant', () => {
  assert.equal(
    createBoardMemberSchema.safeParse({
      ...boardMemberBase,
      appointedDate: '2026-01-02T00:30:00+01:00',
      termEndDate: '2026-01-01T23:45:00Z',
    }).success,
    true,
  );
  assert.equal(
    createBoardMemberSchema.safeParse({
      ...boardMemberBase,
      appointedDate: '2026-01-01T23:45:00Z',
      termEndDate: '2026-01-02T00:30:00+01:00',
    }).success,
    false,
  );
});

test('board member patch rejects contradictions it contains and defers one-sided changes', () => {
  for (const payload of [
    { appointedDate: '2026-02-01', termEndDate: '2026-01-31' },
    { conductSigned: true, conductSignedDate: null },
    { conductSigned: false, conductSignedDate: '2026-01-01' },
    { inductionCompleted: true, inductionDate: null },
    { inductionCompleted: false, inductionDate: '2026-01-01' },
  ]) {
    assert.equal(updateBoardMemberSchema.safeParse(payload).success, false);
  }

  for (const payload of [
    { appointedDate: '2026-02-01' },
    { termEndDate: '2026-01-31' },
    { conductSigned: true },
    { conductSignedDate: '2026-01-01' },
    { inductionCompleted: false },
    { inductionDate: null },
  ]) {
    assert.equal(updateBoardMemberSchema.safeParse(payload).success, true);
  }
});

test('board member complete-state validator accepts Date values and reports stable field paths', () => {
  assert.doesNotThrow(() =>
    validateBoardMemberCompleteState({
      appointedDate: new Date('2026-01-01T00:00:00.000Z'),
      termEndDate: new Date('2026-01-01T00:00:00.000Z'),
      conductSigned: false,
      conductSignedDate: null,
      inductionCompleted: true,
      inductionDate: new Date('2026-01-02T00:00:00.000Z'),
    }),
  );

  const result = (() => {
    try {
      validateBoardMemberCompleteState({
        appointedDate: new Date('2026-02-01T00:00:00.000Z'),
        termEndDate: new Date('2026-01-31T00:00:00.000Z'),
        conductSigned: true,
        conductSignedDate: null,
        inductionCompleted: false,
        inductionDate: null,
      });
      return [];
    } catch (error) {
      return 'issues' in (error as { issues?: unknown[] })
        ? (error as { issues: Array<{ path: PropertyKey[] }> }).issues
        : [];
    }
  })();

  assert.deepEqual(
    result.map((issue) => issue.path),
    [['termEndDate'], ['conductSignedDate']],
  );
});

test('fundraising create and complete state allow open dates but reject reversed ranges', () => {
  assert.equal(
    createFundraisingRecordSchema.safeParse({
      ...fundraisingBase,
      endDate: '2026-04-01',
    }).success,
    true,
  );
  assert.equal(
    createFundraisingRecordSchema.safeParse({
      ...fundraisingBase,
      startDate: '2026-04-02',
      endDate: '2026-04-01',
    }).success,
    false,
  );
  assert.doesNotThrow(() =>
    validateFundraisingRecordCompleteState({
      startDate: null,
      endDate: new Date('2026-04-01T00:00:00.000Z'),
    }),
  );
  assert.throws(() =>
    validateFundraisingRecordCompleteState({
      startDate: new Date('2026-04-02T00:00:00.000Z'),
      endDate: new Date('2026-04-01T00:00:00.000Z'),
    }),
  );
  assert.doesNotThrow(() =>
    validateFundraisingRecordCompleteState({
      startDate: '2026-04-02T00:30:00+01:00',
      endDate: '2026-04-01T23:45:00Z',
    }),
  );
});

test('fundraising patch validates two supplied dates and defers one-sided changes', () => {
  assert.equal(
    updateFundraisingRecordSchema.safeParse({
      startDate: '2026-04-02',
      endDate: '2026-04-01',
    }).success,
    false,
  );
  assert.equal(updateFundraisingRecordSchema.safeParse({ startDate: '2026-04-02' }).success, true);
  assert.equal(updateFundraisingRecordSchema.safeParse({ endDate: '2026-04-01' }).success, true);
});

test('annual report complete state requires a filing date only for FILED status', () => {
  assert.throws(() =>
    validateAnnualReportReadinessCompleteState({
      filingStatus: 'FILED',
      filedDate: null,
    }),
  );
  assert.doesNotThrow(() =>
    validateAnnualReportReadinessCompleteState({
      filingStatus: 'FILED',
      filedDate: new Date('2026-10-01T00:00:00.000Z'),
    }),
  );
  assert.doesNotThrow(() => validateAnnualReportReadinessCompleteState({}));
});

test('annual report upsert validates a self-contained filing pair and defers one-sided changes', () => {
  assert.equal(
    upsertAnnualReportReadinessSchema.safeParse({
      reportingYear: 2026,
      filingStatus: 'FILED',
      filedDate: null,
    }).success,
    false,
  );
  assert.equal(
    upsertAnnualReportReadinessSchema.safeParse({
      reportingYear: 2026,
      filingStatus: 'FILED',
      filedDate: '2026-10-01',
    }).success,
    true,
  );
  assert.equal(
    upsertAnnualReportReadinessSchema.safeParse({
      reportingYear: 2026,
      filingStatus: 'FILED',
    }).success,
    true,
  );
  assert.equal(
    upsertAnnualReportReadinessSchema.safeParse({
      reportingYear: 2026,
      filedDate: null,
    }).success,
    true,
  );
});
