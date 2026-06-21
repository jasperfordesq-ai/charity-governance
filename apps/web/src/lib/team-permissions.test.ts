import assert from 'node:assert/strict';
import test from 'node:test';
import { canInviteMembers, canManageMemberRoles, canEditMemberRole } from './team-permissions';

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
