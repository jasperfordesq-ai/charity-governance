import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20260710123000_add_compliance_revision_snapshots/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const e2eDatabaseHelper = readFileSync(
  new URL('../../../../e2e/helpers/db.ts', import.meta.url),
  'utf8',
);
const fullSignoffAuditKeys = [
  'id',
  'organisationId',
  'reportingYear',
  'status',
  'boardMeetingDate',
  'minuteReference',
  'approvedByName',
  'approvedByRole',
  'approvalNotes',
  'approvedAt',
  'revision',
  'approvalSequence',
  'currentApprovalSnapshotId',
  'invalidatedAt',
  'invalidationReason',
  'invalidatedById',
  'updatedById',
  'createdAt',
  'updatedAt',
];

test('compliance migration establishes revision and immutable-history constraints', () => {
  assert.match(migration, /ALTER TABLE "ComplianceRecord"[\s\S]*ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1/);
  assert.match(migration, /ComplianceRecord_revision_check" CHECK \("revision" >= 1\)/);
  assert.match(migration, /ComplianceSignoff_approval_state_check/);
  assert.match(migration, /ComplianceApprovalSnapshot_evidenceHash_check/);
  assert.match(migration, /ComplianceApprovalSnapshot_snapshotHash_check/);
});

test('compliance migration records truthful baselines and invalidates unbound legacy approvals', () => {
  assert.match(migration, /RECORD_BASELINE_IMPORTED/);
  assert.match(migration, /SIGNOFF_BASELINE_IMPORTED/);
  assert.match(migration, /LEGACY_APPROVAL_INVALIDATED/);
  assert.match(
    migration,
    /UPDATE "ComplianceSignoff"[\s\S]*"status" = 'DRAFT'[\s\S]*"invalidationReason" = 'LEGACY_APPROVAL_UNBOUND'[\s\S]*WHERE "status" = 'APPROVED'/,
  );
  assert.doesNotMatch(
    migration,
    /INSERT INTO "ComplianceApprovalSnapshot"/,
    'legacy approval must not be rebound to whatever record data happens to exist during migration',
  );
});

test('migration signoff baseline and legacy invalidation preserve the complete signoff state', () => {
  const baselineStart = migration.indexOf("'p0-04-signoff-baseline-'");
  const legacyStart = migration.indexOf("'p0-04-legacy-approval-'");
  const legacyEnd = migration.indexOf('UPDATE "ComplianceSignoff"', legacyStart);
  const baselineJson = migration.slice(baselineStart, legacyStart);
  const legacyJson = migration.slice(legacyStart, legacyEnd);

  for (const key of fullSignoffAuditKeys) {
    assert.match(baselineJson, new RegExp(`'${key}'`), `baseline audit is missing ${key}`);
    assert.ok(
      legacyJson.split(`'${key}'`).length - 1 >= 2,
      `legacy before/after audit is missing ${key}`,
    );
  }
});

test('compliance snapshots and audit events are database-enforced append-only tables', () => {
  assert.match(
    migration,
    /CREATE TRIGGER "ComplianceApprovalSnapshot_append_only"[\s\S]*BEFORE UPDATE OR DELETE ON "ComplianceApprovalSnapshot"/,
  );
  assert.match(
    migration,
    /CREATE TRIGGER "ComplianceAuditEvent_append_only"[\s\S]*BEFORE UPDATE OR DELETE ON "ComplianceAuditEvent"/,
  );
  assert.match(migration, /ERRCODE = '55000'/);
});

test('current approval snapshot pointers are database-bound to signoff scope and sequence', () => {
  assert.match(
    migration,
    /ComplianceApprovalSnapshot_id_organisationId_reportingYear_approvalSequence_key/,
  );
  assert.match(
    migration,
    /snapshot\."id" = NEW\."currentApprovalSnapshotId"[\s\S]*snapshot\."organisationId" = NEW\."organisationId"[\s\S]*snapshot\."reportingYear" = NEW\."reportingYear"[\s\S]*snapshot\."approvalSequence" = NEW\."approvalSequence"/,
  );
  assert.match(migration, /ComplianceSignoff_current_snapshot_scope_insert/);
  assert.match(migration, /ComplianceSignoff_current_snapshot_scope_update/);
  assert.match(migration, /ERRCODE = '23514'/);
});

test('disposable E2E reset inventory explicitly includes compliance snapshots and audit events', () => {
  assert.match(e2eDatabaseHelper, /'ComplianceApprovalSnapshot'/);
  assert.match(e2eDatabaseHelper, /'ComplianceAuditEvent'/);
});
