import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  revokeTeamSessionSchema,
  teamGovernanceReasonSchema,
  teamMemberLifecycleActionSchema,
  transferTeamOwnershipSchema,
  updateTeamMemberRoleSchema,
} from '../schemas/team.js';

test('team lifecycle mutations require an optimistic version and substantive bounded reason', () => {
  assert.equal(teamMemberLifecycleActionSchema.safeParse({
    expectedMembershipVersion: 2,
    reason: 'Governance review requires temporary suspension.',
  }).success, true);
  assert.equal(teamMemberLifecycleActionSchema.safeParse({
    expectedMembershipVersion: 0,
    reason: 'too short',
  }).success, false);
  assert.equal(teamMemberLifecycleActionSchema.safeParse({
    expectedMembershipVersion: 2,
    reason: `Valid prefix ${String.fromCharCode(0)} invalid control`,
  }).success, false);
});

test('ownership transfer requires both versions and the exact destructive confirmation', () => {
  const valid = {
    targetMemberId: 'member-2',
    expectedCurrentOwnerVersion: 3,
    expectedTargetVersion: 5,
    confirmation: 'TRANSFER OWNERSHIP',
    reason: 'The board appointed this member as the accountable owner.',
  };
  assert.equal(transferTeamOwnershipSchema.safeParse(valid).success, true);
  assert.equal(transferTeamOwnershipSchema.safeParse({
    ...valid,
    confirmation: 'transfer',
  }).success, false);
});

test('session revocation uses the same version and evidence contract', () => {
  assert.equal(revokeTeamSessionSchema.safeParse({
    expectedMembershipVersion: 1,
    reason: 'This device is no longer controlled by the member.',
  }).success, true);
  assert.equal(revokeTeamSessionSchema.safeParse({
    expectedMembershipVersion: 1.5,
    reason: 'This device is no longer controlled by the member.',
  }).success, false);
});

test('governance reasons normalize safe newlines and reject other control characters', () => {
  const normalized = teamGovernanceReasonSchema.safeParse('  First line\r\nSecond line  ');
  assert.equal(normalized.success, true);
  if (normalized.success) assert.equal(normalized.data, 'First line\nSecond line');
  const boundaryNewlines = teamGovernanceReasonSchema.safeParse('\n  First line\nSecond line  \n');
  assert.equal(boundaryNewlines.success, true);
  if (boundaryNewlines.success) assert.equal(boundaryNewlines.data, 'First line\nSecond line');
  assert.equal(
    teamGovernanceReasonSchema.safeParse(`Valid reason ${String.fromCharCode(9)} with a tab`).success,
    false,
  );
});

test('ordinary role changes cannot represent ownership transfer', () => {
  const base = {
    expectedMembershipVersion: 2,
    reason: 'The board approved this administrator role change.',
  };
  assert.equal(updateTeamMemberRoleSchema.safeParse({ ...base, role: 'ADMIN' }).success, true);
  assert.equal(updateTeamMemberRoleSchema.safeParse({ ...base, role: 'MEMBER' }).success, true);
  assert.equal(updateTeamMemberRoleSchema.safeParse({ ...base, role: 'OWNER' }).success, false);
});
