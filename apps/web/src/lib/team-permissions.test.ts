import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canEditMemberRole,
  canInviteMembers,
  canManageMemberLifecycle,
  canManageMemberRoles,
  canManageMemberSessions,
  canTransferOwnership,
  isCurrentGovernanceActionAuthorized,
  isCurrentSessionTargetAuthorized,
  resolveCanonicalTeamRole,
} from './team-permissions';

// Concern: authorization (UI). A MEMBER must never see or trigger admin-only actions.
// These predicates drive the Team page's disabled/hidden controls; the API enforces the
// same boundary (the API ledger), so the affordance AND the enforcement both hold.

test('only OWNER and ADMIN can invite or revoke team members', () => {
  assert.equal(canInviteMembers('OWNER'), true);
  assert.equal(canInviteMembers('ADMIN'), true);
  assert.equal(canInviteMembers('MEMBER'), false);
  assert.equal(canInviteMembers(undefined), false);
  assert.equal(canInviteMembers(null), false);
});

test('only OWNER can manage member roles', () => {
  assert.equal(canManageMemberRoles('OWNER'), true);
  assert.equal(canManageMemberRoles('ADMIN'), false);
  assert.equal(canManageMemberRoles('MEMBER'), false);
  assert.equal(canManageMemberRoles(undefined), false);
});

test('role editing is owner-only and excludes the owner row and your own row', () => {
  // An owner may change another non-owner member's role.
  assert.equal(canEditMemberRole('OWNER', 'me', { role: 'MEMBER', id: 'them' }), true);
  assert.equal(canEditMemberRole('OWNER', 'me', { role: 'ADMIN', id: 'them' }), true);
  // An owner can never demote another owner via this control.
  assert.equal(canEditMemberRole('OWNER', 'me', { role: 'OWNER', id: 'them' }), false);
  // A user can never change their own role (no self-escalation / self-lockout).
  assert.equal(canEditMemberRole('OWNER', 'me', { role: 'ADMIN', id: 'me' }), false);
  // Admins and members cannot change roles at all.
  assert.equal(canEditMemberRole('ADMIN', 'me', { role: 'MEMBER', id: 'them' }), false);
  assert.equal(canEditMemberRole('MEMBER', 'me', { role: 'MEMBER', id: 'them' }), false);
});

test('member lifecycle controls enforce role hierarchy and prohibit self or owner offboarding', () => {
  assert.equal(canManageMemberLifecycle('OWNER', 'owner', { role: 'ADMIN', id: 'admin' }), true);
  assert.equal(canManageMemberLifecycle('OWNER', 'owner', { role: 'MEMBER', id: 'member' }), true);
  assert.equal(canManageMemberLifecycle('ADMIN', 'admin', { role: 'MEMBER', id: 'member' }), true);

  assert.equal(canManageMemberLifecycle('ADMIN', 'admin', { role: 'ADMIN', id: 'other-admin' }), false);
  assert.equal(canManageMemberLifecycle('ADMIN', 'admin', { role: 'OWNER', id: 'owner' }), false);
  assert.equal(canManageMemberLifecycle('MEMBER', 'member', { role: 'MEMBER', id: 'other' }), false);
  assert.equal(canManageMemberLifecycle('OWNER', 'owner', { role: 'MEMBER', id: 'owner' }), false);
  assert.equal(canManageMemberLifecycle(undefined, 'owner', { role: 'MEMBER', id: 'member' }), false);
  assert.equal(canManageMemberLifecycle('OWNER', undefined, { role: 'MEMBER', id: 'member' }), false);
});

test('session controls allow self-service while preserving the administrative hierarchy', () => {
  assert.equal(canManageMemberSessions('OWNER', 'owner', { role: 'OWNER', id: 'owner' }), true);
  assert.equal(canManageMemberSessions('ADMIN', 'admin', { role: 'ADMIN', id: 'admin' }), true);
  assert.equal(canManageMemberSessions('MEMBER', 'member', { role: 'MEMBER', id: 'member' }), true);
  assert.equal(canManageMemberSessions('OWNER', 'owner', { role: 'ADMIN', id: 'admin' }), true);
  assert.equal(canManageMemberSessions('ADMIN', 'admin', { role: 'MEMBER', id: 'member' }), true);

  assert.equal(canManageMemberSessions('OWNER', 'owner', { role: 'OWNER', id: 'other-owner' }), false);
  assert.equal(canManageMemberSessions('ADMIN', 'admin', { role: 'ADMIN', id: 'other-admin' }), false);
  assert.equal(canManageMemberSessions('ADMIN', 'admin', { role: 'OWNER', id: 'owner' }), false);
  assert.equal(canManageMemberSessions('MEMBER', 'member', { role: 'MEMBER', id: 'other' }), false);
  assert.equal(canManageMemberSessions('OWNER', undefined, { role: 'MEMBER', id: 'member' }), false);
  assert.equal(canManageMemberSessions(undefined, 'member', { role: 'MEMBER', id: 'member' }), false);
  assert.equal(canManageMemberSessions('UNKNOWN', 'member', { role: 'MEMBER', id: 'member' }), false);
});

