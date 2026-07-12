#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  P107A_RECOVERY_IMAGE_CHECKSUM_SCRIPT,
  P107A_RECOVERY_MIGRATIONS,
  buildP107ARecoveryPreflightSql,
  parseP107AMigrationChecksumOutput,
} from './production-recover-p107a-migration.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = dirname(SCRIPT_DIR);
const DEFAULT_MIGRATIONS_ROOT = join(REPOSITORY_ROOT, 'apps', 'api', 'prisma', 'migrations');
const DEFAULT_SCHEMA_PATH = join(REPOSITORY_ROOT, 'apps', 'api', 'prisma', 'schema.prisma');
const PRISMA_CLI_PATH = join(REPOSITORY_ROOT, 'node_modules', 'prisma', 'build', 'index.js');
const PRISMA_PACKAGE_PATH = join(REPOSITORY_ROOT, 'node_modules', 'prisma', 'package.json');
const REQUIRED_PRISMA_VERSION = '6.19.3';
const TARGET_MIGRATION = '20260712013000_add_password_recovery_integrity';
const PREVIOUS_MIGRATION = '20260711230000_add_domain_invariants_referential_safety';
const USAGE = 'Usage: node scripts/verify-password-recovery-upgrade.mjs [--keep-databases] [--dry-run] [--migration-image=<local-image-ref>]';

// This is a valid legacy reset token shape, but only its SHA-256 digest is ever
// inserted. The verifier proves that the recoverable raw value is absent after
// migration and that the digest remains in an unexpired consumable row.
const LEGACY_RAW_TOKEN = 'A'.repeat(43);
const LEGACY_TOKEN_HASH = createHash('sha256').update(LEGACY_RAW_TOKEN, 'utf8').digest('hex');

const VALID_LEGACY_SEED_SQL = String.raw`
BEGIN;
INSERT INTO "Organisation" ("id", "name", "updatedAt")
VALUES ('p107a-valid-org', 'P1-07A valid upgrade fixture', CURRENT_TIMESTAMP);

INSERT INTO "User" (
  "id", "email", "name", "passwordHash", "role", "organisationId",
  "emailVerified", "resetToken", "resetTokenExpiry", "updatedAt"
) VALUES
  (
    'p107a-valid-user', 'p107a-valid@example.test', 'Valid legacy recovery',
    'fixture-password-hash', 'OWNER', 'p107a-valid-org', true,
    '${LEGACY_TOKEN_HASH}', CURRENT_TIMESTAMP + INTERVAL '45 minutes', CURRENT_TIMESTAMP
  ),
  (
    'p107a-boundary-user', 'p107a-boundary@example.test', 'One-hour boundary recovery',
    'fixture-password-hash', 'ADMIN', 'p107a-valid-org', true,
    '${'a'.repeat(64)}', CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP
  ),
  (
    'p107a-expired-user', 'p107a-expired@example.test', 'Expired legacy recovery',
    'fixture-password-hash', 'ADMIN', 'p107a-valid-org', true,
    '${'b'.repeat(64)}', CURRENT_TIMESTAMP - INTERVAL '1 minute', CURRENT_TIMESTAMP
  ),
  (
    'p107a-control-user', 'p107a-control@example.test', 'No legacy recovery',
    'fixture-password-hash', 'MEMBER', 'p107a-valid-org', true,
    NULL, NULL, CURRENT_TIMESTAMP
  );

INSERT INTO "User" (
  "id", "email", "name", "passwordHash", "role", "organisationId",
  "emailVerified", "lifecycleStatus", "resetToken", "resetTokenExpiry", "updatedAt"
) VALUES (
  'p107a-inactive-user', 'p107a-inactive@example.test', 'Inactive half-pair cleanup',
  'fixture-password-hash', 'MEMBER', 'p107a-valid-org', true, 'SUSPENDED',
  NULL, CURRENT_TIMESTAMP + INTERVAL '2 hours', CURRENT_TIMESTAMP
);
COMMIT;
`;

const INVALID_LEGACY_SEED_SQL = String.raw`
BEGIN;
INSERT INTO "Organisation" ("id", "name", "updatedAt")
VALUES ('p107a-invalid-org', 'P1-07A invalid upgrade fixture', CURRENT_TIMESTAMP);

INSERT INTO "User" (
  "id", "email", "name", "passwordHash", "role", "organisationId",
  "emailVerified", "resetToken", "resetTokenExpiry", "updatedAt"
) VALUES
  (
    'p107a-invalid-owner', 'p107a-invalid-owner@example.test', 'Invalid fixture owner',
    'fixture-password-hash', 'OWNER', 'p107a-invalid-org', true,
    NULL, NULL, CURRENT_TIMESTAMP
  ),
  (
    'p107a-half-pair', 'p107a-half-pair@example.test', 'Half-pair blocker',
    'fixture-password-hash', 'ADMIN', 'p107a-invalid-org', true,
    '${'c'.repeat(64)}', NULL, CURRENT_TIMESTAMP
  ),
  (
    'p107a-malformed-hash', 'p107a-malformed@example.test', 'Malformed-hash blocker',
    'fixture-password-hash', 'MEMBER', 'p107a-invalid-org', true,
    'not-a-lowercase-sha256-digest', CURRENT_TIMESTAMP + INTERVAL '30 minutes', CURRENT_TIMESTAMP
  ),
  (
    'p107a-overlong-expiry', 'p107a-overlong@example.test', 'Overlong-expiry blocker',
    'fixture-password-hash', 'MEMBER', 'p107a-invalid-org', true,
    '${'d'.repeat(64)}', CURRENT_TIMESTAMP + INTERVAL '2 hours', CURRENT_TIMESTAMP
  ),
  (
    'p107a-overlong-email', REPEAT('e', 242) || '@example.test', 'Overlong-email blocker',
    'fixture-password-hash', 'MEMBER', 'p107a-invalid-org', true,
    NULL, NULL, CURRENT_TIMESTAMP
  );

INSERT INTO "User" (
  "id", "email", "name", "passwordHash", "role", "organisationId",
  "emailVerified", "lifecycleStatus", "resetToken", "resetTokenExpiry", "updatedAt"
) VALUES (
  'p107a-inactive-half-pair', 'p107a-inactive-half@example.test',
  'Inactive deterministic cleanup', 'fixture-password-hash', 'MEMBER',
  'p107a-invalid-org', true, 'SUSPENDED', NULL,
  CURRENT_TIMESTAMP + INTERVAL '2 hours', CURRENT_TIMESTAMP
);
COMMIT;
`;

const EXACT_BOUNDARY_ASSERTIONS_SQL = String.raw`
DO $fixture$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "_prisma_migrations"
    WHERE migration_name = '${TARGET_MIGRATION}'
  ) OR NOT EXISTS (
    SELECT 1 FROM "_prisma_migrations"
    WHERE migration_name = '${PREVIOUS_MIGRATION}'
      AND finished_at IS NOT NULL
      AND rolled_back_at IS NULL
      AND applied_steps_count = 1
  ) THEN
    RAISE EXCEPTION 'Prisma did not establish the exact pre-P1-07A migration boundary';
  END IF;
END;
$fixture$;
`;

const FAILED_MIGRATION_ATOMICITY_SQL = String.raw`
DO $fixture$
DECLARE
  half_pair_count INTEGER;
  malformed_hash_count INTEGER;
  unsafe_future_expiry_count INTEGER;
  overlong_active_email_count INTEGER;
BEGIN
  IF TO_REGCLASS('public."PasswordRecoveryRequest"') IS NOT NULL
     OR TO_REGCLASS('public."AuthRecoveryRateLimitBucket"') IS NOT NULL
     OR TO_REGCLASS('public."AuthRecoveryControl"') IS NOT NULL
     OR TO_REGCLASS('public."AuthRecoveryRetiredSecret"') IS NOT NULL
     OR TO_REGCLASS('public."AuthSecurityEmailOutbox"') IS NOT NULL THEN
    RAISE EXCEPTION 'Failed P1-07A migration left a target table behind';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_type
    WHERE typname IN (
      'PasswordRecoverySource',
      'PasswordRecoveryDeliveryState',
      'PasswordRecoverySuppressionReason',
      'PasswordRecoveryTerminationReason',
      'AuthRecoveryRateLimitScope',
      'AuthSecurityEmailKind',
      'AuthSecurityEmailDeliveryState'
    )
  ) THEN
    RAISE EXCEPTION 'Failed P1-07A migration left a target enum behind';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc
    WHERE proname IN (
      'guard_password_recovery_request',
      'guard_auth_recovery_retired_secret',
      'reject_auth_recovery_retired_secret_truncate',
      'guard_auth_recovery_control',
      'invalidate_password_recovery_on_password_change',
      'guard_retired_user_password_recovery_slot',
      'guard_auth_security_email_outbox'
    )
  ) THEN
    RAISE EXCEPTION 'Failed P1-07A migration left a target trigger function behind';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_enum AS enum_value
    JOIN pg_catalog.pg_type AS enum_type ON enum_type.oid = enum_value.enumtypid
    WHERE enum_type.typname = 'SecurityAuditEventType'
      AND enum_value.enumlabel = 'PASSWORD_RESET_COMPLETED'
  ) THEN
    RAISE EXCEPTION 'Failed P1-07A migration left the audit enum expansion behind';
  END IF;

  SELECT COUNT(*) FILTER (
           WHERE (account."resetToken" IS NULL) <> (account."resetTokenExpiry" IS NULL)
         )::INTEGER,
         COUNT(*) FILTER (
           WHERE account."resetToken" IS NOT NULL
             AND account."resetToken" !~ '^[0-9a-f]{64}$'
         )::INTEGER,
         COUNT(*) FILTER (
           WHERE account."resetToken" IS NOT NULL
             AND account."resetTokenExpiry" > CURRENT_TIMESTAMP + INTERVAL '1 hour'
         )::INTEGER
  INTO half_pair_count, malformed_hash_count, unsafe_future_expiry_count
  FROM "User" AS account
  JOIN "Organisation" AS organisation
    ON organisation."id" = account."organisationId"
  WHERE account."id" IN (
      'p107a-half-pair', 'p107a-malformed-hash', 'p107a-overlong-expiry'
    )
    AND account."lifecycleStatus" = 'ACTIVE'::"UserLifecycleStatus"
    AND organisation."lifecycleStatus" = 'ACTIVE'::"OrganisationLifecycleStatus";

  SELECT COUNT(*)::INTEGER
  INTO overlong_active_email_count
  FROM "User" AS account
  JOIN "Organisation" AS organisation
    ON organisation."id" = account."organisationId"
  WHERE account."id" = 'p107a-overlong-email'
    AND CHAR_LENGTH(account."email") > 254
    AND account."lifecycleStatus" = 'ACTIVE'::"UserLifecycleStatus"
    AND organisation."lifecycleStatus" = 'ACTIVE'::"OrganisationLifecycleStatus";

  IF half_pair_count <> 1
     OR malformed_hash_count <> 1
     OR unsafe_future_expiry_count <> 1
     OR overlong_active_email_count <> 1
     OR NOT EXISTS (
       SELECT 1 FROM "User"
       WHERE "id" = 'p107a-inactive-half-pair'
         AND "resetToken" IS NULL
         AND "resetTokenExpiry" IS NOT NULL
         AND "lifecycleStatus" = 'SUSPENDED'::"UserLifecycleStatus"
     ) THEN
    RAISE EXCEPTION 'Failed P1-07A migration rewrote active blockers or inactive cleanup input';
  END IF;
END;
$fixture$;
`;

const NO_TARGET_SCHEMA_RESIDUE_SQL = String.raw`
DO $fixture$
BEGIN
  IF TO_REGCLASS('public."PasswordRecoveryRequest"') IS NOT NULL
     OR TO_REGCLASS('public."AuthRecoveryRateLimitBucket"') IS NOT NULL
     OR TO_REGCLASS('public."AuthRecoveryControl"') IS NOT NULL
     OR TO_REGCLASS('public."AuthRecoveryRetiredSecret"') IS NOT NULL
     OR TO_REGCLASS('public."AuthSecurityEmailOutbox"') IS NOT NULL THEN
    RAISE EXCEPTION 'Failed P1-07A migration left a target table behind';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_type
    WHERE typname IN (
      'PasswordRecoverySource',
      'PasswordRecoveryDeliveryState',
      'PasswordRecoverySuppressionReason',
      'PasswordRecoveryTerminationReason',
      'AuthRecoveryRateLimitScope',
      'AuthSecurityEmailKind',
      'AuthSecurityEmailDeliveryState'
    )
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc
    WHERE proname IN (
      'guard_password_recovery_request',
      'guard_auth_recovery_retired_secret',
      'reject_auth_recovery_retired_secret_truncate',
      'guard_auth_recovery_control',
      'invalidate_password_recovery_on_password_change',
      'guard_retired_user_password_recovery_slot',
      'guard_auth_security_email_outbox'
    )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_enum AS enum_value
    JOIN pg_catalog.pg_type AS enum_type ON enum_type.oid = enum_value.enumtypid
    WHERE enum_type.typname = 'SecurityAuditEventType'
      AND enum_value.enumlabel = 'PASSWORD_RESET_COMPLETED'
  ) OR TO_REGCLASS('public."SecurityAuditEvent_id_organisationId_key"') IS NOT NULL THEN
    RAISE EXCEPTION 'Failed P1-07A migration left target catalog residue behind';
  END IF;
END;
$fixture$;
`;

