import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20260712013000_add_password_recovery_integrity/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

test('password recovery migration is atomic, additive, and preserves usable legacy links truthfully', () => {
  assert.match(migration, /^--[\s\S]*\nBEGIN;/u);
  assert.match(migration, /COMMIT;\s*$/u);
  assert.match(migration, /legacy_half_pairs=%.*malformed_token_hashes=%/u);
  assert.match(migration, /unsafe_future_expiries=%/u);
  assert.match(migration, /overlong_active_emails=%/u);
  assert.match(migration, /CHAR_LENGTH\(account\."email"\) > 254/u);
  assert.match(migration, /"resetTokenExpiry" > CURRENT_TIMESTAMP \+ INTERVAL '1 hour'/u);
  assert.doesNotMatch(migration, /INTERVAL '1 hour 5 minutes'/u);
  assert.match(migration, /'LEGACY_USER_SLOT'::"PasswordRecoverySource"[\s\S]*'UNCERTAIN'::"PasswordRecoveryDeliveryState"/u);
  assert.match(migration, /"resetTokenExpiry" > CURRENT_TIMESTAMP/u);
  assert.match(
    migration,
    /UPDATE "User"[\s\S]*SET "resetToken" = NULL,[\s\S]*"resetTokenExpiry" = NULL[\s\S]*WHERE "resetToken" IS NOT NULL OR "resetTokenExpiry" IS NOT NULL/u,
  );
  assert.match(migration, /User_guard_retired_password_recovery_slot/u);
  assert.match(migration, /Legacy User password recovery slots are retired/u);
  assert.doesNotMatch(migration, /DROP COLUMN\s+"resetToken"/u);
  assert.doesNotMatch(migration, /DROP COLUMN\s+"resetTokenExpiry"/u);
});

test('password recovery migration uses safe enum evolution and database integrity constraints', () => {
  assert.doesNotMatch(
    migration,
    /ALTER TYPE "SecurityAuditEventType"[\s\S]*PASSWORD_RESET_COMPLETED/u,
  );
  assert.doesNotMatch(
    schema.match(/enum SecurityAuditEventType \{[\s\S]*?\}/u)?.[0] ?? '',
    /PASSWORD_RESET_COMPLETED/u,
  );
  assert.match(migration, /PasswordRecoveryRequest_termination_tuple_check/u);
  assert.match(migration, /PasswordRecoveryRequest_target_shape_check/u);
  assert.match(migration, /PasswordRecoveryRequest_source_shape_check/u);
  assert.match(migration, /PasswordRecoveryRequest_delivery_evidence_check/u);
  assert.match(migration, /PasswordRecoveryRequest_rejected_termination_check/u);
  assert.match(migration, /PasswordRecoveryRequest_review_alert_check/u);
  assert.match(migration, /AuthSecurityEmailOutbox_review_alert_check/u);
  assert.match(migration, /AuthRecoveryControl_state_check/u);
  assert.match(migration, /AuthRecoveryControl_fingerprint_check/u);
  assert.match(migration, /CREATE TABLE "AuthRecoveryRetiredSecret"/u);
  assert.match(migration, /AuthRecoveryRetiredSecret_guard_integrity/u);
  assert.match(migration, /AuthRecoveryRetiredSecret_reject_truncate/u);
  assert.match(migration, /AuthRecoveryControl_guard_integrity/u);
  assert.match(migration, /Illegal authentication recovery control transition/u);
  assert.match(migration, /PasswordRecoveryRequest_reason_state_check/u);
  assert.match(migration, /'KEY_UNAVAILABLE'/u);
  assert.match(migration, /'KEY_ROTATED'/u);
  assert.match(migration, /PasswordRecoveryRequest_outstanding_limit/u);
  assert.match(migration, /Illegal password recovery delivery-state transition/u);
  assert.match(migration, /AuthSecurityEmailOutbox_delivery_evidence_check/u);
  assert.match(migration, /AuthSecurityEmailOutbox_timeline_check/u);
  assert.match(migration, /AuthSecurityEmailOutbox_template_version_check/u);
  assert.match(migration, /Terminal password recovery delivery evidence is immutable/u);
  assert.match(migration, /Terminal auth security email delivery evidence is immutable/u);
  assert.match(migration, /claim must increment attempts exactly once/u);
  assert.match(migration, /attempts may change only during a valid claim/u);
  assert.match(migration, /review alert acknowledgement requires a claim/u);
  assert.match(migration, /one-way redaction/u);
  assert.match(migration, /User_invalidate_password_recovery_on_password_change/u);
  assert.match(
    migration,
    /invalidate_password_recovery_on_password_change[\s\S]*clock_timestamp\(\)::timestamp\(3\)[\s\S]*"terminatedAt" = invalidated_at/u,
  );
  assert.match(migration, /PasswordRecoveryRequest_recipient_authority/u);
  assert.match(migration, /AuthSecurityEmailOutbox_audit_authority/u);
  assert.match(
    migration,
    /guard_auth_security_email_outbox[\s\S]*recoveryRequestId[\s\S]*JOIN "PasswordRecoveryRequest" AS recovery[\s\S]*recovery_terminated_at IS DISTINCT FROM audit_occurred_at/u,
  );
  assert.match(migration, /AuthSecurityEmailOutbox_recipient_authority/u);
  assert.match(migration, /FOREIGN KEY \("auditEventId", "organisationId"\)/u);
  assert.match(migration, /SecurityAuditEvent_id_organisationId_key/u);
  assert.match(migration, /"evidenceRetentionAnchorAt" TIMESTAMP\(3\) NOT NULL/u);
  assert.match(migration, /NEW\."evidenceRetentionAnchorAt" := GREATEST/u);
});

