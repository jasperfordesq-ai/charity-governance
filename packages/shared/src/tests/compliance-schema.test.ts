import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  complianceEvidenceHashSchema,
  upsertComplianceRecordSchema,
  upsertComplianceSignoffSchema,
} from '../schemas/compliance.js';

const evidenceHash = 'a'.repeat(64);

test('compliance record writes require a non-negative integer revision precondition', () => {
  assert.equal(
    upsertComplianceRecordSchema.safeParse({ reportingYear: 2026, status: 'COMPLIANT' }).success,
    false,
  );
  assert.equal(
    upsertComplianceRecordSchema.safeParse({ reportingYear: 2026, expectedRevision: 0 }).success,
    true,
  );
  assert.equal(
    upsertComplianceRecordSchema.safeParse({ reportingYear: 2026, expectedRevision: -1 }).success,
    false,
  );
  assert.equal(
    upsertComplianceRecordSchema.safeParse({ reportingYear: 2026, expectedRevision: 1.5 }).success,
    false,
  );
});

test('approved signoff requires the reviewed evidence hash and signoff revision', () => {
  const approval = {
    reportingYear: 2026,
    expectedRevision: 0,
    status: 'APPROVED',
    boardMeetingDate: '2026-10-24',
    minuteReference: 'BM-2026-10',
    approvedByName: 'Chair',
  };

  assert.equal(upsertComplianceSignoffSchema.safeParse(approval).success, false);
  assert.equal(
    upsertComplianceSignoffSchema.safeParse({ ...approval, expectedEvidenceHash: evidenceHash }).success,
    true,
  );
  assert.equal(
    upsertComplianceSignoffSchema.safeParse({ ...approval, expectedEvidenceHash: evidenceHash.toUpperCase() }).success,
    false,
  );
});

test('draft signoff does not require an evidence hash but still requires a revision', () => {
  assert.equal(
    upsertComplianceSignoffSchema.safeParse({ reportingYear: 2026, status: 'DRAFT' }).success,
    false,
  );
  assert.equal(
    upsertComplianceSignoffSchema.safeParse({ reportingYear: 2026, expectedRevision: 0, status: 'DRAFT' }).success,
    true,
  );
});

test('compliance evidence hashes are lowercase SHA-256 hex strings', () => {
  assert.equal(complianceEvidenceHashSchema.safeParse(evidenceHash).success, true);
  assert.equal(complianceEvidenceHashSchema.safeParse('a'.repeat(63)).success, false);
  assert.equal(complianceEvidenceHashSchema.safeParse('g'.repeat(64)).success, false);
});
