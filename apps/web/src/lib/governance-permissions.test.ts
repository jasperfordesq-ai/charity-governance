import assert from 'node:assert/strict';
import test from 'node:test';
import { canManageGovernance } from './governance-permissions';

test('governance mutations are available only to owners and administrators', () => {
  assert.equal(canManageGovernance('OWNER'), true);
  assert.equal(canManageGovernance('ADMIN'), true);
  assert.equal(canManageGovernance('MEMBER'), false);
});

test('unknown or unavailable roles fail closed', () => {
  for (const role of [undefined, null, '', 'UNKNOWN', 'owner', 'admin', 'member']) {
    assert.equal(canManageGovernance(role), false, `${String(role)} must not gain governance-write affordances`);
  }
});
