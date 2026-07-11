import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dashboard = (...parts: string[]) =>
  readFileSync(join(process.cwd(), 'src', 'app', '(dashboard)', ...parts), 'utf8');

test('Registers preserve member reads while hiding and guarding every mutation', () => {
  const page = dashboard('registers', 'page.tsx');
  const workflow = dashboard('registers', 'use-registers-workflow.ts');
  const lists = dashboard('registers', 'register-record-lists.tsx');
  const cards = dashboard('registers', 'register-compliance-cards.tsx');
  const modal = dashboard('registers', 'register-record-modal.tsx');

  assert.match(workflow, /canManageGovernance\(user\?\.role\)/);
  assert.match(workflow, /isApiForbiddenError\(error\)/);
  assert.match(workflow, /setPermissionRevoked\(true\)/);
  assert.match(workflow, /setModalType\(null\)/);
  assert.match(workflow, /setAnnual\(persistedAnnualRef\.current\)/);
  assert.match(workflow, /setFinancial\(persistedFinancialRef\.current\)/);
  assert.match(workflow, /refreshUser\(\)/);
  assert.doesNotMatch(workflow, /router\.(?:push|replace)/);

  for (const handler of ['openModal', 'updateForm', 'handleCreate', 'closeRecord', 'saveAnnual', 'saveFinancial']) {
    const start = workflow.indexOf(`const ${handler}`);
    const end = workflow.indexOf('\n  const ', start + 1);
    assert.ok(start >= 0, `${handler} must exist`);
    assert.match(workflow.slice(start, end >= 0 ? end : undefined), /canManage/);
  }

  assert.match(page, /canManage=\{canManage\}/);
  assert.match(modal, /isOpen=\{Boolean\(modalType && canManage\)\}/);
  assert.match(lists, /actions=\{canManage \? \(/);
  assert.match(lists, /action=\{canManage && item\.status/);
  assert.match(cards, /isReadOnly=\{!canManage\}/);
  assert.match(cards, /isDisabled=\{!canManage\}/);
  assert.match(cards, /\{canManage \? \([\s\S]*?Save Annual Report readiness/);
  assert.match(cards, /\{canManage \? \([\s\S]*?Save controls review/);
});

test('Deadlines fail closed on stale-role mutations without removing legitimate reads', () => {
  const page = dashboard('deadlines', 'page.tsx');
  const workflow = dashboard('deadlines', 'use-deadlines-workflow.ts');

  assert.match(workflow, /canManageGovernance\(user\?\.role\)/);
  assert.match(workflow, /isApiForbiddenError\(error\)/);
  assert.match(workflow, /setPermissionRevoked\(true\)/);
  assert.match(workflow, /deadlineModal\.onClose\(\)/);
  assert.match(workflow, /deleteModal\.onClose\(\)/);
  assert.match(workflow, /completionModal\.onClose\(\)/);
  assert.match(workflow, /refreshUser\(\)/);
  assert.doesNotMatch(workflow, /router\.(?:push|replace)/);

  for (const handler of ['openAdd', 'scheduleConditionalDeadline', 'openEdit', 'openDelete', 'handleSaveDeadline', 'applyCompletionChange', 'toggleComplete', 'handleDeleteDeadline']) {
    const start = workflow.indexOf(`const ${handler}`);
    const end = workflow.indexOf('\n  const ', start + 1);
    assert.ok(start >= 0, `${handler} must exist`);
    assert.match(workflow.slice(start, end >= 0 ? end : undefined), /canManage/);
  }

  assert.match(page, /actions=\{canManage \? \(/);
  assert.match(page, /\{canManage \? \(\s*<DeadlineReminderHistoryPanel/);
  assert.match(page, /isOpen=\{canManage && deadlineModal\.isOpen\}/);
  assert.match(page, /isOpen=\{canManage && deleteModal\.isOpen\}/);
  assert.match(page, /isOpen=\{canManage && completionModal\.isOpen\}/);
});

test('Organisation profile remains reviewable but all member-side state changes are guarded', () => {
  const page = dashboard('organisation', 'page.tsx');
  const workflow = dashboard('organisation', 'use-organisation-workflow.ts');
  const form = dashboard('organisation', 'organisation-profile-form.tsx');

  assert.match(workflow, /canManageGovernance\(user\?\.role\)/);
  assert.match(workflow, /isApiForbiddenError\(err\)/);
  assert.match(workflow, /setPermissionRevoked\(true\)/);
  assert.match(workflow, /complexityModal\.onClose\(\)/);
  assert.match(workflow, /restorePersistedProfile\(\)/);
  assert.match(workflow, /refreshUser\(\)/);
  assert.doesNotMatch(workflow, /router\.(?:push|replace)/);

  for (const handler of ['handleComplexityChange', 'handleLegalFormChange', 'handleCroAnnualReturnDateChange', 'handlePurposeChange', 'handleConditionalFactChange', 'handleSave']) {
    const start = workflow.indexOf(`const ${handler}`);
    const end = workflow.indexOf('\n  const ', start + 1);
    assert.ok(start >= 0, `${handler} must exist`);
    assert.match(workflow.slice(start, end >= 0 ? end : undefined), /canManage/);
  }

  assert.match(workflow, /setName: \(value: string\) => \{ if \(canManage\) setName\(value\); \}/);
  assert.match(workflow, /setLegalFormConfirmed: \(value: boolean\) => \{ if \(canManage\)/);
  assert.match(page, /isOpen=\{canManage && complexityModal\.isOpen\}/);
  assert.match(form, /isReadOnly=\{!canManage\}/);
  assert.match(form, /isDisabled=\{!canManage/);
  assert.match(form, /\{canManage \? \([\s\S]*?Save profile/);
  assert.match(form, /Organisation profile changes are available to owners and administrators/);
});