const FAILED_PRISMA_HISTORY_ASSERTIONS_SQL = String.raw`
DO $fixture$
BEGIN
  IF (
    SELECT COUNT(*) FROM "_prisma_migrations"
    WHERE migration_name = '${TARGET_MIGRATION}'
      AND finished_at IS NULL
      AND rolled_back_at IS NULL
      AND applied_steps_count = 0
  ) <> 1 OR (
    SELECT COUNT(*) FROM "_prisma_migrations"
    WHERE migration_name = '${TARGET_MIGRATION}'
  ) <> 1 THEN
    RAISE EXCEPTION 'Prisma did not record exactly one unresolved failed P1-07A migration';
  END IF;
END;
$fixture$;
`;

const REMEDIATE_DISPOSABLE_INVALID_FIXTURE_SQL = String.raw`
BEGIN;
UPDATE "User"
SET "resetToken" = NULL,
    "resetTokenExpiry" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" IN ('p107a-half-pair', 'p107a-malformed-hash', 'p107a-overlong-expiry');

UPDATE "User"
SET "email" = 'p107a-remediated-email@example.test',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'p107a-overlong-email'
  AND CHAR_LENGTH("email") > 254;

DO $fixture$
DECLARE
  affected_count INTEGER;
BEGIN
  SELECT COUNT(*)::INTEGER INTO affected_count
  FROM "User"
  WHERE "id" IN ('p107a-half-pair', 'p107a-malformed-hash', 'p107a-overlong-expiry')
    AND "resetToken" IS NULL
    AND "resetTokenExpiry" IS NULL;
  IF affected_count <> 3 OR NOT EXISTS (
    SELECT 1 FROM "User"
    WHERE "id" = 'p107a-overlong-email'
      AND "email" = 'p107a-remediated-email@example.test'
  ) OR NOT EXISTS (
    SELECT 1 FROM "User"
    WHERE "id" = 'p107a-inactive-half-pair'
      AND "resetToken" IS NULL
      AND "resetTokenExpiry" IS NOT NULL
      AND "lifecycleStatus" = 'SUSPENDED'::"UserLifecycleStatus"
  ) THEN
    RAISE EXCEPTION 'Disposable remediation did not clear exactly three reset blockers, repair the overlong active email, and preserve inactive auto-cleanup input';
  END IF;
END;
$fixture$;
COMMIT;
`;

const ROLLED_BACK_PRISMA_HISTORY_ASSERTIONS_SQL = String.raw`
DO $fixture$
BEGIN
  IF (
    SELECT COUNT(*) FROM "_prisma_migrations"
    WHERE migration_name = '${TARGET_MIGRATION}'
      AND finished_at IS NULL
      AND rolled_back_at IS NOT NULL
      AND applied_steps_count = 0
  ) <> 1 OR EXISTS (
    SELECT 1 FROM "_prisma_migrations"
    WHERE migration_name = '${TARGET_MIGRATION}'
      AND finished_at IS NULL
      AND rolled_back_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Exact P1-07A failed migration was not resolved as rolled back';
  END IF;
END;
$fixture$;
`;

const RECOVERED_PRISMA_HISTORY_ASSERTIONS_SQL = String.raw`
DO $fixture$
BEGIN
  IF (
    SELECT COUNT(*) FROM "_prisma_migrations"
    WHERE migration_name = '${TARGET_MIGRATION}'
  ) <> 2 OR (
    SELECT COUNT(*) FROM "_prisma_migrations"
    WHERE migration_name = '${TARGET_MIGRATION}'
      AND finished_at IS NULL
      AND rolled_back_at IS NOT NULL
      AND applied_steps_count = 0
  ) <> 1 OR (
    SELECT COUNT(*) FROM "_prisma_migrations"
    WHERE migration_name = '${TARGET_MIGRATION}'
      AND finished_at IS NOT NULL
      AND rolled_back_at IS NULL
      AND applied_steps_count = 1
  ) <> 1 THEN
    RAISE EXCEPTION 'Recovered P1-07A history must contain one rolled-back and one applied attempt';
  END IF;

  IF (
    SELECT COUNT(*) FROM "User"
    WHERE "id" IN (
      'p107a-half-pair', 'p107a-malformed-hash', 'p107a-overlong-expiry',
      'p107a-overlong-email', 'p107a-inactive-half-pair'
    )
      AND "resetToken" IS NULL
      AND "resetTokenExpiry" IS NULL
  ) <> 5 OR NOT EXISTS (
    SELECT 1 FROM "User"
    WHERE "id" = 'p107a-overlong-email'
      AND "email" = 'p107a-remediated-email@example.test'
  ) OR EXISTS (
    SELECT 1 FROM "PasswordRecoveryRequest"
    WHERE "userId" IN (
      'p107a-half-pair', 'p107a-malformed-hash', 'p107a-overlong-expiry',
      'p107a-overlong-email', 'p107a-inactive-half-pair'
    )
  ) THEN
    RAISE EXCEPTION 'Recovered invalid fixture invented recovery evidence or lost deliberate cleanup';
  END IF;
END;
$fixture$;
`;

