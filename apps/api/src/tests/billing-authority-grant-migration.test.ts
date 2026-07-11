import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const migration = readFileSync(
  new URL('../../prisma/migrations/20260711120000_add_billing_authority_grants/migration.sql', import.meta.url),
  'utf8',
);
const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
const interlock = readFileSync(
  join(process.cwd(), 'src', 'services', 'billing-authority-interlock.ts'),
  'utf8',
);
const lifecycle = readFileSync(
  join(process.cwd(), 'src', 'services', 'team-lifecycle.service.ts'),
  'utf8',
);
const recovery = readFileSync(
  join(process.cwd(), 'src', 'jobs', 'recover-team-ownership.ts'),
  'utf8',
);
const databaseSafety = readFileSync(
  new URL('../../../../e2e/helpers/database-safety.cjs', import.meta.url),
  'utf8',
);
const backup = readFileSync(
  new URL('../../../../scripts/postgres-backup.mjs', import.meta.url),
  'utf8',
);

test('billing authority migration is atomic under Prisma Migrate', () => {
  assert.match(migration, /^\s*(?:--[^\r\n]*(?:\r?\n|$)\s*)*BEGIN\s*;/i);
  assert.match(migration, /COMMIT;\s*$/i);
});

test('billing authority grant is tenant, owner-version, and session bound with one unresolved row', () => {
  assert.match(schema, /model BillingAuthorityGrant/);
  assert.match(schema, /actorMembershipVersion Int/);
  assert.match(schema, /fields: \[actorUserId, organisationId\], references: \[id, organisationId\]/);
  assert.match(schema, /fields: \[actorSessionId, actorUserId\], references: \[id, userId\]/);
  assert.match(migration, /BillingAuthorityGrant_actorUserId_organisationId_fkey/);
  assert.match(migration, /BillingAuthorityGrant_actorSessionId_actorUserId_fkey/);
  assert.match(
    migration,
    /BillingAuthorityGrant_one_active_per_organisation[\s\S]*WHERE "state" <> 'RELEASED'/,
  );
  assert.match(migration, /Billing authority grant actor is not the current active owner version/);
  assert.match(migration, /Billing authority grant requires the owner active session/);
  assert.match(migration, /Billing authority grant must begin in CLAIMED state/);
});

test('grant state and release evidence are constrained, terminal, and provider truthful', () => {
  for (const state of ['CLAIMED', 'PROVIDER_STARTED', 'CAPABILITY_ISSUED', 'RELEASED']) {
    assert.match(migration, new RegExp(`'${state}'`));
  }
  assert.match(migration, /BillingAuthorityGrant_state_evidence_check/);
  assert.match(
    migration,
    /WHEN 'CLAIMED'[\s\S]*"providerResourceId" IS NULL[\s\S]*"safeReleaseAfter" IS NULL/,
  );
  assert.match(
    migration,
    /WHEN 'PROVIDER_STARTED'[\s\S]*"providerResourceId" IS NULL[\s\S]*"safeReleaseAfter" IS NULL/,
  );
  assert.match(migration, /BillingAuthorityGrant_timeline_check/);
  assert.match(migration, /BillingAuthorityGrant_release_reason_consistency_check/);
  assert.match(
    migration,
    /RESTRICTED_OPERATOR_ATTESTATION'[\s\S]*"kind" = 'PORTAL'/,
  );
  assert.match(
    migration,
    /PROVIDER_CONFIRMED_NOT_ISSUED'[\s\S]*"kind" = 'CHECKOUT'[\s\S]*"releaseActor" = 'SYSTEM:BILLING_SERVICE'/,
  );
  assert.match(migration, /OCTET_LENGTH\("releaseEvidence"::TEXT\) <= 8192/);
  assert.match(migration, /PROVIDER_CAPABILITY_REVOKED'[\s\S]*"kind" = 'CHECKOUT'/);
  assert.match(
    migration,
    /PROVIDER_CAPABILITY_TERMINAL'[\s\S]*"kind" = 'CHECKOUT'[\s\S]*"providerResourceId" IS NOT NULL[\s\S]*"capabilityIssuedAt" IS NOT NULL/,
  );
  assert.match(migration, /PROVIDER_CONFIRMED_NOT_ISSUED/);
  assert.match(
    migration,
    /CHECKOUT_SAFE_RELEASE_AFTER_ELAPSED'[\s\S]*"capabilityIssuedAt" IS NOT NULL[\s\S]*"providerResourceId" IS NOT NULL[\s\S]*"releasedAt" >= "safeReleaseAfter"/,
  );
  assert.match(
    migration,
    /BillingAuthorityGrant_portal_never_time_released_check[\s\S]*"safeReleaseAfter" IS NULL/,
  );
});

test('grant evidence and lifecycle interlocks have database backstops without truncate hooks', () => {
  assert.match(migration, /BillingAuthorityGrant_guard_update/);
  assert.match(migration, /Released billing authority evidence is immutable/);
  assert.match(migration, /BillingAuthorityGrant_append_only_delete/);
  assert.match(migration, /User_billing_authority_membership_interlock/);
  assert.match(migration, /Unresolved billing authority blocks actor membership change/);
  assert.match(migration, /Organisation_billing_authority_lifecycle_interlock/);
  assert.match(migration, /Unresolved billing authority blocks organisation lifecycle change/);
  assert.doesNotMatch(migration, /ON TRUNCATE/i);
});

test('ownership transfer and restricted recovery use Organisation then grant then Users lock order', () => {
  const transfer = lifecycle.slice(
    lifecycle.indexOf('async transferOwnership'),
    lifecycle.indexOf('async listSessions'),
  );
  const transferOrganisation = transfer.indexOf('lockOrganisation');
  const transferGrant = transfer.indexOf('assertBillingAuthorityAllowsOwnershipChange');
  const transferUsers = transfer.indexOf('lockUsers');
  assert.ok(transferOrganisation >= 0);
  assert.ok(transferOrganisation < transferGrant);
  assert.ok(transferGrant < transferUsers);

  const recoveryOrganisation = recovery.indexOf('const organisations = await tx.$queryRaw');
  const recoveryGrant = recovery.indexOf('assertBillingAuthorityAllowsOwnershipChange', recoveryOrganisation);
  const recoveryUsers = recovery.indexOf('const users = await tx.$queryRaw', recoveryOrganisation);
  assert.ok(recoveryOrganisation >= 0);
  assert.ok(recoveryOrganisation < recoveryGrant);
  assert.ok(recoveryGrant < recoveryUsers);

  assert.match(interlock, /FROM "BillingAuthorityGrant"[\s\S]*FOR UPDATE/);
  assert.match(interlock, /grant\.kind === 'CHECKOUT'[\s\S]*grant\.safeReleaseAfter/);
  assert.match(interlock, /grant\.kind === 'PORTAL'[\s\S]*explicit restricted release/);
});

test('new evidence is included in destructive-test and backup inventories and session reasons are truthful', () => {
  assert.match(databaseSafety, /"BillingAuthorityGrant"/);
  assert.match(backup, /'BillingAuthorityGrant'/);
  assert.match(schema, /USER_SESSION_REVOKED/);
  assert.match(schema, /USER_ALL_SESSIONS_REVOKED/);
  assert.match(migration, /ADD VALUE IF NOT EXISTS 'USER_SESSION_REVOKED'/);
  assert.match(migration, /ADD VALUE IF NOT EXISTS 'USER_ALL_SESSIONS_REVOKED'/);
});