test('ownership transfer is offered only to the active owner for an active verified target', () => {
  const eligible = {
    id: 'target',
    role: 'ADMIN',
    lifecycleStatus: 'ACTIVE',
    emailVerified: true,
  };

  assert.equal(canTransferOwnership('OWNER', 'owner', eligible), true);
  assert.equal(canTransferOwnership('ADMIN', 'admin', eligible), false);
  assert.equal(canTransferOwnership('OWNER', undefined, eligible), false);
  assert.equal(canTransferOwnership('OWNER', 'target', eligible), false);
  assert.equal(canTransferOwnership('OWNER', 'owner', { ...eligible, role: 'OWNER' }), false);
  assert.equal(canTransferOwnership('OWNER', 'owner', { ...eligible, lifecycleStatus: 'SUSPENDED' }), false);
  assert.equal(canTransferOwnership('OWNER', 'owner', { ...eligible, lifecycleStatus: 'REMOVED' }), false);
  assert.equal(canTransferOwnership('OWNER', 'owner', { ...eligible, emailVerified: false }), false);
});

test('canonical team membership overrides stale context roles and fails closed when unavailable', () => {
  const staleContextRole = 'OWNER';
  const canonicalMembers = [
    { id: 'me', role: 'MEMBER', lifecycleStatus: 'ACTIVE' },
    { id: 'actual-owner', role: 'OWNER', lifecycleStatus: 'ACTIVE' },
  ];

  assert.equal(staleContextRole, 'OWNER');
  assert.equal(resolveCanonicalTeamRole('me', canonicalMembers), 'MEMBER');
  assert.equal(resolveCanonicalTeamRole('missing', canonicalMembers), null);
  assert.equal(
    resolveCanonicalTeamRole('me', [{ id: 'me', role: 'OWNER', lifecycleStatus: 'SUSPENDED' }]),
    null,
  );
  assert.equal(resolveCanonicalTeamRole('me', null), null);
});

test('open governance actions fail closed across demotion, load failure, and target version drift', () => {
  const target = {
    id: 'target',
    role: 'MEMBER',
    lifecycleStatus: 'ACTIVE',
    membershipVersion: 4,
    emailVerified: true,
  };
  const action = { kind: 'suspend' as const, member: target };

  assert.equal(isCurrentGovernanceActionAuthorized('ADMIN', 'admin', action, [target], []), true);
  assert.equal(isCurrentGovernanceActionAuthorized('MEMBER', 'admin', action, [target], []), false);
  assert.equal(isCurrentGovernanceActionAuthorized('ADMIN', 'admin', action, null, null), false);
  assert.equal(
    isCurrentGovernanceActionAuthorized(
      'ADMIN',
      'admin',
      action,
      [{ ...target, membershipVersion: target.membershipVersion + 1 }],
      [],
    ),
    false,
  );
  assert.equal(isCurrentGovernanceActionAuthorized('ADMIN', 'admin', action, [], []), false);
});

test('open session targets fail closed across demotion, load failure, and target version drift', () => {
  const target = {
    id: 'target',
    role: 'MEMBER',
    lifecycleStatus: 'ACTIVE',
    membershipVersion: 9,
  };

  assert.equal(isCurrentSessionTargetAuthorized('ADMIN', 'admin', target, [target]), true);
  assert.equal(isCurrentSessionTargetAuthorized('MEMBER', 'admin', target, [target]), false);
  assert.equal(isCurrentSessionTargetAuthorized('ADMIN', 'admin', target, null), false);
  assert.equal(
    isCurrentSessionTargetAuthorized(
      'ADMIN',
      'admin',
      target,
      [{ ...target, membershipVersion: target.membershipVersion + 1 }],
    ),
    false,
  );
  assert.equal(isCurrentSessionTargetAuthorized('ADMIN', 'admin', target, []), false);
});