const INSTALLED_CATALOG_ASSERTIONS_SQL = String.raw`
DO $fixture$
DECLARE
  required_column_shapes TEXT[] := ARRAY[
    'PasswordRecoveryRequest|id|uuid|NO|-|-',
    'PasswordRecoveryRequest|source|PasswordRecoverySource|NO|-|-',
    'PasswordRecoveryRequest|organisationId|text|YES|-|-',
    'PasswordRecoveryRequest|userId|text|YES|-|-',
    'PasswordRecoveryRequest|identifierDigest|bpchar|YES|64|-',
    'PasswordRecoveryRequest|requestIpDigest|bpchar|YES|64|-',
    'PasswordRecoveryRequest|requestNetworkDigest|bpchar|YES|64|-',
    'PasswordRecoveryRequest|rateKeyVersion|int4|YES|-|-',
    'PasswordRecoveryRequest|requestEvidenceRedactedAt|timestamp|YES|-|3',
    'PasswordRecoveryRequest|tokenHash|bpchar|YES|64|-',
    'PasswordRecoveryRequest|tokenNonce|bpchar|YES|64|-',
    'PasswordRecoveryRequest|tokenKeyVersion|int4|YES|-|-',
    'PasswordRecoveryRequest|recipientEmail|text|YES|-|-',
    'PasswordRecoveryRequest|recipientName|text|YES|-|-',
    'PasswordRecoveryRequest|frontendOrigin|text|YES|-|-',
    'PasswordRecoveryRequest|deliveryTemplateVersion|int4|YES|-|-',
    'PasswordRecoveryRequest|deliveryState|PasswordRecoveryDeliveryState|NO|-|-',
    'PasswordRecoveryRequest|suppressionReason|PasswordRecoverySuppressionReason|YES|-|-',
    'PasswordRecoveryRequest|claimToken|uuid|YES|-|-',
    'PasswordRecoveryRequest|claimedAt|timestamp|YES|-|3',
    'PasswordRecoveryRequest|deliveryAttemptedAt|timestamp|YES|-|3',
    'PasswordRecoveryRequest|deliveryFinalizedAt|timestamp|YES|-|3',
    'PasswordRecoveryRequest|deliveryAttemptCount|int4|NO|-|-',
    'PasswordRecoveryRequest|nextDeliveryAttemptAt|timestamp|YES|-|3',
    'PasswordRecoveryRequest|providerMessageId|text|YES|-|-',
    'PasswordRecoveryRequest|reviewAlertClaimToken|uuid|YES|-|-',
    'PasswordRecoveryRequest|reviewAlertClaimedAt|timestamp|YES|-|3',
    'PasswordRecoveryRequest|reviewAlertedAt|timestamp|YES|-|3',
    'PasswordRecoveryRequest|evidenceRetentionAnchorAt|timestamp|NO|-|3',
    'PasswordRecoveryRequest|expiresAt|timestamp|YES|-|3',
    'PasswordRecoveryRequest|terminatedAt|timestamp|YES|-|3',
    'PasswordRecoveryRequest|terminationReason|PasswordRecoveryTerminationReason|YES|-|-',
    'PasswordRecoveryRequest|createdAt|timestamp|NO|-|3',
    'PasswordRecoveryRequest|updatedAt|timestamp|NO|-|3',
    'AuthRecoveryRateLimitBucket|scope|AuthRecoveryRateLimitScope|NO|-|-',
    'AuthRecoveryRateLimitBucket|keyVersion|int4|NO|-|-',
    'AuthRecoveryRateLimitBucket|subjectDigest|bpchar|NO|64|-',
    'AuthRecoveryRateLimitBucket|windowStartedAt|timestamp|NO|-|3',
    'AuthRecoveryRateLimitBucket|count|int4|NO|-|-',
    'AuthRecoveryRateLimitBucket|windowEndsAt|timestamp|NO|-|3',
    'AuthRecoveryRateLimitBucket|expiresAt|timestamp|NO|-|3',
    'AuthRecoveryRateLimitBucket|createdAt|timestamp|NO|-|3',
    'AuthRecoveryRateLimitBucket|updatedAt|timestamp|NO|-|3',
    'AuthRecoveryControl|id|int4|NO|-|-',
    'AuthRecoveryControl|blocked|bool|NO|-|-',
    'AuthRecoveryControl|generation|int4|NO|-|-',
    'AuthRecoveryControl|activeSecretFingerprint|bpchar|YES|64|-',
    'AuthRecoveryControl|retiredSecretFingerprint|bpchar|YES|64|-',
    'AuthRecoveryControl|blockedAt|timestamp|YES|-|3',
    'AuthRecoveryControl|activatedAt|timestamp|YES|-|3',
    'AuthRecoveryControl|createdAt|timestamp|NO|-|3',
    'AuthRecoveryControl|updatedAt|timestamp|NO|-|3',
    'AuthRecoveryRetiredSecret|fingerprint|bpchar|NO|64|-',
    'AuthRecoveryRetiredSecret|retiredGeneration|int4|NO|-|-',
    'AuthRecoveryRetiredSecret|retiredAt|timestamp|NO|-|3',
    'AuthSecurityEmailOutbox|id|uuid|NO|-|-',
    'AuthSecurityEmailOutbox|kind|AuthSecurityEmailKind|NO|-|-',
    'AuthSecurityEmailOutbox|organisationId|text|NO|-|-',
    'AuthSecurityEmailOutbox|userId|text|NO|-|-',
    'AuthSecurityEmailOutbox|auditEventId|text|NO|-|-',
    'AuthSecurityEmailOutbox|recipientEmail|text|NO|-|-',
    'AuthSecurityEmailOutbox|recipientName|text|NO|-|-',
    'AuthSecurityEmailOutbox|deliveryTemplateVersion|int4|NO|-|-',
    'AuthSecurityEmailOutbox|deliveryState|AuthSecurityEmailDeliveryState|NO|-|-',
    'AuthSecurityEmailOutbox|claimToken|uuid|YES|-|-',
    'AuthSecurityEmailOutbox|claimedAt|timestamp|YES|-|3',
    'AuthSecurityEmailOutbox|deliveryAttemptedAt|timestamp|YES|-|3',
    'AuthSecurityEmailOutbox|deliveryFinalizedAt|timestamp|YES|-|3',
    'AuthSecurityEmailOutbox|deliveryAttemptCount|int4|NO|-|-',
    'AuthSecurityEmailOutbox|nextDeliveryAttemptAt|timestamp|YES|-|3',
    'AuthSecurityEmailOutbox|providerMessageId|text|YES|-|-',
    'AuthSecurityEmailOutbox|reviewAlertClaimToken|uuid|YES|-|-',
    'AuthSecurityEmailOutbox|reviewAlertClaimedAt|timestamp|YES|-|3',
    'AuthSecurityEmailOutbox|reviewAlertedAt|timestamp|YES|-|3',
    'AuthSecurityEmailOutbox|evidenceRetentionAnchorAt|timestamp|NO|-|3',
    'AuthSecurityEmailOutbox|createdAt|timestamp|NO|-|3',
    'AuthSecurityEmailOutbox|updatedAt|timestamp|NO|-|3'
  ];
  required_default_shapes TEXT[] := ARRAY[
    'PasswordRecoveryRequest|id|gen_random_uuid()',
    'PasswordRecoveryRequest|deliveryState|''PENDING''::"PasswordRecoveryDeliveryState"',
    'PasswordRecoveryRequest|deliveryAttemptCount|0',
    'PasswordRecoveryRequest|evidenceRetentionAnchorAt|CURRENT_TIMESTAMP',
    'PasswordRecoveryRequest|createdAt|CURRENT_TIMESTAMP',
    'PasswordRecoveryRequest|updatedAt|CURRENT_TIMESTAMP',
    'AuthRecoveryRateLimitBucket|count|1',
    'AuthRecoveryRateLimitBucket|createdAt|CURRENT_TIMESTAMP',
    'AuthRecoveryRateLimitBucket|updatedAt|CURRENT_TIMESTAMP',
    'AuthRecoveryControl|blocked|false',
    'AuthRecoveryControl|generation|1',
    'AuthRecoveryControl|createdAt|CURRENT_TIMESTAMP',
    'AuthRecoveryControl|updatedAt|CURRENT_TIMESTAMP',
    'AuthRecoveryRetiredSecret|retiredAt|CURRENT_TIMESTAMP',
    'AuthSecurityEmailOutbox|id|gen_random_uuid()',
    'AuthSecurityEmailOutbox|deliveryTemplateVersion|1',
    'AuthSecurityEmailOutbox|deliveryState|''PENDING''::"AuthSecurityEmailDeliveryState"',
    'AuthSecurityEmailOutbox|deliveryAttemptCount|0',
    'AuthSecurityEmailOutbox|evidenceRetentionAnchorAt|CURRENT_TIMESTAMP',
    'AuthSecurityEmailOutbox|createdAt|CURRENT_TIMESTAMP',
    'AuthSecurityEmailOutbox|updatedAt|CURRENT_TIMESTAMP'
  ];
  required_enum_shapes TEXT[] := ARRAY[
    'PasswordRecoverySource|1|SELF_SERVICE_EMAIL',
    'PasswordRecoverySource|2|LEGACY_USER_SLOT',
    'PasswordRecoverySource|3|PERSONAL_SERVER_OPERATOR',
    'PasswordRecoveryDeliveryState|1|SUPPRESSED',
    'PasswordRecoveryDeliveryState|2|PENDING',
    'PasswordRecoveryDeliveryState|3|SENDING',
    'PasswordRecoveryDeliveryState|4|ACCEPTED',
    'PasswordRecoveryDeliveryState|5|REJECTED',
    'PasswordRecoveryDeliveryState|6|UNCERTAIN',
    'PasswordRecoverySuppressionReason|1|NO_ELIGIBLE_ACCOUNT',
    'PasswordRecoverySuppressionReason|2|RATE_LIMITED',
    'PasswordRecoverySuppressionReason|3|OUTSTANDING_LIMIT',
    'PasswordRecoveryTerminationReason|1|PASSWORD_RESET_COMPLETED',
    'PasswordRecoveryTerminationReason|2|DELIVERY_REJECTED',
    'PasswordRecoveryTerminationReason|3|KEY_UNAVAILABLE',
    'PasswordRecoveryTerminationReason|4|KEY_ROTATED',
    'PasswordRecoveryTerminationReason|5|ACCOUNT_INACTIVE',
    'PasswordRecoveryTerminationReason|6|EXPIRED',
    'AuthRecoveryRateLimitScope|1|FORGOT_IDENTIFIER_15M',
    'AuthRecoveryRateLimitScope|2|FORGOT_IDENTIFIER_24H',
    'AuthRecoveryRateLimitScope|3|FORGOT_NETWORK_15M',
    'AuthRecoveryRateLimitScope|4|FORGOT_NETWORK_24H',
    'AuthRecoveryRateLimitScope|5|RESET_TOKEN_15M',
    'AuthRecoveryRateLimitScope|6|RESET_TOKEN_24H',
    'AuthRecoveryRateLimitScope|7|RESET_NETWORK_15M',
    'AuthRecoveryRateLimitScope|8|RESET_NETWORK_24H',
    'AuthSecurityEmailKind|1|PASSWORD_RESET_COMPLETED_NOTICE',
    'AuthSecurityEmailDeliveryState|1|PENDING',
    'AuthSecurityEmailDeliveryState|2|SENDING',
    'AuthSecurityEmailDeliveryState|3|ACCEPTED',
    'AuthSecurityEmailDeliveryState|4|REJECTED',
    'AuthSecurityEmailDeliveryState|5|UNCERTAIN'
  ];
  required_trigger_shapes TEXT[] := ARRAY[
    'PasswordRecoveryRequest_guard_integrity|PasswordRecoveryRequest|23|guard_password_recovery_request|O',
    'AuthRecoveryRetiredSecret_guard_integrity|AuthRecoveryRetiredSecret|31|guard_auth_recovery_retired_secret|O',
    'AuthRecoveryRetiredSecret_reject_truncate|AuthRecoveryRetiredSecret|34|reject_auth_recovery_retired_secret_truncate|O',
    'AuthRecoveryControl_guard_integrity|AuthRecoveryControl|31|guard_auth_recovery_control|O',
    'User_invalidate_password_recovery_on_password_change|User|19|invalidate_password_recovery_on_password_change|O',
    'User_guard_retired_password_recovery_slot|User|23|guard_retired_user_password_recovery_slot|O',
    'AuthSecurityEmailOutbox_guard_integrity|AuthSecurityEmailOutbox|23|guard_auth_security_email_outbox|O'
  ];
  required_checks TEXT[] := ARRAY[
    'PasswordRecoveryRequest_hash_shape_check',
    'PasswordRecoveryRequest_key_version_check',
    'PasswordRecoveryRequest_attempt_count_check',
    'PasswordRecoveryRequest_termination_tuple_check',
    'PasswordRecoveryRequest_timeline_check',
    'PasswordRecoveryRequest_evidence_check',
    'PasswordRecoveryRequest_target_shape_check',
    'PasswordRecoveryRequest_source_shape_check',
    'PasswordRecoveryRequest_delivery_evidence_check',
    'PasswordRecoveryRequest_rejected_termination_check',
    'PasswordRecoveryRequest_review_alert_check',
    'PasswordRecoveryRequest_reason_state_check',
    'AuthRecoveryRateLimitBucket_shape_check',
    'AuthRecoveryControl_singleton_check',
    'AuthRecoveryControl_generation_check',
    'AuthRecoveryControl_fingerprint_check',
    'AuthRecoveryControl_state_check',
    'AuthRecoveryControl_timeline_check',
    'AuthRecoveryRetiredSecret_fingerprint_check',
    'AuthRecoveryRetiredSecret_generation_check',
    'AuthSecurityEmailOutbox_attempt_count_check',
    'AuthSecurityEmailOutbox_template_version_check',
    'AuthSecurityEmailOutbox_timeline_check',
    'AuthSecurityEmailOutbox_recipient_check',
    'AuthSecurityEmailOutbox_review_alert_check',
    'AuthSecurityEmailOutbox_delivery_evidence_check'
  ];
  required_indexes TEXT[] := ARRAY[
    'SecurityAuditEvent_id_organisationId_key',
    'PasswordRecoveryRequest_tokenHash_key',
    'PasswordRecoveryRequest_providerMessageId_key',
    'PasswordRecoveryRequest_userId_terminatedAt_expiresAt_id_idx',
    'PasswordRecoveryRequest_deliveryState_nextDeliveryAttemptAt_id_idx',
    'PasswordRecoveryRequest_deliveryState_claimedAt_id_idx',
    'PasswordRecoveryRequest_reviewAlertedAt_reviewAlertClaimedAt_createdAt_id_idx',
    'PasswordRecoveryRequest_evidenceRetentionAnchorAt_id_idx',
    'PasswordRecoveryRequest_expiresAt_id_idx',
    'PasswordRecoveryRequest_createdAt_id_idx',
    'AuthRecoveryRateLimitBucket_expiresAt_idx',
    'AuthRecoveryRetiredSecret_retiredGeneration_key',
    'AuthSecurityEmailOutbox_auditEventId_key',
    'AuthSecurityEmailOutbox_providerMessageId_key',
    'AuthSecurityEmailOutbox_deliveryState_nextDeliveryAttemptAt_id_idx',
    'AuthSecurityEmailOutbox_deliveryState_claimedAt_id_idx',
    'AuthSecurityEmailOutbox_reviewAlertedAt_reviewAlertClaimedAt_createdAt_id_idx',
    'AuthSecurityEmailOutbox_evidenceRetentionAnchorAt_id_idx',
    'AuthSecurityEmailOutbox_createdAt_id_idx'
  ];
  check_name TEXT;
  index_name TEXT;
  recovery_guard TEXT;
  password_change_guard TEXT;
  retired_slot_guard TEXT;
  control_guard TEXT;
  retired_registry_guard TEXT;
  retired_registry_truncate_guard TEXT;
  outbox_guard TEXT;
BEGIN
  IF (
    SELECT COUNT(*) FROM "_prisma_migrations"
    WHERE migration_name = '20260712013000_add_password_recovery_integrity'
      AND finished_at IS NOT NULL
      AND rolled_back_at IS NULL
      AND applied_steps_count = 1
  ) <> 1 OR EXISTS (
    SELECT 1 FROM "_prisma_migrations"
    WHERE migration_name > '20260712013000_add_password_recovery_integrity'
  ) THEN
    RAISE EXCEPTION 'P1-07A proof workspace did not stop at its exact target migration';
  END IF;

  IF TO_REGCLASS('public."PasswordRecoveryRequest"') IS NULL
     OR TO_REGCLASS('public."AuthRecoveryRateLimitBucket"') IS NULL
     OR TO_REGCLASS('public."AuthRecoveryControl"') IS NULL
     OR TO_REGCLASS('public."AuthRecoveryRetiredSecret"') IS NULL
     OR TO_REGCLASS('public."AuthSecurityEmailOutbox"') IS NULL THEN
    RAISE EXCEPTION 'P1-07A target tables are incomplete';
  END IF;

  IF EXISTS (
    WITH expected(shape) AS (
      SELECT UNNEST(required_column_shapes)
    ), actual(shape) AS (
      SELECT FORMAT(
        '%s|%s|%s|%s|%s|%s',
        table_name,
        column_name,
        udt_name,
        is_nullable,
        COALESCE(character_maximum_length::text, '-'),
        COALESCE(datetime_precision::text, '-')
      )
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN (
          'PasswordRecoveryRequest',
          'AuthRecoveryRateLimitBucket',
          'AuthRecoveryControl',
          'AuthRecoveryRetiredSecret',
          'AuthSecurityEmailOutbox'
        )
    )
    (SELECT shape FROM expected EXCEPT SELECT shape FROM actual)
    UNION ALL
    (SELECT shape FROM actual EXCEPT SELECT shape FROM expected)
  ) THEN
    RAISE EXCEPTION 'P1-07A exact table column/type/nullability/precision catalog differs';
  END IF;

  IF EXISTS (
    WITH expected(shape) AS (
      SELECT UNNEST(required_default_shapes)
    ), actual(shape) AS (
      SELECT FORMAT('%s|%s|%s', table_name, column_name, column_default)
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN (
          'PasswordRecoveryRequest',
          'AuthRecoveryRateLimitBucket',
          'AuthRecoveryControl',
          'AuthRecoveryRetiredSecret',
          'AuthSecurityEmailOutbox'
        )
        AND column_default IS NOT NULL
    )
    (SELECT shape FROM expected EXCEPT SELECT shape FROM actual)
    UNION ALL
    (SELECT shape FROM actual EXCEPT SELECT shape FROM expected)
  ) THEN
    RAISE EXCEPTION 'P1-07A exact table default catalog differs';
  END IF;

  IF EXISTS (
    WITH expected(shape) AS (
      SELECT UNNEST(required_enum_shapes)
    ), actual(shape) AS (
      SELECT FORMAT('%s|%s|%s', enum_type.typname, enum_value.enumsortorder::integer, enum_value.enumlabel)
      FROM pg_catalog.pg_enum AS enum_value
      JOIN pg_catalog.pg_type AS enum_type ON enum_type.oid = enum_value.enumtypid
      JOIN pg_catalog.pg_namespace AS namespace_row ON namespace_row.oid = enum_type.typnamespace
      WHERE namespace_row.nspname = 'public'
        AND enum_type.typname IN (
          'PasswordRecoverySource',
          'PasswordRecoveryDeliveryState',
          'PasswordRecoverySuppressionReason',
          'PasswordRecoveryTerminationReason',
          'AuthRecoveryRateLimitScope',
          'AuthSecurityEmailKind',
          'AuthSecurityEmailDeliveryState'
        )
    )
    (SELECT shape FROM expected EXCEPT SELECT shape FROM actual)
    UNION ALL
    (SELECT shape FROM actual EXCEPT SELECT shape FROM expected)
  ) THEN
    RAISE EXCEPTION 'P1-07A exact enum label/order catalog differs';
  END IF;

  IF EXISTS (
    WITH expected(shape) AS (
      SELECT UNNEST(required_trigger_shapes)
    ), actual(shape) AS (
      SELECT FORMAT(
        '%s|%s|%s|%s|%s',
        trigger_row.tgname,
        relation_row.relname,
        trigger_row.tgtype,
        function_row.proname,
        trigger_row.tgenabled
      )
      FROM pg_catalog.pg_trigger AS trigger_row
      JOIN pg_catalog.pg_class AS relation_row ON relation_row.oid = trigger_row.tgrelid
      JOIN pg_catalog.pg_namespace AS namespace_row ON namespace_row.oid = relation_row.relnamespace
      JOIN pg_catalog.pg_proc AS function_row ON function_row.oid = trigger_row.tgfoid
      WHERE namespace_row.nspname = 'public'
        AND NOT trigger_row.tgisinternal
        AND trigger_row.tgname IN (
          'PasswordRecoveryRequest_guard_integrity',
          'AuthRecoveryRetiredSecret_guard_integrity',
          'AuthRecoveryRetiredSecret_reject_truncate',
          'AuthRecoveryControl_guard_integrity',
          'User_invalidate_password_recovery_on_password_change',
          'User_guard_retired_password_recovery_slot',
          'AuthSecurityEmailOutbox_guard_integrity'
        )
    )
    (SELECT shape FROM expected EXCEPT SELECT shape FROM actual)
    UNION ALL
    (SELECT shape FROM actual EXCEPT SELECT shape FROM expected)
  ) THEN
    RAISE EXCEPTION 'P1-07A trigger relation/event/timing/function catalog differs';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    JOIN pg_catalog.pg_class AS relation_row ON relation_row.oid = trigger_row.tgrelid
    JOIN pg_catalog.pg_attribute AS attribute_row
      ON attribute_row.attrelid = relation_row.oid
     AND attribute_row.attname = 'passwordHash'
    WHERE trigger_row.tgname = 'User_invalidate_password_recovery_on_password_change'
      AND relation_row.relname = 'User'
      AND trigger_row.tgattr::text = attribute_row.attnum::text
      AND PG_GET_TRIGGERDEF(trigger_row.oid) ILIKE '%BEFORE UPDATE OF "passwordHash"%'
  ) THEN
    RAISE EXCEPTION 'P1-07A password-change trigger is not restricted to the exact User credential column';
  END IF;

  FOREACH check_name IN ARRAY required_checks LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conname = check_name AND contype = 'c' AND convalidated
    ) THEN
      RAISE EXCEPTION 'Required validated P1-07A CHECK % is missing', check_name;
    END IF;
  END LOOP;

  FOREACH index_name IN ARRAY required_indexes LOOP
    IF TO_REGCLASS('public.' || QUOTE_IDENT(index_name)) IS NULL THEN
      RAISE EXCEPTION 'Required P1-07A index % is missing', index_name;
    END IF;
  END LOOP;

  IF (
    SELECT COUNT(*) FROM pg_catalog.pg_constraint
    WHERE conname IN (
      'PasswordRecoveryRequest_organisationId_fkey',
      'PasswordRecoveryRequest_userId_organisationId_fkey',
      'AuthSecurityEmailOutbox_organisationId_fkey',
      'AuthSecurityEmailOutbox_userId_organisationId_fkey',
      'AuthSecurityEmailOutbox_auditEventId_organisationId_fkey'
    )
      AND contype = 'f'
      AND confdeltype = 'r'
      AND confupdtype = 'r'
      AND convalidated
  ) <> 5 THEN
    RAISE EXCEPTION 'P1-07A restrictive tenant/evidence foreign keys are incomplete';
  END IF;

  IF PG_GET_CONSTRAINTDEF((
    SELECT oid FROM pg_catalog.pg_constraint
    WHERE conname = 'PasswordRecoveryRequest_userId_organisationId_fkey'
  )) NOT ILIKE '%FOREIGN KEY ("userId", "organisationId")%REFERENCES "User"(id, "organisationId")%'
     OR PG_GET_CONSTRAINTDEF((
       SELECT oid FROM pg_catalog.pg_constraint
       WHERE conname = 'AuthSecurityEmailOutbox_userId_organisationId_fkey'
     )) NOT ILIKE '%FOREIGN KEY ("userId", "organisationId")%REFERENCES "User"(id, "organisationId")%'
     OR PG_GET_CONSTRAINTDEF((
       SELECT oid FROM pg_catalog.pg_constraint
       WHERE conname = 'AuthSecurityEmailOutbox_auditEventId_organisationId_fkey'
     )) NOT ILIKE '%FOREIGN KEY ("auditEventId", "organisationId")%REFERENCES "SecurityAuditEvent"(id, "organisationId")%' THEN
    RAISE EXCEPTION 'P1-07A composite user/tenant foreign key shape is malformed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger
    WHERE tgname = 'PasswordRecoveryRequest_guard_integrity'
      AND tgenabled = 'O'
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger
    WHERE tgname = 'AuthSecurityEmailOutbox_guard_integrity'
      AND tgenabled = 'O'
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger
    WHERE tgname = 'User_invalidate_password_recovery_on_password_change'
      AND tgenabled = 'O'
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger
    WHERE tgname = 'User_guard_retired_password_recovery_slot'
      AND tgenabled = 'O'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'P1-07A integrity triggers are missing or disabled';
  END IF;

  SELECT prosrc INTO retired_slot_guard
  FROM pg_catalog.pg_proc
  WHERE proname = 'guard_retired_user_password_recovery_slot';
  IF retired_slot_guard IS NULL
     OR retired_slot_guard NOT ILIKE '%Legacy User password recovery slots are retired%'
     OR retired_slot_guard NOT ILIKE '%resetToken%'
     OR retired_slot_guard NOT ILIKE '%resetTokenExpiry%' THEN
    RAISE EXCEPTION 'Retired legacy User password recovery slot guard is missing or incomplete';
  END IF;

  SELECT prosrc INTO recovery_guard
  FROM pg_catalog.pg_proc
  WHERE proname = 'guard_password_recovery_request';
  IF recovery_guard IS NULL
     OR recovery_guard NOT ILIKE '%FOR UPDATE%'
     OR recovery_guard NOT ILIKE '%outstanding_count >= 3%'
     OR recovery_guard NOT ILIKE '%PasswordRecoveryRequest_recipient_authority%'
     OR recovery_guard NOT ILIKE '%one-way redaction%'
     OR recovery_guard NOT ILIKE '%review alert acknowledgement requires a claim%'
     OR recovery_guard NOT ILIKE '%Terminal password recovery delivery evidence is immutable%' THEN
    RAISE EXCEPTION 'Password recovery guard does not serialize per-user outstanding-limit writes';
  END IF;

  SELECT prosrc INTO password_change_guard
  FROM pg_catalog.pg_proc
  WHERE proname = 'invalidate_password_recovery_on_password_change';
  IF password_change_guard IS NULL
     OR password_change_guard NOT ILIKE '%passwordHash%'
     OR password_change_guard NOT ILIKE '%PasswordRecoveryRequest%'
     OR password_change_guard NOT ILIKE '%PASSWORD_RESET_COMPLETED%'
     OR password_change_guard NOT ILIKE '%clock_timestamp()%'
     OR password_change_guard ILIKE '%SET "terminatedAt" = CURRENT_TIMESTAMP%' THEN
    RAISE EXCEPTION 'Password-change compatibility invalidation guard is missing or incomplete';
  END IF;

  SELECT prosrc INTO control_guard
  FROM pg_catalog.pg_proc
  WHERE proname = 'guard_auth_recovery_control';
  IF control_guard IS NULL
     OR control_guard NOT ILIKE '%migration-owned singleton%'
     OR control_guard NOT ILIKE '%cannot be deleted%'
     OR control_guard NOT ILIKE '%Illegal authentication recovery control transition%'
     OR control_guard NOT ILIKE '%AuthRecoveryRetiredSecret%' THEN
    RAISE EXCEPTION 'Authentication recovery control transition guard is missing or incomplete';
  END IF;

  SELECT prosrc INTO retired_registry_guard
  FROM pg_catalog.pg_proc
  WHERE proname = 'guard_auth_recovery_retired_secret';
  SELECT prosrc INTO retired_registry_truncate_guard
  FROM pg_catalog.pg_proc
  WHERE proname = 'reject_auth_recovery_retired_secret_truncate';
  IF retired_registry_guard IS NULL
     OR retired_registry_guard NOT ILIKE '%append-only%'
     OR retired_registry_guard NOT ILIKE '%current active generation%'
     OR retired_registry_truncate_guard IS NULL
     OR retired_registry_truncate_guard NOT ILIKE '%cannot be truncated%' THEN
    RAISE EXCEPTION 'Retired authentication recovery fingerprint registry guards are incomplete';
  END IF;

  SELECT prosrc INTO outbox_guard
  FROM pg_catalog.pg_proc
  WHERE proname = 'guard_auth_security_email_outbox';
  IF outbox_guard IS NULL
     OR outbox_guard NOT ILIKE '%ALL_SESSIONS_REVOKED%'
     OR outbox_guard NOT ILIKE '%PASSWORD_RESET_COMPLETED%'
     OR outbox_guard NOT ILIKE '%PASSWORD_RECOVERY_LINK%'
     OR outbox_guard NOT ILIKE '%recoveryRequestId%'
     OR outbox_guard NOT ILIKE '%PasswordRecoveryRequest%'
     OR outbox_guard NOT ILIKE '%recovery_terminated_at IS DISTINCT FROM audit_occurred_at%'
     OR outbox_guard NOT ILIKE '%AuthSecurityEmailOutbox_audit_authority%'
     OR outbox_guard NOT ILIKE '%review alert acknowledgement requires a claim%'
     OR outbox_guard NOT ILIKE '%Terminal auth security email delivery evidence is immutable%' THEN
    RAISE EXCEPTION 'Auth security email authority/immutability guard is missing or incomplete';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_enum AS enum_value
    JOIN pg_catalog.pg_type AS enum_type ON enum_type.oid = enum_value.enumtypid
    WHERE enum_type.typname = 'SecurityAuditEventType'
      AND enum_value.enumlabel = 'PASSWORD_RESET_COMPLETED'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_enum AS enum_value
    JOIN pg_catalog.pg_type AS enum_type ON enum_type.oid = enum_value.enumtypid
    WHERE enum_type.typname = 'SecurityAuditEventType'
      AND enum_value.enumlabel = 'ALL_SESSIONS_REVOKED'
  ) THEN
    RAISE EXCEPTION 'P1-07A changed the prior-client SecurityAuditEventType contract';
  END IF;
END;
$fixture$;
`;