test('schema exposes tenant-bound requests, authoritative buckets, audit, and security outbox', () => {
  assert.match(schema, /model PasswordRecoveryRequest[\s\S]*tokenHash\s+String\?\s+@unique @db\.Char\(64\)/u);
  assert.match(schema, /model PasswordRecoveryRequest[\s\S]*@relation\(fields: \[userId, organisationId\], references: \[id, organisationId\]/u);
  assert.match(schema, /model AuthRecoveryRateLimitBucket[\s\S]*@@id\(\[scope, keyVersion, subjectDigest, windowStartedAt\]\)/u);
  assert.match(schema, /model AuthRecoveryControl[\s\S]*activeSecretFingerprint\s+String\?/u);
  assert.match(schema, /model AuthRecoveryRetiredSecret[\s\S]*retiredGeneration\s+Int\s+@unique/u);
  assert.match(schema, /model AuthSecurityEmailOutbox[\s\S]*auditEventId\s+String\s+@unique/u);
  assert.match(schema, /model PasswordRecoveryRequest[\s\S]*deliveryTemplateVersion\s+Int\?/u);
  assert.match(schema, /model PasswordRecoveryRequest[\s\S]*requestEvidenceRedactedAt\s+DateTime\?/u);
  assert.match(schema, /model PasswordRecoveryRequest[\s\S]*reviewAlertClaimToken\s+String\?\s+@db\.Uuid/u);
  assert.match(schema, /model AuthSecurityEmailOutbox[\s\S]*deliveryTemplateVersion\s+Int\s+@default\(1\)/u);
  assert.match(schema, /model AuthSecurityEmailOutbox[\s\S]*reviewAlertClaimToken\s+String\?\s+@db\.Uuid/u);
  assert.match(schema, /model PasswordRecoveryRequest[\s\S]*evidenceRetentionAnchorAt\s+DateTime/u);
  assert.match(schema, /model AuthSecurityEmailOutbox[\s\S]*evidenceRetentionAnchorAt\s+DateTime/u);
  assert.match(schema, /PASSWORD_RESET_COMPLETED/u);
});
