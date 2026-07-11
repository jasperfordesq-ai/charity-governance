import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const migration = readFileSync(
  new URL('../../prisma/migrations/20260711030000_add_team_lifecycle_security/migration.sql', import.meta.url),
  'utf8',
);
const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
const seed = readFileSync(new URL('../../prisma/seed.ts', import.meta.url), 'utf8');
const databaseSafety = readFileSync(
  new URL('../../../../e2e/helpers/database-safety.cjs', import.meta.url),
  'utf8',
);
const backup = readFileSync(
  new URL('../../../../scripts/postgres-backup.mjs', import.meta.url),
  'utf8',
);

test('P0-07 migration fails closed on ambiguous owners and invitations before schema mutation', () => {
  const preflightEnd = migration.indexOf('CREATE TYPE "OrganisationLifecycleStatus"');
  const preflight = migration.slice(0, preflightEnd);

  assert.match(preflight, /COUNT\(\*\) FILTER \(WHERE account\."role" = 'OWNER'/);
  assert.match(preflight, /<> 1/);
  assert.match(preflight, /legacy OWNER invitations require manual resolution/);
  assert.match(preflight, /cannot be both accepted and revoked/);
  assert.match(preflight, /LOCK TABLE "Organisation"[\s\S]*LOCK TABLE "User"[\s\S]*LOCK TABLE "TeamInvite"[\s\S]*LOCK TABLE "AuthSession"/);
});

test('P0-07 database enforces terminal lifecycle and exactly one active owner', () => {
  assert.match(migration, /User_one_active_owner_per_organisation/);
  assert.match(migration, /CREATE CONSTRAINT TRIGGER "User_exactly_one_active_owner"[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  assert.match(migration, /CREATE CONSTRAINT TRIGGER "Organisation_exactly_one_active_owner"[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  assert.match(migration, /Closed organisations cannot be reactivated or suspended/);
  assert.match(migration, /Removed memberships are terminal and immutable/);
  assert.match(migration, /User_owner_must_be_active_check/);
});

test('P0-07 session families are lineage-safe, lifecycle-guarded, and irreversibly revoked', () => {
  assert.match(migration, /AuthSession_one_active_session_per_family/);
  assert.match(migration, /AuthSession_family_timeline_check/);
  assert.match(migration, /Auth session family identity is inconsistent/);
  assert.match(migration, /FOR SHARE/);
  assert.match(migration, /AuthSession_immutable_identity_and_revocation/);
  assert.match(migration, /Auth session revocation evidence is immutable once recorded/);
  assert.match(migration, /SET "familyId" = gen_random_uuid\(\)[\s\S]*"revocationReason" = 'LEGACY_UNSPECIFIED'/);
});

test('P0-07 security evidence is tenant-scoped, bounded, append-only, and soft-removal preserving', () => {
  assert.match(schema, /model SecurityAuditEvent/);
  assert.match(migration, /SecurityAuditEvent_actorUserId_organisationId_fkey/);
  assert.match(migration, /SecurityAuditEvent_subjectUserId_organisationId_fkey/);
  assert.match(migration, /OCTET_LENGTH\("context"::TEXT\) <= 8192/);
  assert.match(migration, /CREATE TRIGGER "SecurityAuditEvent_append_only"/);
  assert.match(migration, /CREATE TRIGGER "User_soft_removal_only"/);
  assert.doesNotMatch(migration, /ON TRUNCATE/i);
});

test('P0-07 operational paths know about the owner transaction and immutable audit table', () => {
  assert.match(seed, /prisma\.\$transaction\(async \(tx\)/);
  assert.match(seed, /tx\.organisation\.create/);
  assert.match(seed, /tx\.user\.upsert/);
  assert.match(databaseSafety, /"SecurityAuditEvent"/);
  assert.match(backup, /'SecurityAuditEvent'/);
});