const VALID_BACKFILL_ASSERTIONS_SQL = String.raw`
DO $fixture$
BEGIN
  IF (
    SELECT COUNT(*) FROM "PasswordRecoveryRequest"
    WHERE "source" = 'LEGACY_USER_SLOT'::"PasswordRecoverySource"
  ) <> 2 OR NOT EXISTS (
    SELECT 1
    FROM "PasswordRecoveryRequest" AS recovery
    JOIN "User" AS account
      ON account."id" = recovery."userId"
     AND account."organisationId" = recovery."organisationId"
    JOIN "Organisation" AS organisation
      ON organisation."id" = recovery."organisationId"
    WHERE recovery."userId" = 'p107a-valid-user'
      AND recovery."organisationId" = 'p107a-valid-org'
      AND recovery."source" = 'LEGACY_USER_SLOT'::"PasswordRecoverySource"
      AND recovery."deliveryState" = 'UNCERTAIN'::"PasswordRecoveryDeliveryState"
      AND recovery."tokenHash" = '${LEGACY_TOKEN_HASH}'
      AND recovery."tokenHash" <> '${LEGACY_RAW_TOKEN}'
      AND recovery."tokenNonce" IS NULL
      AND recovery."tokenKeyVersion" IS NULL
      AND recovery."terminatedAt" IS NULL
      AND recovery."terminationReason" IS NULL
      AND recovery."expiresAt" > CURRENT_TIMESTAMP
      AND account."lifecycleStatus" = 'ACTIVE'::"UserLifecycleStatus"
      AND organisation."lifecycleStatus" = 'ACTIVE'::"OrganisationLifecycleStatus"
  ) THEN
    RAISE EXCEPTION 'Valid legacy reset digest was not backfilled exactly into consumable UNCERTAIN evidence';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "PasswordRecoveryRequest"
    WHERE "userId" = 'p107a-boundary-user'
      AND "organisationId" = 'p107a-valid-org'
      AND "source" = 'LEGACY_USER_SLOT'::"PasswordRecoverySource"
      AND "deliveryState" = 'UNCERTAIN'::"PasswordRecoveryDeliveryState"
      AND "tokenHash" = '${'a'.repeat(64)}'
      AND "expiresAt" > CURRENT_TIMESTAMP
      AND "expiresAt" <= "createdAt" + INTERVAL '1 hour'
      AND "terminatedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'Exact database-now plus one-hour legacy boundary was not preserved';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "PasswordRecoveryRequest"
    WHERE COALESCE("tokenHash", '') = '${LEGACY_RAW_TOKEN}'
       OR COALESCE("recipientEmail", '') = '${LEGACY_RAW_TOKEN}'
       OR COALESCE("recipientName", '') = '${LEGACY_RAW_TOKEN}'
       OR COALESCE("frontendOrigin", '') = '${LEGACY_RAW_TOKEN}'
       OR COALESCE("providerMessageId", '') = '${LEGACY_RAW_TOKEN}'
  ) THEN
    RAISE EXCEPTION 'P1-07A migration persisted the recoverable raw legacy token';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "User"
    WHERE "id" = 'p107a-valid-user'
      AND "resetToken" IS NULL
      AND "resetTokenExpiry" IS NULL
  ) THEN
    RAISE EXCEPTION 'P1-07A migration did not atomically retire the backfilled legacy User slot';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "User"
    WHERE "id" = 'p107a-expired-user'
      AND "resetToken" IS NULL
      AND "resetTokenExpiry" IS NULL
  ) OR EXISTS (
    SELECT 1 FROM "PasswordRecoveryRequest"
    WHERE "userId" = 'p107a-expired-user'
  ) THEN
    RAISE EXCEPTION 'Expired legacy pair was not cleared together or invented recovery evidence';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "User"
    WHERE "id" = 'p107a-inactive-user'
      AND "lifecycleStatus" = 'SUSPENDED'::"UserLifecycleStatus"
      AND "resetToken" IS NULL
      AND "resetTokenExpiry" IS NULL
  ) OR EXISTS (
    SELECT 1 FROM "PasswordRecoveryRequest"
    WHERE "userId" = 'p107a-inactive-user'
  ) THEN
    RAISE EXCEPTION 'Inactive legacy half-pair was not deterministically cleared without recovery evidence';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "User"
    WHERE "id" = 'p107a-control-user'
      AND "resetToken" IS NULL
      AND "resetTokenExpiry" IS NULL
      AND "email" = 'p107a-control@example.test'
      AND "name" = 'No legacy recovery'
      AND "role" = 'MEMBER'::"UserRole"
  ) THEN
    RAISE EXCEPTION 'Unrelated representative User data changed during P1-07A upgrade';
  END IF;
END;
$fixture$;
`;

const INSERT_VALID_PENDING_REQUEST_SQL = String.raw`
INSERT INTO "PasswordRecoveryRequest" (
  "id", "source", "organisationId", "userId", "identifierDigest",
  "requestIpDigest", "requestNetworkDigest", "rateKeyVersion", "tokenHash",
  "tokenNonce", "tokenKeyVersion", "recipientEmail", "recipientName",
  "frontendOrigin", "deliveryTemplateVersion", "deliveryState", "deliveryAttemptCount",
  "nextDeliveryAttemptAt", "expiresAt", "createdAt", "updatedAt"
) VALUES (
  '11111111-1111-4111-8111-111111111111',
  'SELF_SERVICE_EMAIL', 'p107a-valid-org', 'p107a-valid-user',
  '${'1'.repeat(64)}', '${'2'.repeat(64)}', '${'3'.repeat(64)}', 1,
  '${'4'.repeat(64)}', '${'5'.repeat(64)}', 1,
  'p107a-valid@example.test', 'Valid legacy recovery', 'https://app.example.test',
  1, 'PENDING', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '30 minutes',
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
`;

const INSERT_THIRD_OUTSTANDING_REQUEST_SQL = String.raw`
INSERT INTO "PasswordRecoveryRequest" (
  "id", "source", "organisationId", "userId", "tokenHash", "deliveryState",
  "deliveryAttemptCount", "expiresAt", "createdAt", "updatedAt"
) VALUES (
  '22222222-2222-4222-8222-222222222222',
  'PERSONAL_SERVER_OPERATOR', 'p107a-valid-org', 'p107a-valid-user',
  '${'6'.repeat(64)}', 'ACCEPTED', 0,
  CURRENT_TIMESTAMP + INTERVAL '30 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
`;

const INSERT_FOURTH_OUTSTANDING_REQUEST_SQL = String.raw`
INSERT INTO "PasswordRecoveryRequest" (
  "id", "source", "organisationId", "userId", "tokenHash", "deliveryState",
  "deliveryAttemptCount", "expiresAt", "createdAt", "updatedAt"
) VALUES (
  '33333333-3333-4333-8333-333333333333',
  'PERSONAL_SERVER_OPERATOR', 'p107a-valid-org', 'p107a-valid-user',
  '${'7'.repeat(64)}', 'ACCEPTED', 0,
  CURRENT_TIMESTAMP + INTERVAL '30 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
`;

const INSERT_OUTBOX_EVIDENCE_SQL = String.raw`
BEGIN;
UPDATE "PasswordRecoveryRequest"
SET "terminatedAt" = CURRENT_TIMESTAMP,
    "terminationReason" = 'PASSWORD_RESET_COMPLETED'::"PasswordRecoveryTerminationReason",
    "nextDeliveryAttemptAt" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = '11111111-1111-4111-8111-111111111111';

INSERT INTO "SecurityAuditEvent" (
  "id", "organisationId", "type", "actorKind", "actorLabel", "subjectLabel",
  "subjectUserId", "reason", "context", "eventVersion", "occurredAt"
) VALUES (
  'p107a-password-reset-audit', 'p107a-valid-org', 'ALL_SESSIONS_REVOKED',
  'SYSTEM', 'Self-service recovery', 'Valid legacy recovery', 'p107a-valid-user',
  'Password reset completed using a one-time recovery link.',
  '{"eventKind":"PASSWORD_RESET_COMPLETED","method":"PASSWORD_RECOVERY_LINK","recoveryRequestId":"11111111-1111-4111-8111-111111111111"}'::jsonb,
  1, CURRENT_TIMESTAMP
);

INSERT INTO "AuthSecurityEmailOutbox" (
  "id", "kind", "organisationId", "userId", "auditEventId", "recipientEmail",
  "recipientName", "deliveryState", "deliveryAttemptCount",
  "nextDeliveryAttemptAt", "createdAt", "updatedAt"
) VALUES (
  '44444444-4444-4444-8444-444444444444',
  'PASSWORD_RESET_COMPLETED_NOTICE', 'p107a-valid-org', 'p107a-valid-user',
  'p107a-password-reset-audit', 'p107a-valid@example.test', 'Valid legacy recovery',
  'PENDING', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
COMMIT;
`;

function defaultCommandRunner(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeoutMs ?? 120_000,
    ...options,
  });
}

function resultText(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
}

function requireSuccess(result, description) {
  if (result.error) {
    throw new Error(`${description} could not execute: ${result.error.message}`, { cause: result.error });
  }
  if (result.status !== 0) {
    throw new Error(`${description} failed with exit code ${result.status}:\n${resultText(result)}`);
  }
}

function validateDatabasePrefix(prefix) {
  if (!/^[a-z][a-z0-9_]{2,38}$/.test(prefix)) {
    throw new Error('CHARITYPILOT_P107A_UPGRADE_DB_PREFIX must be a short lowercase PostgreSQL identifier');
  }
  return prefix;
}

function validateCommandTimeout(value) {
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 600_000) {
    throw new Error('CHARITYPILOT_P107A_UPGRADE_COMMAND_TIMEOUT_MS must be an integer from 10000 to 600000');
  }
  return timeoutMs;
}

function validateCleanupTimeout(value) {
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 60_000) {
    throw new Error('CHARITYPILOT_P107A_UPGRADE_CLEANUP_TIMEOUT_MS must be an integer from 5000 to 60000');
  }
  return timeoutMs;
}

function parseVerifierArgs(args) {
  let migrationImage = null;
  for (const arg of args) {
    if (arg === '--keep-databases' || arg === '--dry-run') continue;
    if (arg.startsWith('--migration-image=')) {
      if (migrationImage !== null) throw new Error(`Duplicate --migration-image option\n${USAGE}`);
      migrationImage = arg.slice('--migration-image='.length);
      if (!/^[a-z0-9][a-z0-9._/:@-]{0,254}$/.test(migrationImage)) {
        throw new Error(`--migration-image must be a safe lowercase Docker image reference\n${USAGE}`);
      }
      continue;
    }
    throw new Error(`Unknown option: ${arg}\n${USAGE}`);
  }
  return {
    keepDatabases: args.includes('--keep-databases'),
    dryRun: args.includes('--dry-run'),
    migrationImage,
  };
}

function defaultDatabasePrefix() {
  return `charitypilot_p107a_${process.pid}_${randomBytes(4).toString('hex')}`;
}

function validateLoopbackHost(value) {
  const host = value.toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(
      'CHARITYPILOT_CI_POSTGRES_HOST must be loopback-only (127.0.0.1 or localhost) for the disposable P1-07A verifier',
    );
  }
  return host;
}

function validatePostgresPort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('CHARITYPILOT_CI_POSTGRES_PORT must be an integer from 1 to 65535');
  }
  return String(port);
}

function disposableDatabaseUrl({ database, host, port, user, password }) {
  const url = new URL('postgresql://localhost/postgres');
  url.hostname = host;
  url.port = port;
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  url.searchParams.set('schema', 'public');
  return url.toString();
}

function createMigrationWorkspace(migrationNames, migrationsRoot, prefix) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), prefix));
  const temporaryPrismaRoot = join(temporaryRoot, 'prisma');
  const temporaryMigrationsRoot = join(temporaryPrismaRoot, 'migrations');
  mkdirSync(temporaryMigrationsRoot, { recursive: true });

  cpSync(join(dirname(migrationsRoot), 'schema.prisma'), join(temporaryPrismaRoot, 'schema.prisma'));
  cpSync(join(migrationsRoot, 'migration_lock.toml'), join(temporaryMigrationsRoot, 'migration_lock.toml'));
  for (const migrationName of migrationNames) {
    cpSync(
      join(migrationsRoot, migrationName),
      join(temporaryMigrationsRoot, migrationName),
      { recursive: true },
    );
  }
  return { root: temporaryRoot, schemaPath: join(temporaryPrismaRoot, 'schema.prisma') };
}

function createPreviousMigrationWorkspace(plan, migrationsRoot) {
  return createMigrationWorkspace(
    plan.previous,
    migrationsRoot,
    'charitypilot-p107a-previous-prisma-',
  );
}

function createTargetMigrationWorkspace(plan, migrationsRoot) {
  return createMigrationWorkspace(
    [...plan.previous, plan.target],
    migrationsRoot,
    'charitypilot-p107a-target-prisma-',
  );
}

function repositoryMigrationChecksums(migrationsRoot) {
  return Object.fromEntries(P107A_RECOVERY_MIGRATIONS.map((migrationName) => {
    const bytes = readFileSync(join(migrationsRoot, migrationName, 'migration.sql'));
    return [migrationName, createHash('sha256').update(bytes).digest('hex')];
  }));
}

export async function cleanupPasswordRecoveryUpgradeDatabases({
  databases,
  dockerBin,
  container,
  user,
  adminDatabase,
  commandRunner = defaultCommandRunner,
  timeoutMs,
  pollAttempts = 20,
  pollDelayMs = 250,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  if (!Array.isArray(databases) || databases.length === 0) {
    throw new Error('P1-07A cleanup requires at least one disposable database name');
  }
  if (databases.some((database) => !/^[a-z][a-z0-9_]{2,62}$/.test(database))) {
    throw new Error('P1-07A cleanup refused an unsafe disposable database name');
  }
  if (!Number.isSafeInteger(pollAttempts) || pollAttempts < 1 || pollAttempts > 100) {
    throw new Error('P1-07A cleanup pollAttempts must be an integer from 1 to 100');
  }

  const databaseSet = new Set(databases);
  const quotedNames = databases.map((database) => `'${database}'`).join(', ');
  const diagnostics = [];
  let lastResidue = [...databases];
  const run = (args) => commandRunner(dockerBin, args, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeoutMs,
  });
  const listResidue = () => {
    const result = run([
      'exec', container,
      'psql', '--no-psqlrc', '--username', user, '--dbname', adminDatabase,
      '--tuples-only', '--no-align', '--command',
      `SELECT datname FROM pg_database WHERE datname IN (${quotedNames}) ORDER BY datname;`,
    ]);
    if (result.error || result.status !== 0) {
      diagnostics.push(
        `residue query failed: ${resultText(result).slice(0, 500) || result.error?.message || 'unknown error'}`,
      );
      return null;
    }
    const residue = String(result.stdout ?? '')
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .filter((entry) => databaseSet.has(entry));
    lastResidue = residue;
    return residue;
  };

  for (let pass = 1; pass <= 2; pass += 1) {
    for (const database of databases) {
      const result = run([
        'exec', container,
        'dropdb', '--if-exists', '--force', '--username', user, database,
      ]);
      if (result.error || result.status !== 0) {
        diagnostics.push(
          `forced drop pass ${pass} for ${database} failed: ` +
          `${resultText(result).slice(0, 500) || result.error?.message || 'unknown error'}`,
        );
      }
    }

    for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
      const residue = listResidue();
      if (residue?.length === 0) return;
      if (attempt < pollAttempts) await sleep(pollDelayMs);
    }
  }

  throw new Error(
    `P1-07A disposable database cleanup left residue: ${lastResidue.join(', ') || 'unknown'}; ` +
    diagnostics.slice(-6).join(' | '),
  );
}

export function discoverPasswordRecoveryUpgradeMigrations(migrationsRoot = DEFAULT_MIGRATIONS_ROOT) {
  const migrations = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{14}_/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const targetIndex = migrations.indexOf(TARGET_MIGRATION);
  if (targetIndex === -1) throw new Error(`Missing target migration: ${TARGET_MIGRATION}`);
  if (migrations[targetIndex - 1] !== PREVIOUS_MIGRATION) {
    throw new Error(`P1-07A historical boundary must immediately follow ${PREVIOUS_MIGRATION}`);
  }
  return { previous: migrations.slice(0, targetIndex), target: TARGET_MIGRATION };
}

export async function verifyPasswordRecoveryUpgrade({
  args = process.argv.slice(2),
  env = process.env,
  migrationsRoot = DEFAULT_MIGRATIONS_ROOT,
  schemaPath = DEFAULT_SCHEMA_PATH,
  commandRunner = defaultCommandRunner,
  cleanupDatabases = cleanupPasswordRecoveryUpgradeDatabases,
  stdout = process.stdout,
} = {}) {
  const { keepDatabases, dryRun, migrationImage } = parseVerifierArgs(args);
  const dockerBin = env.CHARITYPILOT_CI_POSTGRES_DOCKER_BIN ?? 'docker';
  const container = env.CHARITYPILOT_CI_POSTGRES_CONTAINER ?? 'charitypilot-ci-postgres';
  const user = env.CHARITYPILOT_CI_POSTGRES_USER ?? 'charitypilot';
  const password = env.CHARITYPILOT_CI_POSTGRES_PASSWORD ?? 'charitypilot_ci';
  const adminDatabase = env.CHARITYPILOT_CI_POSTGRES_ADMIN_DB ?? 'postgres';
  const host = validateLoopbackHost(env.CHARITYPILOT_CI_POSTGRES_HOST ?? '127.0.0.1');
  const port = validatePostgresPort(env.CHARITYPILOT_CI_POSTGRES_PORT ?? '5432');
  const commandTimeoutMs = validateCommandTimeout(
    env.CHARITYPILOT_P107A_UPGRADE_COMMAND_TIMEOUT_MS ?? '120000',
  );
  const cleanupTimeoutMs = validateCleanupTimeout(
    env.CHARITYPILOT_P107A_UPGRADE_CLEANUP_TIMEOUT_MS ?? '20000',
  );
  const prefix = validateDatabasePrefix(
    env.CHARITYPILOT_P107A_UPGRADE_DB_PREFIX ?? defaultDatabasePrefix(),
  );
  const databases = {
    base: `${prefix}_base`,
    valid: `${prefix}_valid`,
    invalid: `${prefix}_invalid`,
    fresh: `${prefix}_fresh`,
  };
  const allDatabases = Object.values(databases);
  const plan = discoverPasswordRecoveryUpgradeMigrations(migrationsRoot);
  const checkoutMigrationChecksums = repositoryMigrationChecksums(migrationsRoot);
  let selectedMigrationChecksums = checkoutMigrationChecksums;
  let productionRecoveryPreflightSql = buildP107ARecoveryPreflightSql(
    selectedMigrationChecksums,
  );
  const prismaVersion = JSON.parse(readFileSync(PRISMA_PACKAGE_PATH, 'utf8')).version;
  if (prismaVersion !== REQUIRED_PRISMA_VERSION) {
    throw new Error(
      `P1-07A upgrade verification requires Prisma ${REQUIRED_PRISMA_VERSION}; found ${prismaVersion ?? 'unknown'}`,
    );
  }

  if (dryRun) {
    stdout.write(`Container: ${container}\n`);
    stdout.write(`Prisma CLI: ${prismaVersion}\n`);
    stdout.write(`Target migration executor: ${migrationImage ?? `host Prisma ${prismaVersion}`}\n`);
    stdout.write(`PostgreSQL endpoint: ${host}:${port} (loopback-only)\n`);
    stdout.write(`Cleanup command timeout: ${cleanupTimeoutMs}ms (two forced-drop passes)\n`);
    stdout.write(`Pre-P1-07A migrations: ${plan.previous.length}\n`);
    stdout.write(`Previous migration: ${plan.previous.at(-1)}\n`);
    stdout.write(`Target migration: ${plan.target}\n`);
    stdout.write(`Disposable databases: ${allDatabases.join(', ')}\n`);
    return;
  }

  const previousMigrationWorkspace = createPreviousMigrationWorkspace(plan, migrationsRoot);
  const targetMigrationWorkspace = createTargetMigrationWorkspace(plan, migrationsRoot);

  const runDocker = (dockerArgs, description, options = {}) => {
    const result = commandRunner(dockerBin, dockerArgs, {
      timeoutMs: commandTimeoutMs,
      ...options,
    });
    if (!options.allowFailure) requireSuccess(result, description);
    return result;
  };
  const psql = (database, sql, description, options = {}) => runDocker([
    'exec', '-i', container,
    'psql', '--no-psqlrc', '--set=ON_ERROR_STOP=1', '--quiet',
    '--username', user, '--dbname', database,
  ], description, { ...options, input: sql });
  const createDatabase = (database, template) => runDocker([
    'exec', container, 'createdb', '--username', user,
    ...(template ? ['--template', template] : []),
    database,
  ], `create disposable database ${database}`);
  const runPrisma = (database, prismaArgs, description, options = {}) => {
    const result = commandRunner(process.execPath, [PRISMA_CLI_PATH, ...prismaArgs], {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeoutMs: commandTimeoutMs,
      env: {
        ...process.env,
        ...env,
        DATABASE_URL: disposableDatabaseUrl({ database, host, port, user, password }),
        PRISMA_HIDE_UPDATE_MESSAGE: '1',
      },
      ...options,
    });
    if (!options.allowFailure) requireSuccess(result, description);
    return result;
  };
  const runMigrationImagePrisma = (database, prismaArgs, description, options = {}) => {
    if (!migrationImage) throw new Error('P1-07A migration-image command requested without --migration-image');
    const result = commandRunner(dockerBin, [
      'run', '--rm',
      ...(options.input === undefined ? [] : ['--interactive']),
      '--mount', `type=bind,source=${targetMigrationWorkspace.root},target=/p107a-proof,readonly`,
      '--network', 'host', '--env', 'DATABASE_URL',
      migrationImage,
      ...prismaArgs,
    ], {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeoutMs: commandTimeoutMs,
      env: {
        ...process.env,
        ...env,
        DATABASE_URL: disposableDatabaseUrl({ database, host, port, user, password }),
      },
      ...options,
    });
    if (!options.allowFailure) requireSuccess(result, description);
    return result;
  };
  const runTargetPrisma = migrationImage ? runMigrationImagePrisma : runPrisma;
  const targetSchemaPath = migrationImage
    ? '/p107a-proof/prisma/schema.prisma'
    : targetMigrationWorkspace.schemaPath;
  const captureMigrationImageChecksums = () => {
    if (!migrationImage) return selectedMigrationChecksums;
    const result = commandRunner(dockerBin, [
      'run', '--rm', '--network', 'none', '--entrypoint', 'node',
      migrationImage,
      '-e', P107A_RECOVERY_IMAGE_CHECKSUM_SCRIPT,
    ], {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeoutMs: commandTimeoutMs,
      env: { ...process.env, ...env },
    });
    requireSuccess(result, 'capture exact P1-07A migration checksums from selected built image');
    return parseP107AMigrationChecksumOutput(result.stdout);
  };
  const assertSqlFailure = (database, sql, expectedError, description) => {
    const result = psql(database, sql, description, { allowFailure: true });
    if (result.error) throw result.error;
    if (result.status === 0) throw new Error(`${description} unexpectedly succeeded`);
    const failure = resultText(result);
    if (!expectedError.test(failure)) {
      throw new Error(`${description} failed for an unexpected reason:\n${failure}`);
    }
  };
  const fixtureFingerprint = (database, description) => {
    const result = runDocker([
      'exec', '-i', container,
      'psql', '--no-psqlrc', '--set=ON_ERROR_STOP=1', '--quiet',
      '--tuples-only', '--no-align', '--username', user, '--dbname', database,
    ], description, { input: String.raw`
      SELECT md5(jsonb_build_object(
        'organisations', COALESCE((
          SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value."id")
          FROM "Organisation" AS row_value
          WHERE row_value."id" LIKE 'p107a-%'
        ), '[]'::jsonb),
        'usersExceptDocumentedResetPair', COALESCE((
          SELECT jsonb_agg(
            to_jsonb(row_value) - 'resetToken' - 'resetTokenExpiry'
            ORDER BY row_value."id"
          )
          FROM "User" AS row_value
          WHERE row_value."id" LIKE 'p107a-%'
        ), '[]'::jsonb)
      )::text);
    ` });
    const fingerprint = String(result.stdout ?? '').trim();
    if (!/^[a-f0-9]{32}$/.test(fingerprint)) {
      throw new Error(`${description} did not return one logical fixture fingerprint`);
    }
    return fingerprint;
  };
  const recoveryStateFingerprint = (database, description) => {
    const result = runDocker([
      'exec', '-i', container,
      'psql', '--no-psqlrc', '--set=ON_ERROR_STOP=1', '--quiet',
      '--tuples-only', '--no-align', '--username', user, '--dbname', database,
    ], description, { input: String.raw`
      SELECT md5(jsonb_build_object(
        'migrationHistory', COALESCE((
          SELECT jsonb_agg(to_jsonb(history_row) ORDER BY history_row.id)
          FROM "_prisma_migrations" AS history_row
        ), '[]'::jsonb),
        'organisations', COALESCE((
          SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value."id")
          FROM "Organisation" AS row_value
        ), '[]'::jsonb),
        'users', COALESCE((
          SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value."id")
          FROM "User" AS row_value
        ), '[]'::jsonb),
        'catalog', COALESCE((
          SELECT jsonb_agg(to_jsonb(catalog_row) ORDER BY catalog_row.kind, catalog_row.name)
          FROM (
            SELECT 'constraint' AS kind, constraint_row.conname AS name,
                   PG_GET_CONSTRAINTDEF(constraint_row.oid) AS definition
            FROM pg_catalog.pg_constraint AS constraint_row
            JOIN pg_catalog.pg_class AS table_row ON table_row.oid = constraint_row.conrelid
            JOIN pg_catalog.pg_namespace AS namespace_row ON namespace_row.oid = table_row.relnamespace
            WHERE namespace_row.nspname = 'public'
            UNION ALL
            SELECT 'index', index_row.relname, PG_GET_INDEXDEF(index_row.oid)
            FROM pg_catalog.pg_class AS index_row
            JOIN pg_catalog.pg_namespace AS namespace_row ON namespace_row.oid = index_row.relnamespace
            WHERE namespace_row.nspname = 'public' AND index_row.relkind = 'i'
            UNION ALL
            SELECT 'type', type_row.typname, type_row.typtype::text
            FROM pg_catalog.pg_type AS type_row
            JOIN pg_catalog.pg_namespace AS namespace_row ON namespace_row.oid = type_row.typnamespace
            WHERE namespace_row.nspname = 'public'
          ) AS catalog_row
        ), '[]'::jsonb)
      )::text);
    ` });
    const fingerprint = String(result.stdout ?? '').trim();
    if (!/^[a-f0-9]{32}$/.test(fingerprint)) {
      throw new Error(`${description} did not return one complete recovery-state fingerprint`);
    }
    return fingerprint;
  };
  const executeProductionRecoveryPreflight = (database, options = {}) => migrationImage
    ? runTargetPrisma(
      database,
      ['db', 'execute', '--stdin', '--schema', targetSchemaPath],
      'execute exact production P1-07A recovery preflight through built migration image',
      { ...options, input: productionRecoveryPreflightSql },
    )
    : psql(
      database,
      productionRecoveryPreflightSql,
      'execute exact production P1-07A recovery preflight before resolution',
      options,
    );

  let verificationFailure;
  try {
    await cleanupDatabases({
      databases: [...allDatabases].reverse(),
      dockerBin,
      container,
      user,
      adminDatabase,
      commandRunner,
      timeoutMs: cleanupTimeoutMs,
    });
    if (migrationImage) {
      selectedMigrationChecksums = captureMigrationImageChecksums();
      for (const migrationName of P107A_RECOVERY_MIGRATIONS) {
        if (selectedMigrationChecksums[migrationName] !== checkoutMigrationChecksums[migrationName]) {
          throw new Error(
            `Selected migration image bytes differ from the target-only P1-07A proof workspace at ${migrationName}`,
          );
        }
      }
      productionRecoveryPreflightSql = buildP107ARecoveryPreflightSql(
        selectedMigrationChecksums,
      );
      stdout.write(
        `Captured and bound ${P107A_RECOVERY_MIGRATIONS.length} migration checksums from ${migrationImage}; ` +
        'the mounted proof workspace matches those exact bytes and stops at P1-07A.\n',
      );
    }

    createDatabase(databases.base);
    runPrisma(
      databases.base,
      ['migrate', 'deploy', '--schema', previousMigrationWorkspace.schemaPath],
      'establish exact historical schema through P1-09',
    );
    psql(databases.base, EXACT_BOUNDARY_ASSERTIONS_SQL, 'assert exact pre-P1-07A Prisma history');
    stdout.write(
      `Prisma ${prismaVersion} applied ${plan.previous.length} migrations through ${plan.previous.at(-1)}.\n`,
    );

    createDatabase(databases.invalid, databases.base);
    psql(databases.invalid, INVALID_LEGACY_SEED_SQL, 'seed malformed legacy recovery pairs');
    const failedMigration = runTargetPrisma(
      databases.invalid,
      ['migrate', 'deploy', '--schema', targetSchemaPath],
      `apply ${plan.target} against malformed legacy recovery pairs`,
      { allowFailure: true },
    );
    if (failedMigration.error) {
      throw new Error(
        `Prisma migrate deploy for ${plan.target} could not execute: ${failedMigration.error.message}`,
        { cause: failedMigration.error },
      );
    }
    if (failedMigration.status === 0) {
      throw new Error('P1-07A malformed legacy-pair migration unexpectedly succeeded');
    }
    const failedText = resultText(failedMigration);
    if (!failedText.includes(plan.target)) {
      throw new Error(`P1-07A preflight failure was not target-bound:\n${failedText}`);
    }
    psql(databases.invalid, FAILED_MIGRATION_ATOMICITY_SQL, 'prove failed P1-07A migration was atomic');
    psql(
      databases.invalid,
      FAILED_PRISMA_HISTORY_ASSERTIONS_SQL,
      'prove exactly one unresolved failed P1-07A Prisma record',
    );

    const blockedRerun = runTargetPrisma(
      databases.invalid,
      ['migrate', 'deploy', '--schema', targetSchemaPath],
      'prove plain retry is blocked by unresolved P1-07A history',
      { allowFailure: true },
    );
    if (blockedRerun.error) throw blockedRerun.error;
    if (blockedRerun.status === 0) {
      throw new Error('Plain Prisma retry unexpectedly bypassed unresolved P1-07A history');
    }
    const blockedText = resultText(blockedRerun);
    if (!/P3009/.test(blockedText) || !blockedText.includes(plan.target)) {
      throw new Error(`Plain Prisma retry did not fail with target-bound P3009:\n${blockedText}`);
    }

    psql(
      databases.invalid,
      REMEDIATE_DISPOSABLE_INVALID_FIXTURE_SQL,
      'deliberately remediate only the disposable malformed P1-07A fixture',
    );
    psql(
      databases.invalid,
      NO_TARGET_SCHEMA_RESIDUE_SQL,
      'prove remediated database still has no target schema residue',
    );
    psql(
      databases.invalid,
      FAILED_PRISMA_HISTORY_ASSERTIONS_SQL,
      'prove failed history remains unresolved until exact migrate resolve',
    );
    let tamperedChecksumPreflightStatus = null;
    if (migrationImage) {
      const expectedTargetChecksum = selectedMigrationChecksums[plan.target];
      const tamperedChecksum = '0'.repeat(64);
      if (expectedTargetChecksum === tamperedChecksum) {
        throw new Error('Selected P1-07A migration image has the reserved checksum-tamper value');
      }
      psql(databases.invalid, String.raw`
        DO $fixture$
        DECLARE
          affected_rows INTEGER;
        BEGIN
          UPDATE "_prisma_migrations"
          SET checksum = '${tamperedChecksum}'
          WHERE migration_name = '${plan.target}'
            AND finished_at IS NULL
            AND rolled_back_at IS NULL
            AND checksum = '${expectedTargetChecksum}';
          GET DIAGNOSTICS affected_rows = ROW_COUNT;
          IF affected_rows <> 1 THEN
            RAISE EXCEPTION 'P1-07A checksum proof did not tamper exactly one failed target row';
          END IF;
        END;
        $fixture$;
      `, 'tamper only the disposable failed P1-07A checksum');
      const rejectedPreflight = executeProductionRecoveryPreflight(
        databases.invalid,
        { allowFailure: true },
      );
      if (rejectedPreflight.error) throw rejectedPreflight.error;
      const rejection = resultText(rejectedPreflight);
      if (
        rejectedPreflight.status === 0 ||
        !/exact selected-image checksums/i.test(rejection)
      ) {
        throw new Error(
          `Built-image P1-07A recovery preflight accepted a tampered target checksum:\n${rejection}`,
        );
      }
      tamperedChecksumPreflightStatus = rejectedPreflight.status;
      psql(databases.invalid, String.raw`
        DO $fixture$
        DECLARE
          affected_rows INTEGER;
        BEGIN
          UPDATE "_prisma_migrations"
          SET checksum = '${expectedTargetChecksum}'
          WHERE migration_name = '${plan.target}'
            AND finished_at IS NULL
            AND rolled_back_at IS NULL
            AND checksum = '${tamperedChecksum}';
          GET DIAGNOSTICS affected_rows = ROW_COUNT;
          IF affected_rows <> 1 THEN
            RAISE EXCEPTION 'P1-07A checksum proof did not restore exactly one failed target row';
          END IF;
        END;
        $fixture$;
      `, 'restore exact selected-image P1-07A checksum');
    }
    const stateBeforeProductionPreflight = recoveryStateFingerprint(
      databases.invalid,
      'capture complete state before production P1-07A recovery preflight',
    );
    const productionPreflightResult = executeProductionRecoveryPreflight(databases.invalid);
    const stateAfterProductionPreflight = recoveryStateFingerprint(
      databases.invalid,
      'capture complete state after production P1-07A recovery preflight',
    );
    if (stateAfterProductionPreflight !== stateBeforeProductionPreflight) {
      throw new Error('Exact production P1-07A recovery preflight changed rows or catalog state');
    }
    const resolveResult = runTargetPrisma(
      databases.invalid,
      ['migrate', 'resolve', '--rolled-back', plan.target, '--schema', targetSchemaPath],
      'resolve exact remediated P1-07A migration as rolled back',
    );
    psql(
      databases.invalid,
      ROLLED_BACK_PRISMA_HISTORY_ASSERTIONS_SQL,
      'assert exact P1-07A rolled-back history resolution',
    );
    const redeployResult = runTargetPrisma(
      databases.invalid,
      ['migrate', 'deploy', '--schema', targetSchemaPath],
      'redeploy P1-07A after deliberate fixture remediation and exact resolution',
    );
    psql(
      databases.invalid,
      INSTALLED_CATALOG_ASSERTIONS_SQL,
      'assert recovered P1-07A catalog',
    );
    psql(
      databases.invalid,
      RECOVERED_PRISMA_HISTORY_ASSERTIONS_SQL,
      'assert recovered P1-07A history and data',
    );
    const recoveredStatusResult = runTargetPrisma(
      databases.invalid,
      ['migrate', 'status', '--schema', targetSchemaPath],
      'verify recovered P1-07A Prisma migration status',
    );
    if (migrationImage) {
      stdout.write(
        `Built-image recovery command exits: failed deploy=${failedMigration.status}, ` +
        `P3009 retry=${blockedRerun.status}, tampered preflight=${tamperedChecksumPreflightStatus}, ` +
        `pristine preflight=${productionPreflightResult.status}, resolve=${resolveResult.status}, ` +
        `redeploy=${redeployResult.status}, status=${recoveredStatusResult.status}.\n`,
      );
    }
    stdout.write(
      'Verified atomic failure, one unresolved Prisma record, target-bound P3009, deliberate remediation, terminal repeatable-read/read-only production preflight, exact rolled-back resolution, redeploy, and status.\n',
    );

    createDatabase(databases.valid, databases.base);
    psql(databases.valid, VALID_LEGACY_SEED_SQL, 'seed valid and expired legacy recovery pairs');
    const logicalBefore = fixtureFingerprint(
      databases.valid,
      'capture logical legacy fixture before P1-07A migration',
    );
    runTargetPrisma(
      databases.valid,
      ['migrate', 'deploy', '--schema', targetSchemaPath],
      'apply P1-07A to valid historical recovery data',
    );
    const logicalAfter = fixtureFingerprint(
      databases.valid,
      'capture logical legacy fixture after P1-07A migration',
    );
    if (logicalAfter !== logicalBefore) {
      throw new Error(
        'P1-07A changed logical Organisation/User fixture data outside documented reset cleanup/backfill',
      );
    }
    psql(databases.valid, INSTALLED_CATALOG_ASSERTIONS_SQL, 'assert exact P1-07A catalog');
    psql(
      databases.valid,
      VALID_BACKFILL_ASSERTIONS_SQL,
      'assert exact legacy recovery backfill and expired-pair cleanup',
    );

    psql(databases.valid, String.raw`
      UPDATE "AuthRecoveryControl"
      SET "activeSecretFingerprint" = '${'a'.repeat(64)}',
          "activatedAt" = clock_timestamp(),
          "updatedAt" = clock_timestamp()
      WHERE "id" = 1
        AND "generation" = 1
        AND NOT "blocked"
        AND "activeSecretFingerprint" IS NULL;
    `, 'bind the exact initial authentication recovery control generation');
    assertSqlFailure(
      databases.valid,
      String.raw`
        UPDATE "AuthRecoveryControl"
        SET "activeSecretFingerprint" = '${'b'.repeat(64)}',
            "activatedAt" = clock_timestamp(),
            "updatedAt" = clock_timestamp()
        WHERE "id" = 1;
      `,
      /Illegal authentication recovery control transition/i,
      'reject direct active-to-active recovery fingerprint replacement',
    );
    assertSqlFailure(
      databases.valid,
      'DELETE FROM "AuthRecoveryControl" WHERE "id" = 1;',
      /Authentication recovery control cannot be deleted/i,
      'reject authentication recovery control deletion',
    );
    for (const [statement, description, expected] of [
      [
        `UPDATE "AuthRecoveryRetiredSecret" SET "retiredAt" = clock_timestamp();`,
        'reject retired authentication recovery fingerprint rewrite',
        /append-only/i,
      ],
      [
        `DELETE FROM "AuthRecoveryRetiredSecret";`,
        'reject retired authentication recovery fingerprint deletion',
        /append-only/i,
      ],
      [
        `TRUNCATE TABLE "AuthRecoveryRetiredSecret";`,
        'reject retired authentication recovery fingerprint truncation',
        /cannot be truncated/i,
      ],
    ]) {
      assertSqlFailure(
        databases.valid,
        String.raw`
          BEGIN;
          INSERT INTO "AuthRecoveryRetiredSecret" (
            "fingerprint", "retiredGeneration", "retiredAt"
          ) VALUES ('${'a'.repeat(64)}', 1, clock_timestamp());
          ${statement}
          COMMIT;
        `,
        expected,
        description,
      );
    }

    assertSqlFailure(
      databases.valid,
      String.raw`
        INSERT INTO "PasswordRecoveryRequest" (
          "source", "organisationId", "userId", "tokenHash", "deliveryState",
          "suppressionReason", "expiresAt", "createdAt", "updatedAt"
        ) VALUES (
          'SELF_SERVICE_EMAIL', 'p107a-valid-org', 'p107a-valid-user',
          '${'8'.repeat(64)}', 'SUPPRESSED', 'RATE_LIMITED',
          CURRENT_TIMESTAMP + INTERVAL '30 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        );
      `,
      /PasswordRecoveryRequest_(?:source_shape|target_shape|delivery_evidence)_check/i,
      'reject invalid password-recovery request shape',
    );

    psql(
      databases.valid,
      INSERT_VALID_PENDING_REQUEST_SQL,
      'insert one valid PENDING self-service recovery request',
    );
    assertSqlFailure(
      databases.valid,
      String.raw`
        UPDATE "PasswordRecoveryRequest"
        SET "deliveryState" = 'ACCEPTED',
            "deliveryFinalizedAt" = CURRENT_TIMESTAMP,
            "providerMessageId" = 'provider-direct-skip'
        WHERE "id" = '11111111-1111-4111-8111-111111111111';
      `,
      /Illegal password recovery delivery-state transition/i,
      'reject illegal PENDING-to-ACCEPTED recovery transition',
    );
    assertSqlFailure(
      databases.valid,
      String.raw`
        UPDATE "PasswordRecoveryRequest"
        SET "tokenHash" = '${'9'.repeat(64)}'
        WHERE "id" = '11111111-1111-4111-8111-111111111111';
      `,
      /Password recovery identity and recipient evidence are immutable/i,
      'reject recovery identity evidence rewrite',
    );

    psql(
      databases.valid,
      INSERT_THIRD_OUTSTANDING_REQUEST_SQL,
      'insert third outstanding recovery request for serialized-limit proof',
    );
    assertSqlFailure(
      databases.valid,
      INSERT_FOURTH_OUTSTANDING_REQUEST_SQL,
      /PasswordRecoveryRequest_outstanding_limit|outstanding request limit reached/i,
      'reject fourth outstanding recovery request',
    );

    assertSqlFailure(
      databases.valid,
      String.raw`
        INSERT INTO "PasswordRecoveryRequest" (
          "id", "source", "organisationId", "userId", "identifierDigest",
          "requestIpDigest", "requestNetworkDigest", "rateKeyVersion", "tokenHash",
          "tokenNonce", "tokenKeyVersion", "recipientEmail", "recipientName",
          "frontendOrigin", "deliveryTemplateVersion", "deliveryState",
          "deliveryAttemptCount", "nextDeliveryAttemptAt", "expiresAt",
          "createdAt", "updatedAt"
        ) VALUES (
          '55555555-5555-4555-8555-555555555555',
          'SELF_SERVICE_EMAIL', 'p107a-valid-org', 'p107a-valid-user',
          '${'a'.repeat(64)}', '${'b'.repeat(64)}', '${'c'.repeat(64)}', 1,
          '${'d'.repeat(64)}', '${'e'.repeat(64)}', 1,
          'wrong-recipient@example.test', 'Valid legacy recovery',
          'https://app.example.test', 1, 'PENDING', 0, CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP + INTERVAL '30 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        );
      `,
      /PasswordRecoveryRequest_recipient_authority|recipient must match/i,
      'reject self-service recovery recipient not matching locked user email',
    );

    psql(databases.valid, String.raw`
      INSERT INTO "PasswordRecoveryRequest" (
        "id", "source", "organisationId", "userId", "identifierDigest",
        "requestIpDigest", "requestNetworkDigest", "rateKeyVersion", "tokenHash",
        "tokenNonce", "tokenKeyVersion", "recipientEmail", "recipientName",
        "frontendOrigin", "deliveryTemplateVersion", "deliveryState",
        "deliveryAttemptCount", "nextDeliveryAttemptAt", "expiresAt",
        "terminatedAt", "terminationReason", "createdAt", "updatedAt"
      ) VALUES (
        '66666666-6666-4666-8666-666666666666',
        'SELF_SERVICE_EMAIL', 'p107a-valid-org', 'p107a-valid-user',
        '${'f'.repeat(64)}', '${'0'.repeat(64)}', '${'1'.repeat(64)}', 1,
        '${'2'.repeat(64)}', '${'3'.repeat(64)}', 1,
        'p107a-valid@example.test', 'Valid legacy recovery',
        'https://app.example.test', 1, 'PENDING', 0, NULL,
        CURRENT_TIMESTAMP + INTERVAL '30 minutes', CURRENT_TIMESTAMP,
        'ACCOUNT_INACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
    `, 'insert terminated PENDING recovery evidence');
    assertSqlFailure(
      databases.valid,
      String.raw`
        UPDATE "PasswordRecoveryRequest"
        SET "deliveryState" = 'SENDING',
            "claimToken" = '77777777-7777-4777-8777-777777777777',
            "claimedAt" = CURRENT_TIMESTAMP,
            "deliveryAttemptedAt" = CURRENT_TIMESTAMP,
            "deliveryAttemptCount" = 1
        WHERE "id" = '66666666-6666-4666-8666-666666666666';
      `,
      /Illegal password recovery delivery-state transition/i,
      'reject terminated PENDING recovery claim',
    );

    psql(databases.valid, String.raw`
      INSERT INTO "PasswordRecoveryRequest" (
        "id", "source", "organisationId", "userId", "identifierDigest",
        "requestIpDigest", "requestNetworkDigest", "rateKeyVersion", "tokenHash",
        "tokenNonce", "tokenKeyVersion", "recipientEmail", "recipientName",
        "frontendOrigin", "deliveryTemplateVersion", "deliveryState", "claimToken",
        "claimedAt", "deliveryAttemptedAt", "deliveryAttemptCount", "expiresAt",
        "terminatedAt", "terminationReason", "createdAt", "updatedAt"
      ) VALUES (
        '88888888-8888-4888-8888-888888888888',
        'SELF_SERVICE_EMAIL', 'p107a-valid-org', 'p107a-valid-user',
        '${'4'.repeat(64)}', '${'5'.repeat(64)}', '${'6'.repeat(64)}', 1,
        '${'7'.repeat(64)}', '${'8'.repeat(64)}', 1,
        'p107a-valid@example.test', 'Valid legacy recovery',
        'https://app.example.test', 1, 'SENDING',
        '99999999-9999-4999-8999-999999999999', CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP + INTERVAL '30 minutes',
        CURRENT_TIMESTAMP, 'ACCOUNT_INACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
    `, 'insert terminated SENDING recovery evidence');
    assertSqlFailure(
      databases.valid,
      String.raw`
        UPDATE "PasswordRecoveryRequest"
        SET "deliveryState" = 'PENDING',
            "claimToken" = NULL,
            "claimedAt" = NULL,
            "deliveryAttemptedAt" = NULL
        WHERE "id" = '88888888-8888-4888-8888-888888888888';
      `,
      /Illegal password recovery delivery-state transition/i,
      'reject terminated SENDING recovery retry',
    );

    psql(databases.valid, String.raw`
      UPDATE "PasswordRecoveryRequest"
      SET "deliveryState" = 'SENDING',
          "claimToken" = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          "claimedAt" = CURRENT_TIMESTAMP,
          "deliveryAttemptedAt" = CURRENT_TIMESTAMP,
          "deliveryAttemptCount" = 1,
          "nextDeliveryAttemptAt" = NULL
      WHERE "id" = '11111111-1111-4111-8111-111111111111';
      UPDATE "PasswordRecoveryRequest"
      SET "deliveryState" = 'ACCEPTED',
          "claimToken" = NULL,
          "deliveryFinalizedAt" = CURRENT_TIMESTAMP,
          "providerMessageId" = 'provider-accepted-p107a'
      WHERE "id" = '11111111-1111-4111-8111-111111111111';
    `, 'advance recovery evidence through legal PENDING-SENDING-ACCEPTED states');
    assertSqlFailure(
      databases.valid,
      String.raw`
        UPDATE "PasswordRecoveryRequest"
        SET "providerMessageId" = 'rewritten-terminal-recovery-id'
        WHERE "id" = '11111111-1111-4111-8111-111111111111';
      `,
      /Terminal password recovery delivery evidence is immutable/i,
      'reject terminal recovery delivery evidence rewrite',
    );

    psql(databases.valid, INSERT_OUTBOX_EVIDENCE_SQL, 'insert immutable auth security-email evidence');
    assertSqlFailure(
      databases.valid,
      String.raw`
        UPDATE "AuthSecurityEmailOutbox"
        SET "recipientEmail" = 'rewritten@example.test'
        WHERE "id" = '44444444-4444-4444-8444-444444444444';
      `,
      /Auth security email identity and recipient evidence are immutable/i,
      'reject auth security-email recipient evidence rewrite',
    );

    assertSqlFailure(
      databases.valid,
      String.raw`
        INSERT INTO "AuthSecurityEmailOutbox" (
          "id", "kind", "organisationId", "userId", "auditEventId",
          "recipientEmail", "recipientName", "deliveryTemplateVersion",
          "deliveryState", "deliveryAttemptCount", "nextDeliveryAttemptAt",
          "createdAt", "updatedAt"
        ) VALUES (
          'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          'PASSWORD_RESET_COMPLETED_NOTICE', 'p107a-valid-org', 'p107a-control-user',
          'p107a-password-reset-audit', 'p107a-control@example.test',
          'No legacy recovery', 1, 'PENDING', 0, CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        );
      `,
      /AuthSecurityEmailOutbox_audit_authority|exact password reset audit/i,
      'reject auth security email bound to wrong audit subject user',
    );
    assertSqlFailure(
      databases.valid,
      String.raw`
        INSERT INTO "AuthSecurityEmailOutbox" (
          "id", "kind", "organisationId", "userId", "auditEventId",
          "recipientEmail", "recipientName", "deliveryTemplateVersion",
          "deliveryState", "deliveryAttemptCount", "nextDeliveryAttemptAt",
          "createdAt", "updatedAt"
        ) VALUES (
          'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          'PASSWORD_RESET_COMPLETED_NOTICE', 'p107a-valid-org', 'p107a-valid-user',
          'p107a-password-reset-audit', 'wrong@example.test',
          'Valid legacy recovery', 1, 'PENDING', 0, CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        );
      `,
      /AuthSecurityEmailOutbox_recipient_authority|recipient must match/i,
      'reject auth security email recipient mismatch',
    );
    assertSqlFailure(
      databases.valid,
      String.raw`
        BEGIN;
        INSERT INTO "SecurityAuditEvent" (
          "id", "organisationId", "type", "actorKind", "actorLabel",
          "subjectLabel", "subjectUserId", "reason", "context",
          "eventVersion", "occurredAt"
        ) VALUES (
          'p107a-forged-reset-audit', 'p107a-valid-org',
          'ALL_SESSIONS_REVOKED', 'SYSTEM', 'Self-service recovery',
          'Valid legacy recovery', 'p107a-valid-user',
          'Forged compatible-looking reset evidence.',
          '{"eventKind":"PASSWORD_RESET_COMPLETED","method":"PASSWORD_RECOVERY_LINK","recoveryRequestId":"dddddddd-dddd-4ddd-8ddd-dddddddddddd"}'::jsonb,
          1, CURRENT_TIMESTAMP
        );
        INSERT INTO "AuthSecurityEmailOutbox" (
          "id", "kind", "organisationId", "userId", "auditEventId",
          "recipientEmail", "recipientName", "deliveryTemplateVersion",
          "deliveryState", "deliveryAttemptCount", "nextDeliveryAttemptAt",
          "createdAt", "updatedAt"
        ) VALUES (
          'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          'PASSWORD_RESET_COMPLETED_NOTICE', 'p107a-valid-org',
          'p107a-valid-user', 'p107a-forged-reset-audit',
          'p107a-valid@example.test', 'Valid legacy recovery', 1,
          'PENDING', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        );
        COMMIT;
      `,
      /AuthSecurityEmailOutbox_audit_authority|exact password reset audit/i,
      'reject a security notice backed only by compatible-looking audit JSON',
    );

    psql(databases.valid, String.raw`
      UPDATE "AuthSecurityEmailOutbox"
      SET "deliveryState" = 'SENDING',
          "claimToken" = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          "claimedAt" = CURRENT_TIMESTAMP,
          "deliveryAttemptedAt" = CURRENT_TIMESTAMP,
          "deliveryAttemptCount" = 1,
          "nextDeliveryAttemptAt" = NULL
      WHERE "id" = '44444444-4444-4444-8444-444444444444';
      UPDATE "AuthSecurityEmailOutbox"
      SET "deliveryState" = 'ACCEPTED',
          "claimToken" = NULL,
          "deliveryFinalizedAt" = CURRENT_TIMESTAMP,
          "providerMessageId" = 'provider-security-notice-p107a'
      WHERE "id" = '44444444-4444-4444-8444-444444444444';
    `, 'advance auth security email through legal terminal delivery states');
    assertSqlFailure(
      databases.valid,
      String.raw`
        UPDATE "AuthSecurityEmailOutbox"
        SET "providerMessageId" = 'rewritten-terminal-security-id'
        WHERE "id" = '44444444-4444-4444-8444-444444444444';
      `,
      /Terminal auth security email delivery evidence is immutable/i,
      'reject terminal auth security email delivery evidence rewrite',
    );

    assertSqlFailure(
      databases.valid,
      String.raw`
        UPDATE "User"
        SET "resetToken" = '${'f'.repeat(64)}',
            "resetTokenExpiry" = CURRENT_TIMESTAMP + INTERVAL '30 minutes',
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = 'p107a-valid-user';
      `,
      /legacy User password recovery slots are retired|User_legacy_password_recovery_slot_retired_check/i,
      'reject a p109-shaped write to the retired User recovery slot',
    );

    psql(databases.valid, String.raw`
      BEGIN;
      SELECT pg_sleep(0.05);
      INSERT INTO "PasswordRecoveryRequest" (
        "id", "source", "organisationId", "userId", "tokenHash",
        "deliveryState", "deliveryAttemptCount", "expiresAt", "createdAt",
        "updatedAt"
      ) VALUES (
        'ffffffff-ffff-4fff-8fff-ffffffffffff',
        'PERSONAL_SERVER_OPERATOR', 'p107a-valid-org', 'p107a-valid-user',
        '${'e'.repeat(64)}', 'ACCEPTED', 0,
        clock_timestamp() + INTERVAL '30 minutes',
        clock_timestamp(), clock_timestamp()
      );
      UPDATE "User"
      SET "passwordHash" = 'legacy-p109-client-password-change',
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = 'p107a-valid-user';
      DO $fixture$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM "PasswordRecoveryRequest"
          WHERE "userId" = 'p107a-valid-user' AND "terminatedAt" IS NULL
        ) OR NOT EXISTS (
          SELECT 1 FROM "PasswordRecoveryRequest"
          WHERE "id" = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
            AND "terminationReason" =
              'PASSWORD_RESET_COMPLETED'::"PasswordRecoveryTerminationReason"
            AND "terminatedAt" >= "createdAt"
        ) OR NOT EXISTS (
          SELECT 1 FROM "User"
          WHERE "id" = 'p107a-valid-user'
            AND "resetToken" IS NULL
            AND "resetTokenExpiry" IS NULL
        ) THEN
          RAISE EXCEPTION 'Out-of-band password change did not invalidate every recovery path';
        END IF;
      END;
      $fixture$;
      COMMIT;
    `, 'prove a long-running out-of-band password change uses post-lock invalidation time');

    createDatabase(databases.fresh);
    runTargetPrisma(
      databases.fresh,
      ['migrate', 'deploy', '--schema', targetSchemaPath],
      'deploy complete fresh schema including P1-07A',
    );
    psql(databases.fresh, INSTALLED_CATALOG_ASSERTIONS_SQL, 'assert fresh P1-07A catalog');
    runTargetPrisma(
      databases.fresh,
      ['migrate', 'status', '--schema', targetSchemaPath],
      'verify fresh P1-07A Prisma migration status',
    );

    stdout.write(
      'P1-07A PostgreSQL 16 fixture passed legacy digest backfill with atomic User-slot retirement, p109-shaped write rejection, plaintext absence, expired cleanup, logical-data fingerprint, fresh schema, exact catalog, transition, immutability, and serialized outstanding-limit assertions.\n',
    );
  } catch (error) {
    verificationFailure = error;
  }

  const cleanupFailures = [];
  try {
    rmSync(previousMigrationWorkspace.root, { recursive: true, force: true });
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    rmSync(targetMigrationWorkspace.root, { recursive: true, force: true });
  } catch (error) {
    cleanupFailures.push(error);
  }

  if (keepDatabases) {
    stdout.write(`Keeping disposable databases for inspection: ${allDatabases.join(', ')}\n`);
  } else {
    try {
      await cleanupDatabases({
        databases: [...allDatabases].reverse(),
        dockerBin,
        container,
        user,
        adminDatabase,
        commandRunner,
        timeoutMs: cleanupTimeoutMs,
      });
    } catch (error) {
      cleanupFailures.push(error);
    }
  }

  if (verificationFailure) {
    if (cleanupFailures.length > 0) {
      throw new Error(
        `${verificationFailure instanceof Error ? verificationFailure.message : verificationFailure}\n` +
        `Additionally, P1-07A disposable cleanup failed: ${cleanupFailures.map((error) => error instanceof Error ? error.message : error).join(' | ')}`,
        { cause: verificationFailure },
      );
    }
    throw verificationFailure;
  }
  if (cleanupFailures.length > 0) {
    throw new Error(
      `P1-07A disposable cleanup failed after successful verification: ${cleanupFailures.map((error) => error instanceof Error ? error.message : error).join(' | ')}`,
      { cause: cleanupFailures[0] },
    );
  }
}

async function main() {
  try {
    await verifyPasswordRecoveryUpgrade();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
